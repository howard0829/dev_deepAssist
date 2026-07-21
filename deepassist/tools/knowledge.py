"""서버직접 SDK MCP 도구 — RAG/knowledge (§4.2, §10).

서버에서 직접 실행되며 클라 위임하지 않는다. 여기서는 인터페이스만 두고, 기존
g_tas_server/rag 자산 연결은 후속(§10 재사용 매핑).
"""

from __future__ import annotations

from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool


def build_knowledge_server(session=None):
    @tool("rag_search", "코드/문서 지식베이스를 검색한다.", {"query": str})
    async def rag_search(args: dict[str, Any]) -> dict:
        query = args.get("query", "")
        # TODO(§10): 기존 rag.search 를 서버직접으로 연결.
        return {"content": [{"type": "text",
                             "text": f"[knowledge] RAG 미연결 (stub). query={query!r}"}]}

    return create_sdk_mcp_server(name="knowledge", version="0.1.0", tools=[rag_search])
