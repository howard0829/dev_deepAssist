"""위임형 SDK MCP 도구 (§5.2).

내장 워크스페이스 도구를 대체한다. 각 handler는 세션 bridge를 통해 클라이언트에
tool_request를 위임하고 tool_result를 기다린 뒤 결과를 SDK 루프로 반환한다.
서버 FS가 아니라 사용자 워크스페이스에서 실제 실행이 일어난다.
"""

from __future__ import annotations

import logging
from typing import Any

from claude_agent_sdk import create_sdk_mcp_server, tool

from .. import config
from ..protocol import MessageType as MT
from ..ws.session import Session

logger = logging.getLogger(__name__)


def _text(text: str, is_error: bool = False) -> dict:
    return {"content": [{"type": "text", "text": text}], "is_error": is_error}


async def _delegate(session: Session, mcp_name: str, args: dict[str, Any]) -> dict:
    """위임 공통 처리 — tool_request 전송 → tool_result 대기 → 부수효과 반영."""
    client_tool = config.CLIENT_TOOL_NAME.get(mcp_name, mcp_name)
    logger.info("도구 위임 → %s", client_tool)
    await session.send(MT.STATUS_UPDATE, {"activity": "coding", "message": f"{client_tool} 실행"})

    try:
        result = await session.bridge.request(
            MT.TOOL_REQUEST,
            {"tool_name": client_tool, "arguments": args},
            timeout=config.TOOL_TIMEOUT,
        )
    except (TimeoutError, ConnectionError) as e:
        return _text(f"도구 위임 실패: {e}", is_error=True)

    output = result.get("output", "") or ""
    success = result.get("success", True)
    side = result.get("side_effects") or {}

    # 부수효과 누적 + 수정 파일 diff 즉시 발송
    diffs = side.get("diffs") or {}
    for path in (side.get("modified_files") or []):
        session.modified_files.add(path)
        if diffs.get(path):
            session.diffs[path] = diffs[path]
            await session.send(MT.MODIFIED_FILE_DIFF, {
                "file_path": path, "diff": diffs[path], "op": client_tool})
    for path in (side.get("created_files") or []):
        session.modified_files.add(path)

    await session.send(MT.TOOL_CALL_UPDATE, {
        "tool_name": client_tool,
        "arguments": args,
        "result_preview": output[:400],
        "duration": result.get("duration", 0.0),
    })
    return _text(output, is_error=not success)


def build_delegated_server(session: Session):
    """세션 bridge에 바인딩된 위임형 MCP 서버를 생성한다."""

    @tool("bash", "사용자 워크스페이스에서 셸 명령을 실행한다.", {"command": str})
    async def bash(args: dict[str, Any]) -> dict:
        return await _delegate(session, "bash", args)

    @tool("read", "워크스페이스의 파일을 읽는다.", {"path": str})
    async def read(args: dict[str, Any]) -> dict:
        return await _delegate(session, "read", args)

    @tool("write", "워크스페이스에 파일을 생성/덮어쓴다.", {"path": str, "content": str})
    async def write(args: dict[str, Any]) -> dict:
        return await _delegate(session, "write", args)

    @tool("edit", "파일의 문자열을 치환한다. 먼저 read로 현재 내용을 확인할 것.",
          {"path": str, "old_string": str, "new_string": str})
    async def edit(args: dict[str, Any]) -> dict:
        return await _delegate(session, "edit", args)

    @tool("glob", "패턴으로 파일 경로를 찾는다.", {"pattern": str})
    async def glob(args: dict[str, Any]) -> dict:
        return await _delegate(session, "glob", args)

    @tool("grep", "정규식으로 파일 내용을 검색한다.", {"pattern": str})
    async def grep(args: dict[str, Any]) -> dict:
        return await _delegate(session, "grep", args)

    return create_sdk_mcp_server(
        name="deepassist", version="0.1.0",
        tools=[bash, read, write, edit, glob, grep],
    )
