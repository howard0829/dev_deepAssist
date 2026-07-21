"""AsyncBridge — 비동기 위임 브리지.

Claude Agent SDK는 async이므로, 위임형 MCP 도구 handler와 query() 루프가 같은
이벤트 루프에서 동시에 돈다. 따라서 기존 G-TAS의 동기 브리지(threading.Event +
run_coroutine_threadsafe) 대신 asyncio.Future 기반으로 구현한다.

동작:
  1. 도구 handler가 `await request("tool_request", {...})` 호출
  2. 브리지가 Future를 등록하고 ws로 tool_request 전송
  3. WS 수신 루프가 tool_result 수신 → `resolve(id, payload)`로 Future 완료
  4. handler가 결과를 받아 SDK 루프로 반환

heartbeat: 클라가 tool_progress를 보내면 `heartbeat(id)`가 deadline을 연장한다.
"""

from __future__ import annotations

import asyncio
import time
import uuid

from fastapi import WebSocket

# heartbeat 갱신 확인용 wait chunk. 이 간격으로 깨어 deadline 재확인.
_CHUNK_SECONDS = 5.0


class AsyncBridge:
    def __init__(self, websocket: WebSocket):
        self._ws = websocket
        self._pending: dict[str, dict] = {}     # id -> {future, deadline, initial}
        self._send_lock = asyncio.Lock()        # 프레임 인터리브 방지
        self._closed = False

    # ── 전송 (단방향) ──
    async def send(self, msg_type: str, payload: dict) -> None:
        if self._closed:
            return
        async with self._send_lock:
            await self._ws.send_json({"type": msg_type, "payload": payload or {}})

    # ── 요청-응답 (양방향, 위임) ──
    async def request(self, msg_type: str, payload: dict, timeout: float = 300.0) -> dict:
        if self._closed:
            raise ConnectionError("WebSocket 연결 종료됨")

        # 호출자가 id를 명시했으면(approval_request 등) 그것을 재사용, 아니면 발급.
        req_id = payload.get("id") or uuid.uuid4().hex
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        self._pending[req_id] = {
            "future": fut,
            "deadline": time.monotonic() + timeout,
            "initial": timeout,
        }

        await self.send(msg_type, {**payload, "id": req_id})

        try:
            while True:
                entry = self._pending.get(req_id)
                if entry is None:
                    raise ConnectionError("요청이 정리되었습니다")
                remaining = entry["deadline"] - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(f"클라이언트 응답 타임아웃 ({msg_type})")
                try:
                    # shield로 timeout 시 Future 취소 방지 (heartbeat로 재대기 가능)
                    return await asyncio.wait_for(
                        asyncio.shield(fut), timeout=min(remaining, _CHUNK_SECONDS)
                    )
                except asyncio.TimeoutError:
                    continue  # deadline 재확인 (heartbeat로 갱신됐을 수 있음)
        finally:
            self._pending.pop(req_id, None)

    # ── 수신 핸들러가 호출 ──
    def resolve(self, req_id: str, payload: dict) -> bool:
        entry = self._pending.get(req_id)
        if entry is None or entry["future"].done():
            return False
        entry["future"].set_result(payload)
        return True

    def heartbeat(self, req_id: str) -> bool:
        entry = self._pending.get(req_id)
        if entry is None:
            return False
        entry["deadline"] = time.monotonic() + entry["initial"]
        return True

    def close(self) -> None:
        self._closed = True
        for entry in self._pending.values():
            fut = entry["future"]
            if not fut.done():
                fut.set_exception(ConnectionError("connection_closed"))
        self._pending.clear()

    @property
    def is_closed(self) -> bool:
        return self._closed
