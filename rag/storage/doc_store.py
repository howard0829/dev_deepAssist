"""
rag/storage/doc_store.py — 인메모리 문서 저장소

소스코드, 아웃라인, 메타데이터, 부모 매핑 등을 키-값 형태로 저장.
Redis 없이 동작하며, pickle로 디스크 영속화를 지원한다.
"""

from __future__ import annotations

import json
import os
import pickle
import tempfile


class DocStore:
    """인메모리 키-값 문서 저장소."""

    def __init__(self) -> None:
        self._data: dict[str, str] = {}

    # ── 소스코드 ──

    def set_code(self, chunk_id: str, code: str) -> None:
        self._data[f"code:{chunk_id}"] = code

    def get_code(self, chunk_id: str) -> str | None:
        return self._data.get(f"code:{chunk_id}")

    # ── 요약 ──

    def set_summary(self, chunk_id: str, summary: str) -> None:
        self._data[f"summary:{chunk_id}"] = summary

    def get_summary(self, chunk_id: str) -> str | None:
        return self._data.get(f"summary:{chunk_id}")

    # ── 파일 아웃라인 ──

    def set_outline(self, file_path: str, outline_text: str) -> None:
        self._data[f"outline:{file_path}"] = outline_text

    def get_outline(self, file_path: str) -> str | None:
        return self._data.get(f"outline:{file_path}")

    # ── 청크 메타데이터 ──

    def set_metadata(self, chunk_id: str, metadata: dict) -> None:
        self._data[f"meta:{chunk_id}"] = json.dumps(metadata)

    def get_metadata(self, chunk_id: str) -> dict | None:
        data = self._data.get(f"meta:{chunk_id}")
        return json.loads(data) if data else None

    # ── 섹션 정보 ──

    def set_sections(self, chunk_id: str, sections: list[dict]) -> None:
        self._data[f"sections:{chunk_id}"] = json.dumps(sections)

    def get_sections(self, chunk_id: str) -> list[dict] | None:
        data = self._data.get(f"sections:{chunk_id}")
        return json.loads(data) if data else None

    # ── 부모 매핑 ──

    def set_parent_mapping(self, child_id: str, parent_id: str) -> None:
        self._data[f"parent:{child_id}"] = parent_id

    def get_parent_id(self, child_id: str) -> str | None:
        return self._data.get(f"parent:{child_id}")

    # ── 영속화 ──

    def save(self, path: str) -> None:
        """디스크에 저장한다. atomic write — 도중 실패해도 기존 파일 보존."""
        dir_path = os.path.dirname(path)
        if dir_path:
            os.makedirs(dir_path, exist_ok=True)
        _dir = dir_path or "."
        _fd, _tmp = tempfile.mkstemp(dir=_dir, prefix=".doc.", suffix=".tmp")
        try:
            with os.fdopen(_fd, "wb") as f:
                pickle.dump(self._data, f)
            os.replace(_tmp, path)
        except BaseException:
            try:
                os.unlink(_tmp)
            except OSError:
                pass
            raise

    def load(self, path: str) -> None:
        """디스크에서 로드한다."""
        with open(path, "rb") as f:
            self._data = pickle.load(f)

    def clear(self) -> None:
        """저장소를 초기화한다."""
        self._data.clear()

    def stats(self) -> dict[str, int]:
        """접두사별 항목 수 통계를 반환한다."""
        prefixes: dict[str, int] = {}
        for key in self._data:
            prefix = key.split(":")[0]
            prefixes[prefix] = prefixes.get(prefix, 0) + 1
        return prefixes
