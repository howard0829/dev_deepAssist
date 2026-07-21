"""Orchestrator — DeepAssist 핵심 계층.

세션별로 Claude Agent SDK의 query() 옵션(위임 MCP + RAG MCP + skills + 시스템
프롬프트 + permission)을 조립하고, query()가 yield하는 메시지를 UI 프로토콜로
번역한다.

⚠ SDK 메시지 클래스/필드의 정확한 형태는 구현 초기 검증 대상(§11). 미설치·클래스명
변경에도 모듈 import가 깨지지 않도록 방어적으로 처리한다.
"""

from __future__ import annotations

import asyncio
import logging
import os

from . import config
from .prompts import DEEPASSIST_TOOL_GUIDE
from .protocol import MessageType as MT
from .ws.session import Session

logger = logging.getLogger(__name__)

try:  # SDK는 런타임 의존 — 미설치 환경에서도 서버 import는 가능해야 함
    from claude_agent_sdk import ClaudeAgentOptions, query
    _SDK_OK, _SDK_ERR = True, ""
except Exception as e:  # noqa: BLE001
    _SDK_OK, _SDK_ERR = False, str(e)


class Orchestrator:
    def _build_options(self, session: Session):
        # SDK 의존 모듈은 지연 import — SDK 미설치 시 서버 import가 깨지지 않게.
        from .tools.delegated import build_delegated_server
        from .tools.knowledge import build_knowledge_server

        allowed = [f"mcp__deepassist__{t}" for t in config.DELEGATED_TOOLS]
        allowed.append("mcp__knowledge__rag_search")

        model = session.provider_config.get("model") or config.DEEPASSIST_MODEL
        opts = dict(
            model=model,
            system_prompt={
                "type": "preset", "preset": "claude_code",
                "append": DEEPASSIST_TOOL_GUIDE,       # §9.1 도구 지침 보강
            },
            disallowed_tools=list(config.DISABLED_BUILTINS),   # 내장 워크스페이스 도구 제거
            allowed_tools=allowed,                             # 위임/서버직접 사전 승인
            mcp_servers={
                "deepassist": build_delegated_server(session),
                "knowledge": build_knowledge_server(session),
            },
            permission_mode=config.PERMISSION_MODE,
            skills=config.skills_option(),
            include_partial_messages=False,   # MVP: 턴 단위 (§11: 토큰 스트리밍 후속)
            # 전체 부모 환경(PATH·HOME 등) + Anthropic 오버라이드를 함께 전달.
            # small/fast 모델도 같은 LiteLLM 모델로 지정하지 않으면 기본 Haiku 호출로 실패.
            env={
                **os.environ,
                "ANTHROPIC_BASE_URL": config.ANTHROPIC_BASE_URL,
                "ANTHROPIC_AUTH_TOKEN": config.ANTHROPIC_AUTH_TOKEN,
                "ANTHROPIC_API_KEY": config.ANTHROPIC_AUTH_TOKEN,
                "ANTHROPIC_MODEL": model,
                "ANTHROPIC_SMALL_FAST_MODEL": config.SMALL_MODEL,
                # 비필수 트래픽 차단 — 잘 되는 CLI와 동일. 미설정 시 실패/행의 주원인.
                "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": config.DISABLE_NONESSENTIAL_TRAFFIC,
            },
        )
        if session.workspace:
            opts["cwd"] = session.workspace          # 명목상(실 실행은 클라 위임)
        if session.sdk_session_id:
            opts["resume"] = session.sdk_session_id  # 멀티턴 연속성
        return ClaudeAgentOptions(**opts)

    async def run(self, session: Session, prompt: str) -> None:
        if not _SDK_OK:
            await session.send(MT.ERROR, {
                "code": "sdk_missing",
                "message": f"claude-agent-sdk 미설치/로드 실패: {_SDK_ERR}"})
            return

        session.begin_turn()
        model = session.provider_config.get("model") or config.DEEPASSIST_MODEL
        logger.info("query 시작 — model=%s, base_url=%s", model, config.ANTHROPIC_BASE_URL)
        got_result = False
        try:
            options = self._build_options(session)
            async for msg in query(prompt=prompt, options=options):
                name = type(msg).__name__
                logger.debug("SDK 메시지 수신: %s", name)
                if name == "ResultMessage":
                    got_result = True
                await self._translate(session, msg)
        except asyncio.CancelledError:
            await session.send(MT.STATUS_UPDATE, {"message": "중지됨"})
            raise
        except Exception as e:  # noqa: BLE001
            logger.exception("에이전트 실행 오류")
            # 예외 타입명을 함께 노출 — LiteLLM 연결·SDK 옵션 오류 등 원인 파악용.
            await session.send(MT.ERROR, {
                "code": "agent_error", "message": f"{type(e).__name__}: {e}"})
            return
        if not got_result:
            # ResultMessage 없이 루프 종료 — UI가 멈추지 않게 완료 통지 + 경고 로그.
            logger.warning("query 종료했으나 ResultMessage 없음 (SDK 메시지 형태 확인 필요, §11)")
            await session.send(MT.AGENT_COMPLETE, {
                "response": "", "modified_files": sorted(session.modified_files),
                "diffs": session.diffs, "metrics": {}})

    async def _translate(self, session: Session, msg) -> None:
        """SDK 메시지 → UI 프로토콜 (방어적)."""
        name = type(msg).__name__

        if name == "AssistantMessage":
            for block in (getattr(msg, "content", None) or []):
                if type(block).__name__ == "TextBlock" or getattr(block, "type", None) == "text":
                    text = getattr(block, "text", "") or ""
                    if text:
                        await session.send(MT.AGENT_TEXT, {"text": text, "is_final": False})

        elif name == "ResultMessage":
            sid = getattr(msg, "session_id", None)
            if sid:
                session.sdk_session_id = sid
            usage = getattr(msg, "usage", None) or {}
            await session.send(MT.AGENT_COMPLETE, {
                "response": getattr(msg, "result", "") or "",
                "modified_files": sorted(session.modified_files),
                "diffs": session.diffs,
                "metrics": {"usage": usage} if usage else {},
            })

        elif name == "SystemMessage":
            sid = getattr(msg, "session_id", None)
            if sid:
                session.sdk_session_id = sid

        else:
            logger.debug("미처리 SDK 메시지 타입: %s", name)
