# DeepAssist 아키텍처 설계안

VSCode UI 기반 AI 코딩 에이전트/오케스트레이터. `dev_agent_client`(G-TAS)의 **VSCode UI와 위임(delegation) 아키텍처를 재활용**하되, 자체 제작 에이전트 엔진을 **Claude Agent SDK**로 교체한다. LLM은 원격 공유 서버의 **LiteLLM 프록시**를 거쳐 **vLLM/OpenAI**에 연결한다.

> 상태: 초안(설계 합의 완료, 구현 전). 미검증 항목은 §10에 명시.

---

## 1. 목표와 범위

- **Orchestrator = DeepAssist**: MCP 서버·RAG·skills를 관리하여 core agent에 넘긴다. 실체는 "Claude Agent SDK의 `query()` 옵션을 조립하고, 워크스페이스 도구 위임 브리지를 운영하는 서버측 계층".
- **Core agent = Claude Agent SDK**(Python). 자체 에이전트 루프를 직접 구현하지 않는다.
- **UI = 기존 VSCode 확장을 그대로 사용**. 기존 WebSocket 위임 프로토콜(`tool_request`/`tool_result` 등)을 유지한다.
- **LLM proxy = LiteLLM**, **provider = vLLM / OpenAI**. 원격 공유 서버에 상주.
- 파일/셸만 위임한다. **LSP는 제외**(이번 범위 밖).

---

## 2. 핵심 설계 결정 (요약)

| 항목 | 결정 | 근거 |
|---|---|---|
| 실행 토폴로지 | **원격 공유 서버**에 Agent SDK 상주, 워크스페이스 도구만 클라 위임 | Agent SDK가 통제된 서버 환경에서 도는 게 설계 의도. 확장 host에서 subprocess 구동 리스크 회피 |
| 언어 | 서버 = **Python** / 클라 = **TypeScript** | 기존 Python RAG·MCP 자산 재활용, 기존 TS 확장 재활용 |
| UI 재사용 범위 | **기존 위임 프로토콜 그대로 유지** | 위임 토폴로지와 정합. `protocol.py` + `tool-executor.ts` 재사용 |
| 워크스페이스 도구 처리 | 내장 Bash/Read/Write/Edit/Glob/Grep **비활성화** → 동일 책임의 **위임형 SDK MCP 도구**로 대체 | 훅으로는 "다른 곳에서 실행" 불가(내장이 서버에서 먼저 실행됨) |
| LLM 연결 | `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` → LiteLLM `/v1/messages` | Agent SDK 표준 커스텀 엔드포인트 방식 |
| LSP | 제외 | 범위 축소 |

---

## 3. 아키텍처 개요

