"""
rag/__main__.py — MarkdownRAG / CodeRAG 테스트 실행

사용법:
    # 구축된 DB에 바로 쿼리
    python -m rag query "검색할 내용"
    python -m rag query "TEL-3 설명" --db /path/to/db --top_k 4

    # 구축된 DB 목록 확인
    python -m rag list

    # 인터랙티브 모드 (연속 쿼리)
    python -m rag interactive
    python -m rag interactive --db /path/to/db

    # TESTS 리스트 기반 테스트
    python -m rag             → 전체 테스트
    python -m rag markdown    → 마크다운 RAG만
    python -m rag code        → 코드 RAG만
"""

import hashlib
import logging
import os
import sys
from typing import List

from langchain_core.documents import Document

from rag.config import KNOWLEDGE_BASE_DIR
from rag.markdown import MarkdownRAG
from rag.code import CodeRAG

# CLI 실행 시 로깅 출력 활성화
logging.basicConfig(
    level=logging.INFO,
    format="%(message)s",
)


def _auto_db_path(source_path: str) -> str:
    """source_path 기반으로 KNOWLEDGE_BASE_DIR 하위에 고유 DB 경로를 자동 결정"""
    abs_path = os.path.abspath(os.path.expanduser(source_path))
    basename = os.path.splitext(os.path.basename(abs_path))[0]
    hash8 = hashlib.md5(abs_path.encode()).hexdigest()[:8]
    return os.path.join(KNOWLEDGE_BASE_DIR, f"{basename}_{hash8}")


def _print_results(tag: str, query: str, docs: List[Document]) -> None:
    """검색 결과를 포맷팅하여 출력 (pinned/rerank_score 포함)"""
    pinned_count = sum(1 for d in docs if d.metadata.get("pinned"))
    print(f"\n{'='*60}")
    print(f"[{tag}] 🔍 쿼리: {query}")
    print(f"  📊 결과: {len(docs)}건 (pinned: {pinned_count}건)")
    print('='*60)
    for i, doc in enumerate(docs):
        meta = doc.metadata
        chunk_type = meta.get("chunk_type", "")

        section = meta.get("section", "")
        page = meta.get("page", "")

        hierarchy = meta.get("hierarchy", "")
        signature = meta.get("signature", "")
        language = meta.get("language", "")
        line_range = meta.get("line_range", "")

        source = meta.get("source", "Unknown")
        req_ids = meta.get("requirement_ids", [])
        req_info = f" | IDs: {', '.join(req_ids[:20])}" if req_ids else ""
        if len(req_ids) > 20:
            req_info += f" (+{len(req_ids)-20})"

        # RAG 알고리즘 메타 표시
        rag_tags = []
        if meta.get("pinned"):
            rag_tags.append("📌 pinned")
        rerank_score = meta.get("rerank_score")
        if rerank_score is not None:
            rag_tags.append(f"score: {rerank_score:.2f}")
        rag_info = f" [{', '.join(rag_tags)}]" if rag_tags else ""

        if chunk_type in ("file_summary", "function", "class", "subchunk", "declarations"):
            project = meta.get("project", "")
            info_parts = [f"결과 {i+1}{rag_info}"]
            if project:
                info_parts.append(f"프로젝트: {project}")
            if language:
                info_parts.append(f"언어: {language}")
            if chunk_type:
                info_parts.append(f"유형: {chunk_type}")
            if line_range:
                info_parts.append(f"라인: {line_range[0]}-{line_range[1]}")
            if hierarchy:
                info_parts.append(f"계층: {hierarchy}")
            info_parts.append(f"파일: {source}")
            print(f"  {' | '.join(info_parts)}{req_info}")
            if signature and chunk_type != "file_summary":
                print(f"  시그니처: {signature}")
        else:
            doc_name = meta.get("doc_name", "")
            doc_info = f" | 문서: {doc_name}" if doc_name else ""
            page_info = f" | 페이지: {page}" if page else ""
            section_info = f" | 섹션: {section}" if section else ""
            print(f"  결과 {i+1}{rag_info}{doc_info}{page_info}{section_info}{req_info}")

        content = doc.page_content
        if len(content) > 2000:
            content = content[:1000] + f"\n... (중략, 총 {len(content)}자) ...\n" + content[-500:]
        print(f"  내용:\n{content}")
        print(f"  {'-'*56}")


def _run_test_suite(rag, label: str, queries: List[dict]) -> None:
    """테스트 쿼리 목록을 순차 실행하고 결과 출력"""
    for i, q in enumerate(queries, 1):
        tag = f"{label} Test {i} - {q['tag']}"
        docs = rag.retrieve(q["query"], top_k=q.get("top_k", 6))
        _print_results(tag, q["query"], docs)


# ══════════════════════════════════════════════════════════════
# __main__ — MarkdownRAG / CodeRAG 테스트 실행
# ══════════════════════════════════════════════════════════════

