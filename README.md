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
| vLLM | **8080** | 로컬 모델 (OpenAI 호환) |

```
VSCode 확장 ⇄(ws:8000)⇄ DeepAssist ─query()→ Claude Agent SDK ─(base_url:4000)→ LiteLLM → vLLM:8080
                              └ 위임형 MCP 도구 ─(tool_request)→ 확장이 워크스페이스에서 실행
```

## 빠른 시작

```bash
cp .env.sample .env          # 값 조정 (VLLM_MODEL 등)
pip install -r requirements.txt
pip install vllm             # GPU 환경 (START_VLLM=true 인 경우)
./start.sh                   # vLLM(8080) + LiteLLM(4000) + DeepAssist(8000) 일괄 기동
```

- 개별 실행: `python -m deepassist.main` (DeepAssist만)
- 상태: `curl http://localhost:8000/api/health`
- 이미 떠 있는 컴포넌트는 `.env`에서 `START_VLLM=false` / `START_LITELLM=false`로 재사용.

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
litellm/config.yaml  LiteLLM 프록시 설정
start.sh             통합 시작 스크립트
```

## 상태 / 검증 필요 (§11)

MVP 골격. 구현 초기 스파이크로 확인할 항목:
1. LiteLLM `/v1/messages`가 Agent SDK의 `cache_control·thinking·count_tokens`를 정상 처리하는지
2. 위임 MCP handler ↔ 세션 bridge 매칭
3. 내장 도구 비활성화 후 위임 도구만으로 도구 선택 품질(프롬프트 튜닝)
4. 위임 `tool_name`이 재사용 VSCode tool-executor 기대값과 일치하는지
