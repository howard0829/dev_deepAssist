"""
rag/markdown.py — MarkdownRAG (마크다운 기술문서 전용 RAG)

헤더 경계 기반 구조적 청킹, Requirement ID/약어 용어 인덱스,
희귀 용어 직접 검색 + 앙상블 보충 전략을 제공한다.
"""

import logging
import os
import pickle
import re
import tempfile
from typing import List, Optional

from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_core.documents import Document
from tqdm import tqdm

from rag.base import BaseRAG, rerank_documents, _RERANKER_AVAILABLE
from rag.constants import (
    _HEADER_RE, _PAGE_RE, _TABLE_ROW_RE, _TABLE_SEP_RE,
    _REQ_ID_RE, _REQ_ID_EXCLUDE, _ABBR_DEF_RE,
)
from rag.utils import bm25_preprocessor, _extract_chunk_context

logger = logging.getLogger(__name__)


# ══════════════════════════════════════════════════════════════
# 마크다운 청킹 유틸리티
# ══════════════════════════════════════════════════════════════

def _find_content_start(lines: List[str], min_body_chars: int = 100) -> int:
    """목차(TOC) 등 프론트매터를 건너뛰고 실제 본문이 시작되는 라인 인덱스를 반환."""
    for i, line in enumerate(lines):
        if not _HEADER_RE.match(line.strip()):
            continue
        body_len = 0
        for j in range(i + 1, len(lines)):
            next_stripped = lines[j].strip()
            if _HEADER_RE.match(next_stripped):
                break
            if next_stripped == '---' or _PAGE_RE.search(next_stripped):
                continue
            body_len += len(next_stripped)
        if body_len >= min_body_chars:
            return i
    return 0


