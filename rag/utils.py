"""
rag/utils.py — 마크다운/코드 RAG 공유 유틸리티

BM25 전처리, 청크 문맥 추출 등 양쪽 RAG에서 사용하는 공통 함수.
"""

import logging
import re
from typing import List

from rag.constants import (
    _HEADER_RE, _TABLE_ROW_RE, _TABLE_SEP_RE,
    _REQ_ID_RE, _REQ_ID_EXCLUDE,
)

logger = logging.getLogger(__name__)


def bm25_preprocessor(text: str) -> str:
    """마크다운 BM25 전처리: 특수문자 제거, Requirement ID 하이픈 보존 후 소문자화.

    "TEL-6" → "tel-6" (하이픈 보존, 단일 토큰 유지)
    "NVMe-oF" → "nvme of" (일반 하이픈은 공백 치환)
    """
    # 1단계: Requirement ID 패턴의 하이픈을 임시 플레이스홀더로 치환
    processed = _REQ_ID_RE.sub(
        lambda m: m.group(0).replace('-', '\x00') if m.group(0) not in _REQ_ID_EXCLUDE else m.group(0),
        text,
    )
    # 2단계: 나머지 특수문자 제거
    processed = re.sub(r'[^a-zA-Z0-9가-힣\s\x00]', ' ', processed)
    # 3단계: 플레이스홀더를 하이픈으로 복원
    processed = processed.replace('\x00', '-')
    return processed.lower()


def _extract_chunk_context(page_content: str) -> str:
    """원본 청크에서 2차 분할 시 서브 청크에 주입할 구조적 문맥을 추출.

    추출 대상:
    - [source | 섹션: ...] 접두사
    - 마크다운 헤더 (# ~ ######)
    - 테이블 헤더행 + 구분선 (첫 번째 테이블만)
    """
    context_lines: List[str] = []
    lines = page_content.split('\n')
    table_header_found = False

    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith('[') and '섹션:' in stripped:
            context_lines.append(line)
            continue
        if _HEADER_RE.match(stripped):
            context_lines.append(line)
            continue
        if (not table_header_found
                and _TABLE_ROW_RE.match(stripped)
                and i + 1 < len(lines)
                and _TABLE_SEP_RE.match(lines[i + 1].strip())):
            context_lines.append(line)
            context_lines.append(lines[i + 1])
            table_header_found = True

    return '\n'.join(context_lines)
