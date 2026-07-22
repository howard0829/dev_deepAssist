"""서버직접 SDK MCP 도구 — RAG/knowledge (§4.2, §10).

서버에서 직접 실행되며 클라 위임하지 않는다. 리포 루트 `rag/` 모듈(dev_agent_client
재사용)의 검색 API에 연결한다. 벡터 DB는 서버의 `KNOWLEDGE_BASE_DIR`(기본
`~/.deepassist/knowledge`)를 그대로 검색한다.

rag 의존성(langchain·faiss·sentence-transformers·tree-sitter 등) 미설치 시에도 서버가
죽지 않도록 지연 import + graceful 메시지로 처리한다.
"""

from __future__ import annotations

import logging
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

logger = logging.getLogger(__name__)


def _rag():
    """rag.search 모듈 지연 import. Returns (module, err). 실패 시 (None, 사유)."""
    try:
        from rag import search as rag_search  # 리포 루트 rag/ (sys.path=repo root)
        return rag_search, ""
    except Exception as e:  # noqa: BLE001
        return None, str(e)


def _text(text: str) -> dict:
    return {"content": [{"type": "text", "text": text}]}


def _call(fn_name: str, **kwargs) -> dict:
    mod, err = _rag()
    if mod is None:
        return _text(f"[knowledge] RAG 사용 불가 (의존성 미설치?): {err}")
    fn = getattr(mod, fn_name, None)
    if fn is None:
        return _text(f"[knowledge] rag.search.{fn_name} 없음")
    try:
        return _text(fn(**kwargs))
    except Exception as e:  # noqa: BLE001
        logger.warning("knowledge.%s 오류: %s", fn_name, e)
        return _text(f"[knowledge] {fn_name} 오류: {e}")


def build_knowledge_server(session=None):
    @tool("rag_search", "코드/문서 지식베이스(벡터 DB)를 의미 검색한다.", {"query": str})
    async def rag_search(args: dict[str, Any]) -> dict:
        return _call("search_knowledge", query=args.get("query", ""), top_k=6)

    @tool("lookup_symbol", "지식 DB에서 심볼(함수/클래스) 정의를 찾는다.", {"symbol": str})
    async def lookup_symbol(args: dict[str, Any]) -> dict:
        return _call("lookup_symbol", symbol=args.get("symbol", ""))

    @tool("get_file_outline", "지식 DB에서 파일의 심볼 아웃라인을 얻는다.", {"file_path": str})
    async def get_file_outline(args: dict[str, Any]) -> dict:
        return _call("get_file_outline", file_path=args.get("file_path", ""))

    @tool("get_callgraph", "지식 DB에서 함수 콜그래프를 얻는다.", {"function_name": str})
    async def get_callgraph(args: dict[str, Any]) -> dict:
        return _call("get_callgraph", function_name=args.get("function_name", ""))

    return create_sdk_mcp_server(
        name="knowledge", version="0.1.0",
        tools=[rag_search, lookup_symbol, get_file_outline, get_callgraph],
    )
