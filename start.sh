#!/bin/bash
# ──────────────────────────────────────────────────────────────
# DeepAssist 서버 시작 스크립트
#   DeepAssist(8000)만 기동한다.
#   vLLM(8080)·LiteLLM(4000)은 이 리포 밖에서 별도로 실행한다 —
#   DeepAssist는 .env 의 ANTHROPIC_BASE_URL 로 외부 LiteLLM 에 접속한다.
# ──────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'

echo -e "${GREEN}🚀 DeepAssist 서버 시작${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── .env 로드 ──
if [ -f ".env" ]; then
  set -a; source ./.env; set +a
  echo -e "${GREEN}   ✅ .env 로드${NC}"
else
  echo -e "${YELLOW}   ⚠️  .env 없음 — 기본값으로 진행 ( cp .env.sample .env 권장 )${NC}"
fi

DEEPASSIST_HOST="${DEEPASSIST_HOST:-0.0.0.0}"
DEEPASSIST_PORT="${DEEPASSIST_PORT:-8000}"
ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-http://127.0.0.1:4000}"
VLLM_BASE_URL="${VLLM_BASE_URL:-http://localhost:8080}"

DEEPASSIST_PID=""

# ── 포트 점유 프로세스 정리 (관련 프로세스만) ──
kill_port() {
  local port="$1"
  local pids; pids=$(lsof -ti :"$port" 2>/dev/null || true)
  [ -z "$pids" ] && return 0
  for pid in $pids; do
    local cmd; cmd=$(basename "$(ps -p "$pid" -o comm= 2>/dev/null || true)" 2>/dev/null || true)
    case "$cmd" in
      python*|Python*|uvicorn)
        echo -e "${YELLOW}   ⚠️  포트 $port 사용 프로세스 종료: $cmd (PID $pid)${NC}"
        kill -9 "$pid" 2>/dev/null || true ;;
      *) echo -e "${YELLOW}   ⚠️  포트 $port — 시스템 프로세스 건너뜀: $cmd (PID $pid)${NC}" ;;
    esac
  done
  sleep 1
}

cleanup() {
  echo ""
  echo -e "${YELLOW}🛑 DeepAssist 서버 종료 중...${NC}"
  if [ -n "$DEEPASSIST_PID" ] && kill -0 "$DEEPASSIST_PID" 2>/dev/null; then
    kill "$DEEPASSIST_PID" 2>/dev/null || true
  fi
  echo -e "${GREEN}✅ 종료 완료${NC}"
  exit 0
}
trap cleanup SIGINT SIGTERM

# ── 의존성 확인 ──
echo -e "\n${CYAN}📦 Python 의존성 확인${NC}"
if ! python3 -c "import fastapi, uvicorn" 2>/dev/null; then
  echo -e "${YELLOW}   필수 패키지 설치...${NC}"; pip install -r requirements.txt
else
  echo -e "${GREEN}   ✅ fastapi/uvicorn 확인${NC}"
fi

echo -e "\n${YELLOW}ℹ️  vLLM·LiteLLM은 외부에서 별도로 실행한다 (start.sh는 시작하지 않음).${NC}"
echo -e "${YELLOW}   - LiteLLM 접속: ${ANTHROPIC_BASE_URL}${NC}"
echo -e "${YELLOW}   - vLLM 조회:   ${VLLM_BASE_URL}/v1/models${NC}"

# ── DeepAssist (8000) ──
echo -e "\n${CYAN}🧭 DeepAssist 서버 시작 (port $DEEPASSIST_PORT)${NC}"
kill_port "$DEEPASSIST_PORT"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "   WebSocket : ${GREEN}ws://${DEEPASSIST_HOST}:${DEEPASSIST_PORT}/ws${NC}"
echo -e "   Health    : ${GREEN}http://${DEEPASSIST_HOST}:${DEEPASSIST_PORT}/api/health${NC}"
echo -e "   종료      : ${YELLOW}Ctrl+C${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

python3 -m deepassist.main &
DEEPASSIST_PID=$!
wait "$DEEPASSIST_PID"
