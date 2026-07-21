#!/bin/bash
# ──────────────────────────────────────────────────────────────
# DeepAssist VSCode 확장 빌드 스크립트
#   .vsix 설치 파일을 생성한다. (dev_agent_client/build_client.sh 참고)
#
#   대상 확장 디렉토리:
#     기본  deepassist-vscode/   (이 리포에 동봉된 재사용 확장)
#     없으면 ../dev_agent_client/g-tas-vscode 로 폴백
#     EXT_DIR 환경변수로 강제 지정 가능:  EXT_DIR=/path/to/ext ./build_client.sh
# ──────────────────────────────────────────────────────────────
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'

echo -e "${GREEN}🔨 DeepAssist VSCode 확장 빌드${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 대상 확장 디렉토리 결정 ──
if [ -n "${EXT_DIR:-}" ]; then
    VSCODE_DIR="$EXT_DIR"
elif [ -d "$SCRIPT_DIR/deepassist-vscode" ]; then
    VSCODE_DIR="$SCRIPT_DIR/deepassist-vscode"
elif [ -d "$SCRIPT_DIR/../dev_agent_client/g-tas-vscode" ]; then
    VSCODE_DIR="$SCRIPT_DIR/../dev_agent_client/g-tas-vscode"
    echo -e "${YELLOW}   ⚠️  in-repo 확장이 없어 형제 리포로 폴백: $VSCODE_DIR${NC}"
else
    echo -e "${RED}   ❌ 확장 디렉토리를 찾을 수 없습니다. EXT_DIR로 지정하세요.${NC}"
    exit 1
fi
echo -e "${CYAN}   대상: ${VSCODE_DIR}${NC}"

# ── 필수 도구 확인 ──
echo -e "\n${CYAN}📋 빌드 환경 확인${NC}"
if ! command -v node &>/dev/null; then
    echo -e "${RED}   ❌ Node.js 미설치 — https://nodejs.org/ LTS 20+${NC}"; exit 1
fi
NODE_VER=$(node --version)
NODE_MAJOR=$(echo "$NODE_VER" | sed -E 's/^v([0-9]+).*/\1/')
if [ "$NODE_MAJOR" -lt 20 ]; then
    echo -e "${RED}   ❌ Node.js ${NODE_VER} — v20 이상 필요 (@vscode/vsce 요구사항).${NC}"
    echo -e "      ${YELLOW}nvm:${NC} nvm install 20 && nvm use 20"
    exit 1
fi
echo -e "${GREEN}   ✅ Node.js ${NODE_VER}${NC}"
command -v npm &>/dev/null || { echo -e "${RED}   ❌ npm 미설치${NC}"; exit 1; }
echo -e "${GREEN}   ✅ npm $(npm --version)${NC}"

# npm 부수 효과 억제
export NPM_CONFIG_LOGS_MAX=0
export NPM_CONFIG_FUND=false
export NPM_CONFIG_AUDIT=false
export NPM_CONFIG_LOGLEVEL=error

cd "$VSCODE_DIR"

# ── 의존성 설치 ──
echo -e "\n${CYAN}📦 의존성 설치${NC}"
if [ ! -d "node_modules" ]; then
    echo -e "   npm install 실행 중..."; npm install
else
    echo -e "${GREEN}   ✅ node_modules 존재 — 스킵 (재설치: rm -rf node_modules)${NC}"
fi

# ── 타입 체크 + esbuild 번들 ──
echo -e "\n${CYAN}⚙️  타입 체크${NC}"
npm run check-types
echo -e "${GREEN}   ✅ 타입 체크 통과${NC}"

echo -e "\n${CYAN}📦 esbuild 번들 (production)${NC}"
node esbuild.js --production
echo -e "${GREEN}   ✅ dist/extension.js (의존성 인라인)${NC}"

# ── 리비전 자동 증가 (vsix가 바뀌면 버전 상향 — VSCode가 재설치를 업데이트로 인식) ──
# NO_BUMP=1 로 건너뛸 수 있음.
if [ "${NO_BUMP:-0}" != "1" ]; then
  NEW_VER=$(node -e '
const fs=require("fs");
let s=fs.readFileSync("package.json","utf8");let out="";
s=s.replace(/("version"\s*:\s*")(\d+)\.(\d+)\.(\d+)(")/,(m,a,x,y,z,b)=>{out=x+"."+y+"."+(+z+1);return a+out+b;});
fs.writeFileSync("package.json",s);process.stdout.write(out);
')
  echo -e "${CYAN}   🔖 리비전 상향 → v${NEW_VER}${NC}"
else
  echo -e "${YELLOW}   ⏭️  리비전 상향 건너뜀 (NO_BUMP=1)${NC}"
fi

# ── .vsix 패키징 ──
echo -e "\n${CYAN}📦 .vsix 패키지 생성${NC}"
npx @vscode/vsce package --allow-missing-repository 2>&1 | tail -3

VSIX_FILE=$(ls -t ./*.vsix 2>/dev/null | head -1)
if [ -z "$VSIX_FILE" ]; then
    echo -e "\n${RED}❌ .vsix 생성 실패${NC}"; exit 1
fi
VSIX_PATH="$VSCODE_DIR/$(basename "$VSIX_FILE")"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✅ 빌드 완료!${NC}"
echo -e "   파일: ${CYAN}${VSIX_PATH}${NC}   (크기: $(du -h "$VSIX_FILE" | cut -f1))"
echo ""
echo -e "   ${YELLOW}설치:${NC} code --install-extension ${VSIX_PATH}"
echo -e "         또는 VSCode → Extensions → ··· → Install from VSIX..."
echo -e "   ${YELLOW}설정:${NC} gtas.serverUrl = ws://<서버IP>:8000  (DeepAssist)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
