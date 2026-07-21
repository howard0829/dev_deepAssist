# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 무엇인가

VSCode UI 기반 AI 코딩 에이전트/오케스트레이터. 자체 에이전트 루프를 구현하지 않고
**Claude Agent SDK를 core agent로 감싼다**. **DeepAssist**(서버측 오케스트레이션 계층)가
SDK의 `query()` 옵션을 조립하고, 워크스페이스 도구를 WebSocket으로 VSCode 확장에 위임한다.

권위 있는 설계 문서: **`docs/design/architecture.md`**. 코드 주석의 `§N`은 이 문서의 절을
가리킨다(예: `⚠ 검증(§11)`).

## 명령어

```bash
cp .env.sample .env                 # 최초 1회 — VLLM_MODEL 등 조정
pip install -r requirements.txt     # + pip install vllm  (START_VLLM=true 인 GPU 환경)
./start.sh                          # vLLM(8080)+LiteLLM(4000)+DeepAssist(8000) 일괄 기동, Ctrl+C 일괄 정리
python -m deepassist.main           # DeepAssist(8000)만 단독 기동
curl http://localhost:8000/api/health
python -m py_compile deepassist/*.py deepassist/ws/*.py deepassist/tools/*.py   # 문법 검사
bash -n start.sh                    # 스크립트 문법 검사
```

- **테스트 스위트는 아직 없다.** 위 두 문법 검사가 현재 유일한 정적 확인 수단.
- 세 컴포넌트 중 이미 떠 있는 것은 `.env`에서 `START_VLLM=false`/`START_LITELLM=false`로 재사용.
- 포트는 고정: DeepAssist **8000**, LiteLLM **4000**, vLLM **8080**.

## 아키텍처 (여러 파일을 읽어야 이해되는 큰 그림)

**핵심 결정 — SDK는 서버, 워크스페이스 도구는 클라 위임.**
Claude Agent SDK는 통제된 서버에서 돌고, 그 **내장 도구(Bash/Read/Write/Edit/Glob/Grep)는
서버 파일시스템에서 실행**된다. 서버엔 사용자 파일이 없으므로, 이 내장 도구를
`disallowed_tools`로 **끄고**(`config.DISABLED_BUILTINS`), 같은 책임의 **위임형 SDK MCP
도구**(`tools/delegated.py`)로 대체한다. 각 handler는 세션 bridge로 `tool_request`를
클라에 보내고 `tool_result`를 기다린다 — 실제 실행은 VSCode 확장이 사용자 워크스페이스에서
한다. (훅으로는 위임 불가: 내장 도구가 서버에서 먼저 실행되기 때문. §5.2)

**요청 경로.** `main.py`(/ws) → `ws/handler.py`가 메시지 라우팅 → `user_message`면
`orchestrator.run()`을 태스크로 시작 → `orchestrator._build_options()`가
`ClaudeAgentOptions`(위임 MCP + knowledge MCP + skills + system_prompt + permission)를 조립 →
`async for msg in query(...)` 루프가 SDK 메시지를 `_translate()`로 UI 프로토콜로 변환.

**async 브리지가 핵심.** `ws/bridge.py`는 `asyncio.Future` 기반(기존 G-TAS의 동기
`threading.Event` 브리지와 다름). 위임 도구 handler와 `query()` 루프가 **같은 이벤트
루프에서 동시에** 돌기 때문에 가능하다: handler가 `await bridge.request(...)`로 Future를
대기하고, 수신 루프가 `tool_result` 도착 시 `bridge.resolve()`로 완료시킨다.
`tool_progress`는 `bridge.heartbeat()`로 deadline을 연장한다.

**LLM 연결.** Agent SDK는 `ANTHROPIC_BASE_URL`(→ LiteLLM 4000)로 붙어 Anthropic 포맷
`/v1/messages`를 호출한다. LiteLLM(`litellm/config.yaml`)이 vLLM/OpenAI로 변환한다. base URL과
토큰은 `orchestrator._build_options()`의 `env=`와 `main.py`의 `os.environ.setdefault`로 이중
주입(SDK가 native 서브프로세스를 spawn하므로).

## 이 저장소에서 지켜야 할 것들

- **`deepassist/config.py`가 모든 환경변수의 SSOT.** 값·기본값을 다른 곳에 복제하지 말 것.
- **`deepassist/protocol.py`의 메시지 필드명은 재사용하는 VSCode 확장(`../dev_agent_client`의
  `shared/protocol.py`)과 반드시 일치**해야 한다. 확장은 이 프로젝트에서 재구현하지 않고 그대로
  쓴다. 마찬가지로 위임 `tool_name`(`config.CLIENT_TOOL_NAME`)은 확장 `tool-executor`가
  기대하는 이름과 맞아야 한다(§11 검증 항목).
- **SDK 연동은 런타임 미검증.** 옵션 kwarg명, SDK 메시지 클래스/필드, `@tool` 스키마 형태 등은
  코드에 `⚠ 검증(§11)`로 표시. SDK 메시지는 클래스명 변경에 견디도록 `_translate()`에서
  `type(msg).__name__` + `getattr`로 방어적으로 처리한다 — 이 패턴을 유지할 것.
- **SDK 의존 모듈은 지연 import.** `orchestrator._build_options()`가 `tools/*`를 함수 내부에서
  import한다. SDK 미설치 시에도 서버가 부팅되고 `user_message`에서만 `sdk_missing`을 반환하기
  위함 — 최상단으로 끌어올리지 말 것.
- **언어 컨벤션**: docstring·주석·UI 메시지·프롬프트는 **한국어**, 코드 식별자는 **영어**
  (PEP 8). 형제 저장소 `../dev_agent_client`의 관습을 따른다 — RAG·MCP·UI 재사용 시 참고.

## 미완/후속 (§10·§11)

`tools/knowledge.py`의 RAG는 stub — `../dev_agent_client/g_tas_server/rag` 연결 예정. 토큰
단위 스트리밍(`include_partial_messages`)·승인 게이트(`canUseTool`→`approval_request`)·멀티턴
`resume`는 골격만 존재. 새 기능 추가 전 설계 문서의 해당 절을 먼저 확인할 것.
