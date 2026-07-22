"""
Knowledge 검색 핵심 로직 — DB 검색, 웹 검색/스크래핑

MCP 어댑터(mcp/server.py)와 Tool 어댑터(tools/knowledge_tools.py)가
이 모듈의 함수를 공유하여 호출합니다. 비즈니스 로직은 이 파일에만 존재합니다.
"""

import hashlib
import logging
import os
import pickle
import random
import re
from typing import Dict, List

from langchain_core.documents import Document

from rag.config import KNOWLEDGE_BASE_DIR

logger = logging.getLogger(__name__)

# RAG 인스턴스 글로벌 캐시 (동일 DB를 반복 로드하지 않도록)
_rag_cache: Dict[str, "BaseRAG"] = {}


# ──────────────────────────────────────────────
# 내부 헬퍼
# ──────────────────────────────────────────────

def _safe_pickle_load(path: str) -> dict:
    """pickle 파일을 안전하게 로드. 실패 시 빈 딕셔너리 반환."""
    try:
        with open(path, "rb") as f:
            return pickle.load(f)
    except (FileNotFoundError, pickle.UnpicklingError, EOFError, ModuleNotFoundError) as e:
        logger.warning(f"pickle 로드 실패 ({path}): {e}")
        return {}
    except Exception as e:
        logger.warning(f"pickle 로드 중 예상치 못한 오류 ({path}): {e}")
        return {}


def _auto_db_path(source_path: str) -> str:
    """source_path의 기반 이름 + MD5 앞 8자리로 고유한 DB 경로를 자동 결정"""
    abs_path = os.path.abspath(os.path.expanduser(source_path))
    basename = os.path.splitext(os.path.basename(abs_path))[0]
    hash8 = hashlib.md5(abs_path.encode()).hexdigest()[:8]
    return os.path.expanduser(f"~/.deepassist/knowledge/{basename}_{hash8}")


def _rrf_merge(results_per_db: List[List[Document]], top_k: int, k: int = 60) -> List[Document]:
    """Reciprocal Rank Fusion으로 여러 DB의 검색 결과를 병합"""
    scores: dict = {}
    docs_map: dict = {}

    for results in results_per_db:
        for rank, doc in enumerate(results):
            key = doc.page_content[:150]
            scores[key] = scores.get(key, 0.0) + 1.0 / (k + rank + 1)
            docs_map[key] = doc

    sorted_keys = sorted(scores, key=lambda x: scores[x], reverse=True)
    return [docs_map[key] for key in sorted_keys[:top_k]]


def _detect_rag_type(db_path: str) -> str:
    """DB 경로 내 인덱스 파일로 RAG 유형(markdown/code) 자동 감지"""
    if os.path.exists(os.path.join(db_path, "symbol_index.pkl")):
        return "code"
    return "markdown"


def _detect_source_type(source_path: str) -> str:
    """소스 경로의 파일 확장자 분포로 RAG 유형 자동 결정"""
    code_exts = {'.py', '.c', '.cpp', '.h', '.hpp', '.cc', '.java', '.js', '.ts'}
    md_exts = {'.md'}

    source_path = os.path.abspath(os.path.expanduser(source_path))
    if os.path.isfile(source_path):
        ext = os.path.splitext(source_path)[1].lower()
        return "code" if ext in code_exts else "markdown"

    code_count = 0
    md_count = 0
    for root, dirs, filenames in os.walk(source_path):
        dirs[:] = [d for d in dirs if d not in {'.venv', 'venv', 'node_modules', '__pycache__', '.git', 'build', 'dist'}]
        for f in filenames:
            ext = os.path.splitext(f)[1].lower()
            if ext in code_exts:
                code_count += 1
            elif ext in md_exts:
                md_count += 1

    if code_count > 0 and md_count == 0:
        return "code"
    elif md_count > 0 and code_count == 0:
        return "markdown"
    elif code_count > md_count:
        return "code"
    return "markdown"


