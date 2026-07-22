"""
rag/chunker/ast_chunker.py — AST 기반 계층적 청킹 엔진

알고리즘: Recursive Split-then-Merge
1. 최상위 AST 노드 순회
2. 예산 초과 노드를 자식 노드로 재귀 분할
3. 인접한 소형 노드를 병합
4. 부모-자식 계층 구조 확립
"""

from __future__ import annotations

from rag.config import (
    CHUNK_AUTO_MERGE_RATIO,
    CHUNK_MIN_SIZE,
    CHUNK_SEARCH_BUDGET,
    HUGE_FUNCTION_THRESHOLD,
    LARGE_FUNCTION_THRESHOLD,
)
from rag.models import (
    Chunk,
    ChunkLevel,
    NodeType,
    UnifiedASTNode,
    generate_chunk_id,
)
from rag.chunker.large_function_splitter import LargeFunctionSplitter


class ASTChunker:
    """AST 기반 계층적 청킹 엔진."""

    def __init__(self) -> None:
        self._large_splitter = LargeFunctionSplitter()

    def chunk_file(
        self,
        nodes: list[UnifiedASTNode],
        file_path: str,
        parser=None,
    ) -> list[Chunk]:
        """최상위 AST 노드 목록을 계층적 청크로 변환한다."""
        chunks: list[Chunk] = []

        for node in nodes:
            if (
                self._is_function(node)
                and node.line_count >= HUGE_FUNCTION_THRESHOLD
            ):
                parent, sections, blocks = self._large_splitter.split_huge_function(
                    node, parser
                )
                chunks.append(parent)
                chunks.extend(sections)
                chunks.extend(blocks)
            elif (
                self._is_function(node)
                and node.line_count >= LARGE_FUNCTION_THRESHOLD
            ):
                parent, children = self._large_splitter.split_large_function(
                    node, parser
                )
                chunks.append(parent)
                chunks.extend(children)
            elif self._exceeds_budget(node):
                chunks.extend(self._recursive_split(node))
            else:
                chunks.append(
                    self._node_to_chunk(node, level=ChunkLevel.FUNCTION)
                )

        chunks = self._merge_small_siblings(chunks)
        return chunks

    def _recursive_split(self, node: UnifiedASTNode) -> list[Chunk]:
        """예산 초과 노드를 재귀적으로 분할한다."""
        if not self._exceeds_budget(node) or not node.children:
            return [self._node_to_chunk(node, level=ChunkLevel.FUNCTION)]

        chunks: list[Chunk] = []
        for child in node.children:
            if self._exceeds_budget(child):
                chunks.extend(self._recursive_split(child))
            else:
                chunks.append(self._node_to_chunk(child, level=ChunkLevel.BLOCK))
        return chunks

    def _merge_small_siblings(self, chunks: list[Chunk]) -> list[Chunk]:
        """인접한 소형 청크를 병합한다."""
        if len(chunks) <= 1:
            return chunks

        merged: list[Chunk] = []
        buffer: list[Chunk] = []
        buffer_size = 0

        for chunk in chunks:
            char_count = self._non_whitespace_count(chunk.source_code)

            if (
                chunk.level.value <= ChunkLevel.FUNCTION.value
                and char_count >= CHUNK_MIN_SIZE
            ):
                if buffer:
                    merged.append(self._merge_buffer(buffer))
                    buffer = []
                    buffer_size = 0
                merged.append(chunk)
                continue

            if buffer_size + char_count > CHUNK_SEARCH_BUDGET and buffer:
                merged.append(self._merge_buffer(buffer))
                buffer = []
                buffer_size = 0

            buffer.append(chunk)
            buffer_size += char_count

        if buffer:
            merged.append(self._merge_buffer(buffer))

        return merged

    def _merge_buffer(self, chunks: list[Chunk]) -> Chunk:
        """소형 청크 목록을 하나의 청크로 병합한다."""
        if len(chunks) == 1:
            return chunks[0]

        combined_code = "\n".join(c.source_code for c in chunks)
        names = [c.name for c in chunks[:3]]
        name = " + ".join(names) + (
            f" + {len(chunks) - 3} more" if len(chunks) > 3 else ""
        )

        return Chunk(
            chunk_id=generate_chunk_id(
                chunks[0].file_path,
                chunks[0].line_start,
                chunks[-1].line_end,
                name,
            ),
            parent_id=chunks[0].parent_id,
            child_ids=[],
            level=chunks[0].level,
            source_code=combined_code,
            language=chunks[0].language,
            file_path=chunks[0].file_path,
            line_start=chunks[0].line_start,
            line_end=chunks[-1].line_end,
            node_type=chunks[0].node_type,
            name=name,
            signature="",
            scope_chain=chunks[0].scope_chain,
            docstring="",
            called_functions=[fn for c in chunks for fn in c.called_functions],
            referenced_types=[t for c in chunks for t in c.referenced_types],
            includes_or_imports=[i for c in chunks for i in c.includes_or_imports],
            line_count=chunks[-1].line_end - chunks[0].line_start + 1,
        )

    def _node_to_chunk(
        self,
        node: UnifiedASTNode,
        level: ChunkLevel,
        parent_id: str | None = None,
        structural_context: str | None = None,
    ) -> Chunk:
        """UnifiedASTNode를 Chunk로 변환한다."""
        chunk_id = generate_chunk_id(
            node.file_path, node.line_start, node.line_end, node.name
        )
        return Chunk(
            chunk_id=chunk_id,
            parent_id=parent_id,
            child_ids=[],
            level=level,
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
            structural_context=structural_context,
            line_count=node.line_count,
        )

    def _exceeds_budget(self, node: UnifiedASTNode) -> bool:
        return node.non_whitespace_chars > CHUNK_SEARCH_BUDGET * 4

    def _is_function(self, node: UnifiedASTNode) -> bool:
        return node.node_type in (NodeType.FUNCTION, NodeType.METHOD)

    @staticmethod
    def _non_whitespace_count(text: str) -> int:
        return len(text.replace(" ", "").replace("\t", "").replace("\n", ""))
