"""
rag/chunker/large_function_splitter.py — 대형 함수 전문 분할기

- 500-999 라인: 2-level (부모 → 블록 자식)
- 1000+ 라인:  3-level (부모 → 섹션 → 블록 자식)

각 자식 블록에 구조적 오버랩(함수 시그니처 + 로컬 변수 선언)을
프리펜드하여 검색 시 컨텍스트를 보존한다.
"""

from __future__ import annotations

import re

from rag.config import CHUNK_SEARCH_BUDGET
from rag.models import (
    Chunk,
    ChunkLevel,
    NodeType,
    UnifiedASTNode,
    generate_chunk_id,
)


class LargeFunctionSplitter:
    """대형 함수(500+) 및 초대형 함수(1000+) 분할기."""

    def split_large_function(
        self, node: UnifiedASTNode, parser=None,
    ) -> tuple[Chunk, list[Chunk]]:
        """500-999 라인 함수를 부모 + 블록 자식으로 분할한다."""
        parent_id = generate_chunk_id(
            node.file_path, node.line_start, node.line_end, node.name
        )
        structural_ctx = self._extract_structural_context(node)

        parent_chunk = Chunk(
            chunk_id=parent_id,
            parent_id=None,
            child_ids=[],
            level=ChunkLevel.FUNCTION,
            source_code=node.source_code,
            language=node.language,
            file_path=node.file_path,
            line_start=node.line_start,
            line_end=node.line_end,
            node_type=node.node_type,
            name=node.name,
            signature=node.signature,
            scope_chain=node.scope_chain,
            docstring=node.docstring,
            called_functions=node.called_functions,
            referenced_types=node.referenced_types,
            structural_context=structural_ctx,
            line_count=node.line_count,
        )

        block_nodes = self._get_block_children(node, parser)
        child_chunks = self._nodes_to_block_chunks(
            block_nodes, parent_id, structural_ctx
        )

        parent_chunk.child_ids = [c.chunk_id for c in child_chunks]
        return parent_chunk, child_chunks

    def split_huge_function(
        self, node: UnifiedASTNode, parser=None,
    ) -> tuple[Chunk, list[Chunk], list[Chunk]]:
        """1000+ 라인 함수를 부모 → 섹션 → 블록 3계층으로 분할한다."""
        parent_id = generate_chunk_id(
            node.file_path, node.line_start, node.line_end, node.name
        )
        structural_ctx = self._extract_structural_context(node)

        parent_chunk = Chunk(
            chunk_id=parent_id,
            parent_id=None,
            child_ids=[],
            level=ChunkLevel.FUNCTION,
            source_code=node.source_code,
            language=node.language,
            file_path=node.file_path,
            line_start=node.line_start,
            line_end=node.line_end,
            node_type=node.node_type,
            name=node.name,
            signature=node.signature,
            scope_chain=node.scope_chain,
            docstring=node.docstring,
            called_functions=node.called_functions,
            referenced_types=node.referenced_types,
            structural_context=structural_ctx,
            line_count=node.line_count,
        )

        block_nodes = self._get_block_children(node, parser)
        sections = self._group_into_sections(block_nodes, node)

        section_chunks: list[Chunk] = []
        all_block_chunks: list[Chunk] = []

        for section_name, section_nodes in sections:
            section_code = "\n".join(n.source_code for n in section_nodes)
            section_line_start = (
                section_nodes[0].line_start if section_nodes else node.line_start
            )
            section_line_end = (
                section_nodes[-1].line_end if section_nodes else node.line_end
            )
            section_id = generate_chunk_id(
                node.file_path,
                section_line_start,
                section_line_end,
                f"{node.name}:{section_name}",
            )

            section_chunk = Chunk(
                chunk_id=section_id,
                parent_id=parent_id,
                child_ids=[],
                level=ChunkLevel.SECTION,
                source_code=section_code,
                language=node.language,
                file_path=node.file_path,
                line_start=section_line_start,
                line_end=section_line_end,
                node_type=NodeType.BLOCK,
                name=f"{node.name}:{section_name}",
                signature=node.signature,
                scope_chain=node.scope_chain,
                docstring="",
                section_name=section_name,
                structural_context=structural_ctx,
                line_count=section_line_end - section_line_start + 1,
            )

            block_chunks = self._nodes_to_block_chunks(
                section_nodes, section_id, structural_ctx
            )
            section_chunk.child_ids = [c.chunk_id for c in block_chunks]

            section_chunks.append(section_chunk)
            all_block_chunks.extend(block_chunks)

        parent_chunk.child_ids = [s.chunk_id for s in section_chunks]
        return parent_chunk, section_chunks, all_block_chunks

    def _get_block_children(
        self, node: UnifiedASTNode, parser
    ) -> list[UnifiedASTNode]:
        """파서에서 블록 레벨 자식을 가져온다. 실패 시 라인 기반 폴백."""
        if parser is not None and hasattr(parser, "get_block_children"):
            children = parser.get_block_children(node)
            if children:
                return children
        return self._line_based_split(node)

    def _line_based_split(self, node: UnifiedASTNode) -> list[UnifiedASTNode]:
        """폴백: AST 블록 분할 실패 시 라인 수 기반 분할."""
        lines = node.source_code.split("\n")
        target_lines = 30
        blocks: list[UnifiedASTNode] = []
        offset = node.line_start

        for i in range(0, len(lines), target_lines):
            block_lines = lines[i : i + target_lines]
            code = "\n".join(block_lines)
            if not code.strip():
                continue

            blocks.append(
                UnifiedASTNode(
                    node_type=NodeType.BLOCK,
                    name=f"block@L{offset + i}",
                    signature="",
                    source_code=code,
                    file_path=node.file_path,
                    line_start=offset + i,
                    line_end=offset + i + len(block_lines) - 1,
                    byte_start=0,
                    byte_end=0,
                    language=node.language,
                    scope_chain=node.scope_chain,
                )
            )
        return blocks

    def _group_into_sections(
        self, block_nodes: list[UnifiedASTNode], parent: UnifiedASTNode
    ) -> list[tuple[str, list[UnifiedASTNode]]]:
        """1000+ 라인 함수의 블록 노드를 논리적 섹션으로 그룹핑한다."""
        if not block_nodes:
            return []

        target_section_lines = max(200, parent.line_count // 5)
        sections: list[tuple[str, list[UnifiedASTNode]]] = []
        current_nodes: list[UnifiedASTNode] = []
        current_lines = 0
        section_idx = 0

        section_labels = [
            "initialization",
            "main_logic",
            "processing",
            "error_handling",
            "cleanup",
            "finalization",
            "section_6",
            "section_7",
            "section_8",
            "section_9",
        ]

        for block in block_nodes:
            current_nodes.append(block)
            current_lines += block.line_count

            if current_lines >= target_section_lines:
                label = (
                    section_labels[section_idx]
                    if section_idx < len(section_labels)
                    else f"section_{section_idx}"
                )
                sections.append((label, current_nodes))
                current_nodes = []
                current_lines = 0
                section_idx += 1

        if current_nodes:
            if sections:
                if current_lines < target_section_lines // 2:
                    last_label, last_nodes = sections[-1]
                    sections[-1] = (last_label, last_nodes + current_nodes)
                else:
                    label = (
                        section_labels[section_idx]
                        if section_idx < len(section_labels)
                        else f"section_{section_idx}"
                    )
                    sections.append((label, current_nodes))
            else:
                sections.append(("main", current_nodes))

        return sections

    def _nodes_to_block_chunks(
        self,
        nodes: list[UnifiedASTNode],
        parent_id: str,
        structural_ctx: str,
    ) -> list[Chunk]:
        """블록 AST 노드를 Chunk로 변환하고 소형 인접 노드를 병합한다."""
        chunks: list[Chunk] = []
        buffer_nodes: list[UnifiedASTNode] = []
        buffer_chars = 0

        for node in nodes:
            char_count = node.non_whitespace_chars

            if (
                buffer_chars + char_count > CHUNK_SEARCH_BUDGET
                and buffer_nodes
            ):
                chunks.append(
                    self._merge_block_nodes(
                        buffer_nodes, parent_id, structural_ctx
                    )
                )
                buffer_nodes = []
                buffer_chars = 0

            buffer_nodes.append(node)
            buffer_chars += char_count

            if buffer_chars >= CHUNK_SEARCH_BUDGET:
                chunks.append(
                    self._merge_block_nodes(
                        buffer_nodes, parent_id, structural_ctx
                    )
                )
                buffer_nodes = []
                buffer_chars = 0

        if buffer_nodes:
            chunks.append(
                self._merge_block_nodes(buffer_nodes, parent_id, structural_ctx)
            )

        return chunks

    def _merge_block_nodes(
        self,
        nodes: list[UnifiedASTNode],
        parent_id: str,
        structural_ctx: str,
    ) -> Chunk:
        """하나 이상의 블록 노드를 단일 청크로 병합한다."""
        code = "\n".join(n.source_code for n in nodes)
        line_start = nodes[0].line_start
        line_end = nodes[-1].line_end
        name = (
            nodes[0].name
            if len(nodes) == 1
            else f"{nodes[0].name}..{nodes[-1].name}"
        )

        return Chunk(
            chunk_id=generate_chunk_id(
                nodes[0].file_path, line_start, line_end, name
            ),
            parent_id=parent_id,
            child_ids=[],
            level=ChunkLevel.BLOCK,
            source_code=code,
            language=nodes[0].language,
            file_path=nodes[0].file_path,
            line_start=line_start,
            line_end=line_end,
            node_type=NodeType.BLOCK,
            name=name,
            signature="",
            scope_chain=nodes[0].scope_chain,
            docstring="",
            structural_context=structural_ctx,
            line_count=line_end - line_start + 1,
        )

    def _extract_structural_context(self, func_node: UnifiedASTNode) -> str:
        """자식 블록에 프리펜드할 구조적 컨텍스트를 추출한다.

        포함 항목:
        - 함수 시그니처
        - 로컬 변수 선언 (본문 첫 ~10줄)
        - 파일 경로와 라인 범위
        """
        parts = [f"// CONTEXT: {func_node.signature}"]

        local_vars = self._extract_local_vars(func_node)
        if local_vars:
            parts.append(f"// LOCAL VARS: {local_vars}")

        parts.append(
            f"// FILE: {func_node.file_path} "
            f"[L{func_node.line_start}-L{func_node.line_end}, "
            f"{func_node.line_count} lines]"
        )

        return "\n".join(parts)

    def _extract_local_vars(self, func_node: UnifiedASTNode) -> str:
        """함수 본문에서 로컬 변수 선언을 추출한다."""
        lines = func_node.source_code.split("\n")
        var_decls: list[str] = []

        if func_node.language == "c":
            in_body = False
            for line in lines[:50]:
                stripped = line.strip()
                if stripped.startswith("{"):
                    in_body = True
                    continue
                if not in_body:
                    continue
                if re.match(
                    r"^\s*(int|char|void|long|short|unsigned|signed|float|double|"
                    r"struct|enum|union|const|static|volatile)\s+",
                    stripped,
                ):
                    var_decls.append(stripped.rstrip(";").strip())
                elif (
                    stripped
                    and not stripped.startswith("//")
                    and not stripped.startswith("/*")
                ):
                    if len(var_decls) > 0:
                        break

        elif func_node.language == "python":
            in_body = False
            for line in lines[:30]:
                stripped = line.strip()
                if stripped.endswith(":") and not in_body:
                    in_body = True
                    continue
                if not in_body:
                    continue
                if '"""' in stripped or "'''" in stripped:
                    continue
                match = re.match(r"^(\w+)\s*[=:]", stripped)
                if match:
                    var_decls.append(stripped.split("=")[0].strip())

        return "; ".join(var_decls[:10])