def _load_and_search(db_path: str, query: str, top_k: int) -> List[Document]:
    """단일 DB를 로드하고 검색 결과를 반환. DB가 없으면 빈 리스트."""
    from rag import MarkdownRAG, CodeRAG

    db_path = os.path.abspath(os.path.expanduser(db_path))

    if db_path in _rag_cache:
        return _rag_cache[db_path].retrieve(query, top_k=top_k)

    rag_type = _detect_rag_type(db_path)

    if rag_type == "code":
        rag = CodeRAG(db_store_path=db_path)
    else:
        rag = MarkdownRAG(db_store_path=db_path)

    if not rag.is_db_exists():
        return []
    rag.load_db()
    _rag_cache[db_path] = rag
    return rag.retrieve(query, top_k=top_k)


def _format_results(docs: List[Document]) -> str:
    """검색 결과 Document 리스트를 읽기 쉬운 문자열로 포맷팅"""
    output = []
    for i, doc in enumerate(docs):
        meta = doc.metadata
        source = meta.get("source", "Unknown")
        chunk_type = meta.get("chunk_type", "")

        if chunk_type in ("file_summary", "function", "class", "subchunk", "declarations"):
            # 코드 RAG 결과
            language = meta.get("language", "")
            hierarchy = meta.get("hierarchy", "")
            signature = meta.get("signature", "")
            line_range = meta.get("line_range", "")
            req_ids = meta.get("requirement_ids", [])

            project = meta.get("project", "")
            header_parts = [f"[결과 {i+1}]"]
            if project:
                header_parts.append(f"프로젝트: {project}")
            header_parts.append(f"파일: {source}")
            if language:
                header_parts.append(f"언어: {language}")
            if chunk_type:
                header_parts.append(f"유형: {chunk_type}")
            if line_range:
                header_parts.append(f"라인: {line_range[0]}-{line_range[1]}")
            if hierarchy:
                header_parts.append(f"계층: {hierarchy}")
            if req_ids:
                header_parts.append(f"Req IDs: {', '.join(req_ids[:10])}")
            header = " | ".join(header_parts)
            if signature and chunk_type != "file_summary":
                header += f"\n  시그니처: {signature}"
        else:
            # 마크다운 RAG 결과
            doc_name = meta.get("doc_name", "")
            section = meta.get("section", meta.get("Header 2", "N/A"))
            page = meta.get("page", "")
            doc_info = f"문서: {doc_name} | " if doc_name else ""
            page_info = f" | 페이지: {page}" if page else ""
            header = f"[결과 {i+1}] {doc_info}파일: {source} | 섹션: {section}{page_info}"

        output.append(f"{header}\n{doc.page_content.strip()}")
    return ("\n" + "-"*50 + "\n").join(output)


def _keyword_in_query(kw: str, query_lower: str) -> bool:
    """키워드가 쿼리에 독립 토큰으로 포함되는지 확인 (서브스트링 오매칭 방지)"""
    start = 0
    while True:
        idx = query_lower.find(kw, start)
        if idx == -1:
            return False
        if idx > 0:
            ch = query_lower[idx - 1]
            if ch.isascii() and ch.isalnum():
                start = idx + 1
                continue
        end = idx + len(kw)
        if end < len(query_lower):
            ch = query_lower[end]
            if ch.isascii() and ch.isalnum():
                start = idx + 1
                continue
        return True


