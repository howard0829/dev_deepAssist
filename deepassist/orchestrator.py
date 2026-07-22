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
        # 클라이언트 OS 자동 인식(명시값 → 경로 형식) 후 OS별 지시문 주입 — 모델이 대상 OS를
        # 명확히 인지해 서버(Linux) 기준으로 파일 접근을 거부하지 않게 한다. Windows/Linux 자동 대응.
        client_os = session.client_os()
        os_label = {"windows": "Windows", "linux": "Linux", "macos": "macOS"}.get(client_os, "unknown")
        shell = (session.workspace_meta or {}).get("shell", "")
        workspace = session.workspace or "(미지정)"
        logger.info("클라이언트 OS 인식: %s (shell=%s)", client_os, shell or "-")
        note = f"[현재 세션] 사용자 PC OS: {os_label} · 워크스페이스: {workspace}"
        if client_os == "windows":
            note += (f"\n사용자 PC는 Windows다. 경로는 `C:\\...`/`D:\\...` 형식이며 위임 도구에 그대로 "
                     f"넘겨 접근하라. bash는 Windows 셸({shell or 'cmd/powershell'})에서 실행되니 OS 종속 "
                     f"명령을 피하고 파일 열람·탐색은 read/glob/grep을 우선 사용하라.")
        elif client_os in ("linux", "macos"):
            note += "\n사용자 PC는 POSIX(경로 `/...`)다. 위임 도구로 접근하라."
        guide = f"{DEEPASSIST_TOOL_GUIDE}\n\n{note}"
        opts = dict(
            model=model,
            system_prompt={
                "type": "preset", "preset": "claude_code",
                "append": guide,       # §9.1 도구 지침 + 클라 OS 컨텍스트
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
        # cwd는 클라이언트(다른 OS) 경로가 아니라 서버의 유효 디렉토리로 지정한다.
        # session.workspace(예: d:\KDK\...)를 cwd로 쓰면 SDK 서브프로세스가
        # 'Working directory does not exist'로 실패(멀티 OS 불변식). 실제 파일 접근은
        # 위임 도구가 클라에서 수행하므로 SDK cwd는 무관. 빈 서버 디렉토리라 프로젝트 오염도 없음.
        os.makedirs(config.AGENT_CWD, exist_ok=True)
        opts["cwd"] = config.AGENT_CWD
        if session.sdk_session_id:
            opts["resume"] = session.sdk_session_id  # 멀티턴 연속성
        return ClaudeAgentOptions(**opts)

    def _augment_prompt(self, session: Session, prompt: str) -> str:
        """UI 첨부 컨텍스트를 프롬프트에 주입.

        - attached_snippets: 선택 코드 본문을 인라인 임베드(파일:라인 헤더 포함).
        - attached_paths: 클라 절대경로 목록을 제시 — 에이전트가 위임 도구
          (mcp__deepassist__read/glob/grep)로 직접 열람하도록 유도.
        """
        parts: list[str] = []

        snippets = session.attached_snippets or []
        if snippets:
            parts.append("## 첨부된 코드")
            for s in snippets:
                f = s.get("file", "")
                a, b = s.get("start_line", ""), s.get("end_line", "")
                text = s.get("text", "")
                parts.append(f"### {f} ({a}-{b})\n```\n{text}\n```")

        paths = session.attached_paths or []
        if paths:
            parts.append("## 첨부된 파일/폴더 (경로는 아래 슬래시 표기 그대로 사용)\n"
                         "폴더면 read하지 말고 glob(pattern=\"**/*\", path=\"<폴더>\")로 파일을 나열한 뒤 "
                         "각 파일을 read하라.")
            parts.extend(f"- {p.replace(chr(92), '/')}" for p in paths)   # 백슬래시 → 슬래시

        parts.append(prompt)
        return "\n\n".join(p for p in parts if p)

    async def run(self, session: Session, prompt: str) -> None:
        if not _SDK_OK:
            await session.send(MT.ERROR, {
                "code": "sdk_missing",
                "message": f"claude-agent-sdk 미설치/로드 실패: {_SDK_ERR}"})
            return

        session.begin_turn()
        model = session.provider_config.get("model") or config.DEEPASSIST_MODEL
        logger.info("query 시작 — model=%s, base_url=%s", model, config.ANTHROPIC_BASE_URL)
        result_payload = None
        saw_result = False
        try:
            options = self._build_options(session)
            full_prompt = self._augment_prompt(session, prompt)
            async for msg in query(prompt=full_prompt, options=options):
                logger.debug("SDK 메시지 수신: %s", type(msg).__name__)
                rp = await self._translate(session, msg)
                if rp is not None:                    # ResultMessage payload
                    result_payload, saw_result = rp, True
        except asyncio.CancelledError:
            await session.send(MT.STATUS_UPDATE, {"message": "중지됨"})
            raise
        except Exception as e:  # noqa: BLE001
            logger.exception("에이전트 실행 오류")
            # 예외 타입명을 함께 노출 — LiteLLM 연결·SDK 옵션 오류 등 원인 파악용.
            await session.send(MT.ERROR, {
                "code": "agent_error", "message": f"{type(e).__name__}: {e}"})
            return

        # ★ 완료 통지는 루프가 실제 종료된 뒤 딱 한 번 — 중간/중복 ResultMessage로 인한
        #    조기 종료 인식(전송버튼 조기 활성화) 방지. 이 시점에만 UI가 turn 종료로 인식.
        if not saw_result:
            logger.warning("ResultMessage 없이 종료 (SDK 메시지 형태 확인 필요, §11)")
        final = result_payload or {}
        await session.send(MT.AGENT_COMPLETE, {
            "response": final.get("response", ""),
            "modified_files": sorted(session.modified_files),
            "diffs": session.diffs,
            "metrics": final.get("metrics", {}),
        })

    async def _translate(self, session: Session, msg):
        """SDK 메시지 → UI 프로토콜 (방어적).

        ResultMessage면 완료 payload(dict)를 반환한다(여기서 agent_complete를 보내지
        않는다 — 조기 종료 방지를 위해 run()이 루프 종료 후 1회만 전송). 그 외 None.
        """
        name = type(msg).__name__

        if name == "AssistantMessage":
            for block in (getattr(msg, "content", None) or []):
                if type(block).__name__ == "TextBlock" or getattr(block, "type", None) == "text":
                    text = getattr(block, "text", "") or ""
                    if text:
                        await session.send(MT.AGENT_TEXT, {"text": text, "is_final": False})
            return None

        if name == "ResultMessage":
            sid = getattr(msg, "session_id", None)
            if sid:
                session.sdk_session_id = sid
            usage = getattr(msg, "usage", None) or {}
            logger.info("ResultMessage 수신 (subtype=%s, num_turns=%s)",
                        getattr(msg, "subtype", None), getattr(msg, "num_turns", None))
            return {
                "response": getattr(msg, "result", "") or "",
                "metrics": {"usage": usage} if usage else {},
            }

        if name == "SystemMessage":
            sid = getattr(msg, "session_id", None)
            if sid:
                session.sdk_session_id = sid
            return None

        logger.debug("미처리 SDK 메시지 타입: %s", name)
        return None
