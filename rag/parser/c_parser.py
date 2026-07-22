"""
rag/parser/c_parser.py — C/C++ 소스코드 파서 (tree-sitter 기반)

함수, 구조체, 열거형, 매크로, typedef 등을 AST에서 추출하여
UnifiedASTNode 트리로 변환한다. 선행 주석 블록을 포함시켜
함수 문서화 정보를 보존한다.
"""

from __future__ import annotations

import re

import tree_sitter_c as tsc
from tree_sitter import Language, Parser, Node

from rag.models import (
    FileOutline,
    GraphEdge,
    NodeType,
    OutlineEntry,
    RelationType,
    UnifiedASTNode,
)
from rag.parser.base import BaseParser

C_LANGUAGE = Language(tsc.language())

_NODE_TYPE_MAP: dict[str, NodeType] = {
    "function_definition": NodeType.FUNCTION,
    "struct_specifier": NodeType.STRUCT,
    "union_specifier": NodeType.STRUCT,
    "enum_specifier": NodeType.ENUM,
    "declaration": NodeType.GLOBAL_VAR,
    "type_definition": NodeType.TYPE_ALIAS,
    "preproc_function_def": NodeType.MACRO,
    "preproc_def": NodeType.MACRO,
    "preproc_ifdef": NodeType.CONDITIONAL_COMPILE,
    "preproc_if": NodeType.CONDITIONAL_COMPILE,
}

_BLOCK_SPLIT_TYPES: set[str] = {
    "if_statement",
    "for_statement",
    "while_statement",
    "do_statement",
    "switch_statement",
    "compound_statement",
}