def _match_dbs_by_query(query: str, all_dbs: List[dict]) -> List[dict]:
    """쿼리 텍스트에서 DB명/폴더명과 매칭되는 DB를 선별"""
    query_lower = query.lower()

    db_keywords: List[tuple] = []
    for db in all_dbs:
        db_name = db.get("name", "")
        keywords: List[str] = []

        full_name = re.sub(r'[^a-zA-Z0-9]', '', db_name).lower()
        if len(full_name) >= 2:
            keywords.append(full_name)

        alnum_tokens = re.findall(r'[a-zA-Z0-9]{2,}', db_name)
        keywords.extend([t.lower() for t in alnum_tokens])

        alpha_tokens = re.findall(r'[a-zA-Z]{2,}', db_name)
        keywords.extend([t.lower() for t in alpha_tokens])

        folder_name = os.path.basename(db.get("path", ""))
        folder_base = folder_name.rsplit("_", 1)[0] if "_" in folder_name else folder_name
        folder_alnum = re.findall(r'[a-zA-Z0-9]{2,}', folder_base)
        keywords.extend([t.lower() for t in folder_alnum])

        keywords = sorted(set(keywords), key=len, reverse=True)
        db_keywords.append((db, keywords))

    matched: List[dict] = []
    for db, keywords in db_keywords:
        for kw in keywords:
            if _keyword_in_query(kw, query_lower):
                matched.append(db)
                break

    return matched


def _list_all_dbs() -> List[dict]:
    """구축된 모든 knowledge DB 목록을 반환"""
    base_dir = KNOWLEDGE_BASE_DIR
    if not os.path.exists(base_dir):
        return []

    dbs = []
    for entry in sorted(os.listdir(base_dir)):
        db_path = os.path.join(base_dir, entry)
        if not os.path.isdir(db_path):
            continue
        if not os.path.exists(os.path.join(db_path, "faiss_index")):
            continue

        db_info = {"path": db_path, "type": "unknown", "name": entry}

        project_meta_path = os.path.join(db_path, "project_meta.pkl")
        if os.path.exists(project_meta_path):
            meta = _safe_pickle_load(project_meta_path)
            db_info["type"] = "code"
            db_info["name"] = meta.get("project_name", entry)
            db_info["project_root"] = meta.get("project_root", "")

        doc_meta_path = os.path.join(db_path, "doc_meta.pkl")
        if os.path.exists(doc_meta_path):
            meta = _safe_pickle_load(doc_meta_path)
            db_info["type"] = "markdown"
            db_info["name"] = meta.get("doc_name", entry)

        dbs.append(db_info)

    return dbs


# ──────────────────────────────────────────────
# 공개 API — MCP 어댑터와 Tool 어댑터가 공유
# ──────────────────────────────────────────────

def build_knowledge_db(source_path: str, db_path: str = "", force_rebuild: bool = False) -> str:
    """파일/폴더를 청킹·임베딩하여 Vector DB를 구축하고 디스크에 저장"""
    from rag import MarkdownRAG, CodeRAG

    resolved_db_path = db_path.strip() if db_path.strip() else _auto_db_path(source_path)
    resolved_db_path = os.path.abspath(os.path.expanduser(resolved_db_path))

    try:
        src_type = _detect_source_type(source_path)

        if src_type == "code":
            rag = CodeRAG(db_store_path=resolved_db_path)
        else:
            rag = MarkdownRAG(db_store_path=resolved_db_path)

        if rag.is_db_exists() and not force_rebuild:
            return f"✅ 기존 DB 재사용 ({src_type}): {resolved_db_path}\n(재구축하려면 force_rebuild=True 로 호출하세요)"

        rag._build_from_source(source_path)
        return f"✅ DB 구축 완료 ({src_type}): {resolved_db_path}"

    except Exception as e:
        return f"❌ DB 구축 중 오류가 발생했습니다: {e}"


def list_knowledge_dbs() -> str:
    """구축된 모든 Knowledge DB 목록을 문자열로 반환"""
    dbs = _list_all_dbs()
    if not dbs:
        return "❌ 구축된 Knowledge DB가 없습니다.\nbuild_knowledge_db()로 먼저 DB를 구축하세요."

    lines = [f"📚 구축된 Knowledge DB 목록 ({len(dbs)}개):", ""]
    for i, db in enumerate(dbs, 1):
        db_type = db['type'].upper()
        name = db['name']
        path = db['path']
        extra = ""
        if db.get("project_root"):
            extra = f"\n     소스: {db['project_root']}"
        lines.append(f"  {i}. [{db_type}] {name}")
        lines.append(f"     경로: {path}{extra}")

    lines.append("")
    lines.append("💡 검색 시 db_path에 위 경로를 지정하세요.")
    lines.append("   여러 DB 동시 검색: db_path=\"경로1,경로2\"")
    return "\n".join(lines)


