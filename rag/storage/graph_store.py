"""
rag/storage/graph_store.py — 인메모리 코드 관계 그래프

Neo4j 없이 동작하는 인메모리 속성 그래프.
노드(Function, File, Struct, Class)와 엣지(CALLS, INCLUDES, IMPORTS,
DEFINED_IN, USES_TYPE, MEMBER_OF)를 저장하고 깊이 제한 순회를 지원한다.
"""

from __future__ import annotations

import os
import pickle
import tempfile
from collections import defaultdict

from rag.models import GraphEdge


class GraphStore:
    """인메모리 코드 관계 그래프 스토어."""

    def __init__(self) -> None:
        self._nodes: dict[str, dict[str, dict]] = defaultdict(dict)
        self._edges: set[tuple[str, str, str]] = set()
        self._outgoing: dict[str, list[tuple[str, str]]] = defaultdict(list)
        self._incoming: dict[str, list[tuple[str, str]]] = defaultdict(list)

    def add_function(
        self, name: str, file_path: str, signature: str,
        line_start: int, line_end: int, chunk_id: str,
        summary: str = "", language: str = "",
    ) -> None:
        """함수 노드를 추가한다."""
        self._nodes["Function"][name] = {
            "name": name, "file_path": file_path, "signature": signature,
            "line_start": line_start, "line_end": line_end,
            "chunk_id": chunk_id, "summary": summary, "language": language,
            "line_count": line_end - line_start + 1,
        }

    def add_file(self, path: str, language: str, line_count: int) -> None:
        """파일 노드를 추가한다."""
        self._nodes["File"][path] = {
            "path": path, "language": language, "line_count": line_count,
        }

    def add_struct(self, name: str, file_path: str, chunk_id: str) -> None:
        """구조체 노드를 추가한다."""
        self._nodes["Struct"][name] = {
            "name": name, "file_path": file_path, "chunk_id": chunk_id,
        }

    def add_class(self, name: str, file_path: str, chunk_id: str) -> None:
        """클래스 노드를 추가한다."""
        self._nodes["Class"][name] = {
            "name": name, "file_path": file_path, "chunk_id": chunk_id,
        }

    def add_edges(self, edges: list[GraphEdge]) -> None:
        """그래프 엣지를 추가한다 (중복 자동 제거)."""
        for edge in edges:
            key = (edge.source, edge.relation.value, edge.target)
            if key not in self._edges:
                self._edges.add(key)
                self._outgoing[edge.source].append(
                    (edge.relation.value, edge.target)
                )
                self._incoming[edge.target].append(
                    (edge.relation.value, edge.source)
                )

    def get_callees(self, function_name: str, depth: int = 1) -> list[dict]:
        """주어진 함수가 호출하는 함수 목록을 반환한다 (깊이 제한)."""
        visited: set[str] = set()
        results: list[dict] = []
        self._traverse_outgoing(function_name, "CALLS", depth, visited, results)
        return results

    def get_callers(self, function_name: str, depth: int = 1) -> list[dict]:
        """주어진 함수를 호출하는 함수 목록을 반환한다."""
        visited: set[str] = set()
        results: list[dict] = []
        self._traverse_incoming(function_name, "CALLS", depth, visited, results)
        return results

    def get_definition(self, symbol: str) -> dict | None:
        """심볼 정의를 검색한다."""
        for label in ("Function", "Struct", "Class", "Macro"):
            if symbol in self._nodes.get(label, {}):
                return self._nodes[label][symbol]
        return None

    def get_type_users(self, type_name: str) -> list[dict]:
        """주어진 타입을 사용하는 함수 목록을 반환한다."""
        results = []
        for rel, src in self._incoming.get(type_name, []):
            if rel == "USES_TYPE":
                func_info = self._nodes.get("Function", {}).get(src)
                if func_info:
                    results.append(func_info)
        return results

    def clear(self) -> None:
        """그래프를 초기화한다."""
        self._nodes.clear()
        self._edges.clear()
        self._outgoing.clear()
        self._incoming.clear()

    def save(self, path: str) -> None:
        """그래프를 디스크에 저장한다. atomic write — 도중 실패해도 기존 파일 보존."""
        dir_path = os.path.dirname(path)
        if dir_path:
            os.makedirs(dir_path, exist_ok=True)
        data = {
            "nodes": dict(self._nodes),
            "edges": list(self._edges),
        }
        _dir = dir_path or "."
        _fd, _tmp = tempfile.mkstemp(dir=_dir, prefix=".graph.", suffix=".tmp")
        try:
            with os.fdopen(_fd, "wb") as f:
                pickle.dump(data, f)
            os.replace(_tmp, path)
        except BaseException:
            try:
                os.unlink(_tmp)
            except OSError:
                pass
            raise

    def load(self, path: str) -> None:
        """디스크에서 그래프를 로드한다."""
        with open(path, "rb") as f:
            data = pickle.load(f)
        self._nodes = defaultdict(dict, data["nodes"])
        self._edges = set()
        self._outgoing = defaultdict(list)
        self._incoming = defaultdict(list)
        for src, rel, tgt in data["edges"]:
            self._edges.add((src, rel, tgt))
            self._outgoing[src].append((rel, tgt))
            self._incoming[tgt].append((rel, src))

    def stats(self) -> dict:
        """그래프 통계를 반환한다."""
        return {
            "nodes": {label: len(nodes) for label, nodes in self._nodes.items()},
            "edges": len(self._edges),
        }

    def _traverse_outgoing(
        self, name: str, rel_type: str, depth: int,
        visited: set[str], results: list[dict],
    ) -> None:
        if depth <= 0 or name in visited:
            return
        visited.add(name)
        for rel, tgt in self._outgoing.get(name, []):
            if rel == rel_type and tgt not in visited:
                info = self._nodes.get("Function", {}).get(tgt)
                if info:
                    results.append(info)
                self._traverse_outgoing(tgt, rel_type, depth - 1, visited, results)

    def _traverse_incoming(
        self, name: str, rel_type: str, depth: int,
        visited: set[str], results: list[dict],
    ) -> None:
        if depth <= 0 or name in visited:
            return
        visited.add(name)
        for rel, src in self._incoming.get(name, []):
            if rel == rel_type and src not in visited:
                info = self._nodes.get("Function", {}).get(src)
                if info:
                    results.append(info)
                self._traverse_incoming(src, rel_type, depth - 1, visited, results)
