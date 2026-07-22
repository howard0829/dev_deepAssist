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


def _normalize_path_args(args: dict[str, Any]) -> dict[str, Any]:
    """경로 인자의 백슬래시 → 슬래시 정규화.

    Windows 경로(`d:\\a\\b`)는 도구 호출 JSON에서 이스케이프 손상(\\u,\\t 등)을 일으킨다.
    Node fs는 Windows에서도 슬래시 경로(`d:/a/b`)를 허용하므로, 넘기기 전에 슬래시로 통일해
    해석 오류를 방어한다(Linux 경로엔 백슬래시가 없어 무해).
    """
    out = dict(args or {})
    for k in ("file_path", "path"):
        v = out.get(k)
        if isinstance(v, str) and "\\" in v:
            out[k] = v.replace("\\", "/")
    return out


async def _delegate(session: Session, mcp_name: str, args: dict[str, Any]) -> dict:
    """위임 공통 처리 — tool_request 전송 → tool_result 대기 → 부수효과 반영."""
    client_tool = config.CLIENT_TOOL_NAME.get(mcp_name, mcp_name)
    args = _normalize_path_args(args)      # 백슬래시 경로 → 슬래시 (Windows 방어)
    logger.info("도구 위임 → %s %s", client_tool, {k: args[k] for k in ("file_path", "path") if k in args})
    # 도구별 "{tool} 실행" status_update는 보내지 않는다 — 확장이 이 메시지를 Output 채널에
    # 매번 logger.log 하고 채팅에도 라인으로 렌더해 중복 출력됐다. 도구 호출 기록은
    # 아래 tool_call_update가 이미 담당한다.
    try:
        result = await session.bridge.request(
            MT.TOOL_REQUEST,
            {"tool_name": client_tool, "arguments": args},
            timeout=config.TOOL_TIMEOUT,
            max_timeout=config.TOOL_MAX_TIMEOUT,   # heartbeat 무한 연장 방어(절대 상한)
        )
    except (TimeoutError, ConnectionError) as e:
        logger.warning("도구 위임 실패 ← %s: %s", client_tool, e)
        return _text(f"도구 위임 실패: {e}", is_error=True)

    output = result.get("output", "") or ""
    success = result.get("success", True)
    # glob 결과 경로는 Windows에서 백슬래시(path.join native)로 온다 → 모델이 그대로 read에
    # 넘기면 JSON 이스케이프 손상 재발. glob 출력은 순수 경로 목록이므로 슬래시로 정규화.
    if mcp_name == "glob" and "\\" in output:
        output = output.replace("\\", "/")
    logger.info("도구 완료 ← %s (success=%s)", client_tool, success)
    # 실패 시 원인 진단용 — 클라 tool-executor가 돌려준 에러 본문을 서버 로그에 노출.
    # (평시엔 success/실패 플래그만 남아 "폴더 리뷰 Read 실패" 같은 근본 원인을 못 봤다.)
    if not success:
        logger.warning("도구 실패 상세 ← %s %s: %s",
                       client_tool,
                       {k: args[k] for k in ("file_path", "path", "pattern") if k in args},
                       output[:500] or "(빈 응답)")
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

    @tool("bash", "사용자 PC 셸에서 명령을 실행한다.", {"command": str})
    async def bash(args: dict[str, Any]) -> dict:
        return await _delegate(session, "bash", args)

    @tool("read", "파일을 읽는다. file_path는 슬래시 경로(Windows도 D:/... 형식, 공백 허용).",
          {"file_path": str})
    async def read(args: dict[str, Any]) -> dict:
        return await _delegate(session, "read", args)

    @tool("write", "파일을 생성/덮어쓴다.", {"file_path": str, "content": str})
    async def write(args: dict[str, Any]) -> dict:
        return await _delegate(session, "write", args)

    @tool("edit", "파일의 문자열을 치환한다. 먼저 read로 현재 내용을 확인할 것.",
          {"file_path": str, "old_string": str, "new_string": str})
    async def edit(args: dict[str, Any]) -> dict:
        return await _delegate(session, "edit", args)

    @tool("glob", "패턴으로 파일 경로를 찾는다. path에 검색 대상 폴더(슬래시 경로) 지정.",
          {"pattern": str, "path": str})
    async def glob(args: dict[str, Any]) -> dict:
        return await _delegate(session, "glob", args)

    @tool("grep", "정규식으로 파일 내용을 검색한다. path에 검색 대상 폴더(슬래시 경로) 지정.",
          {"pattern": str, "path": str})
    async def grep(args: dict[str, Any]) -> dict:
        return await _delegate(session, "grep", args)

    return create_sdk_mcp_server(
        name="deepassist", version="0.1.0",
        tools=[bash, read, write, edit, glob, grep],
    )
