# dev_deepAssist

VSCode UI 기반 AI 코딩 에이전트/오케스트레이터. **DeepAssist**가 MCP·RAG·skills를
관리해 **Claude Agent SDK**(core agent)에 넘기고, 워크스페이스 도구는 WebSocket으로
VSCode 확장에 위임한다. LLM은 원격 **LiteLLM** 프록시를 거쳐 **vLLM·OpenAI**로 연결.

설계 문서: [`docs/design/architecture.md`](docs/design/architecture.md) · [HTML](docs/design/architecture.html)

## 구성 / 포트

| 컴포넌트 | 포트 | 역할 |
|---|---|---|
| DeepAssist | **8000** | WebSocket 서버 + 오케스트레이터 + Agent SDK |
| LiteLLM | **4000** | Anthropic `/v1/messages` → vLLM/OpenAI 변환 |
| vLLM | **8080** | 로컬 모델 (OpenAI 호환) — **외부에서 서빙**, 모델명은 `/v1/models`로 읽음 |

```
VSCode 확장 ⇄(ws:8000)⇄ DeepAssist ─query()→ Claude Agent SDK ─(base_url:4000)→ LiteLLM → vLLM:8080
                              └ 위임형 MCP 도구 ─(tool_request)→ 확장이 워크스페이스에서 실행
```

## 실행 환경 (서버 ↔ 클라이언트 분리)

로컬 단일 머신이 아니라 **물리적으로 다른 두 머신**에서 동작한다.

- **서버**: 고정 **Ubuntu 22.04 워크스테이션**. DeepAssist(8000)·LiteLLM(4000)이 여기서 돌고,
  vLLM은 이 서버에서 `:8080`으로 서빙된다. 설정/스크립트의 `localhost`·`127.0.0.1`은 모두
  **서버 호스트** 기준이다(클라이언트의 localhost 아님).
- **클라이언트**: **Windows 또는 Linux** 중 하나의 VSCode. 확장이 파일/셸 도구를 **자기 OS에서
  native 실행**하며, 서버는 클라이언트 워크스페이스를 직접 건드리지 않는다(경로는 라벨).
- **연결**: 확장 → 서버는 네트워크 WebSocket. 설치 후 설정에서
  `gtas.serverUrl = ws://<서버-IP>:8000` (localhost 아님). 서버 8000 포트가 클라이언트에
  네트워크로 열려 있어야 한다(`DEEPASSIST_HOST=0.0.0.0` + 방화벽).

> 서버 코드 수정 시 **클라이언트 OS(Windows/Linux)를 가정하지 말 것** — 경로 형식·셸이 다르다.
> 셸 감지·위험명령 차단은 클라이언트가 담당하고, 서버는 경로를 라벨로만 다룬다.

## 빠른 시작

```bash
cp .env.sample .env          # 값 조정 (VLLM_BASE_URL 등)
pip install -r requirements.txt
./start.sh                   # LiteLLM(4000) + DeepAssist(8000) 일괄 기동 (vLLM은 외부)
```

- vLLM은 외부(공유 서버)에서 이미 서빙 중이라고 가정 — `start.sh`는 시작하지 않는다.
  서빙 모델명은 선언하지 않고 `VLLM_BASE_URL/v1/models`로 읽어 사용(dev_agent_client 방식).
- 개별 실행: `python -m deepassist.main` (DeepAssist만)
- 상태: `curl http://localhost:8000/api/health`
- 이미 떠 있는 LiteLLM을 재사용하려면 `.env`에서 `START_LITELLM=false`.

## VSCode 확장(클라이언트) 빌드

기존 확장을 재사용하며 `deepassist-vscode/`에 동봉. `.vsix`를 빌드해 설치한다.

```bash
./build_client.sh                        # → deepassist-vscode/*.vsix (Node 20+ 필요)
code --install-extension deepassist-vscode/<파일>.vsix
# 설치 후: 설정 gtas.serverUrl = ws://<서버IP>:8000
```

- 확장 위치 변경: `EXT_DIR=/path/to/ext ./build_client.sh`
- in-repo 확장이 없으면 `../dev_agent_client/g-tas-vscode`로 자동 폴백.

## 주요 환경변수 (`.env`)

`DEEPASSIST_PORT`·`LITELLM_PORT`·`VLLM_PORT`(포트), `VLLM_MODEL`(서빙 모델),
`DEEPASSIST_MODEL`(LiteLLM model_name), `LITELLM_MASTER_KEY`(=Agent SDK 인증 토큰),
`DEEPASSIST_PERMISSION_MODE`, `DEEPASSIST_SKILLS` 등. 전체는 `.env.sample` 참고.

## 디렉토리

```
deepassist/          DeepAssist 서버 (Python)
  main.py            FastAPI + /ws 엔트리포인트
  config.py          환경변수 설정(SSOT)
  protocol.py        WS 메시지 타입 (기존 확장과 호환)
  prompts.py         위임 도구 시스템 프롬프트 보강(§9.1)
  orchestrator.py    query() 옵션 조립 + SDK 이벤트 → UI 번역
  ws/                bridge(async 위임) · session · handler
  tools/             delegated(클라 위임) · knowledge(서버직접 RAG)
deepassist-vscode/   VSCode 확장 (재사용, TypeScript) — 빌드 대상
litellm/config.yaml  LiteLLM 프록시 설정
start.sh             서버 통합 시작 스크립트
build_client.sh      확장 .vsix 빌드 스크립트
```

## 변경 시 주의 (확산 확인)

포트·프로토콜 필드·모델명·LiteLLM 키 등은 여러 파일과 클라이언트 확장에 걸쳐 있다. **한 곳을
바꾸면 그 값이 참조되는 모든 곳을 확산 전개하여 함께 확인·수정할 것** — 예: 포트를 바꾸면
`.env`·`litellm/config.yaml`·`start.sh`·`config.py`·문서·클라이언트 `gtas.serverUrl`을 모두
맞춰야 한다. 항목별 상세 표는 `CLAUDE.md`의 **"변경 시 확산(ripple) 확인"** 참조.

## 상태 / 검증 필요 (§11)

MVP 골격. 구현 초기 스파이크로 확인할 항목:
1. LiteLLM `/v1/messages`가 Agent SDK의 `cache_control·thinking·count_tokens`를 정상 처리하는지
2. 위임 MCP handler ↔ 세션 bridge 매칭
3. 내장 도구 비활성화 후 위임 도구만으로 도구 선택 품질(프롬프트 튜닝)
4. 위임 `tool_name`이 재사용 VSCode tool-executor 기대값과 일치하는지