class CParser(BaseParser):
    """C 소스코드 파서 (tree-sitter-c 기반)."""

    def __init__(self) -> None:
        self._parser = Parser(C_LANGUAGE)

    @property
    def language(self) -> str:
        return "c"

    @property
    def file_extensions(self) -> list[str]:
        return [".c", ".h"]

    def parse_file(self, file_path: str) -> list[UnifiedASTNode]:
        """파일을 파싱하여 최상위 AST 노드 목록을 반환한다."""
        source = self._read_file(file_path)
        tree = self._parser.parse(source)
        source_text = source.decode("utf-8", errors="replace")
        lines = source_text.split("\n")

        nodes: list[UnifiedASTNode] = []
        for child in tree.root_node.children:
            node = self._convert_node(
                child, file_path, source_text, lines, scope_chain=""
            )
            if node is not None:
                nodes.append(node)
        return nodes

    def get_file_outline(self, file_path: str) -> FileOutline:
        """파일의 구조 요약을 반환한다."""
        source = self._read_file(file_path)
        tree = self._parser.parse(source)
        source_text = source.decode("utf-8", errors="replace")
        total_lines = source_text.count("\n") + 1

        entries: list[OutlineEntry] = []
        for child in tree.root_node.children:
            entry = self._node_to_outline_entry(child, source_text)
            if entry is not None:
                entries.append(entry)

        return FileOutline(
            file_path=file_path,
            language="c",
            total_lines=total_lines,
            entries=entries,
        )

    def extract_dependencies(self, file_path: str) -> list[GraphEdge]:
        """#include 관계와 함수 호출 관계를 추출한다."""
        source = self._read_file(file_path)
        tree = self._parser.parse(source)
        source_text = source.decode("utf-8", errors="replace")
        edges: list[GraphEdge] = []

        for child in tree.root_node.children:
            if child.type == "preproc_include":
                path_node = child.child_by_field_name("path")
                if path_node:
                    include_path = source_text[
                        path_node.start_byte : path_node.end_byte
                    ]
                    include_path = include_path.strip('"<>')
                    edges.append(
                        GraphEdge(
                            source=file_path,
                            target=include_path,
                            relation=RelationType.INCLUDES,
                            source_file=file_path,
                            line=child.start_point[0] + 1,
                        )
                    )

            if child.type == "function_definition":
                func_name = self._get_function_name(child, source_text)
                if func_name:
                    call_names = self._extract_function_calls(child, source_text)
                    for callee in call_names:
                        edges.append(
                            GraphEdge(
                                source=func_name,
                                target=callee,
                                relation=RelationType.CALLS,
                                source_file=file_path,
                            )
                        )

        return edges

    def get_block_children(self, node: UnifiedASTNode) -> list[UnifiedASTNode]:
        """함수 본문을 다시 파싱하여 블록 레벨 자식 노드를 추출한다."""
        source = node.source_code.encode("utf-8")
        tree = self._parser.parse(source)
        root = tree.root_node

        func_node = self._find_first(root, "function_definition")
        if func_node is None:
            func_node = root
        body = func_node.child_by_field_name("body")
        if body is None:
            return []

        source_text = node.source_code
        lines = source_text.split("\n")
        children: list[UnifiedASTNode] = []

        for child in body.children:
            if child.type in ("{", "}"):
                continue
            block_node = self._convert_block_node(
                child,
                node.file_path,
                source_text,
                lines,
                scope_chain=(
                    f"{node.scope_chain} > {node.name}"
                    if node.scope_chain
                    else node.name
                ),
                offset_line=node.line_start - 1,
            )
            if block_node is not None:
                children.append(block_node)
        return children

    # ── Private helpers ──

    def _convert_node(
        self,
        ts_node: Node,
        file_path: str,
        source_text: str,
        lines: list[str],
        scope_chain: str,
    ) -> UnifiedASTNode | None:
        node_type = _NODE_TYPE_MAP.get(ts_node.type)
        if node_type is None:
            return None

        code = source_text[ts_node.start_byte : ts_node.end_byte]
        name = self._get_node_name(ts_node, source_text, node_type)
        signature = self._get_signature(ts_node, source_text, node_type)
        line_start = ts_node.start_point[0] + 1
        line_end = ts_node.end_point[0] + 1

        docstring = self._extract_preceding_comment_block(ts_node, source_text)
        if docstring:
            code = docstring + "\n" + code
            comment_lines = docstring.count("\n") + 1
            line_start = max(1, line_start - comment_lines)

        called = (
            self._extract_function_calls(ts_node, source_text)
            if node_type == NodeType.FUNCTION
            else []
        )
        ref_types = self._extract_type_references(ts_node, source_text)

        sc = f"{scope_chain} > {name}" if scope_chain else name
        ast_node = UnifiedASTNode(
            node_type=node_type,
            name=name,
            signature=signature,
            source_code=code,
            file_path=file_path,
            line_start=line_start,
            line_end=line_end,
            byte_start=ts_node.start_byte,
            byte_end=ts_node.end_byte,
            language="c",
            docstring=docstring,
            called_functions=called,
            referenced_types=ref_types,
            scope_chain=sc,
        )

        if node_type in (NodeType.STRUCT, NodeType.ENUM):
            for child in ts_node.children:
                child_node = self._convert_node(
                    child, file_path, source_text, lines, sc
                )
                if child_node is not None:
                    child_node.parent = ast_node
                    ast_node.children.append(child_node)

        return ast_node

    def _convert_block_node(
        self,
        ts_node: Node,
        file_path: str,
        source_text: str,
        lines: list[str],
        scope_chain: str,
        offset_line: int,
    ) -> UnifiedASTNode | None:
        code = source_text[ts_node.start_byte : ts_node.end_byte]
        if not code.strip():
            return None

        line_start = ts_node.start_point[0] + 1 + offset_line
        line_end = ts_node.end_point[0] + 1 + offset_line

        block_type = ts_node.type
        name = f"{block_type}@L{line_start}"

        return UnifiedASTNode(
            node_type=NodeType.BLOCK,
            name=name,
            signature="",
            source_code=code,
            file_path=file_path,
            line_start=line_start,
            line_end=line_end,
            byte_start=ts_node.start_byte,
            byte_end=ts_node.end_byte,
            language="c",
            scope_chain=scope_chain,
        )

    def _get_node_name(
        self, ts_node: Node, source: str, node_type: NodeType
    ) -> str:
        if node_type == NodeType.FUNCTION:
            return self._get_function_name(ts_node, source) or "anonymous"
        if node_type in (NodeType.STRUCT, NodeType.ENUM):
            name_node = ts_node.child_by_field_name("name")
            if name_node:
                return source[name_node.start_byte : name_node.end_byte]
        if node_type == NodeType.TYPE_ALIAS:
            declarator = ts_node.child_by_field_name("declarator")
            if declarator:
                return source[declarator.start_byte : declarator.end_byte]
        if node_type == NodeType.MACRO:
            name_node = ts_node.child_by_field_name("name")
            if name_node:
                return source[name_node.start_byte : name_node.end_byte]
        return f"{node_type.value}@L{ts_node.start_point[0] + 1}"

    def _get_function_name(self, ts_node: Node, source: str) -> str | None:
        declarator = ts_node.child_by_field_name("declarator")
        while declarator and declarator.type != "identifier":
            declarator = declarator.child_by_field_name("declarator")
            if declarator is None:
                for c in ts_node.children:
                    if c.type == "identifier":
                        return source[c.start_byte : c.end_byte]
                return None
        if declarator:
            return source[declarator.start_byte : declarator.end_byte]
        return None

    def _get_signature(
        self, ts_node: Node, source: str, node_type: NodeType
    ) -> str:
        if node_type == NodeType.FUNCTION:
            body = ts_node.child_by_field_name("body")
            if body:
                sig = source[ts_node.start_byte : body.start_byte].strip()
                return sig
            return source[ts_node.start_byte : ts_node.end_byte][:200]
        if node_type in (NodeType.STRUCT, NodeType.ENUM, NodeType.TYPE_ALIAS):
            first_line = source[ts_node.start_byte : ts_node.end_byte].split("\n")[0]
            return first_line.strip()
        if node_type == NodeType.MACRO:
            return (
                source[ts_node.start_byte : ts_node.end_byte].split("\n")[0].strip()
            )
        return ""

    def _extract_preceding_comment_block(
        self, ts_node: Node, source: str
    ) -> str:
        comments: list[str] = []
        prev = ts_node.prev_sibling
        while prev and prev.type == "comment":
            comments.append(source[prev.start_byte : prev.end_byte])
            prev = prev.prev_sibling
        if not comments:
            return ""
        comments.reverse()
        return "\n".join(comments)

    def _extract_function_calls(
        self, ts_node: Node, source: str
    ) -> list[str]:
        calls: set[str] = set()
        self._walk_for_calls(ts_node, source, calls)
        return sorted(calls)

    def _walk_for_calls(
        self, node: Node, source: str, calls: set[str]
    ) -> None:
        if node.type == "call_expression":
            func = node.child_by_field_name("function")
            if func:
                name = source[func.start_byte : func.end_byte]
                if re.match(r"^[a-zA-Z_]\w*$", name):
                    calls.add(name)
        for child in node.children:
            self._walk_for_calls(child, source, calls)

    def _extract_type_references(
        self, ts_node: Node, source: str
    ) -> list[str]:
        types: set[str] = set()
        self._walk_for_types(ts_node, source, types)
        return sorted(types)

    def _walk_for_types(
        self, node: Node, source: str, types: set[str]
    ) -> None:
        if node.type == "type_identifier":
            types.add(source[node.start_byte : node.end_byte])
        if node.type == "struct_specifier":
            name_node = node.child_by_field_name("name")
            if name_node:
                types.add(
                    "struct " + source[name_node.start_byte : name_node.end_byte]
                )
        for child in node.children:
            self._walk_for_types(child, source, types)

    def _node_to_outline_entry(
        self, ts_node: Node, source: str
    ) -> OutlineEntry | None:
        node_type = _NODE_TYPE_MAP.get(ts_node.type)
        if node_type is None:
            return None

        name = self._get_node_name(ts_node, source, node_type)
        signature = self._get_signature(ts_node, source, node_type)

        return OutlineEntry(
            node_type=node_type,
            name=name,
            signature=signature,
            line_start=ts_node.start_point[0] + 1,
            line_end=ts_node.end_point[0] + 1,
        )

    def _find_first(self, node: Node, type_name: str) -> Node | None:
        if node.type == type_name:
            return node
        for child in node.children:
            result = self._find_first(child, type_name)
            if result:
                return result
        return None
