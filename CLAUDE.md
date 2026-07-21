# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 무엇인가

VSCode UI 기반 AI 코딩 에이전트/오케스트레이터. 자체 에이전트 루프를 구현하지 않고
**Claude Agent SDK를 core agent로 감싼다**. **DeepAssist**(서버측 오케스트레이션 계층)가
SDK의 `query()` 옵션을 조립하고, 워크스페이스 도구를 WebSocket으로 VSCode 확장에 위임한다.

권위 있는 설계 문서: **`docs/design/architecture.md`**. 코드 주석의 `§N`은 이 문서의 절을
가리킨다(예: `⚠ 검증(§11)`).

## 배포 토폴로지 · 실행 환경

**서버와 클라이언트는 물리적으로 다른 머신에서 동작한다. 로컬 단일 머신이 아니다.**

- **서버**: 고정된 **Ubuntu 22.04 워크스테이션** 1대. **DeepAssist(8000)만 이 리포가 기동**하고,
  **LiteLLM(4000)·vLLM(8080)은 이 리포 밖에서 별도로 실행**한다(같은 서버든 다른 곳이든 무방).
  DeepAssist는 `.env`의 `ANTHROPIC_BASE_URL`로 외부 LiteLLM에 접속한다. `start.sh`·health의
  `localhost`/`127.0.0.1`은 모두 **이 서버 호스트** 기준이다 — 클라이언트 머신의 localhost가 아니다.
- **클라이언트**: **Windows 또는 Linux** 중 하나의 VSCode. 확장이 파일/셸 도구를 **자기 OS에서
  native 실행**한다. 서버는 클라이언트 워크스페이스를 직접 만지지 않으며, 워크스페이스 경로는
  라벨로만 보유한다.
- **연결**: 확장 ↔ 서버는 네트워크 WebSocket. 설정 `gtas.serverUrl = ws://<서버-IP>:8000`
  (localhost 아님). 서버는 `DEEPASSIST_HOST=0.0.0.0`으로 외부 접속을 받고, 방화벽/보안그룹에서
  8000 포트가 클라이언트에 열려 있어야 한다.

**멀티 OS 불변식 (서버 코드 수정 시 필수 고려) — 서버는 클라이언트 OS를 가정하지 말 것:**
- 경로 구분자·절대경로 형식이 Windows(`C:\...`)와 Linux(`/home/...`)에서 다르다. 서버는 경로를
  파싱·정규화하지 말고 **불투명 라벨**로 전달한다(위임 도구 args를 그대로 클라에 위임).
- 셸이 다르다(Linux `bash` vs Windows `git-bash`/`powershell`/`cmd`). 셸 감지·위험명령 차단은
  **클라이언트 tool-executor**가 담당한다. 서버는 POSIX 셸을 가정한 명령을 합성하지 않는다.
- 줄바꿈(CRLF/LF)·파일 인코딩 차이에 민감한 도구 결과 처리에 주의.

## 명령어

```bash
cp .env.sample .env                 # 최초 1회 — ANTHROPIC_BASE_URL(외부 LiteLLM) 등 조정
pip install -r requirements.txt
./start.sh                          # DeepAssist(8000)만 기동/정리 (vLLM·LiteLLM은 외부에서 별도 실행)
python -m deepassist.main           # DeepAssist(8000)만 단독 기동
curl http://localhost:8000/api/health
python -m py_compile deepassist/*.py deepassist/ws/*.py deepassist/tools/*.py   # 문법 검사
bash -n start.sh                    # 스크립트 문법 검사
./build_client.sh                   # VSCode 확장(deepassist-vscode/) → .vsix (Node 20+)
```

**클라이언트 확장(`deepassist-vscode/`)은 형제 리포 `../dev_agent_client/g-tas-vscode`를
그대로 가져온 재사용 코드**다. 명령/뷰/설정 ID는 `gtas.*`로 남아 있고(표시 이름만 DeepAssist로
경량 리브랜딩), 서버와의 계약은 `protocol.py` 필드명·`CLIENT_TOOL_NAME`으로 맞춘다. 확장 내부
로직을 수정하기 전, 서버 protocol과의 호환을 먼저 확인할 것. `build_client.sh`는 `EXT_DIR`로
대상 지정, 없으면 형제 리포로 폴백. **확장을 바꾸면 `deepassist-vscode/package.json`의 version을
올려야** VSCode가 재설치를 업데이트로 인식한다(같은 버전 vsix는 갱신 안 됨). `build_client.sh`가
빌드마다 patch를 자동 증가시킨다(`NO_BUMP=1`로 생략). 설치 후 webview 캐시 때문에 **Reload
Window**가 필요할 수 있다.

