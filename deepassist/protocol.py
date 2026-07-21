"""WebSocket 프로토콜 — 메시지 타입.

기존 VSCode 확장을 재사용하므로, 확장이 기대하는 `dev_agent_client`의
protocol.py 필드명과 **동일**해야 한다. 여기서는 DeepAssist가 실제로 쓰는
부분집합만 정의한다. 와이어 포맷: {"type": <str>, "payload": <dict>}.
"""

from __future__ import annotations

from typing import Any


class MessageType:
    # Client → Server
    USER_MESSAGE = "user_message"
    TOOL_RESULT = "tool_result"
    TOOL_PROGRESS = "tool_progress"          # 장시간 도구 heartbeat
    STOP_REQUEST = "stop_request"
    APPROVAL_RESPONSE = "approval_response"
    WORKSPACE_METADATA = "workspace_metadata"
    SESSION_RESET = "session_reset"
    FETCH_VLLM_MODELS = "fetch_vllm_models"   # 설정 패널 — 서버 망에서 vLLM /v1/models 조회
    PING = "ping"

    # Server → Client
    SESSION_INIT = "session_init"
    FETCH_VLLM_MODELS_RESULT = "fetch_vllm_models_result"
    AGENT_TEXT = "agent_text"
    AGENT_COMPLETE = "agent_complete"
    TOOL_REQUEST = "tool_request"            # 워크스페이스 도구 위임
    TOOL_CALL_UPDATE = "tool_call_update"
    STATUS_UPDATE = "status_update"
    MODIFIED_FILE_DIFF = "modified_file_diff"
    APPROVAL_REQUEST = "approval_request"
    ERROR = "error"
    PONG = "pong"


def encode(msg_type: str, payload: Any) -> dict:
    """{"type", "payload"} 봉투로 직렬화."""
    if not isinstance(payload, dict):
        payload = {}
    return {"type": msg_type, "payload": payload}


def decode(data: dict) -> tuple[str, dict]:
    """수신 dict를 (타입, payload)로 분해."""
    return data.get("type", ""), data.get("payload", {}) or {}
