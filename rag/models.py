"""
rag/models.py — 코드 RAG 핵심 데이터 모델

AST 노드, 청크, 그래프 엣지, 검색 결과, 파일 아웃라인 등
파서/청커/스토리지/리트리버 전반에서 공유하는 자료구조.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from enum import Enum


class NodeType(Enum):
    """AST 노드 유형."""
    FUNCTION = "function"
    CLASS = "class"
    STRUCT = "struct"
    ENUM = "enum"
    METHOD = "method"
    GLOBAL_VAR = "global_var"
    CONSTANT = "constant"
    IMPORT = "import"
    MACRO = "macro"
    CONDITIONAL_COMPILE = "conditional_compile"
    BLOCK = "block"
    DECORATOR = "decorator"
    TYPE_ALIAS = "type_alias"
    COMMENT = "comment"
    UNKNOWN = "unknown"


class RelationType(Enum):
    """그래프 엣지 관계 유형."""
    CALLS = "CALLS"
    INCLUDES = "INCLUDES"
    IMPORTS = "IMPORTS"
    DEFINED_IN = "DEFINED_IN"
    USES_TYPE = "USES_TYPE"
    MEMBER_OF = "MEMBER_OF"


class ChunkLevel(Enum):
    """청크 계층 레벨."""
    FILE = 2
    FUNCTION = 3
    SECTION = 35
    BLOCK = 4


def generate_chunk_id(file_path: str, line_start: int, line_end: int,
                      name: str) -> str:
    """파일 경로, 라인 범위, 이름 기반으로 고유 청크 ID를 생성한다."""
    raw = f"{file_path}:{line_start}-{line_end}:{name}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


@dataclass
class UnifiedASTNode:
    """언어 무관 통합 AST 노드."""
    node_type: NodeType
    name: str
    signature: str
    source_code: str
    file_path: str
    line_start: int
    line_end: int
    byte_start: int
    byte_end: int
    language: str

    children: list[UnifiedASTNode] = field(default_factory=list)
    parent: UnifiedASTNode | None = field(default=None, repr=False)
    docstring: str = ""
    called_functions: list[str] = field(default_factory=list)
    referenced_types: list[str] = field(default_factory=list)
    scope_chain: str = ""
    decorators: list[str] = field(default_factory=list)

    @property
    def line_count(self) -> int:
        return self.line_end - self.line_start + 1

    @property
    def non_whitespace_chars(self) -> int:
        return len(
            self.source_code.replace(" ", "").replace("\t", "").replace("\n", "")
        )


@dataclass
class Chunk:
    """계층적 코드 청크 — 파서/청커 출력, 인덱서/리트리버 입력."""
    chunk_id: str
    parent_id: str | None
    child_ids: list[str]
    level: ChunkLevel

    source_code: str
    language: str
    file_path: str
    line_start: int
    line_end: int

    node_type: NodeType
    name: str
    signature: str
    scope_chain: str
    docstring: str

    called_functions: list[str] = field(default_factory=list)
    referenced_types: list[str] = field(default_factory=list)
    includes_or_imports: list[str] = field(default_factory=list)
    corresponding_header: str | None = None
    structural_context: str | None = None
    section_name: str | None = None
    line_count: int = 0
    summary: str = ""

    @property
    def is_large_function(self) -> bool:
        return self.line_count >= 500

    @property
    def is_huge_function(self) -> bool:
        return self.line_count >= 1000

    def to_metadata(self) -> dict:
        """인덱싱/저장용 메타데이터 딕셔너리를 반환한다."""
        return {
            "chunk_id": self.chunk_id,
            "parent_id": self.parent_id,
            "level": self.level.value,
            "file_path": self.file_path,
            "language": self.language,
            "line_start": self.line_start,
            "line_end": self.line_end,
            "node_type": self.node_type.value,
            "name": self.name,
            "signature": self.signature,
            "scope_chain": self.scope_chain,
            "line_count": self.line_count,
            "is_large_function": self.is_large_function,
            "section_name": self.section_name,
        }


@dataclass
class GraphEdge:
    """코드 관계 그래프 엣지."""
    source: str
    target: str
    relation: RelationType
    source_file: str = ""
    line: int = 0


@dataclass
class SearchResult:
    """하이브리드 검색 결과."""
    chunk_id: str
    score: float
    chunk: Chunk | None = None
    source: str = ""


@dataclass
class FileOutline:
    """파일 구조 요약 (함수/클래스/구조체 목록)."""
    file_path: str
    language: str
    total_lines: int
    entries: list[OutlineEntry] = field(default_factory=list)

    def to_text(self) -> str:
        """사람이 읽을 수 있는 텍스트 형식으로 변환한다."""
        lines = [f"# {self.file_path} ({self.total_lines} lines, {self.language})"]
        for e in self.entries:
            mark = " *" if e.line_count >= 500 else ""
            lines.append(
                f"  [L{e.line_start}-L{e.line_end}]  {e.signature}"
                f"  ({e.line_count}L){mark}"
            )
        return "\n".join(lines)


@dataclass
class OutlineEntry:
    """파일 아웃라인의 개별 항목."""
    node_type: NodeType
    name: str
    signature: str
    line_start: int
    line_end: int

    @property
    def line_count(self) -> int:
        return self.line_end - self.line_start + 1
