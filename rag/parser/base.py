"""
rag/parser/base.py — 언어 무관 파서 추상 인터페이스

모든 언어별 파서(PythonParser, CParser 등)가 구현해야 하는 공통 인터페이스.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from pathlib import Path

from rag.models import FileOutline, GraphEdge, UnifiedASTNode


class BaseParser(ABC):
    """언어별 소스코드 파서의 추상 기반 클래스."""

    @property
    @abstractmethod
    def language(self) -> str:
        """언어 식별자를 반환한다 (예: 'c', 'python')."""

    @property
    @abstractmethod
    def file_extensions(self) -> list[str]:
        """지원하는 파일 확장자 목록을 반환한다 (예: ['.c', '.h'])."""

    @abstractmethod
    def parse_file(self, file_path: str) -> list[UnifiedASTNode]:
        """파일을 파싱하여 최상위 AST 노드 목록을 반환한다."""

    @abstractmethod
    def get_file_outline(self, file_path: str) -> FileOutline:
        """파일의 구조 요약을 반환한다 (~500 토큰으로 100K 라인 파일도 커버)."""

    @abstractmethod
    def extract_dependencies(self, file_path: str) -> list[GraphEdge]:
        """의존성 관계(includes/imports, calls)를 추출한다."""

    def can_handle(self, file_path: str) -> bool:
        """이 파서가 해당 파일을 처리할 수 있는지 확인한다."""
        return Path(file_path).suffix in self.file_extensions

    def _read_file(self, file_path: str) -> bytes:
        """tree-sitter용 바이트 데이터로 파일을 읽는다."""
        with open(file_path, "rb") as f:
            return f.read()

    def _read_file_text(self, file_path: str) -> str:
        """텍스트로 파일을 읽는다."""
        with open(file_path, encoding="utf-8", errors="replace") as f:
            return f.read()
