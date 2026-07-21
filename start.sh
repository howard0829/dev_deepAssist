#!/bin/bash
# ──────────────────────────────────────────────────────────────
# DeepAssist 서버 통합 시작 스크립트
#   LiteLLM(4000) + DeepAssist(8000)를 한 번에 띄운다.
#   vLLM은 외부(공유 서버)에서 이미 서빙 중이라고 가정 — 여기서 시작하지 않는다.
#   Ctrl+C 시 두 프로세스를 모두 정리한다.
#
#   구동 토글(.env): START_LITELLM (이미 떠 있으면 false로 재사용)
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

# 기본값
DEEPASSIST_HOST="${DEEPASSIST_HOST:-0.0.0.0}"
DEEPASSIST_PORT="${DEEPASSIST_PORT:-8000}"
LITELLM_HOST="${LITELLM_HOST:-127.0.0.1}"
LITELLM_PORT="${LITELLM_PORT:-4000}"
START_LITELLM="${START_LITELLM:-true}"
LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY:-sk-deepassist-local}"
VLLM_BASE_URL="${VLLM_BASE_URL:-http://localhost:8080}"
export LITELLM_MASTER_KEY

LITELLM_PID=""; DEEPASSIST_PID=""

# ── 포트 점유 프로세스 정리 (관련 프로세스만) ──
kill_port() {
  local port="$1"
  local pids; pids=$(lsof -ti :"$port" 2>/dev/null || true)
  [ -z "$pids" ] && return 0
  for pid in $pids; do
    local cmd; cmd=$(basename "$(ps -p "$pid" -o comm= 2>/dev/null || true)" 2>/dev/null || true)
    case "$cmd" in
      python*|Python*|uvicorn|litellm)
        echo -e "${YELLOW}   ⚠️  포트 $port 사용 프로세스 종료: $cmd (PID $pid)${NC}"
        kill -9 "$pid" 2>/dev/null || true ;;
      *) echo -e "${YELLOW}   ⚠️  포트 $port — 시스템 프로세스 건너뜀: $cmd (PID $pid)${NC}" ;;
    esac
  done
  sleep 1
}

# ── HTTP 준비 대기 ──
wait_http() {
  local url="$1" name="$2" tries="${3:-60}"
  echo -ne "${CYAN}   ⏳ $name 준비 대기 ${NC}"
  for _ in $(seq 1 "$tries"); do
    if curl -sf -o /dev/null "$url" 2>/dev/null; then echo -e "${GREEN} ✅${NC}"; return 0; fi
    echo -n "."; sleep 2
  done
  echo -e "${RED} ❌ ($name 준비 실패: $url)${NC}"; return 1
}

# ── 종료 핸들러 ──
cleanup() {
  echo ""
  echo -e "${YELLOW}🛑 DeepAssist 서버 종료 중...${NC}"
  for pid in "$DEEPASSIST_PID" "$LITELLM_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; fi
  done
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

echo -e "\n${YELLOW}ℹ️  vLLM은 외부에서 서빙 중이라고 가정한다 (start.sh는 시작하지 않음).${NC}"
echo -e "${YELLOW}   조회 대상: ${VLLM_BASE_URL}/v1/models  — 서빙 모델명을 런타임에 읽어 사용${NC}"

# ── 1) LiteLLM (4000) ──
if [ "$START_LITELLM" = "true" ]; then
  echo -e "\n${CYAN}🔀 LiteLLM 프록시 시작 (port $LITELLM_PORT)${NC}"
  kill_port "$LITELLM_PORT"
  litellm --config litellm/config.yaml --host "$LITELLM_HOST" --port "$LITELLM_PORT" &
  LITELLM_PID=$!
  wait_http "http://${LITELLM_HOST}:${LITELLM_PORT}/health/liveliness" "LiteLLM" 60 \
    || wait_http "http://${LITELLM_HOST}:${LITELLM_PORT}/v1/models" "LiteLLM" 30 || { cleanup; }
else
  echo -e "\n${YELLOW}⏭️  LiteLLM 시작 건너뜀 (START_LITELLM=false)${NC}"
fi

# ── 2) DeepAssist (8000) ──
echo -e "\n${CYAN}🧭 DeepAssist 서버 시작 (port $DEEPASSIST_PORT)${NC}"
kill_port "$DEEPASSIST_PORT"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "   WebSocket : ${GREEN}ws://${DEEPASSIST_HOST}:${DEEPASSIST_PORT}/ws${NC}"
echo -e "   Health    : ${GREEN}http://${DEEPASSIST_HOST}:${DEEPASSIST_PORT}/api/health${NC}"
echo -e "   LiteLLM   : ${GREEN}http://${LITELLM_HOST}:${LITELLM_PORT}/v1/messages${NC}"
echo -e "   vLLM(외부): ${GREEN}${VLLM_BASE_URL}/v1/models${NC}"
echo -e "   종료      : ${YELLOW}Ctrl+C${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

python3 -m deepassist.main &
DEEPASSIST_PID=$!
wait "$DEEPASSIST_PID"