def search_knowledge(query: str, db_path: str = "", top_k: int = 6) -> str:
    """Knowledge DB(FAISS + BM25 하이브리드)에서 기술 문서를 검색"""
    if db_path.strip():
        db_paths = [p.strip() for p in db_path.split(",") if p.strip()]
    else:
        all_dbs = _list_all_dbs()
        if not all_dbs:
            return ("❌ 구축된 Knowledge DB가 없습니다.\n"
                    "build_knowledge_db(source_path)로 먼저 DB를 구축하세요.")

        matched_dbs = _match_dbs_by_query(query, all_dbs)
        if matched_dbs:
            db_paths = [db["path"] for db in matched_dbs]
        else:
            db_paths = [db["path"] for db in all_dbs]

    try:
        if len(db_paths) == 1:
            docs = _load_and_search(db_paths[0], query, top_k)
            if not docs:
                return f"❌ DB에서 관련 문서를 찾을 수 없습니다. (DB 경로: {db_paths[0]})\nbuild_knowledge_db()로 먼저 DB를 구축했는지 확인하세요."
            return _format_results(docs)

        else:
            results_per_db: List[List[Document]] = []
            missing = []

            for path in db_paths:
                results = _load_and_search(path, query, top_k)
                if results:
                    results_per_db.append(results)
                else:
                    missing.append(path)

            if not results_per_db:
                return f"❌ 지정된 DB({', '.join(db_paths)}) 모두에서 결과를 찾지 못했습니다."

            merged = _rrf_merge(results_per_db, top_k)
            header = f"🔍 {len(db_paths)}개 DB Fan-out 검색 | RRF 통합 결과 (top {top_k})"
            if missing:
                header += f"\n⚠️ DB 없음(건너뜀): {', '.join(missing)}"

            return header + "\n" + "="*50 + "\n" + _format_results(merged)

    except Exception as e:
        return f"❌ 문서 검색 중 오류가 발생했습니다: {e}"


def search_knowledge_docs(query: str, db_path: str = "", top_k: int = 6) -> List[Document]:
    """Knowledge DB에서 검색하여 Document 리스트를 반환한다.

    search_knowledge()와 동일한 검색 로직이지만 포맷팅 없이 Document 객체를
    그대로 반환한다. metadata에 pinned, rerank_score 등이 포함되어 있어
    호출자가 관련성 판단에 활용할 수 있다.
    """
    if db_path.strip():
        db_paths = [p.strip() for p in db_path.split(",") if p.strip()]
    else:
        all_dbs = _list_all_dbs()
        if not all_dbs:
            return []

        matched_dbs = _match_dbs_by_query(query, all_dbs)
        if matched_dbs:
            db_paths = [db["path"] for db in matched_dbs]
        else:
            db_paths = [db["path"] for db in all_dbs]

    try:
        if len(db_paths) == 1:
            return _load_and_search(db_paths[0], query, top_k)
        else:
            results_per_db: List[List[Document]] = []
            for path in db_paths:
                results = _load_and_search(path, query, top_k)
                if results:
                    results_per_db.append(results)
            if not results_per_db:
                return []
            return _rrf_merge(results_per_db, top_k)
    except Exception:
        return []