def _split_md_by_header_boundary(
    content: str,
    source: str,
    min_chunk_size: int = 1000,
    max_chunk_size: int = 3000,
) -> List[Document]:
    """마크다운을 헤더 경계 기준으로 분할.

    - 프론트매터 스킵, 라인별 누적, 헤더에서 청크 확정
    - max_chunk_size 초과 시 테이블 행 > 단락 경계로 2차 분할
    """
    raw_chunks: List[Document] = []
    current_lines: List[str] = []
    current_len: int = 0
    current_page: int = 1
    header_stack: dict = {}

    in_table: bool = False
    table_header_lines: List[str] = []

    def flush() -> None:
        nonlocal current_lines, current_len
        text = '\n'.join(current_lines).strip()
        text = re.sub(r'\n{3,}', '\n\n', text)
        if not text:
            current_lines = []
            current_len = 0
            return
        path_parts = [header_stack[lvl] for lvl in sorted(header_stack.keys())]
        section_path = " > ".join(path_parts)
        prefix = f"[{source} | 섹션: {section_path}]\n" if section_path else f"[{source}]\n"
        req_ids = sorted(set(_REQ_ID_RE.findall(text)) - _REQ_ID_EXCLUDE)
        abbr_matches = _ABBR_DEF_RE.findall(text)
        abbreviations = {abbr: full_name for full_name, abbr in abbr_matches}
        raw_chunks.append(Document(
            page_content=prefix + text,
            metadata={
                "source": source,
                "section": section_path,
                "page": current_page,
                "requirement_ids": req_ids,
                "abbreviations": abbreviations,
            },
        ))
        current_lines = []
        current_len = 0

    def update_header_stack(level: int, header_text: str) -> None:
        header_stack[level] = header_text
        for k in list(header_stack.keys()):
            if k > level:
                del header_stack[k]

    all_lines = content.split('\n')
    content_start = _find_content_start(all_lines)

    for line in all_lines[content_start:]:
        stripped = line.strip()

        page_m = _PAGE_RE.search(line)
        if page_m:
            current_page = int(page_m.group(1))
            continue

        if stripped == '---':
            continue

        if in_table and not stripped:
            continue

        # ── 테이블 구분선 ──
        if _TABLE_SEP_RE.match(stripped):
            new_col_count = stripped.count('|')
            if in_table and table_header_lines:
                existing_seps = [ln for ln in table_header_lines if _TABLE_SEP_RE.match(ln.strip())]
                existing_col_count = existing_seps[0].count('|') if existing_seps else 0
                if new_col_count == existing_col_count:
                    if current_lines and _TABLE_ROW_RE.match(current_lines[-1].strip()):
                        dup_line = current_lines.pop()
                        current_len -= len(dup_line) + 1
                    continue
                else:
                    current_lines.append(line)
                    current_len += len(line) + 1
                    continue

            in_table = True
            table_header_lines.clear()
            if current_lines and _TABLE_ROW_RE.match(current_lines[-1].strip()):
                table_header_lines.append(current_lines[-1])
            table_header_lines.append(line)
            current_lines.append(line)
            current_len += len(line) + 1
            continue

        # ── 테이블 데이터 행 ──
        if _TABLE_ROW_RE.match(stripped):
            if not in_table:
                current_lines.append(line)
                current_len += len(line) + 1
                continue
            current_lines.append(line)
            current_len += len(line) + 1
            continue

        if in_table and stripped and not stripped.startswith('|'):
            in_table = False
            table_header_lines.clear()

        # ── 마크다운 헤더 ──
        header_m = _HEADER_RE.match(line)
        if header_m and current_len >= min_chunk_size:
            flush()
            in_table = False
            table_header_lines.clear()
            level = len(header_m.group(1))
            update_header_stack(level, header_m.group(2).strip())
            current_lines = [line]
            current_len = len(line) + 1
        else:
            if header_m:
                level = len(header_m.group(1))
                update_header_stack(level, header_m.group(2).strip())
            current_lines.append(line)
            current_len += len(line) + 1

    flush()

    # 2차: max_chunk_size 초과 청크를 테이블 행 > 단락 경계로 재분할
    fallback_splitter = RecursiveCharacterTextSplitter(
        chunk_size=max_chunk_size,
        chunk_overlap=200,
        separators=[r"\n(?=\|)", "\n\n", "\n", " ", ""],
        is_separator_regex=True,
    )
    result: List[Document] = []
    for doc in raw_chunks:
        if len(doc.page_content) <= max_chunk_size:
            result.append(doc)
        else:
            sub_docs = fallback_splitter.split_documents([doc])
            context = _extract_chunk_context(doc.page_content)
            for i, sub_doc in enumerate(sub_docs):
                if i > 0 and context:
                    sub_doc.page_content = context + '\n' + sub_doc.page_content
                # 서브 청크의 실제 텍스트에서 requirement_ids 재추출
                sub_doc.metadata["requirement_ids"] = sorted(
                    set(_REQ_ID_RE.findall(sub_doc.page_content)) - _REQ_ID_EXCLUDE
                )
            result.extend(sub_docs)

    return result


# ══════════════════════════════════════════════════════════════
# MarkdownRAG
# ══════════════════════════════════════════════════════════════

