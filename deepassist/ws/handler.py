"""WSHandler — 연결 수명주기 + 메시지 라우팅.

수신 루프가 클라 메시지를 분기한다:
  - user_message      → 오케스트레이터 실행 태스크 시작
  - tool_result       → bridge.resolve (위임 왕복 완료)
  - tool_progress     → bridge.heartbeat (timeout 연장)
  - approval_response → bridge.resolve (승인 게이트 해소)
  - stop_request      → 실행 태스크 취소
  - session_reset     → 세션 상태 초기화 + 실행 취소
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import WebSocket, WebSocketDisconnect

from .. import config
from ..orchestrator import Orchestrator
from ..protocol import MessageType as MT
from ..protocol import decode
from .bridge import AsyncBridge
from .session import Session

logger = logging.getLogger(__name__)


class WSHandler:
    def __init__(self, websocket: WebSocket):
        self.ws = websocket

    async def handle(self) -> None:
        await self.ws.accept()
        bridge = AsyncBridge(self.ws)
        session = Session(bridge)
        orchestrator = Orchestrator()
        run_task: asyncio.Task | None = None

        await bridge.send(MT.SESSION_INIT, {
            "config": {
                "model": config.DEEPASSIST_MODEL,
                "permission_mode": config.PERMISSION_MODE,
            },
        })

        try:
            while True:
                data = await self.ws.receive_json()
                mtype, payload = decode(data)

                if mtype == MT.USER_MESSAGE:
                    if run_task and not run_task.done():
                        await bridge.send(MT.ERROR, {
                            "code": "busy", "message": "이미 실행 중입니다"})
                        continue
                    session.update_from_user_message(payload)
                    prompt = payload.get("prompt", "")
                    run_task = asyncio.create_task(
                        orchestrator.run(session, prompt))

                elif mtype == MT.TOOL_RESULT:
                    bridge.resolve(payload.get("id", ""), payload)

                elif mtype == MT.TOOL_PROGRESS:
                    bridge.heartbeat(payload.get("id", ""))

                elif mtype == MT.APPROVAL_RESPONSE:
                    bridge.resolve(payload.get("id", ""), payload)

                elif mtype == MT.STOP_REQUEST:
                    if run_task and not run_task.done():
                        run_task.cancel()

                elif mtype == MT.WORKSPACE_METADATA:
                    session.workspace_meta = payload

                elif mtype == MT.SESSION_RESET:
                    if run_task and not run_task.done():
                        run_task.cancel()
                    session.reset()

                elif mtype == MT.PING:
                    await bridge.send(MT.PONG, {})

        except WebSocketDisconnect:
            logger.info("클라이언트 연결 종료")
        except Exception as e:  # noqa: BLE001
            logger.exception(f"WS 핸들러 오류: {e}")
        finally:
            if run_task and not run_task.done():
                run_task.cancel()
            bridge.close()