```
┌──────────────────────── 클라이언트 (VSCode 확장, TS) ────────────────────────┐
│  webview UI (chat / settings)  — 기존 재사용                                  │
│  ws-client  ──────────────── WebSocket ──────────────┐                        │
│  tool-executor (파일/Bash native 실행, dangerous 체크) │  기존 재사용          │
└────────────────────────────────────────────────────────┼─────────────────────┘
                                                          │  user_message
                     tool_request ▲   ▼ tool_result       │  agent_text
                     approval_*   ▲   ▼ approval_response  │  agent_complete …
┌─────────────────────────────────────────────────────────┼─────────────────────┐
│  원격 공유 서버 (Python)                                  ▼                     │
│  ┌───────────── ws/handler · bridge · session_pool ──────────────┐             │
│  │                    (세션별 위임 브리지)                          │             │
│  └───────────────┬───────────────────────────────┬───────────────┘             │
│                  │                               │                             │
│        ┌─────────▼──────────┐          ┌─────────▼────────────┐                │
│        │ DeepAssist         │          │ 위임형 SDK MCP 도구   │                │
│        │ (오케스트레이터)    │─────────▶│ bash/read/write/…     │──▶ bridge ──▶ 클라│
│        │ query() 옵션 조립   │          │ (handler가 클라 위임) │                │
│        └─────────┬──────────┘          └──────────────────────┘                │
│                  │ query(prompt, options)                                       │
│        ┌─────────▼──────────┐   ANTHROPIC_BASE_URL                              │
│        │ Claude Agent SDK   │──────────────┐                                    │
│        │ (에이전트 루프)     │              ▼                                    │
│        └────────────────────┘      ┌──────────────┐   ┌──────────────┐         │
│        ┌────────────────────┐      │ LiteLLM 프록시│──▶│ vLLM / OpenAI│         │
│        │ 서버직접 MCP 도구   │      │ /v1/messages │   └──────────────┘         │
│        │ RAG / knowledge …  │      └──────────────┘                            │
│        └────────────────────┘                                                  │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. 구성요소 상세

### 4.1 클라이언트 (VSCode 확장, TypeScript) — 대부분 재사용

- **webview UI**: 기존 `chat/`, `settings/` 화면 그대로. 스트리밍 텍스트, 도구 호출 표시, diff 카드, 승인 카드.
- **ws-client**: 서버와 WebSocket 통신. 기존 프로토콜 유지.
- **tool-executor**: `tool_request` 수신 → 클라 OS/워크스페이스에서 파일·Bash native 실행 → `tool_result` 반환. `dangerous-commands`·`shell-detector`·변경전 콘텐츠 캐시·되돌리기(`user_reject_change`) 로직 재사용.
- 신규/변경: 없음에 가깝다. 서버가 보내는 메시지 종류가 Agent SDK 이벤트 기반으로 바뀌므로, 표시 계층에서 매핑만 조정(§7).

### 4.2 서버 (Python)

**DeepAssist 오케스트레이터** — 이 프로젝트의 핵심 신규 계층. 역할:
1. 세션별로 Agent SDK `query()`의 `ClaudeAgentOptions`를 조립(§8).
2. **위임형 SDK MCP 도구**를 세션의 bridge에 바인딩하여 등록.
3. **서버직접 MCP 도구**(RAG/knowledge 등)를 등록.
4. skills 디렉토리·subagents·시스템 프롬프트·permission 정책 주입.
5. Agent SDK가 yield하는 메시지를 UI 프로토콜 메시지로 번역(§7).

**Claude Agent SDK** — 에이전트 루프·컨텍스트 관리·도구 호출을 담당. 서버 프로세스에서 구동. `ANTHROPIC_BASE_URL`을 로컬 LiteLLM으로 지정.

**LiteLLM 프록시** — Anthropic 포맷 `/v1/messages`를 수신해 vLLM/OpenAI 백엔드로 변환. `cache_control`·`thinking`·`count_tokens` 등 Anthropic 고유 필드 처리 필요(§10 검증 항목).

**RAG / MCP** — 기존 `g_tas_server/rag`, `g_tas_server/mcp` 자산을 **서버직접 MCP 도구** 또는 in-process 도구로 재활용. 무거운 인덱싱은 서버에 유지.

### 4.3 LLM 프로바이더

- vLLM(사내 로컬 모델) 우선, OpenAI 호환. LiteLLM이 라우팅.
- 설정 패널의 연결 테스트·모델 목록 조회는 기존 `test_llm_connection`/`fetch_vllm_models` 방식(서버 망 경유) 재사용.

---

## 5. 도구 아키텍처

### 5.1 분류: 서버직접 vs 클라위임

기존 G-TAS의 `execute=callable(서버직접) / None(클라위임)` 구도를 그대로 계승한다. Agent SDK에서는 **모든 도구를 SDK MCP 도구로 정의**하되, handler 내부에서 위임 여부가 갈린다.

| 분류 | 도구 | 실행 위치 | 구현 |
|---|---|---|---|
| **클라 위임** | bash, read, write, edit, glob, grep | 클라 워크스페이스 | handler가 `bridge.request_and_wait(tool_request)`로 위임 |
| **서버 직접** | RAG/knowledge 검색, scratch, 거대파일 변환, ask_user 등 | 서버 | handler가 서버 리소스 직접 호출 |
| **비활성화** | Agent SDK 내장 Bash/Read/Write/Edit/Glob/Grep | — | `disallowed_tools`로 제거(서버 FS 오염 방지) |
| **제외** | LSP 계열 | — | 이번 범위 밖 |

### 5.2 위임 메커니즘 (핵심)

내장 도구는 서버 FS에서 실행되므로 반드시 **끄고**, 동일 책임의 위임형 MCP 도구로 대체한다. 훅(PreToolUse/PostToolUse)은 내장 도구가 서버에서 먼저 실행되는 문제 때문에 위임 용도로 부적합.

```
모델: mcp__deepassist__bash(command="pytest")
  → SDK가 handler 호출 (서버, async)
     → ToolRequest(id, "bash", {command}) 생성
     → await bridge.request_and_wait(ToolRequest)      # 기존 브리지 재사용
        → ws로 tool_request 전송 → 클라 tool-executor 실행
        ← tool_result(output, side_effects)
     → 필요시 modified_file_diff 등 부수효과 emit
  ← handler가 결과 content 반환 → SDK 루프 계속
