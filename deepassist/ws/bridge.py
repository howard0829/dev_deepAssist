"""AsyncBridge — 루프/스레드 안전 위임 브리지.

Agent SDK가 in-process MCP 도구 handler(_delegate)를 **WSHandler와 다른 이벤트 루프/
스레드**에서 호출할 수 있다. 이 경우 handler가 만든 Future를 WSHandler 루프에서 그냥
set_result 하면 대기 코루틴이 깨어나지 않아 무한 대기한다. 그래서:

  - 각 요청의 Future와 그 **소유 루프**를 함께 기록하고,
  - resolve/close는 그 소유 루프에 `call_soon_threadsafe`로 결과를 설정하며,
  - send는 호출 루프가 소유(WSHandler) 루프와 다르면 `run_coroutine_threadsafe`로
    소유 루프에서 실제 ws 전송을 수행한다(웹소켓·send_lock은 소유 루프 전용).
  - _pending은 threading.Lock으로 보호(다중 스레드 접근 대비).

동작: handler가 `await request()` → tool_request 전송 → WS 수신 루프가 tool_result 수신
시 `resolve()` → handler의 Future가 소유 루프에서 완료 → handler 재개.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
import uuid

from fastapi import WebSocket

logger = logging.getLogger(__name__)

# heartbeat 갱신 확인용 wait chunk.
_CHUNK_SECONDS = 5.0


def _set_result_if_pending(fut: asyncio.Future, payload: dict) -> None:
    if not fut.done():
        fut.set_result(payload)


def _set_exc_if_pending(fut: asyncio.Future, exc: BaseException) -> None:
    if not fut.done():
        fut.set_exception(exc)


class AsyncBridge:
    def __init__(self, websocket: WebSocket):
        self._ws = websocket
        self._loop = asyncio.get_running_loop()   # WSHandler(소유) 루프
        self._pending: dict[str, dict] = {}       # id -> {future, loop, deadline, initial}
        self._lock = threading.Lock()             # _pending 보호
        self._send_lock = asyncio.Lock()          # 소유 루프 전용 — 프레임 인터리브 방지
        self._closed = False

    # ── 전송 (소유 루프에서 실제 write) ──
    async def _send_on_owner(self, message: dict) -> None:
        async with self._send_lock:
            await self._ws.send_json(message)

    async def send(self, msg_type: str, payload: dict) -> None:
        if self._closed:
            return
        message = {"type": msg_type, "payload": payload or {}}
        cur = asyncio.get_running_loop()
        if cur is self._loop:
            await self._send_on_owner(message)
        else:
            # 다른 루프/스레드에서 호출 — 소유 루프에 스케줄하고 현재 루프에서 대기.
            cfut = asyncio.run_coroutine_threadsafe(self._send_on_owner(message), self._loop)
            await asyncio.wrap_future(cfut)

    # ── 요청-응답 (위임) ──
    async def request(self, msg_type: str, payload: dict, timeout: float = 300.0) -> dict:
        if self._closed:
            raise ConnectionError("WebSocket 연결 종료됨")

        req_id = payload.get("id") or uuid.uuid4().hex
        cur = asyncio.get_running_loop()          # 호출자(_delegate) 루프
        fut: asyncio.Future = cur.create_future()
        with self._lock:
            self._pending[req_id] = {
                "future": fut, "loop": cur,
                "deadline": time.monotonic() + timeout, "initial": timeout,
            }
        logger.debug("bridge.request id=%s type=%s owner_loop=%s cur_loop=%s",
                     req_id, msg_type, id(self._loop), id(cur))

        await self.send(msg_type, {**payload, "id": req_id})

        try:
            while True:
                with self._lock:
                    entry = self._pending.get(req_id)
                    deadline = entry["deadline"] if entry else 0.0
                if entry is None:
                    raise ConnectionError("요청이 정리되었습니다")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError(f"클라이언트 응답 타임아웃 ({msg_type})")
                try:
                    return await asyncio.wait_for(
                        asyncio.shield(fut), timeout=min(remaining, _CHUNK_SECONDS))
                except asyncio.TimeoutError:
                    continue  # deadline 재확인 (heartbeat 갱신 가능)
        finally:
            with self._lock:
                self._pending.pop(req_id, None)

    # ── WS 수신 루프(소유 루프)에서 호출 ──
    def resolve(self, req_id: str, payload: dict) -> bool:
        with self._lock:
            entry = self._pending.get(req_id)
        if entry is None:
            logger.warning("bridge.resolve: 대기 없음 id=%s (id 불일치/이미 완료)", req_id)
            return False
        fut = entry["future"]
        if fut.done():
            return False
        # Future의 소유 루프에서 안전하게 결과 설정 (cross-loop 대응).
        entry["loop"].call_soon_threadsafe(_set_result_if_pending, fut, payload)
        logger.debug("bridge.resolve: id=%s → 전달", req_id)
        return True

    def heartbeat(self, req_id: str) -> bool:
        with self._lock:
            entry = self._pending.get(req_id)
            if entry is None:
                return False
            entry["deadline"] = time.monotonic() + entry["initial"]
        return True

    def close(self) -> None:
        self._closed = True
        with self._lock:
            entries = list(self._pending.values())
            self._pending.clear()
        for entry in entries:
            fut = entry["future"]
            if not fut.done():
                entry["loop"].call_soon_threadsafe(
                    _set_exc_if_pending, fut, ConnectionError("connection_closed"))

    @property
    def is_closed(self) -> bool:
        return self._closed
