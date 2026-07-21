"""환경변수 기반 서버 설정 (SSOT).

start.sh가 .env를 셸 환경으로 로드하지만, 직접 실행(`python -m deepassist.main`)도
지원하도록 여기서도 .env를 로드한다.
"""

from __future__ import annotations

import os
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parent.parent / ".env")
except Exception:  # dotenv 미설치여도 셸 환경변수로 동작
    pass


def _bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


# ── 포트/호스트 ──
DEEPASSIST_HOST = os.getenv("DEEPASSIST_HOST", "0.0.0.0")
DEEPASSIST_PORT = int(os.getenv("DEEPASSIST_PORT", "8000"))
LITELLM_HOST = os.getenv("LITELLM_HOST", "127.0.0.1")
LITELLM_PORT = int(os.getenv("LITELLM_PORT", "4000"))
# vLLM은 외부에서 서빙 중. 모델명은 /v1/models로 읽어 사용(dev_agent_client 방식).
VLLM_BASE_URL = os.getenv("VLLM_BASE_URL", "http://localhost:8080").rstrip("/")

# ── LLM 연결 (Agent SDK → LiteLLM, Anthropic 포맷) ──
ANTHROPIC_BASE_URL = os.getenv("ANTHROPIC_BASE_URL", "").strip() \
    or f"http://{LITELLM_HOST}:{LITELLM_PORT}"
ANTHROPIC_AUTH_TOKEN = os.getenv("ANTHROPIC_AUTH_TOKEN", "").strip() \
    or os.getenv("LITELLM_MASTER_KEY", "sk-deepassist-local")
DEEPASSIST_MODEL = os.getenv("DEEPASSIST_MODEL", "deepassist")

# ── 에이전트 동작 ──
PERMISSION_MODE = os.getenv("DEEPASSIST_PERMISSION_MODE", "acceptEdits")
APPROVAL_TOOLS = [t.strip() for t in os.getenv("DEEPASSIST_APPROVAL_TOOLS", "").split(",") if t.strip()]
SKILLS = os.getenv("DEEPASSIST_SKILLS", "all").strip()   # "all" | "a,b" | ""
TOOL_TIMEOUT = float(os.getenv("DEEPASSIST_TOOL_TIMEOUT", "300"))
MAX_SESSIONS = int(os.getenv("DEEPASSIST_MAX_SESSIONS", "200"))
CORS_ORIGINS = [o.strip() for o in os.getenv("DEEPASSIST_CORS_ORIGINS", "*").split(",")]

# ── 도구 분류 (§5) ──
# 클라 위임 도구: 모델에는 mcp__deepassist__<name> 으로 노출. 서버 FS 오염을 막기
# 위해 SDK 내장 동종 도구(DISABLED_BUILTINS)는 disallowed_tools로 제거한다.
DELEGATED_TOOLS = ["bash", "read", "write", "edit", "glob", "grep"]
DISABLED_BUILTINS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"]

# 위임 시 tool_request.tool_name 으로 보낼 클라이언트측 도구명 매핑.
# ⚠ 검증(§11): 재사용하는 VSCode tool-executor가 기대하는 이름과 일치해야 한다.
CLIENT_TOOL_NAME = {
    "bash": "Bash", "read": "Read", "write": "Write",
    "edit": "Edit", "glob": "Glob", "grep": "Grep",
}


def skills_option():
    """SKILLS 문자열을 Agent SDK skills 옵션 형태로 변환."""
    if not SKILLS:
        return []
    if SKILLS == "all":
        return "all"
    return [s.strip() for s in SKILLS.split(",") if s.strip()]