TESTS = [
    # ── 마크다운 RAG 테스트 예시 ──────────────────────────────
    # 아래 source/db_path 경로를 실제 환경에 맞게 변경하여 사용하세요.
    # {
    #     "type": "markdown",
    #     "label": "NVMe 2.3 Base Spec",
    #     "source": "/path/to/your/markdown/document.md",
    #     "db_path": "/path/to/knowledge/nvme23",
    #     "queries": [
    #         {"tag": "의미 검색",       "query": "큐(Queue)의 제출 및 완료 메커니즘은 어떻게 동작하나요?"},
    #         {"tag": "약어: RESERVS",  "query": "RESERVS"},
    #     ],
    # },
    # ── 코드 RAG 테스트 예시 ──────────────────────────────────
    # {
    #     "type": "code",
    #     "label": "NVMe Test Framework",
    #     "source": "/path/to/your/code/project",
    #     "db_path": "/path/to/knowledge/nvme_test_code",
    #     "queries": [
    #         {"tag": "Req ID 검색",   "query": "TEL-2 관련 평가를 진행하고 싶어"},
    #         {"tag": "심볼 검색",      "query": "allocate_block"},
    #     ],
    # },
]

# ══════════════════════════════════════════════════════════════
# CLI 명령: query / list / interactive
# ══════════════════════════════════════════════════════════════

def _cmd_list() -> None:
    """구축된 모든 Knowledge DB 목록을 출력"""
    from rag.search import list_knowledge_dbs
    print(list_knowledge_dbs())


def _load_rag_from_db(db_path: str):
    """DB 경로에서 RAG 인스턴스를 로드"""
    db_path = os.path.abspath(os.path.expanduser(db_path))
    if not os.path.exists(db_path):
        print(f"❌ DB 경로가 존재하지 않습니다: {db_path}")
        sys.exit(1)
    if not os.path.exists(os.path.join(db_path, "faiss_index")):
        print(f"❌ 유효한 Knowledge DB가 아닙니다 (faiss_index 없음): {db_path}")
        sys.exit(1)

    # 코드/마크다운 자동 감지
    if os.path.exists(os.path.join(db_path, "symbol_index.pkl")):
        rag = CodeRAG(db_store_path=db_path)
    else:
        rag = MarkdownRAG(db_store_path=db_path)
    rag.load_db()
    return rag


def _resolve_db_path(db_arg: str) -> str:
    """DB 경로를 확인하고, 미지정 시 자동 선택"""
    if db_arg:
        return db_arg

    # DB 미지정 → 전체 DB 목록에서 자동 선택
    from rag.search import _list_all_dbs
    all_dbs = _list_all_dbs()
    if not all_dbs:
        print("❌ 구축된 Knowledge DB가 없습니다.")
        print("   python -m rag list  로 확인하거나 DB를 먼저 구축하세요.")
        sys.exit(1)

    if len(all_dbs) == 1:
        chosen = all_dbs[0]
        print(f"📂 DB 자동 선택: {chosen['name']} ({chosen['path']})")
        return chosen["path"]

    # 여러 DB가 있으면 목록 표시 후 선택
    print(f"\n📚 구축된 Knowledge DB ({len(all_dbs)}개):")
    for i, db in enumerate(all_dbs, 1):
        db_type = db["type"].upper()
        print(f"  {i}. [{db_type}] {db['name']}  ({db['path']})")

    while True:
        try:
            choice = input(f"\n검색할 DB 번호를 선택하세요 (1-{len(all_dbs)}): ").strip()
            idx = int(choice) - 1
            if 0 <= idx < len(all_dbs):
                return all_dbs[idx]["path"]
            print(f"  1~{len(all_dbs)} 사이 번호를 입력하세요.")
        except (ValueError, EOFError):
            print("  숫자를 입력하세요.")
        except KeyboardInterrupt:
            print("\n취소됨.")
            sys.exit(0)


def _cmd_query(args: list) -> None:
    """단일 쿼리 실행: python -m rag query "검색어" [--db PATH] [--top_k N]"""
    import argparse
    parser = argparse.ArgumentParser(prog="python -m rag query")
    parser.add_argument("query", help="검색 쿼리")
    parser.add_argument("--db", default="", help="DB 경로 (미지정 시 자동 선택)")
    parser.add_argument("--top_k", type=int, default=6, help="반환 결과 수 (기본: 6)")
    parsed = parser.parse_args(args)

    db_path = _resolve_db_path(parsed.db)
    rag = _load_rag_from_db(db_path)
    docs = rag.retrieve(parsed.query, top_k=parsed.top_k)
    _print_results("Query", parsed.query, docs)
    pinned_count = sum(1 for d in docs if d.metadata.get("pinned"))
    scored = [d for d in docs if d.metadata.get("rerank_score") is not None]
    max_score = max((d.metadata["rerank_score"] for d in scored), default=None)
    score_info = f" | max_score: {max_score:.2f}" if max_score is not None else ""
    print(f"\n📊 총 {len(docs)}개 결과 (top_k={parsed.top_k} | pinned: {pinned_count}{score_info})")