class MarkdownRAG(BaseRAG):
    """FAISS + BM25 하이브리드 RAG (마크다운 기술문서 전용).

    헤더 경계 기반 구조적 청킹, Requirement ID/약어 용어 인덱스,
    희귀 용어 직접 검색 + 앙상블 보충 전략을 제공한다.
    """

    def __init__(self, db_store_path: str = "./knowledge_base",
                 doc_name: str = ""):
        super().__init__(db_store_path)
        self.term_index_path = os.path.join(self.db_store_path, "term_index.pkl")
        self.doc_meta_path = os.path.join(self.db_store_path, "doc_meta.pkl")
        self.term_index: dict = {}
        self.doc_name: str = doc_name

    def is_db_exists(self) -> bool:
        """FAISS DB, BM25 캐시, 용어 인덱스가 모두 존재하는지 확인"""
        return (os.path.exists(self.faiss_path)
                and os.path.exists(self.bm25_path)
                and os.path.exists(self.term_index_path))

    def load_db(self):
        """기존 구축된 DB 로드"""
        logger.info(f"📦 로컬에 구축된 DB를 '{self.db_store_path}'에서 로드 중...")
        self._load_vector_stores()
        with open(self.term_index_path, "rb") as f:
            self.term_index = pickle.load(f)
        if os.path.exists(self.doc_meta_path):
            with open(self.doc_meta_path, "rb") as f:
                meta = pickle.load(f)
                if not self.doc_name:
                    self.doc_name = meta.get("doc_name", "")
        self._setup_ensemble()
        display_name = self.doc_name or "(미지정)"
        logger.info(f"✅ DB 재로드 완료! (문서: {display_name}, "
                     f"용어 인덱스: {len(self.term_index)}종)")

    def build_db_from_files(self, file_paths: List[str]):
        """마크다운 파일 목록을 헤더 경계 기준 청킹 후 Vector DB와 BM25 구축"""
        logger.info(f"🔨 {len(file_paths)}개의 파일로 DB 구축 시작...")

        all_splits: List[Document] = []
        for path in tqdm(file_paths, desc="📄 마크다운 로딩", unit="file"):
            if not os.path.exists(path):
                logger.warning(f"⚠️ 경고: '{path}' 파일을 찾을 수 없습니다.")
                continue
            source = os.path.basename(path)
            with open(path, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
            splits = _split_md_by_header_boundary(content, source)
            all_splits.extend(splits)

        if not all_splits:
            raise ValueError("문서에서 추출된 텍스트가 없습니다. 유효한 마크다운 파일인지 확인하세요.")

        for doc in all_splits:
            doc.metadata["doc_name"] = self.doc_name

        self._save_vector_stores(all_splits, bm25_preprocessor)

        os.makedirs(self.db_store_path, exist_ok=True)

        # atomic write — doc_meta
        _dir = os.path.dirname(self.doc_meta_path) or "."
        _fd, _tmp = tempfile.mkstemp(dir=_dir, prefix=".meta.", suffix=".tmp")
        try:
            with os.fdopen(_fd, "wb") as f:
                pickle.dump({"doc_name": self.doc_name}, f)
            os.replace(_tmp, self.doc_meta_path)
        except BaseException:
            try:
                os.unlink(_tmp)
            except OSError:
                pass
            raise

        self.term_index = {}
        for doc in all_splits:
            for req_id in doc.metadata.get("requirement_ids", []):
                self.term_index.setdefault(req_id, []).append(doc)
            for abbr, full_name in doc.metadata.get("abbreviations", {}).items():
                self.term_index.setdefault(abbr, []).append(doc)
                self.term_index.setdefault(full_name.upper(), []).append(doc)

        # atomic write — term_index
        _dir = os.path.dirname(self.term_index_path) or "."
        _fd, _tmp = tempfile.mkstemp(dir=_dir, prefix=".term.", suffix=".tmp")
        try:
            with os.fdopen(_fd, "wb") as f:
                pickle.dump(self.term_index, f)
            os.replace(_tmp, self.term_index_path)
        except BaseException:
            try:
                os.unlink(_tmp)
            except OSError:
                pass
            raise

        self._setup_ensemble()
        logger.info(f"✅ DB 구축 완료! (청크: {len(all_splits)}, 용어 인덱스: {len(self.term_index)}종)")
        logger.info(f"   저장 경로: '{self.db_store_path}'")

    def build_or_load(self, source_path: str):
        """DB가 로컬에 있으면 즉시 로드, 없으면 source_path를 인덱싱하여 새로 구축"""
        if self.is_db_exists():
            self.load_db()
        else:
            self._build_from_source(source_path)

    def _build_from_source(self, source_path: str):
        """단일 .md 파일 또는 폴더 내 .md 파일들을 인덱싱하여 DB 구축"""
        source_path = os.path.abspath(os.path.expanduser(source_path))

        if not self.doc_name:
            self.doc_name = os.path.splitext(os.path.basename(source_path))[0]

        if os.path.isfile(source_path):
            self.build_db_from_files([source_path])
        elif os.path.isdir(source_path):
            exclude_dirs = {'.venv', 'venv', 'node_modules', '__pycache__', '.git',
                            '.claude', 'build', 'dist', '.vscode', '.idea'}
            files = []
            for root, dirs, filenames in os.walk(source_path):
                dirs[:] = [d for d in dirs if d not in exclude_dirs]
                for f in filenames:
                    if f.lower().endswith('.md'):
                        files.append(os.path.join(root, f))
            if not files:
                raise FileNotFoundError(f"'{source_path}' 내에 인덱싱할 .md 파일이 없습니다.")
            self.build_db_from_files(files)
        else:
            raise FileNotFoundError(f"'{source_path}' 파일 또는 폴더를 찾을 수 없습니다.")

    def _extract_terms(self, query: str) -> set:
        """쿼리에서 용어 인덱스와 매칭 가능한 키를 추출."""
        terms: set = set()
        upper_query = query.upper()
        terms.update(set(_REQ_ID_RE.findall(upper_query)) - _REQ_ID_EXCLUDE)
        for _, abbr in _ABBR_DEF_RE.findall(query):
            terms.add(abbr)
        for word in re.findall(r'\b([A-Z][A-Z0-9]{1,})\b', query):
            terms.add(word)
        for full_name in re.findall(r'([A-Z][a-z]+(?: [A-Z][a-z]+)+)', query):
            key = full_name.upper()
            if key in self.term_index:
                terms.add(key)
        return terms

    TERM_INDEX_MAX_HITS = 10

    # 키워드 직접 매칭 결과가 최종 top_k에서 차지할 최대 비율
    MAX_TERM_RATIO = 0.5

    def retrieve(self, query: str, top_k: int = 6) -> List[Document]:
        """하이브리드 검색: 희귀 용어 직접 매칭 상위 고정 + 앙상블 Rerank 보충."""
        if not self.ensemble_retriever:
            raise RuntimeError("검색할 DB가 로드되지 않았습니다. build_or_load()를 먼저 호출하세요.")

        # reranker 사용 시 후보를 넓게 가져와서 정제
        fetch_k = top_k * 2 if _RERANKER_AVAILABLE else top_k

        query_terms = self._extract_terms(query)
        rare_terms = {t for t in query_terms
                      if len(self.term_index.get(t, [])) <= self.TERM_INDEX_MAX_HITS}

        # ── 키워드 직접 매칭 (상위 고정 대상) ──
        pinned: List[Document] = []
        pinned_keys: set = set()
        if rare_terms:
            for term in rare_terms:
                for doc in self.term_index.get(term, []):
                    key = doc.page_content[:150]
                    if key not in pinned_keys:
                        doc.metadata["pinned"] = True
                        pinned.append(doc)
                        pinned_keys.add(key)

        # 키워드 매칭 상한 적용 (top_k의 절반까지, 초과 시 Reranker로 선별)
        term_limit = min(len(pinned), int(top_k * self.MAX_TERM_RATIO))
        if len(pinned) > term_limit:
            pinned = rerank_documents(query, pinned, term_limit)
        pinned_keys = {doc.page_content[:150] for doc in pinned}

        # ── Ensemble 검색 (pinned과 중복 제거) ──
        self.bm25_retriever.k = fetch_k
        self.vector_store.override_search_kwargs = {"k": fetch_k}
        ensemble_results = self.ensemble_retriever.invoke(query)
        ensemble_only = [doc for doc in ensemble_results
                         if doc.page_content[:150] not in pinned_keys]

        # ── Rerank: Ensemble 결과만 대상 ──
        remaining_k = top_k - len(pinned)
        reranked = rerank_documents(query, ensemble_only, remaining_k)

        return pinned + reranked
