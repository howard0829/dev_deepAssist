"""
rag/parser/language_registry.py — 파일 확장자 기반 파서 자동 선택

tree-sitter 파서가 설치되어 있으면 해당 파서를 사용하고,
미설치 시 빈 레지스트리로 graceful degradation (기존 regex 폴백 사용).
"""

from __future__ import annotations

import logging
from pathlib import Path

from rag.parser.base import BaseParser

logger = logging.getLogger(__name__)

# 제외할 디렉토리 패턴
_EXCLUDED_DIRS: set[str] = {
    "__pycache__", ".git", ".svn", ".hg", "node_modules", ".tox",
    ".mypy_cache", ".pytest_cache", "dist", "build", ".eggs",
    "venv", ".venv", "env", ".env",
}


def _load_parsers() -> list[BaseParser]:
    """사용 가능한 파서를 로드한다. tree-sitter 미설치 시 빈 목록 반환."""
    parsers: list[BaseParser] = []

    try:
        from rag.parser.python_parser import PythonParser
        parsers.append(PythonParser())
    except ImportError:
        logger.debug("tree-sitter-python 미설치, Python 파서 비활성화")

    try:
        from rag.parser.c_parser import CParser
        parsers.append(CParser())
    except ImportError:
        logger.debug("tree-sitter-c 미설치, C 파서 비활성화")

    return parsers


class LanguageRegistry:
    """파일 확장자 기반 언어별 파서 레지스트리."""

    def __init__(self) -> None:
        self._parsers: list[BaseParser] = _load_parsers()
        self._extension_map: dict[str, BaseParser] = {}
        for parser in self._parsers:
            for ext in parser.file_extensions:
                self._extension_map[ext] = parser

    def get_parser(self, file_path: str) -> BaseParser | None:
        """파일에 적합한 파서를 반환한다."""
        ext = Path(file_path).suffix
        return self._extension_map.get(ext)

    def can_handle(self, file_path: str) -> bool:
        """이 레지스트리에 파일을 처리할 수 있는 파서가 있는지 확인한다."""
        return self.get_parser(file_path) is not None

    def supported_extensions(self) -> list[str]:
        """지원하는 모든 파일 확장자 목록을 반환한다."""
        return list(self._extension_map.keys())

    @property
    def available(self) -> bool:
        """tree-sitter 파서가 하나라도 사용 가능한지 반환한다."""
        return len(self._parsers) > 0

    def collect_files(self, root_dir: str) -> list[str]:
        """디렉토리에서 지원하는 모든 소스 파일을 재귀적으로 수집한다."""
        root = Path(root_dir)
        files: list[str] = []
        for ext in self._extension_map:
            for p in root.rglob(f"*{ext}"):
                if not any(part in _EXCLUDED_DIRS for part in p.parts):
                    files.append(str(p))
        return sorted(files)