def _cmd_interactive(args: list) -> None:
    """인터랙티브 모드: 연속 쿼리 실행"""
    import argparse
    parser = argparse.ArgumentParser(prog="python -m rag interactive")
    parser.add_argument("--db", default="", help="DB 경로 (미지정 시 자동 선택)")
    parser.add_argument("--top_k", type=int, default=6, help="기본 반환 결과 수 (기본: 6)")
    parsed = parser.parse_args(args)

    db_path = _resolve_db_path(parsed.db)
    rag = _load_rag_from_db(db_path)

    print(f"\n{'='*60}")
    print(f"🔍 RAG 인터랙티브 모드 (top_k={parsed.top_k})")
    print(f"   DB: {db_path}")
    print(f"   종료: quit / exit / Ctrl+C")
    print(f"   top_k 변경: /top_k 8")
    print(f"{'='*60}")

    top_k = parsed.top_k
    query_count = 0

    while True:
        try:
            query = input(f"\n🔎 쿼리 ({top_k}): ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n\n👋 종료합니다.")
            break

        if not query:
            continue
        if query.lower() in ("quit", "exit", "q"):
            print("👋 종료합니다.")
            break
        if query.startswith("/top_k"):
            try:
                top_k = int(query.split()[1])
                print(f"   top_k → {top_k}")
            except (IndexError, ValueError):
                print(f"   현재 top_k: {top_k}. 변경: /top_k 8")
            continue

        query_count += 1
        docs = rag.retrieve(query, top_k=top_k)
        _print_results(f"Q{query_count}", query, docs)
        pinned_count = sum(1 for d in docs if d.metadata.get("pinned"))
        scored = [d for d in docs if d.metadata.get("rerank_score") is not None]
        max_score = max((d.metadata["rerank_score"] for d in scored), default=None)
        score_info = f" | max_score: {max_score:.2f}" if max_score is not None else ""
        print(f"📊 {len(docs)}개 결과 (top_k={top_k} | pinned: {pinned_count}{score_info})")


# ══════════════════════════════════════════════════════════════
# CLI 인자 파싱
# ══════════════════════════════════════════════════════════════

mode = sys.argv[1].lower() if len(sys.argv) > 1 else "all"

# 새 CLI 명령 분기
if mode == "query":
    _cmd_query(sys.argv[2:])
    sys.exit(0)
elif mode == "list":
    _cmd_list()
    sys.exit(0)
elif mode == "interactive":
    _cmd_interactive(sys.argv[2:])
    sys.exit(0)

# 기존 TESTS 기반 테스트 모드
valid_modes = {"all", "markdown", "code"}
if mode not in valid_modes:
    print("사용법:")
    print("  python -m rag query \"검색어\" [--db PATH] [--top_k N]  — 단일 쿼리")
    print("  python -m rag interactive [--db PATH] [--top_k N]      — 인터랙티브 모드")
    print("  python -m rag list                                     — 구축된 DB 목록")
    print("  python -m rag [all|markdown|code]                      — TESTS 기반 테스트")
    sys.exit(1)

filtered_tests = [t for t in TESTS if mode == "all" or t["type"] == mode]
if not filtered_tests:
    print(f"⚠️ '{mode}' 유형의 테스트 설정이 없습니다. TESTS 리스트에 항목을 추가하세요.")
    sys.exit(0)

try:
    for test_cfg in filtered_tests:
        test_type = test_cfg["type"]
        label = test_cfg["label"]
        source = test_cfg["source"]
        db_path = test_cfg.get("db_path", "").strip() or _auto_db_path(test_cfg["source"])

        print(f"\n{'='*60}")
        print(f"🚀 [{test_type.upper()}] {label} RAG 구축/로드")
        print(f"{'='*60}")

        if test_type == "markdown":
            rag = MarkdownRAG(db_store_path=db_path)
        elif test_type == "code":
            rag = CodeRAG(db_store_path=db_path)
        else:
            print(f"⚠️ 알 수 없는 유형: {test_type}")
            continue

        rag.build_or_load(source)
        _run_test_suite(rag, label, test_cfg["queries"])

    # ── DB 재로드 검증 ──
    md_tests = [t for t in filtered_tests if t["type"] == "markdown"]
    if md_tests:
        print(f"\n{'='*60}")
        print("[재로드 검증] 기존 DB를 디스크에서 재로드 후 검색")
        print(f"{'='*60}")
        reload_db_path = md_tests[0].get("db_path", "").strip() or _auto_db_path(md_tests[0]["source"])
        rag_reload = MarkdownRAG(db_store_path=reload_db_path)
        rag_reload.build_or_load(md_tests[0]["source"])
        _print_results(
            "재로드 검증",
            "Endurance Group 정의 및 용도",
            rag_reload.retrieve("Endurance Group 정의 및 용도", top_k=2),
        )

    print(f"\n✅ 전체 테스트 완료!")

except Exception as e:
    print(f"\n❌ 실행 중 오류 발생: {e}")
    import traceback
    traceback.print_exc()
    print("\n💡 팁:")
    print("  - Ollama 서버 실행 중이고 OLLAMA_EMBEDDING_MODEL이 .env에 설정되어 있어야 합니다.")
    print("  - CodeRAG는 tree-sitter 설치 시 정확도가 크게 향상됩니다:")
    print("    pip install tree-sitter tree-sitter-python tree-sitter-c tree-sitter-cpp tree-sitter-java")