def _get_random_headers() -> dict:
    """봇 차단 우회를 위한 브라우저 유사 헤더 + UA 로테이션"""
    _USER_AGENTS = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    ]
    return {
        "User-Agent": random.choice(_USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip, deflate, br",
        "DNT": "1",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Cache-Control": "max-age=0",
    }


def _scrape_with_trafilatura(url: str, timeout: int = 10) -> str:
    """trafilatura를 사용한 본문 추출 (requests 실패 시 fallback)"""
    try:
        import trafilatura
    except ImportError:
        return ""

    try:
        downloaded = trafilatura.fetch_url(url)
        if not downloaded:
            return ""
        text = trafilatura.extract(
            downloaded,
            include_comments=False,
            include_tables=True,
            favor_recall=True,
        )
        return text or ""
    except Exception as e:
        logger.debug(f"trafilatura 추출 실패 ({url}): {e}")
        return ""


def _scrape_url(url: str, session) -> str:
    """URL 본문 추출: requests+BeautifulSoup → trafilatura fallback 순서로 시도"""
    from bs4 import BeautifulSoup

    text = ""

    # 1차: requests + BeautifulSoup (랜덤 헤더)
    try:
        resp = session.get(url, headers=_get_random_headers(), timeout=10)
        if resp.status_code == 200:
            soup = BeautifulSoup(resp.text, "html.parser")
            for tag in soup(["script", "style", "header", "footer", "nav", "aside", "iframe", "svg"]):
                tag.extract()
            text = " ".join(soup.get_text(separator=" ", strip=True).split())
    except Exception as e:
        logger.debug(f"requests 스크래핑 실패 ({url}): {e}")

    # 본문이 너무 짧으면 실패로 간주 (광고/차단 페이지일 가능성)
    if len(text) < 200:
        # 2차: trafilatura fallback
        traf_text = _scrape_with_trafilatura(url)
        if len(traf_text) > len(text):
            text = traf_text

    return text


def search_web_and_scrape(query: str, max_results: int = 2) -> str:
    """DuckDuckGo 웹 검색 후 상위 페이지 본문을 스크래핑하여 반환.

    스크래핑 전략:
      1차) requests + BeautifulSoup (UA 로테이션 + 브라우저 유사 헤더)
      2차) trafilatura fallback (1차 실패 또는 본문 200자 미만 시)

    DuckDuckGo 레이트 리밋(HTTP 202/차단) 발생 시 지수 백오프로 최대 3회 재시도.
    환경변수 SEARCH_PROXY로 프록시 설정 가능 (예: socks5://host:port).
    """
    try:
        import time as _time
        import requests as _requests
        from bs4 import BeautifulSoup
        from duckduckgo_search import DDGS
    except ImportError as e:
        return (
            f"⛔ SearchWeb 도구를 사용할 수 없습니다 — 필수 패키지 미설치: {e}\n"
            "이 도구 없이 작업을 계속하세요. pip install로 해결할 수 없는 서버 환경 문제입니다."
        )

    try:
        # 프록시 지원 (환경변수 SEARCH_PROXY)
        proxy = os.getenv("SEARCH_PROXY", "")
        ddgs_kwargs = {}
        if proxy:
            ddgs_kwargs["proxy"] = proxy

        # DuckDuckGo 레이트 리밋 대응: 지수 백오프 재시도
        results = None
        last_error = None
        for attempt in range(3):
            try:
                results = DDGS(**ddgs_kwargs).text(query, max_results=max_results + 3)
                if results:
                    break
            except Exception as e:
                last_error = e
                err_str = str(e).lower()
                # 레이트 리밋 또는 None 반환 → 대기 후 재시도
                if "ratelimit" in err_str or "return none" in err_str or "202" in err_str:
                    wait = 2 ** attempt  # 1, 2, 4초
                    logger.warning(f"DuckDuckGo 레이트 리밋 감지 — {wait}초 대기 후 재시도 ({attempt + 1}/3)")
                    _time.sleep(wait)
                    continue
                raise  # 레이트 리밋이 아닌 오류는 바로 전파

        if not results:
            if last_error:
                return (
                    f"❌ DuckDuckGo 검색이 레이트 리밋에 의해 차단되었습니다.\n"
                    f"   원인: DuckDuckGo가 자동화 요청을 감지하여 응답을 거부함\n"
                    f"   오류: {last_error}\n\n"
                    f"해결 방법:\n"
                    f"  1. 잠시 후 다시 시도 (보통 1-2분 후 해제)\n"
                    f"  2. 환경변수 SEARCH_PROXY에 프록시 설정 (예: socks5://host:port)\n"
                    f"  3. 이 도구 없이 기존 지식으로 답변을 진행하세요."
                )
            return "❌ 검색 결과가 없습니다."

        # requests 세션 재사용 (TCP 커넥션 풀링)
        session = _requests.Session()

        scraped_texts = []
        success_count = 0

        for res in results:
            if success_count >= max_results:
                break

            href = res.get("href") or res.get("url")
            if not href:
                continue
            title = res.get("title", "제목 없음")

            text = _scrape_url(href, session)

            if len(text) >= 200:
                if len(text) > 5000:
                    text = text[:5000] + "\n...(중략)..."

                snippet = res.get("body", "")
                scraped_texts.append(
                    f"### [웹 검색 결과 {success_count+1}] {title}\n"
                    f"🔗 출처: {href}\n📝 스니펫: {snippet}\n\n{text}"
                )
                success_count += 1

        if not scraped_texts:
            # 검색은 성공했지만 스크래핑 전부 실패 → 스니펫이라도 반환
            snippet_texts = []
            for i, res in enumerate(results[:max_results]):
                title = res.get("title", "제목 없음")
                href = res.get("href") or res.get("url", "")
                snippet = res.get("body", "")
                if snippet:
                    snippet_texts.append(
                        f"### [검색 결과 {i+1}] {title}\n"
                        f"🔗 출처: {href}\n📝 {snippet}"
                    )
            if snippet_texts:
                return (
                    "⚠️ 페이지 본문 스크래핑이 차단되어 검색 스니펫만 반환합니다.\n\n"
                    + ("\n\n" + "="*50 + "\n\n").join(snippet_texts)
                )
            return "❌ 상위 사이트들이 스크래핑을 차단(403)했거나 접속할 수 없습니다. 검색어를 바꿔서 다시 시도해주세요."

        return "\n\n" + "="*50 + "\n\n" + ("\n\n" + "="*50 + "\n\n").join(scraped_texts)

    except Exception as e:
        return f"❌ 웹 검색/스크래핑 중 오류가 발생했습니다: {str(e)}"


# ──────────────────────────────────────────────
# Wikipedia 검색
# ──────────────────────────────────────────────

def _wiki_api_search(query: str, lang: str, limit: int) -> list[dict]:
    """MediaWiki API로 문서 검색 — [{title, snippet}, ...]"""
    import requests as _requests

    url = f"https://{lang}.wikipedia.org/w/api.php"
    params = {
        "action": "query",
        "list": "search",
        "srsearch": query,
        "srlimit": limit,
        "format": "json",
        "utf8": 1,
    }
    resp = _requests.get(url, params=params, headers=_get_random_headers(), timeout=10)
    resp.raise_for_status()
    data = resp.json()
    return data.get("query", {}).get("search", [])


def _wiki_api_summary(title: str, lang: str) -> dict:
    """Wikipedia REST API로 문서 요약 반환 — {title, extract, url}"""
    import requests as _requests

    url = f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{title}"
    resp = _requests.get(url, headers=_get_random_headers(), timeout=10)
    if resp.status_code == 404:
        return {}
    resp.raise_for_status()
    data = resp.json()
    return {
        "title": data.get("title", title),
        "extract": data.get("extract", ""),
        "url": data.get("content_urls", {}).get("desktop", {}).get("page", ""),
    }


def _wiki_api_full_text(title: str, lang: str) -> str:
    """MediaWiki API로 문서 전체 plaintext 반환"""
    import requests as _requests

    url = f"https://{lang}.wikipedia.org/w/api.php"
    params = {
        "action": "query",
        "titles": title,
        "prop": "extracts",
        "explaintext": True,
        "format": "json",
        "utf8": 1,
    }
    resp = _requests.get(url, params=params, headers=_get_random_headers(), timeout=15)
    resp.raise_for_status()
    pages = resp.json().get("query", {}).get("pages", {})
    for page in pages.values():
        return page.get("extract", "")
    return ""


def search_wikipedia(query: str, lang: str = "ko", top_k: int = 2, mode: str = "summary") -> str:
    """Wikipedia에서 문서를 검색하여 요약 또는 전문을 반환.

    - query  : 검색어
    - lang   : 언어 코드 (ko, en, ja 등, 기본 ko)
    - top_k  : 반환할 문서 수 (기본 2)
    - mode   : summary(요약), full(전문), sections(목차+요약)
    """
    try:
        import requests as _requests  # noqa: F811
    except ImportError as e:
        return (
            f"⛔ SearchWikipedia 도구를 사용할 수 없습니다 — 필수 패키지 미설치: {e}\n"
            "이 도구 없이 작업을 계속하세요."
        )

    try:
        # 1단계: 검색어로 관련 문서 찾기
        search_results = _wiki_api_search(query, lang, limit=top_k + 2)
        if not search_results:
            # 한국어 결과 없으면 영어로 fallback
            if lang != "en":
                search_results = _wiki_api_search(query, "en", limit=top_k + 2)
                if search_results:
                    lang = "en"
            if not search_results:
                return f"❌ Wikipedia에서 '{query}' 관련 문서를 찾지 못했습니다."

        # 2단계: 상위 문서의 내용 가져오기
        output_parts = []
        success_count = 0

        for sr in search_results:
            if success_count >= top_k:
                break

            title = sr.get("title", "")
            if not title:
                continue

            if mode == "full":
                text = _wiki_api_full_text(title, lang)
                if not text:
                    continue
                if len(text) > 8000:
                    text = text[:8000] + "\n...(이하 생략)..."
                page_url = f"https://{lang}.wikipedia.org/wiki/{title.replace(' ', '_')}"
                output_parts.append(
                    f"### [Wikipedia {success_count+1}] {title}\n"
                    f"🔗 {page_url}\n\n{text}"
                )
            else:
                # summary (기본) 또는 sections
                info = _wiki_api_summary(title, lang)
                if not info or not info.get("extract"):
                    continue
                output_parts.append(
                    f"### [Wikipedia {success_count+1}] {info['title']}\n"
                    f"🔗 {info.get('url', '')}\n\n{info['extract']}"
                )

            success_count += 1

        if not output_parts:
            return f"❌ Wikipedia에서 '{query}' 문서 내용을 가져올 수 없습니다."

        return "\n\n" + "="*50 + "\n\n" + ("\n\n" + "="*50 + "\n\n").join(output_parts)

    except Exception as e:
        return f"❌ Wikipedia 검색 중 오류가 발생했습니다: {str(e)}"


# ──────────────────────────────────────────────
# 새 기능: 심볼 조회, 파일 아웃라인, 콜 그래프
# ──────────────────────────────────────────────

def lookup_symbol(symbol: str, db_path: str = "") -> str:
    """심볼 정의를 검색하여 소스코드와 위치를 반환한다."""
    try:
        from rag.code import CodeRAG

        dbs = _list_all_dbs()
        code_dbs = [db for db in dbs if db.get("type") == "code"]

        if db_path:
            paths = [p.strip() for p in db_path.split(",") if p.strip()]
        elif code_dbs:
            paths = [db["path"] for db in code_dbs]
        else:
            return "❌ 구축된 CodeRAG DB가 없습니다."

        for path in paths:
            cache_key = os.path.abspath(path)
            if cache_key in _rag_cache:
                rag = _rag_cache[cache_key]
            else:
                rag = CodeRAG(db_store_path=path)
                if not rag.is_db_exists():
                    continue
                rag.load_db()
                _rag_cache[cache_key] = rag

            if not isinstance(rag, CodeRAG):
                continue

            result = rag.lookup_symbol(symbol)
            if result:
                parts = [f"## {result.get('name', symbol)}"]
                if result.get("file_path") or result.get("file"):
                    parts.append(f"파일: {result.get('file_path') or result.get('file')}")
                if result.get("signature"):
                    parts.append(f"시그니처: {result['signature']}")
                line_start = result.get("line_start", 0)
                line_end = result.get("line_end", 0)
                if line_start:
                    parts.append(f"라인: {line_start}-{line_end}")
                if result.get("code"):
                    parts.append(f"\n```\n{result['code']}\n```")
                return "\n".join(parts)

        return f"❌ 심볼 '{symbol}'을 찾을 수 없습니다."

    except Exception as e:
        return f"❌ 심볼 조회 중 오류: {str(e)}"


def get_file_outline(file_path: str, db_path: str = "") -> str:
    """파일 구조 요약(함수/클래스 목록)을 반환한다."""
    try:
        from rag.code import CodeRAG

        dbs = _list_all_dbs()
        code_dbs = [db for db in dbs if db.get("type") == "code"]

        if db_path:
            paths = [p.strip() for p in db_path.split(",") if p.strip()]
        elif code_dbs:
            paths = [db["path"] for db in code_dbs]
        else:
            return "❌ 구축된 CodeRAG DB가 없습니다."

        for path in paths:
            cache_key = os.path.abspath(path)
            if cache_key in _rag_cache:
                rag = _rag_cache[cache_key]
            else:
                rag = CodeRAG(db_store_path=path)
                if not rag.is_db_exists():
                    continue
                rag.load_db()
                _rag_cache[cache_key] = rag

            if not isinstance(rag, CodeRAG):
                continue

            result = rag.get_file_outline(file_path)
            if result:
                return result

        return f"❌ 파일 '{file_path}'의 아웃라인을 찾을 수 없습니다."

    except Exception as e:
        return f"❌ 파일 아웃라인 조회 중 오류: {str(e)}"


def get_callgraph(function_name: str, db_path: str = "", depth: int = 2) -> str:
    """함수의 콜 그래프(호출하는 함수 + 호출받는 함수)를 반환한다."""
    try:
        from rag.code import CodeRAG

        dbs = _list_all_dbs()
        code_dbs = [db for db in dbs if db.get("type") == "code"]

        if db_path:
            paths = [p.strip() for p in db_path.split(",") if p.strip()]
        elif code_dbs:
            paths = [db["path"] for db in code_dbs]
        else:
            return "❌ 구축된 CodeRAG DB가 없습니다."

        for path in paths:
            cache_key = os.path.abspath(path)
            if cache_key in _rag_cache:
                rag = _rag_cache[cache_key]
            else:
                rag = CodeRAG(db_store_path=path)
                if not rag.is_db_exists():
                    continue
                rag.load_db()
                _rag_cache[cache_key] = rag

            if not isinstance(rag, CodeRAG):
                continue

            result = rag.get_callgraph(function_name, depth=depth)
            if result is None:
                continue

            parts = [f"## 콜 그래프: {function_name}"]

            calls = result.get("calls", [])
            if calls:
                parts.append(f"\n### 호출하는 함수 ({len(calls)}개)")
                for c in calls:
                    sig = c.get("signature", "")
                    file_info = c.get("file", "")
                    parts.append(f"  - {c['name']}")
                    if sig:
                        parts.append(f"    시그니처: {sig}")
                    if file_info:
                        parts.append(f"    파일: {file_info}")

            called_by = result.get("called_by", [])
            if called_by:
                parts.append(f"\n### 호출받는 함수 ({len(called_by)}개)")
                for c in called_by:
                    file_info = c.get("file", "")
                    parts.append(f"  - {c['name']}")
                    if file_info:
                        parts.append(f"    파일: {file_info}")

            if not calls and not called_by:
                parts.append("\n콜 그래프 정보 없음 (그래프 스토어가 비어있거나 해당 함수 없음)")

            return "\n".join(parts)

        return f"❌ 함수 '{function_name}'의 콜 그래프를 찾을 수 없습니다."

    except Exception as e:
        return f"❌ 콜 그래프 조회 중 오류: {str(e)}"