```

- handler는 **세션의 bridge를 클로저로 캡처**한다(bridge는 `session_pool`에서 세션별). DeepAssist가 세션마다 MCP 서버를 구성하며 주입.
- 장시간 도구는 클라가 `tool_progress` heartbeat 발송 → bridge timeout 연장(기존 로직 재사용).

---

## 6. 데이터 흐름 (요청 라이프사이클)

```
1. 사용자 프롬프트        클라 → 서버 : user_message(prompt, workspace, provider_config …)
2. 세션 준비              DeepAssist: ClaudeAgentOptions 조립(위임 MCP + RAG MCP + skills + system_prompt)
3. 에이전트 실행          for msg in query(prompt, options):
     - StreamEvent(text_delta)      → agent_text (스트리밍)
     - AssistantMessage(tool_use)   → tool_call_update / status_update
       └─ (위임 도구면) handler가 tool_request↔tool_result 왕복 수행
          └─ 파일 수정 시 modified_file_diff 즉시 emit
     - canUseTool(위험 작업)        → approval_request ↔ approval_response
     - SystemMessage(init)          → session_init 보강
4. 완료                   ResultMessage → agent_complete(response, modified_files, diffs, metrics)
```

---

## 7. WebSocket 프로토콜 ↔ Agent SDK 이벤트 매핑

기존 `shared/protocol.py`를 유지하고, DeepAssist가 아래처럼 번역한다.

| Agent SDK (yield/callback) | UI 프로토콜 메시지 | 비고 |
|---|---|---|
| `StreamEvent` content_block_delta(text_delta) | `agent_text`(스트리밍) | `include_partial_messages=True` 필요 |
| `AssistantMessage` tool_use 블록 | `tool_call_update` / `status_update` | 표시용 |
| 위임 MCP handler 내부 | `tool_request` → `tool_result` | 실제 위임 왕복 |
| 파일 수정 감지(side_effects) | `modified_file_diff` | 도구 결과 직후 즉시 |
| `canUseTool` 콜백(위험 작업) | `approval_request` ↔ `approval_response` | Plan/승인 게이트 |
| ask_user 도구 | `clarification_request` ↔ `clarification_response` | 서버직접 도구 |
| `SystemMessage`(subtype=init) | `session_init` 보강 | 도구/ MCP 상태 |
| `ResultMessage` | `agent_complete` | 최종 응답·수정 파일·메트릭 |

> `PhaseEnter/PhaseExit`, `finding_added` 등 리뷰/Phase 전용 메시지는 초기 범위에서 선택적. 필요 시 DeepAssist가 상태에 맞춰 발송.

---

## 8. Agent SDK `query()` 옵션 구성 (개략)

```python
options = ClaudeAgentOptions(
    model=provider_config.model,                 # per-query 모델 지정
    system_prompt={                              # 프리셋 + 위임 도구 지침 보강 (§9.1)
        "type": "preset", "preset": "claude_code",
        "append": DEEPASSIST_TOOL_GUIDE,
    },
    disallowed_tools=[                            # 내장 워크스페이스 도구 제거
        "Bash", "Read", "Write", "Edit", "Glob", "Grep",
    ],
    mcp_servers={                                # 위임형 + 서버직접
        "deepassist": create_sdk_mcp_server(
            name="deepassist",
            tools=[bash_tool, read_tool, write_tool, edit_tool,
                   glob_tool, grep_tool],        # handler가 bridge 위임
        ),
        "knowledge": create_sdk_mcp_server(
            name="knowledge", tools=[rag_search, ...],   # 서버직접
        ),
    },
    allowed_tools=[                              # 위임/서버직접 도구 사전 승인
        "mcp__deepassist__bash", "mcp__deepassist__read", ...,
        "mcp__knowledge__rag_search",
    ],
    permission_mode="default",                   # canUseTool로 위험작업 승인 게이트
    agents={...},                                # subagents (선택)
    skills="all" 또는 ["..."],                    # skills 디렉토리 로드
    include_partial_messages=True,               # 스트리밍 UI
    cwd=workspace_label,                         # 명목상(실 실행은 클라)
    env={"ANTHROPIC_BASE_URL": litellm_url,
         "ANTHROPIC_AUTH_TOKEN": token},         # 또는 프로세스 환경
)
```

> `bash_tool` 등은 `@tool` 데코레이터로 정의하고, handler가 세션 bridge를 캡처해 `tool_request`를 위임한다.

---

## 9. 충돌 처리 (권장안 확정)

### 9.1 도구 이름·시스템 프롬프트 정합성 — **유일한 튜닝 지점**
- MCP 도구는 항상 `mcp__<server>__<name>` 프리픽스라 이름이 `Bash`/`Edit`가 될 수 없다. `claude_code` 프리셋은 "Bash/Read/Edit"를 지칭하므로 어긋난다.
- **처리**: 프리셋 + `append`로 위임 도구(`mcp__deepassist__*`)의 이름·용도·사용 규칙을 명시. 필요 시 프리셋 대신 커스텀 시스템 프롬프트. → 구현 초기 프롬프트 튜닝/스파이크 대상.

### 9.2 Edit/Read 의미론 재현
- 내장 Edit의 "Read 후 수정, staleness 검사" 규약을 위임 도구가 스스로 일관되게 구현.
- 기존 클라 `_beforeContentCache`·diff·`user_reject_change` 로직 재활용.

### 9.3 지연 누적
- 도구 호출마다 서버↔클라 왕복. Agent SDK는 도구 호출이 잦아 지연이 쌓임(G-TAS가 이미 감수하던 특성).
- 완화: `tool_progress` heartbeat, 병렬 안전 도구는 병렬 실행 검토.

---

## 10. 재사용 vs 신규 구현 매핑

| 영역 | 기존 G-TAS | DeepAssist |
|---|---|---|
| webview UI | `g-tas-vscode/webview` | **재사용** |
| 클라 도구 실행 | `tool-executor.ts` 등 | **재사용** (LSP 제외) |
| WebSocket 프로토콜 | `shared/protocol.py` | **재사용** |
| ws handler/bridge/session_pool | `g_tas_server/ws` | **재사용** (위임 왕복 그대로) |
| RAG / MCP | `g_tas_server/rag`, `mcp` | **재사용**(서버직접 MCP 도구로 래핑) |
| 에이전트 엔진 | `agent/deepassist_agent.py`, `pipelines/` | **폐기 → Claude Agent SDK** |
| 도구 레지스트리 | `tools/_ALL_TOOLS` | **재구성**: 위임/서버직접 SDK MCP 도구로 |
| 오케스트레이션 | (에이전트 내부) | **신규 DeepAssist 계층** |
| LLM 호출 | `llm_providers.py` | **LiteLLM 프록시로 대체** |

---

## 11. 검증·리스크 항목 (구현 전 확인)

1. **LiteLLM `/v1/messages` 호환**: Agent SDK가 보내는 `cache_control`·`thinking`·`count_tokens`를 LiteLLM이 vLLM/OpenAI로 정상 변환/패스스루하는지. → 최소 왕복 스파이크.
2. **위임 MCP handler ↔ bridge 연동**: async MCP handler에서 `bridge.request_and_wait` await가 세션 스코프로 정확히 매칭되는지.
3. **내장 도구 비활성화 후 도구 선택 품질**: 위임형 MCP 도구만 남겼을 때 모델이 적절히 사용하는지(§9.1 프롬프트 튜닝과 함께).
4. **모델 능력**: vLLM 로컬 모델의 도구 호출·장기 에이전트 스태미나(기존 `llm-providers.md`의 interleaved thinking 보존 등 고려).

## 12. 미결정 / 향후

- Plan Mode·리뷰 파이프라인(`finding_added` 등) 재도입 여부.
- subagents 활용 범위.
- skills 레지스트리 위치(서버 디렉토리 vs 원격 배포).
- 멀티유저 동시성·vLLM 큐잉 정책.