- **테스트 스위트는 아직 없다.** 위 두 문법 검사가 현재 유일한 정적 확인 수단.
- **vLLM·LiteLLM은 외부에서 별도 실행**한다. DeepAssist는 `.env`의 `ANTHROPIC_BASE_URL`로 외부
  LiteLLM에 접속하고, `start.sh`는 DeepAssist(8000)만 띄운다. LiteLLM 설정/기동은 이 리포 밖.
- 포트: DeepAssist **8000**(이 리포) / LiteLLM **4000** · vLLM **8080**(외부).

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

**LLM 연결.** Agent SDK는 `.env`의 `ANTHROPIC_BASE_URL`(외부 LiteLLM, 기본 4000)로 붙어 Anthropic
포맷 `/v1/messages`를 호출한다. **외부 LiteLLM**이 vLLM/OpenAI로 변환한다(LiteLLM 설정·실행은 이
리포 밖에서 관리). base URL과 토큰은 `orchestrator._build_options()`의 `env=`와 `main.py`의
`os.environ.setdefault`로 이중 주입(SDK가 native 서브프로세스를 spawn하므로).

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

## 변경 시 확산(ripple) 확인 — 필수 절차

**어느 한 곳을 바꾸면, 그 값/계약이 참조되는 다른 모든 곳을 확산 전개하여 함께 확인·수정한다.**
한쪽만 고치면 다른 파일·다른 OS·클라이언트에서 조용히 깨진다. 변경 전 아래 표에서 해당 항목의
"함께 확인할 곳"을 모두 점검하고, 변경 후 `python -m py_compile ...`·`bash -n ...`로 재확인한다.

| 바꾸는 것 | 함께 확인/수정할 곳 |
|---|---|
| **포트**(8000·4000·8080) | `.env(.sample)` · `start.sh`(8000) · `deepassist/config.py` · `README.txt`·`CLAUDE` · **클라이언트 `gtas.serverUrl`(8000)** · 외부 LiteLLM(4000)·vLLM(8080) 실행 설정 |
| **WS 메시지 필드**(`protocol.py`) | 재사용 확장 `../dev_agent_client/shared/protocol.py` + 확장 src. 필드명이 1글자만 달라도 확장이 조용히 무시/오동작 |
| **위임 도구명**(`config.CLIENT_TOOL_NAME`) | 클라이언트 `tool-executor`가 기대하는 tool_name. 불일치 시 도구 실행 실패(§11) |
| **워크스페이스 도구 추가/삭제** | `config.DELEGATED_TOOLS` + `config.DISABLED_BUILTINS` + `tools/delegated.py`(build_delegated_server) + `orchestrator` allowed_tools + `prompts.py`(도구 지침). **5곳이 한 세트** |
| **모델 라우팅** | `.env DEEPASSIST_MODEL` == **외부 LiteLLM**의 `model_name`. Agent SDK가 요청하는 모델명과 반드시 일치 |
| **vLLM 모델** | 외부 LiteLLM의 vLLM 라우팅 모델 == 실제 vLLM 서빙 id(`VLLM_BASE_URL/v1/models`) |
| **외부 LiteLLM 접속**(`ANTHROPIC_BASE_URL`·`ANTHROPIC_AUTH_TOKEN`) | `.env`(URL/토큰 기록) → 주입 지점 **3곳**: `config.py`(env 기본값) · `main.py`(os.environ.setdefault) · `orchestrator._build_options`(options.env) |
| **서버 코드 일반** | 위 "멀티 OS 불변식" — 클라이언트 OS(Windows/Linux)를 가정하는 경로/셸 처리 금지 |

원칙: 값·계약은 **SSOT 한 곳**(코드 또는 `.env`)에 두고 나머지는 그곳을 참조. 부득이 복제한 값은
이 표에 등재해 드리프트를 막는다.

## 미완/후속 (§10·§11)

`tools/knowledge.py`의 RAG는 stub — `../dev_agent_client/g_tas_server/rag` 연결 예정. 토큰
단위 스트리밍(`include_partial_messages`)·승인 게이트(`canUseTool`→`approval_request`)·멀티턴
`resume`는 골격만 존재. 새 기능 추가 전 설계 문서의 해당 절을 먼저 확인할 것.
