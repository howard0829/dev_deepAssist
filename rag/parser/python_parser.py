"""
rag/parser/python_parser.py — Python 소스코드 파서 (tree-sitter 기반)

함수, 클래스, 메서드, 데코레이터, import 등을 AST에서 추출하여
UnifiedASTNode 트리로 변환한다.
"""

from __future__ import annotations

import re

import tree_sitter_python as tsp
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

PY_LANGUAGE = Language(tsp.language())

_NODE_TYPE_MAP: dict[str, NodeType] = {
    "function_definition": NodeType.FUNCTION,
    "class_definition": NodeType.CLASS,
    "decorated_definition": NodeType.DECORATOR,
    "import_statement": NodeType.IMPORT,
    "import_from_statement": NodeType.IMPORT,
    "expression_statement": NodeType.GLOBAL_VAR,
}

_BLOCK_SPLIT_TYPES: set[str] = {
    "if_statement",
    "for_statement",
    "while_statement",
    "with_statement",
    "try_statement",
    "match_statement",
}


class PythonParser(BaseParser):
    """Python 소스코드 파서 (tree-sitter-python 기반)."""

    def __init__(self) -> None:
        self._parser = Parser(PY_LANGUAGE)

    @property
    def language(self) -> str:
        return "python"

    @property
    def file_extensions(self) -> list[str]:
        return [".py"]

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
        self._collect_outline_entries(tree.root_node, source_text, entries, depth=0)

        return FileOutline(
            file_path=file_path,
            language="python",
            total_lines=total_lines,
            entries=entries,
        )

    def extract_dependencies(self, file_path: str) -> list[GraphEdge]:
        """import 관계와 함수 호출 관계를 추출한다."""
        source = self._read_file(file_path)
        tree = self._parser.parse(source)
        source_text = source.decode("utf-8", errors="replace")
        edges: list[GraphEdge] = []

        for child in tree.root_node.children:
            if child.type in ("import_statement", "import_from_statement"):
                module = self._extract_import_module(child, source_text)
                if module:
                    edges.append(
                        GraphEdge(
                            source=file_path,
                            target=module,
                            relation=RelationType.IMPORTS,
                            source_file=file_path,
                            line=child.start_point[0] + 1,
                        )
                    )

            actual = self._unwrap_decorated(child)
            if actual and actual.type == "function_definition":
                func_name = self._get_func_name(actual, source_text)
                if func_name:
                    call_names = self._extract_function_calls(actual, source_text)
                    for callee in call_names:
                        edges.append(
                            GraphEdge(
                                source=func_name,
                                target=callee,
                                relation=RelationType.CALLS,
                                source_file=file_path,
                            )
                        )

            if actual and actual.type == "class_definition":
                class_name = self._get_class_name(actual, source_text)
                body = actual.child_by_field_name("body")
                if class_name and body:
                    for member in body.children:
                        member_actual = self._unwrap_decorated(member)
                        if (
                            member_actual
                            and member_actual.type == "function_definition"
                        ):
                            method_name = self._get_func_name(
                                member_actual, source_text
                            )
                            if method_name:
                                edges.append(
                                    GraphEdge(
                                        source=f"{class_name}.{method_name}",
                                        target=class_name,
                                        relation=RelationType.MEMBER_OF,
                                        source_file=file_path,
                                    )
                                )

        return edges

    def get_block_children(self, node: UnifiedASTNode) -> list[UnifiedASTNode]:
        """함수 본문을 다시 파싱하여 블록 레벨 자식 노드를 추출한다."""
        source = node.source_code.encode("utf-8")
        tree = self._parser.parse(source)
        source_text = node.source_code

        func_node = self._find_first(tree.root_node, "function_definition")
        if func_node is None:
            return []
        body = func_node.child_by_field_name("body")
        if body is None:
            return []

        children: list[UnifiedASTNode] = []
        scope = (
            f"{node.scope_chain} > {node.name}" if node.scope_chain else node.name
        )
        offset_line = node.line_start - 1

        for child in body.children:
            code = source_text[child.start_byte : child.end_byte]
            if not code.strip():
                continue

            line_start = child.start_point[0] + 1 + offset_line
            line_end = child.end_point[0] + 1 + offset_line
            name = f"{child.type}@L{line_start}"

            children.append(
                UnifiedASTNode(
                    node_type=NodeType.BLOCK,
                    name=name,
                    signature="",
                    source_code=code,
                    file_path=node.file_path,
                    line_start=line_start,
                    line_end=line_end,
                    byte_start=child.start_byte,
                    byte_end=child.end_byte,
                    language="python",
                    scope_chain=scope,
                )
            )
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
        actual = self._unwrap_decorated(ts_node)
        if actual is None:
            node_type = _NODE_TYPE_MAP.get(ts_node.type)
            if node_type is None:
                return None
            actual = ts_node
        else:
            type_key = actual.type
            node_type = _NODE_TYPE_MAP.get(type_key)
            if node_type is None:
                return None

        use_node = ts_node

        code = source_text[use_node.start_byte : use_node.end_byte]
        name = self._get_node_name(actual, source_text, node_type)
        signature = self._get_signature(actual, source_text, node_type)
        line_start = use_node.start_point[0] + 1
        line_end = use_node.end_point[0] + 1
        docstring = self._extract_docstring(actual, source_text)
        decorators = (
            self._extract_decorators(ts_node, source_text)
            if ts_node != actual
            else []
        )

        preceding_comment = self._extract_preceding_comment_block(
            use_node, source_text
        )
        if preceding_comment:
            code = preceding_comment + "\n" + code
            comment_lines = preceding_comment.count("\n") + 1
            line_start = max(1, line_start - comment_lines)
            if not docstring:
                docstring = preceding_comment

        called = (
            self._extract_function_calls(actual, source_text)
            if node_type in (NodeType.FUNCTION, NodeType.CLASS)
            else []
        )

        sc = f"{scope_chain} > {name}" if scope_chain else name

        ast_node = UnifiedASTNode(
            node_type=node_type,
            name=name,
            signature=signature,
            source_code=code,
            file_path=file_path,
            line_start=line_start,
            line_end=line_end,
            byte_start=use_node.start_byte,
            byte_end=use_node.end_byte,
            language="python",
            docstring=docstring,
            called_functions=called,
            scope_chain=sc,
            decorators=decorators,
        )

        if node_type == NodeType.CLASS:
            body = actual.child_by_field_name("body")
            if body:
                for child in body.children:
                    child_node = self._convert_node(
                        child, file_path, source_text, lines, sc
                    )
                    if child_node is not None:
                        child_node.parent = ast_node
                        if child_node.node_type == NodeType.FUNCTION:
                            child_node.node_type = NodeType.METHOD
                        ast_node.children.append(child_node)

        return ast_node

    def _unwrap_decorated(self, ts_node: Node) -> Node | None:
        if ts_node.type == "decorated_definition":
            definition = ts_node.child_by_field_name("definition")
            return definition
        if ts_node.type in ("function_definition", "class_definition"):
            return ts_node
        return None

    def _get_node_name(
        self, ts_node: Node, source: str, node_type: NodeType
    ) -> str:
        if node_type in (NodeType.FUNCTION, NodeType.METHOD, NodeType.CLASS):
            name_node = ts_node.child_by_field_name("name")
            if name_node:
                return source[name_node.start_byte : name_node.end_byte]
        if node_type == NodeType.IMPORT:
            return source[ts_node.start_byte : ts_node.end_byte].strip()[:80]
        if node_type == NodeType.GLOBAL_VAR:
            code = source[ts_node.start_byte : ts_node.end_byte]
            match = re.match(r"(\w+)\s*=", code)
            if match:
                return match.group(1)
        return f"{node_type.value}@L{ts_node.start_point[0] + 1}"

    def _get_func_name(self, ts_node: Node, source: str) -> str | None:
        name_node = ts_node.child_by_field_name("name")
        if name_node:
            return source[name_node.start_byte : name_node.end_byte]
        return None

    def _get_class_name(self, ts_node: Node, source: str) -> str | None:
        name_node = ts_node.child_by_field_name("name")
        if name_node:
            return source[name_node.start_byte : name_node.end_byte]
        return None

    def _get_signature(
        self, ts_node: Node, source: str, node_type: NodeType
    ) -> str:
        if node_type in (NodeType.FUNCTION, NodeType.METHOD):
            body = ts_node.child_by_field_name("body")
            if body:
                sig = source[ts_node.start_byte : body.start_byte].rstrip().rstrip(":")
                return sig.strip()
            first_line = source[ts_node.start_byte : ts_node.end_byte].split("\n")[0]
            return first_line.strip()
        if node_type == NodeType.CLASS:
            body = ts_node.child_by_field_name("body")
            if body:
                sig = source[ts_node.start_byte : body.start_byte].rstrip().rstrip(":")
                return sig.strip()
            first_line = source[ts_node.start_byte : ts_node.end_byte].split("\n")[0]
            return first_line.strip()
        return source[ts_node.start_byte : ts_node.end_byte].split("\n")[0].strip()[
            :120
        ]

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

    def _extract_docstring(self, ts_node: Node, source: str) -> str:
        body = ts_node.child_by_field_name("body")
        if body is None:
            return ""
        for child in body.children:
            if child.type == "expression_statement":
                expr = child.children[0] if child.children else None
                if expr and expr.type == "string":
                    return source[expr.start_byte : expr.end_byte]
            elif child.type != "comment":
                break
        return ""

    def _extract_decorators(self, ts_node: Node, source: str) -> list[str]:
        decorators: list[str] = []
        if ts_node.type != "decorated_definition":
            return decorators
        for child in ts_node.children:
            if child.type == "decorator":
                decorators.append(
                    source[child.start_byte : child.end_byte].strip()
                )
        return decorators

    def _extract_import_module(self, ts_node: Node, source: str) -> str | None:
        if ts_node.type == "import_from_statement":
            module_node = ts_node.child_by_field_name("module_name")
            if module_node:
                return source[module_node.start_byte : module_node.end_byte]
        if ts_node.type == "import_statement":
            for child in ts_node.children:
                if child.type == "dotted_name":
                    return source[child.start_byte : child.end_byte]
        return None

    def _extract_function_calls(self, ts_node: Node, source: str) -> list[str]:
        calls: set[str] = set()
        self._walk_for_calls(ts_node, source, calls)
        return sorted(calls)

    def _walk_for_calls(
        self, node: Node, source: str, calls: set[str]
    ) -> None:
        if node.type == "call":
            func = node.child_by_field_name("function")
            if func:
                name = source[func.start_byte : func.end_byte]
                if re.match(r"^[a-zA-Z_][\w.]*$", name):
                    calls.add(name)
        for child in node.children:
            self._walk_for_calls(child, source, calls)

    def _collect_outline_entries(
        self, node: Node, source: str, entries: list[OutlineEntry], depth: int
    ) -> None:
        for child in node.children:
            actual = self._unwrap_decorated(child)
            if actual is None:
                continue
            node_type = _NODE_TYPE_MAP.get(actual.type)
            if node_type is None:
                continue
            if node_type in (NodeType.IMPORT, NodeType.GLOBAL_VAR):
                continue

            use_node = child
            name = self._get_node_name(actual, source, node_type)
            signature = self._get_signature(actual, source, node_type)
            prefix = "  " * depth

            entries.append(
                OutlineEntry(
                    node_type=node_type,
                    name=name,
                    signature=f"{prefix}{signature}",
                    line_start=use_node.start_point[0] + 1,
                    line_end=use_node.end_point[0] + 1,
                )
            )

            if node_type == NodeType.CLASS:
                body = actual.child_by_field_name("body")
                if body:
                    self._collect_outline_entries(body, source, entries, depth + 1)

    def _find_first(self, node: Node, type_name: str) -> Node | None:
        if node.type == type_name:
            return node
        for child in node.children:
            result = self._find_first(child, type_name)
            if result:
                return result
        return None
