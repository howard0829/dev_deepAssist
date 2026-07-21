/*
 * 채팅 webview 진입점.
 * - 카드형 앱 스위처
 * - 메시지 렌더링 (마크다운 + 도구 호출 expander)
 * - Progress 패널 갱신
 * - modified_files 카드
 */

(function () {
    'use strict';

    const vscode = acquireVsCodeApi();
    const { ProgressTracker } = window.GtasProgress;
    const { render: mdRender, escapeHtml } = window.GtasMarkdown;

    const $ = (id) => document.getElementById(id);
    const chatMessages = $('chat-messages');
    const progressContainer = $('progress-panel');
    const tracker = new ProgressTracker(progressContainer);

    let apps = [];
    let currentApp = '';
    let currentMode = 'agent'; // 'agent' | 'chat' — vscode.setState로 영속
    let toolCallBuffer = [];
    /** modified_file_diff 메시지로 누적되는 파일별 unified diff.
     *  agent_complete 시 buildModifiedFiles가 이 데이터를 사용해 인라인 diff 렌더.
     *  같은 파일 다회 수정 시 마지막 diff만 보존. clearMessages가 비움. */
    let pendingDiffs = {};
    /** 진행 중인 approval card. request_id → DOM element.
     *  사용자 결정 전송 후 카드를 'resolved' 상태로 잠금. */
    let activeApprovalCards = {};

    /** AskUser — 진행 중인 clarification card. request_id → DOM element.
     *  답변 전송 후 'resolved' 상태로 잠금. clearMessages가 비움. */
    let activeClarificationCards = {};

    // 컨텍스트 (extension에서 push, webview는 표시만)
    let attachedPaths = [];
    let attachedSnippets = []; // [{file, start_line, end_line, preview}]

    // 이전 세션의 mode 복원
    const savedState = vscode.getState();
    if (savedState && savedState.mode) {
        currentMode = savedState.mode;
    }

    // ── Extension → Webview 메시지 수신 ──
    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.type) {
            case 'session_init':
                handleSessionInit(msg.payload);
                break;
            case 'connection_state':
                applyConnectionInfo(msg.payload);
                break;
            case 'status_update':
                // 서버 정책: ✅/📊로 시작하는 메시지만 UI 라인으로 노출(`ui_visible=true`).
                // 그 외는 ~/.gtas/debug_logs/<session>.jsonl에만 기록되고 UI에서는 숨김.
                // tracker는 활동/phase/turn 메타를 항상 흡수해야 진행 상태 패널이 멈추지 않음.
                if (msg.payload.ui_visible !== false) {
                    appendStatusLine(msg.payload.message);
                }
                tracker.onStatus(msg.payload);
                break;
            case 'phase_enter':
                // phase 진입 명시 메시지. 정규식 매칭 의존 없이 정확.
                tracker.onPhaseEnter(msg.payload);
                break;
            case 'phase_exit':
                tracker.onPhaseExit(msg.payload);
                break;
            case 'progress_update':
                tracker.onProgress(msg.payload);
                break;
            case 'tool_call_update':
                tracker.onToolCall(msg.payload);
                toolCallBuffer.push(msg.payload);
                break;
            case 'finding_added':
                appendFinding(msg.payload);
                break;
            case 'agent_text':
                handleAgentText(msg.payload);
                // 스트리밍 청크(is_final=false)는 진행 패널 render()를 트리거하지 않음.
                // 과거엔 청크마다(초당 ~10회) onAgentText→render()로 패널 전체 innerHTML이
                // 재생성되어 도구 타임라인이 깜빡였다. 최종(is_final)만 패널 요약 1회 갱신.
                if (msg.payload && msg.payload.is_final) tracker.onAgentText(msg.payload);
                break;
            case 'agent_complete':
                handleAgentComplete(msg.payload);
                break;
            case 'modified_file_diff':
                // 도구 호출 직후 즉시 발송 unified diff. 같은 파일의
                // 마지막 diff만 보존 — agent_complete가 최종 카드 렌더 시 사용.
                pendingDiffs[msg.payload.file_path] = msg.payload.diff;
                break;
            case 'modified_file_reverted':
                // 사용자가 되돌린 파일을 카드에서 시각 갱신.
                // 모든 활성 modified-file-card 중 해당 path를 찾아 reverted 클래스 추가.
                handleModifiedFileReverted(msg.payload || {});
                break;
            case 'modified_file_unreverted':
                // 되돌리기 취소(재적용) 후 카드를 원상 복구 — 반복 토글 지원.
                handleModifiedFileUnreverted(msg.payload || {});
                break;
            case 'approval_request':
                // Plan Mode 승인 요청. Approval Card 렌더.
                handleApprovalRequest(msg.payload);
                break;
            case 'approval_ack':
                // 2.9 fix — extension이 wsClient.send 결과를 ack로 회신.
                // ok=true면 카드 시각 확정, ok=false면 pending 해제 + 재시도 가능 상태로 복원.
                handleApprovalAck(msg.payload || {});
                break;
            case 'approval_resolved':
                // 서버가 승인 게이트를 해소(사용자 클릭 외 timeout 자동승인·오류 폴백 포함).
                // 카드를 닫아 활성 버튼이 좀비로 남지 않게 한다(현상 5).
                handleApprovalResolved(msg.payload || {});
                break;
            case 'clarification_request':
                // AskUser — 구현 중 사용자에게 질문. Clarification Card 렌더.
                handleClarificationRequest(msg.payload);
                break;
            case 'clarification_ack':
                // approval_ack와 동일 — 답변 송신 성공/실패에 따른 카드 상태 갱신.
                handleClarificationAck(msg.payload || {});
                break;
            case 'input_result':
                // VSCode webview sandbox는 window.prompt 미지원 → extension의
                // showInputBox 결과를 이 메시지로 회신. payload.kind로 라우팅.
                handleInputResult(msg.payload || {});
                break;
            case 'focus_input':
                $('prompt-input').focus();
                break;
            case 'app_switched':
                setActiveApp(msg.payload.app);
                break;
            case 'reset_chat':
                clearMessages();
                break;
            case 'context_update':
                attachedPaths = (msg.payload && msg.payload.attached_paths) || [];
                attachedSnippets = (msg.payload && msg.payload.attached_snippets) || [];
                renderContextBar();
                break;
        }
    });

    // ── 컨텍스트 바 렌더 ──
    function basename(p) {
        if (!p) return '';
        const norm = p.replace(/\\/g, '/');
        const idx = norm.lastIndexOf('/');
        return idx >= 0 ? norm.slice(idx + 1) || norm : norm;
    }

    function renderContextBar() {
        const bar = $('context-bar');
        const chips = $('context-chips');
        const clearBtn = $('context-clear-btn');
        const hasAttached = attachedPaths.length > 0;
        const hasSnippet = attachedSnippets.length > 0;
        if (!hasAttached && !hasSnippet) {
            bar.hidden = true;
            return;
        }
        bar.hidden = false;
        clearBtn.hidden = !(hasAttached || hasSnippet);

        const parts = [];
        for (const p of attachedPaths) {
            parts.push(
                `<span class="ctx-chip" data-role="attached" data-path="${escapeHtml(p)}" title="${escapeHtml(p)}">
                    <span class="ctx-icon">📎</span>
                    <span class="ctx-name">${escapeHtml(basename(p))}</span>
                    <button class="ctx-chip-btn" data-action="remove" title="제거">×</button>
                </span>`
            );
        }
        for (const s of attachedSnippets) {
            const range = s.start_line === s.end_line
                ? `L${s.start_line}`
                : `L${s.start_line}-${s.end_line}`;
            const title = `선택 영역 — ${s.file}\n줄 ${s.start_line}-${s.end_line}\n\n${s.preview || ''}`;
            parts.push(
                `<span class="ctx-chip ctx-snippet" data-role="snippet"
                    data-file="${escapeHtml(s.file)}"
                    data-start="${s.start_line}" data-end="${s.end_line}"
                    title="${escapeHtml(title)}">
                    <span class="ctx-icon">📋</span>
                    <span class="ctx-name">${escapeHtml(basename(s.file))} ${range}</span>
                    <button class="ctx-chip-btn" data-action="remove" title="제거">×</button>
                </span>`
            );
        }
        chips.innerHTML = parts.join('');

        chips.querySelectorAll('.ctx-chip[data-role="attached"] .ctx-chip-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const chip = btn.closest('.ctx-chip');
                const path = chip && chip.dataset.path;
                if (path) {
                    vscode.postMessage({ type: 'remove_attached_path', path });
                }
            });
        });
        chips.querySelectorAll('.ctx-chip[data-role="snippet"] .ctx-chip-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const chip = btn.closest('.ctx-chip');
                if (!chip) return;
                vscode.postMessage({
                    type: 'remove_attached_snippet',
                    file: chip.dataset.file,
                    start_line: parseInt(chip.dataset.start, 10),
                    end_line: parseInt(chip.dataset.end, 10),
                });
            });
        });
    }

    $('context-clear-btn').addEventListener('click', () => {
        vscode.postMessage({ type: 'clear_attached_paths' });
    });

    function handleSessionInit(payload) {
        apps = (payload && payload.apps) || [];
        renderAppSwitcher();
        if (apps.length > 0 && !currentApp) {
            const enabled = apps.find((a) => a.enabled !== false);
            currentApp = (enabled || apps[0]).id;
            setActiveApp(currentApp);
        }
        applyMode(currentMode);
    }

    function applyMode(mode) {
        currentMode = mode;
        document.querySelectorAll('.mode-btn').forEach((el) => {
            el.classList.toggle('active', el.dataset.mode === mode);
        });
        const input = $('prompt-input');
        if (input) {
            input.placeholder = mode === 'chat'
                ? '💬 채팅 모드 — LLM과 대화 (Enter 전송)'
                : '🤖 에이전트 모드 — 자율 작업 수행 (Enter 전송)';
        }
        vscode.setState({ ...(vscode.getState() || {}), mode });
        // Chat 모드에서는 앱 카드 비활성화 — apps 로드된 후에만 리렌더
        if (apps.length > 0) renderAppSwitcher();
    }

    document.querySelectorAll('.mode-btn').forEach((el) => {
        el.addEventListener('click', () => {
            const mode = el.dataset.mode;
            if (mode && mode !== currentMode) applyMode(mode);
        });
    });

    // 첫 연결 실패 안내를 세션 당 1회만 표시하기 위한 플래그
    let firstFailureNoticeShown = false;

    function applyConnectionInfo(info) {
        const dot = $('status-dot');
        const txt = $('status-text');
        const btn = $('connection-status');
        const connected = !!(info && info.connected);

        // 점 색상 토글
        dot.classList.toggle('connected', connected);
        btn.classList.toggle('connected', connected);

        // 진행 펄스: burst 시도 중일 때만
        const isBurst = !connected && (info?.reconnectAttempt || 0) > 0 && !info?.isPolling;
        btn.classList.toggle('attempting', isBurst);

        // 텍스트
        let label;
        let title;
        if (connected) {
            label = '연결됨';
            title = '연결됨';
        } else if (info?.isPolling) {
            label = '재연결 대기 중 — 클릭하여 즉시 시도';
            title = `60초 간격으로 자동 재시도 중\n클릭하면 즉시 재시도\n\n마지막 오류: ${info.lastError || '알 수 없음'}`;
        } else if (isBurst) {
            const n = info.reconnectAttempt;
            const max = info.maxBurstAttempts;
            label = `재연결 시도 중 (${n}/${max})`;
            title = `재연결 시도 중\n클릭하면 즉시 재시도\n\n마지막 오류: ${info.lastError || '알 수 없음'}`;
        } else {
            label = '연결 끊김 — 클릭하여 재시도';
            title = `클릭하면 재시도\n\n마지막 오류: ${info?.lastError || '알 수 없음'}`;
        }
        txt.textContent = label;
        btn.setAttribute('title', title);

        // 첫 연결 실패 1회 안내 (한 번도 성공한 적 없는데 실패가 발생한 경우)
        if (!connected && info && !info.hasEverConnected && info.reconnectAttempt > 0
                && !firstFailureNoticeShown) {
            firstFailureNoticeShown = true;
            appendSystemNotice(
                'G-TAS 서버에 연결할 수 없습니다.\n터미널에서 `python g_tas_server/main.py` 실행 여부를 확인하세요. '
                + '서버가 켜지면 자동으로 연결됩니다.'
            );
        }
    }

    function appendSystemNotice(text) {
        const div = document.createElement('div');
        div.className = 'message status system-notice';
        div.textContent = '💡 ' + text;
        chatMessages.appendChild(div);
        scrollToBottom();
    }

    // 상태 표시줄 클릭 → 수동 재연결
    $('connection-status').addEventListener('click', () => {
        const btn = $('connection-status');
        if (btn.classList.contains('connected')) return;
        vscode.postMessage({ type: 'manual_reconnect' });
    });

    function renderAppSwitcher() {
        const container = $('app-switcher');
        if (!apps.length) {
            container.innerHTML = '<div class="status-text">앱 정보 없음</div>';
            return;
        }
        const visible = apps.filter((a) => a.visible !== false);
        const chatMode = currentMode === 'chat';
        container.innerHTML = visible.map((app) => {
            const disabled = app.enabled === false || chatMode;
            const active = app.id === currentApp;
            const cls = ['app-card', active ? 'active' : '', disabled ? 'disabled' : '']
                .filter(Boolean).join(' ');
            const tooltip = chatMode
                ? '채팅 모드에서는 앱 선택이 적용되지 않습니다'
                : (app.description || '');
            return `
                <div class="${cls}" data-app-id="${escapeHtml(app.id)}" title="${escapeHtml(tooltip)}">
                    <div class="app-card-icon">${escapeHtml(app.icon || '📱')}</div>
                    <div class="app-card-name">${escapeHtml(app.name || app.id)}</div>
                    <div class="app-card-desc">${escapeHtml(app.description || '')}</div>
                </div>
            `;
        }).join('');
        container.querySelectorAll('.app-card').forEach((el) => {
            el.addEventListener('click', () => {
                if (el.classList.contains('disabled')) return;
                const id = el.dataset.appId;
                if (id && id !== currentApp) {
                    currentApp = id;
                    setActiveApp(id);
                    vscode.postMessage({ type: 'switch_app', app: id });
                }
            });
        });
    }

    function setActiveApp(appId) {
        currentApp = appId;
        document.querySelectorAll('.app-card').forEach((el) => {
            el.classList.toggle('active', el.dataset.appId === appId);
        });
    }

    // ── 메시지 렌더링 ──
    function appendUserMessage(text) {
        const div = document.createElement('div');
        div.className = 'message user';
        const content = document.createElement('div');
        content.className = 'message-content';
        content.innerHTML = mdRender(text);
        div.appendChild(content);
        chatMessages.appendChild(div);
        scrollToBottom();
    }

    function ensureAgentBubble() {
        let el = document.getElementById('agent-current');
        if (!el) {
            el = document.createElement('div');
            el.id = 'agent-current';
            el.className = 'message agent';
            const content = document.createElement('div');
            content.className = 'message-content';
            el.appendChild(content);
            // 답변 복사 버튼. 도구 호출 expander/modified-files 카드가 추가되어도
            // .message-content만 캡처해 답변 텍스트만 깔끔하게 복사. 호버 시 노출.
            const copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'msg-copy-btn';
            copyBtn.title = '답변 복사 (markdown + 서식)';
            copyBtn.setAttribute('aria-label', '답변 복사');
            copyBtn.textContent = '📋';
            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                copyAgentMessage(el, copyBtn);
            });
            el.appendChild(copyBtn);
            chatMessages.appendChild(el);
        }
        return el;
    }

    function handleAgentText(payload) {
        const el = ensureAgentBubble();
        const content = el.querySelector('.message-content');
        const text = payload.text || '';
        // 스트리밍: 누적 텍스트로 매번 재렌더
        content.innerHTML = mdRender(text);
        // 복사용 markdown 원본 보관. handleAgentComplete가 최종값으로 덮어씀.
        el.dataset.mdSource = text;
        // 회귀 패치 — id 제거는 agent_complete가 단독 담당.
        // 과거에 is_final=true 시 즉시 id를 떼면 후속 agent_complete의
        // getElementById('agent-current')가 null이 되어 도구 호출 expander/
        // modified_files 카드가 표시되지 않던 회귀 차단.
        // is_final 자체는 서버 측 신호로 보존 (스피너 종료 등 향후 활용 가능).
        scrollToBottom();
    }

    function handleAgentComplete(payload) {
        const el = document.getElementById('agent-current');
        if (el) {
            const content = el.querySelector('.message-content');
            if (payload.response) {
                content.innerHTML = mdRender(payload.response);
                // agent_complete.response가 canonical (agent_text는 스트리밍 누적)
                el.dataset.mdSource = payload.response;
            }
            // 도구 호출 기록 expander
            if (toolCallBuffer.length > 0) {
                el.appendChild(buildToolCallExpander(toolCallBuffer));
            }
            // modified_files 카드 (server diffs 우선, fallback으로 modified_file_diff 누적분 사용)
            if (payload.modified_files && payload.modified_files.length > 0) {
                const diffs = (payload.diffs && Object.keys(payload.diffs).length > 0)
                    ? payload.diffs
                    : pendingDiffs;
                el.appendChild(buildModifiedFiles(payload.modified_files, diffs));
            }
            el.removeAttribute('id');
        }
        toolCallBuffer = [];
        pendingDiffs = {};
        tracker.hide();
        $('send-btn').classList.remove('hidden');
        $('stop-btn').classList.remove('active');
        $('prompt-input').disabled = false;
        $('prompt-input').focus();
    }

    // 답변 메시지 복사 (markdown 원본 + 렌더된 HTML 동시 클립보드 쓰기).
    // 사용처:
    //   - 터미널/텍스트 에디터 붙여넣기 → text/plain (markdown 원본)
    //   - Word/Notion/Confluence 붙여넣기 → text/html (서식 보존)
    // ClipboardItem 미지원 환경(구 Electron 등)에서는 writeText 폴백 — markdown만 살림.
    async function copyAgentMessage(bubbleEl, btnEl) {
        const md = (bubbleEl && bubbleEl.dataset && bubbleEl.dataset.mdSource) || '';
        const contentEl = bubbleEl.querySelector('.message-content');
        const html = contentEl ? contentEl.innerHTML : '';
        if (!md && !html) return;

        const plainText = md || _stripHtmlToText(html);
        const wrappedHtml = `<!DOCTYPE html><html><body>${html}</body></html>`;

        let copied = false;
        try {
            if (navigator.clipboard && typeof window.ClipboardItem === 'function') {
                const item = new ClipboardItem({
                    'text/plain': new Blob([plainText], { type: 'text/plain' }),
                    'text/html': new Blob([wrappedHtml], { type: 'text/html' }),
                });
                await navigator.clipboard.write([item]);
                copied = true;
            }
        } catch (_e) {
            // ClipboardItem 미지원/거부 — fallback
        }
        if (!copied) {
            try {
                await navigator.clipboard.writeText(plainText);
                copied = true;
            } catch (_e) { /* 클립보드 접근 실패 */ }
        }

        // 시각 피드백 (1.5초)
        const orig = btnEl.textContent;
        btnEl.textContent = copied ? '✅' : '⚠️';
        btnEl.classList.add(copied ? 'copied' : 'failed');
        setTimeout(() => {
            btnEl.textContent = orig;
            btnEl.classList.remove('copied', 'failed');
        }, 1500);
    }

    function _stripHtmlToText(html) {
        const tmp = document.createElement('div');
        tmp.innerHTML = html || '';
        return tmp.textContent || tmp.innerText || '';
    }

    function buildToolCallExpander(records) {
        const details = document.createElement('details');
        details.className = 'tool-calls-expander';
        const summary = document.createElement('summary');
        summary.textContent = `🔧 도구 호출 기록 (${records.length})`;
        details.appendChild(summary);
        const list = document.createElement('div');
        list.className = 'tool-calls-list';
        records.forEach((r) => {
            const row = document.createElement('div');
            row.className = 'tool-call-record';
            const argsStr = JSON.stringify(r.arguments || {}, null, 2).slice(0, 400);
            const result = (r.result_preview || '').slice(0, 300);
            row.innerHTML = `
                <div><span class="name">${escapeHtml(r.tool_name || '?')}</span>
                    <span style="opacity:0.6;font-size:0.75rem">· ${(r.duration || 0).toFixed(1)}s</span>
                </div>
                <pre>${escapeHtml(argsStr)}</pre>
                ${result ? `<pre>${escapeHtml(result)}</pre>` : ''}
            `;
            list.appendChild(row);
        });
        details.appendChild(list);
        return details;
    }

    function buildModifiedFiles(files, diffs) {
        // diffs 인자 추가. 펼치면 인라인 unified diff, "VSCode Diff" 버튼은
        // git 무관 native diff(임시 untitled URI). diffs 미전달 시 기존 동작 유지.
        const wrap = document.createElement('div');
        wrap.className = 'modified-files';
        wrap.innerHTML = `<div class="modified-files-title">📁 수정된 파일 (${files.length})</div>`;
        files.forEach((path) => {
            const card = document.createElement('div');
            card.className = 'modified-file-card';
            const diffText = (diffs && diffs[path]) || '';
            const hasDiff = !!diffText;
            // 카드 내부 행은 path + 액션 버튼들. diff가 있으면 펼침 토글 표시.
            const row = document.createElement('div');
            row.className = 'modified-file-row';
            row.innerHTML = `
                <span class="icon">${hasDiff ? '<span class="toggle-diff"></span>' : ''}📄</span>
                <span class="path" title="${escapeHtml(path)}">${escapeHtml(path)}</span>
                <div class="actions">
                    <button class="action-btn" data-action="open">열기</button>
                    <button class="action-btn" data-action="vscode_diff" ${hasDiff ? '' : 'disabled'}>VSCode Diff</button>
                    <button class="action-btn btn-revert" data-action="revert" ${hasDiff ? '' : 'disabled'}>되돌리기</button>
                </div>
            `;
            card.appendChild(row);

            const diffArea = document.createElement('div');
            diffArea.className = 'modified-file-diff-area';
            if (hasDiff) {
                try {
                    diffArea.innerHTML = (window.GtasDiffRenderer || {}).renderUnifiedDiff
                        ? window.GtasDiffRenderer.renderUnifiedDiff(diffText)
                        : `<pre class="diff-block">${escapeHtml(diffText)}</pre>`;
                } catch (_e) {
                    diffArea.innerHTML = `<pre class="diff-block">${escapeHtml(diffText)}</pre>`;
                }
            }
            card.appendChild(diffArea);

            row.querySelectorAll('.action-btn').forEach((btn) => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (btn.disabled) return;
                    // action은 클릭 시점의 data-action을 읽음 — 되돌리기/취소 토글을 그대로 전달.
                    const action = btn.dataset.action;
                    vscode.postMessage({
                        type: 'modified_file_action',
                        action,
                        path,
                    });
                });
            });
            // 카드 본문(path 영역) 클릭 → 펼침 토글 (diff 있을 때만)
            row.addEventListener('click', (e) => {
                if (e.target.closest('.action-btn')) return;
                if (hasDiff) {
                    card.classList.toggle('expanded');
                } else {
                    vscode.postMessage({ type: 'modified_file_action', action: 'open', path });
                }
            });
            wrap.appendChild(card);
        });
        return wrap;
    }

    // Plan Mode Approval Card
    function handleApprovalRequest(payload) {
        const requestId = payload.request_id;
        if (!requestId) return;
        // 채팅 영역에 카드 삽입
        const chatMessages = $('chat-messages');
        if (!chatMessages) return;
        const card = document.createElement('div');
        card.className = 'approval-card';
        card.dataset.requestId = requestId;

        const planItems = (payload.plan || []).slice(0, 20);
        const filesPreview = (payload.estimated_files || []).slice(0, 8);
        const filesText = filesPreview.length > 0
            ? `예상 수정 파일 (${(payload.estimated_files || []).length}개): ${filesPreview.map(escapeHtml).join(', ')}`
            : '예상 수정 파일: 알 수 없음';

        card.innerHTML = `
            <div class="approval-title">${escapeHtml(payload.title || 'Implementation Phase 진입 승인')}</div>
            <div class="approval-summary">${mdRender(payload.summary || '')}</div>
            ${planItems.length > 0 ? `<ul class="approval-plan">${planItems.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>` : ''}
            <div class="approval-files">${filesText}</div>
            <div class="approval-actions">
                <button data-decision="approve">승인 ▶</button>
                <button data-decision="modify" class="btn-modify">수정 요청…</button>
                <button data-decision="reject" class="btn-reject">중단 ⏹</button>
            </div>
            <div class="approval-countdown" data-deadline="${Date.now() + (payload.timeout_seconds || 120) * 1000}">
                ⏱ ${payload.timeout_seconds || 120}초 무응답 시 자동 승인
            </div>
        `;
        card.querySelectorAll('.approval-actions button').forEach((btn) => {
            btn.addEventListener('click', () => {
                const decision = btn.dataset.decision;
                if (decision === 'modify') {
                    // VSCode webview는 window.prompt 미지원 → extension에 showInputBox
                    // 요청을 보내고 input_result 회신을 기다림. 카드는 응답 도착 전까지
                    // 다중 클릭 방지를 위해 잠시 disable.
                    card.querySelectorAll('.approval-actions button').forEach((b) => (b.disabled = true));
                    vscode.postMessage({
                        type: 'request_input',
                        payload: {
                            kind: 'approval_modify',
                            requestId,
                            prompt: 'Implementation Phase 진행 시 추가로 반영할 지시 사항',
                            placeHolder: '예: 특정 파일은 건드리지 말 것 / 테스트 먼저 작성',
                        },
                    });
                    return;
                }
                // 2.9 fix — extension의 approval_ack 도착 전까지 pending 표시.
                // 미연결 등으로 송신이 실패하면 ack가 ok=false로 와서 카드를 재시도 가능 상태로
                // 복원 — 사용자가 "눌렀는데 120s 후 자동 승인" 무음 회귀 차단.
                _setApprovalPending(card, decision, null);
                vscode.postMessage({
                    type: 'approval_response',
                    payload: { id: requestId, decision, feedback: null },
                });
            });
        });
        chatMessages.appendChild(card);
        activeApprovalCards[requestId] = card;
        scrollToBottom();

        // 카운트다운 자동 갱신
        const countdownEl = card.querySelector('.approval-countdown');
        const deadline = parseInt(countdownEl.dataset.deadline, 10);
        const tick = () => {
            const remain = Math.max(0, Math.round((deadline - Date.now()) / 1000));
            countdownEl.textContent = `⏱ ${remain}초 무응답 시 자동 승인`;
            if (remain > 0 && card.classList.contains('resolved') === false) {
                setTimeout(tick, 1000);
            }
        };
        setTimeout(tick, 1000);
    }

    function _markApprovalResolved(card, decision, feedback) {
        card.classList.add('resolved');
        const labels = { approve: '✅ 승인', reject: '⏹ 중단', modify: '✏️ 수정 요청' };
        const note = document.createElement('div');
        note.className = 'approval-decision';
        note.textContent = labels[decision] + (feedback ? ` — "${feedback.slice(0, 100)}"` : '');
        card.appendChild(note);
    }

    // 2.9 fix — Approval Card pending/ack 처리.
    // 클릭 즉시 잠그던 기존 동작은 미연결 시 무음 실패(서버 무응답 → 120s 자동승인)를
    // 감추는 원인이었다. 이제 클릭은 pending 상태만 만들고, extension의 approval_ack를
    // 받아야 시각 확정. 이전 에러 표시는 새 ack가 ok=false로 다시 와도 갱신되도록 텍스트만 교체.
    function _setApprovalPending(card, decision, feedback) {
        card.classList.add('pending');
        card.dataset.pendingDecision = decision;
        card.dataset.pendingFeedback = feedback == null ? '' : feedback;
        card.querySelectorAll('.approval-actions button').forEach((b) => (b.disabled = true));
        const prevErr = card.querySelector('.approval-send-error');
        if (prevErr) prevErr.remove();
    }

    // 서버 승인 해소 통지(현상 5) — 사용자 클릭뿐 아니라 timeout 자동승인·오류 폴백에도 도착.
    // 카드 버튼을 잠그고 결정을 표시해 좀비 카드(활성 버튼 잔류)를 방지. 이미 확정된 카드는 멱등 무시.
    function handleApprovalResolved(payload) {
        const requestId = payload && payload.request_id;
        if (!requestId) return;
        const card = activeApprovalCards[requestId];
        if (!card) return;
        if (card.classList.contains('resolved')) return;   // 사용자 ack로 이미 확정 — 멱등
        card.classList.remove('pending');
        delete card.dataset.pendingDecision;
        delete card.dataset.pendingFeedback;
        card.querySelectorAll('.approval-actions button').forEach((b) => (b.disabled = true));
        const decision = payload.decision || 'approve';
        _markApprovalResolved(card, decision, null);
        if (payload.auto) {
            const note = card.querySelector('.approval-decision');
            if (note) note.textContent += payload.reason ? ` (자동 — ${payload.reason})` : ' (자동)';
        }
    }

    function handleApprovalAck(payload) {
        const requestId = payload && payload.id;
        if (!requestId) return;
        const card = activeApprovalCards[requestId];
        if (!card) return;
        if (payload.ok) {
            const decision = card.dataset.pendingDecision || 'approve';
            const feedback = card.dataset.pendingFeedback || null;
            card.classList.remove('pending');
            delete card.dataset.pendingDecision;
            delete card.dataset.pendingFeedback;
            _markApprovalResolved(card, decision, feedback);
        } else {
            card.classList.remove('pending');
            delete card.dataset.pendingDecision;
            delete card.dataset.pendingFeedback;
            card.querySelectorAll('.approval-actions button').forEach((b) => (b.disabled = false));
            let errEl = card.querySelector('.approval-send-error');
            if (!errEl) {
                errEl = document.createElement('div');
                errEl.className = 'approval-send-error';
                card.appendChild(errEl);
            }
            errEl.textContent = '⚠️ ' + (payload.reason || '전송 실패 — 연결 복구 후 다시 시도하세요.');
        }
    }

    // VSCode webview sandbox는 window.prompt 미지원이라 extension의 showInputBox를
    // 거쳐 결과만 input_result로 받음. payload.kind로 후속 동작을 라우팅.
    // payload.cancelled=true는 사용자가 ESC로 취소했음을 의미 — 카드 상태 복원만.
    function handleInputResult(payload) {
        const kind = payload && payload.kind;
        if (kind === 'approval_modify') {
            const requestId = payload.requestId;
            const card = activeApprovalCards[requestId];
            if (!card) return;
            if (payload.cancelled) {
                // 사용자 취소 — 클릭 직전 disable했던 버튼 복원
                card.querySelectorAll('.approval-actions button').forEach((b) => (b.disabled = false));
                return;
            }
            const feedback = payload.value == null ? '' : String(payload.value);
            _setApprovalPending(card, 'modify', feedback);
            vscode.postMessage({
                type: 'approval_response',
                payload: { id: requestId, decision: 'modify', feedback },
            });
        } else if (kind === 'clarification_answer') {
            const requestId = payload.requestId;
            const card = activeClarificationCards[requestId];
            if (!card) return;
            if (payload.cancelled || payload.value == null || !String(payload.value).trim()) {
                // 취소·빈 답변 — 버튼 복원. (서버는 무응답을 timeout으로 처리해 가정 후 진행)
                card.querySelectorAll('.clarification-actions button').forEach((b) => (b.disabled = false));
                return;
            }
            const answer = String(payload.value);
            _setClarificationPending(card, answer);
            vscode.postMessage({
                type: 'clarification_response',
                payload: { id: requestId, answer },
            });
        }
    }

    // AskUser — 서버 CLARIFICATION_REQUEST 수신 시 질문 카드 렌더.
    // Approval Card와 동일 구조지만 결정 버튼 대신 '답변 입력' 1개, 타임아웃 시
    // 자동 승인이 아니라 '가정 후 진행'. 답변 입력은 request_input(showInputBox) 경유.
    function handleClarificationRequest(payload) {
        const requestId = payload.request_id;
        if (!requestId) return;
        const chatMessages = $('chat-messages');
        if (!chatMessages) return;
        const card = document.createElement('div');
        card.className = 'clarification-card';
        card.dataset.requestId = requestId;
        const timeoutSec = payload.timeout_seconds || 180;

        card.innerHTML = `
            <div class="clarification-title">🤔 에이전트의 질문</div>
            <div class="clarification-question">${mdRender(payload.question || '')}</div>
            <div class="clarification-actions">
                <button data-action="answer">답변 입력…</button>
            </div>
            <div class="clarification-countdown" data-deadline="${Date.now() + timeoutSec * 1000}">
                ⏱ ${timeoutSec}초 무응답 시 가정 후 진행
            </div>
        `;
        card.querySelector('.clarification-actions button').addEventListener('click', () => {
            // VSCode webview는 window.prompt 미지원 → extension에 showInputBox 요청.
            // 응답 도착(input_result) 전까지 버튼 disable.
            card.querySelectorAll('.clarification-actions button').forEach((b) => (b.disabled = true));
            vscode.postMessage({
                type: 'request_input',
                payload: {
                    kind: 'clarification_answer',
                    requestId,
                    prompt: payload.question || '에이전트에게 전달할 답변',
                    placeHolder: '예: src/auth 모듈을 사용하세요',
                },
            });
        });
        chatMessages.appendChild(card);
        activeClarificationCards[requestId] = card;
        scrollToBottom();

        // 카운트다운 자동 갱신
        const countdownEl = card.querySelector('.clarification-countdown');
        const deadline = parseInt(countdownEl.dataset.deadline, 10);
        const tick = () => {
            const remain = Math.max(0, Math.round((deadline - Date.now()) / 1000));
            countdownEl.textContent = `⏱ ${remain}초 무응답 시 가정 후 진행`;
            if (remain > 0 && card.classList.contains('resolved') === false) {
                setTimeout(tick, 1000);
            }
        };
        setTimeout(tick, 1000);
    }

    function _setClarificationPending(card, answer) {
        card.classList.add('pending');
        card.dataset.pendingAnswer = answer == null ? '' : answer;
        card.querySelectorAll('.clarification-actions button').forEach((b) => (b.disabled = true));
        const prevErr = card.querySelector('.clarification-send-error');
        if (prevErr) prevErr.remove();
    }

    function _markClarificationResolved(card, answer) {
        card.classList.add('resolved');
        const note = document.createElement('div');
        note.className = 'clarification-decision';
        note.textContent = '✅ 답변 전송' + (answer ? ` — "${String(answer).slice(0, 100)}"` : '');
        card.appendChild(note);
    }

    function handleClarificationAck(payload) {
        const requestId = payload && payload.id;
        if (!requestId) return;
        const card = activeClarificationCards[requestId];
        if (!card) return;
        if (payload.ok) {
            const answer = card.dataset.pendingAnswer || '';
            card.classList.remove('pending');
            delete card.dataset.pendingAnswer;
            _markClarificationResolved(card, answer);
        } else {
            card.classList.remove('pending');
            delete card.dataset.pendingAnswer;
            card.querySelectorAll('.clarification-actions button').forEach((b) => (b.disabled = false));
            let errEl = card.querySelector('.clarification-send-error');
            if (!errEl) {
                errEl = document.createElement('div');
                errEl.className = 'clarification-send-error';
                card.appendChild(errEl);
            }
            errEl.textContent = '⚠️ ' + (payload.reason || '전송 실패 — 연결 복구 후 다시 시도하세요.');
        }
    }

    // 해당 path의 modified-file-card에 콜백 적용 (반복 토글 공용 헬퍼).
    function _forEachCardByPath(targetPath, fn) {
        if (!targetPath) return;
        document.querySelectorAll('.modified-file-card').forEach((card) => {
            const pathSpan = card.querySelector('.path');
            if (!pathSpan) return;
            const cardPath = (pathSpan.getAttribute('title') || pathSpan.textContent || '').trim();
            if (cardPath !== targetPath) return;
            fn(card);
        });
    }

    // 되돌리기 후 카드 시각 갱신.
    // 되돌리기 버튼을 "되돌리기 취소"(data-action=unrevert)로 토글 — 재적용 가능.
    // VSCode Diff는 비활성(파일이 변경 전 상태라 비교 무의미).
    function handleModifiedFileReverted(payload) {
        _forEachCardByPath(payload.path, (card) => {
            card.classList.add('reverted');
            const revertBtn = card.querySelector('.btn-revert');
            if (revertBtn) {
                revertBtn.dataset.action = 'unrevert';
                revertBtn.textContent = '되돌리기 취소';
                revertBtn.disabled = false;
            }
            const diffBtn = card.querySelector('[data-action="vscode_diff"]');
            if (diffBtn) diffBtn.disabled = true;
            if (!card.querySelector('.reverted-note')) {
                const note = document.createElement('div');
                note.className = 'reverted-note';
                note.textContent = '↩️ 되돌림';
                card.appendChild(note);
            }
        });
    }

    // 되돌리기 취소(재적용) 후 카드 원상 복구 — 버튼을 다시 "되돌리기"로 토글.
    function handleModifiedFileUnreverted(payload) {
        _forEachCardByPath(payload.path, (card) => {
            card.classList.remove('reverted');
            const revertBtn = card.querySelector('.btn-revert');
            if (revertBtn) {
                revertBtn.dataset.action = 'revert';
                revertBtn.textContent = '되돌리기';
                revertBtn.disabled = false;
            }
            const diffBtn = card.querySelector('[data-action="vscode_diff"]');
            if (diffBtn) diffBtn.disabled = false;
            const note = card.querySelector('.reverted-note');
            if (note) note.remove();
        });
    }

    function appendStatusLine(text) {
        if (!text) return;
        const div = document.createElement('div');
        div.className = 'message status';
        div.textContent = text;
        chatMessages.appendChild(div);
        scrollToBottom();
    }

    function clearMessages() {
        chatMessages.innerHTML = '';
        toolCallBuffer = [];
        pendingDiffs = {};
        activeApprovalCards = {};
        activeClarificationCards = {};
        findingsBuffer = [];
        findingsFilter = 'all';
        const fs = document.getElementById('findings-section');
        if (fs) fs.remove();
        tracker.hide();
        // 새로고침 = 처음부터 모두 새로 시작. 진행 중이던 pending UI(중지 버튼 active /
        // 입력 disabled)도 즉시 정상 상태로 복원해 다음 입력을 막지 않음. 서버 측에서
        // _handle_session_reset이 stop_requested=True로 agent를 멈추므로 늦게 도착하는
        // agent_complete가 와도 같은 상태로 멱등 처리됨.
        $('send-btn').classList.remove('hidden');
        $('stop-btn').classList.remove('active');
        $('prompt-input').disabled = false;
    }

    // ── 리뷰 발견사항 ──
    let findingsBuffer = [];
    let findingsFilter = 'all';  // 'all' | 'critical' | 'warning' | 'info'

    function ensureFindingsPanel() {
        let section = document.getElementById('findings-section');
        if (section) return section.querySelector('#findings-panel');
        section = document.createElement('div');
        section.id = 'findings-section';
        section.className = 'collapsible-section visible';
        section.innerHTML = `
            <div class="collapsible-header" data-toggle-section="findings">
                <span class="collapsible-chevron">▼</span>
                <span class="collapsible-title">🔍 리뷰 발견사항 <span id="findings-count">0</span></span>
            </div>
            <div class="collapsible-body">
                <div id="findings-panel" class="findings-panel">
                    <div class="findings-filters">
                        <button class="ff-btn active" data-filter="all">All</button>
                        <button class="ff-btn" data-filter="critical">🔴 Critical</button>
                        <button class="ff-btn" data-filter="warning">🟡 Warning</button>
                        <button class="ff-btn" data-filter="info">🔵 Info</button>
                    </div>
                    <div class="findings-list" id="findings-list"></div>
                </div>
            </div>
        `;
        chatMessages.parentElement.insertBefore(section, chatMessages);

        // 필터 버튼 이벤트
        section.querySelectorAll('.ff-btn').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                findingsFilter = btn.dataset.filter || 'all';
                section.querySelectorAll('.ff-btn').forEach((b) => b.classList.toggle('active', b === btn));
                renderFindings();
            });
        });
        // 동적 생성된 collapsible 헤더에 토글 핸들러 부착 + 저장된 상태 복원
        attachCollapsibleHandlers(section);
        return section.querySelector('#findings-panel');
    }

    function appendFinding(payload) {
        if (!payload || !payload.message) return;
        findingsBuffer.push(payload);
        ensureFindingsPanel();
        renderFindings();
    }

    function renderFindings() {
        const list = document.getElementById('findings-list');
        const counter = document.getElementById('findings-count');
        if (!list) return;
        const filtered = findingsFilter === 'all'
            ? findingsBuffer
            : findingsBuffer.filter((f) => f.severity === findingsFilter);
        if (counter) {
            const total = findingsBuffer.length;
            const sev = { critical: 0, warning: 0, info: 0 };
            findingsBuffer.forEach((f) => { sev[f.severity] = (sev[f.severity] || 0) + 1; });
            counter.textContent = `${total}건 (🔴${sev.critical} 🟡${sev.warning} 🔵${sev.info})`;
        }
        if (filtered.length === 0) {
            list.innerHTML = '<div class="ff-empty">표시할 발견사항이 없습니다.</div>';
            return;
        }
        const sevIcon = { critical: '🔴', warning: '🟡', info: '🔵' };
        list.innerHTML = filtered.map((f) => {
            const file = f.file ? f.file.split(/[\\/]/).pop() : '?';
            const loc = f.line ? `${file}:${f.line}` : file;
            const sym = f.symbol ? ` <span class="ff-sym">${escapeHtml(f.symbol)}</span>` : '';
            const cat = f.category ? ` <span class="ff-cat">${escapeHtml(f.category)}</span>` : '';
            const fix = f.fix_hint
                ? `<div class="ff-fix">💡 ${escapeHtml(f.fix_hint)}</div>`
                : '';
            return `
                <div class="ff-card ff-${escapeHtml(f.severity)}" title="${escapeHtml(f.file || '')}">
                    <div class="ff-head">
                        <span class="ff-sev">${sevIcon[f.severity] || '🔵'}</span>
                        <span class="ff-loc">${escapeHtml(loc)}</span>${sym}${cat}
                    </div>
                    <div class="ff-msg">${escapeHtml(f.message)}</div>
                    ${fix}
                </div>
            `;
        }).join('');
    }

    function scrollToBottom() {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // ── 입력 처리 ──
    function send() {
        const input = $('prompt-input');
        const prompt = input.value.trim();
        if (!prompt) return;
        appendUserMessage(prompt);
        vscode.postMessage({
            type: 'user_message',
            prompt,
            app: currentApp,
            mode: currentMode,
        });
        input.value = '';
        input.disabled = true;
        $('send-btn').classList.add('hidden');
        $('stop-btn').classList.add('active');
        toolCallBuffer = [];
        // 채팅 모드는 도구/Phase 없이 단순 대화 — Progress 패널 숨김
        if (currentMode === 'agent') {
            tracker.start();
        } else {
            tracker.hide();
        }
    }

    $('send-btn').addEventListener('click', send);
    $('stop-btn').addEventListener('click', () => {
        vscode.postMessage({ type: 'stop_request' });
    });

    $('prompt-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
        }
    });

    // 자동 높이 조절
    $('prompt-input').addEventListener('input', (e) => {
        const ta = e.target;
        ta.style.height = 'auto';
        ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
    });

    // 헤더 액션
    $('reset-chat-btn').addEventListener('click', () => {
        clearMessages();
        vscode.postMessage({ type: 'reset_chat' });
    });
    $('open-settings-btn').addEventListener('click', () => {
        vscode.postMessage({ type: 'open_settings' });
    });

    // ── Collapsible 섹션 (progress, findings 등) ──
    // header 클릭으로 본문 접고 펼침. vscode.setState()로 상태 영속화 — 다음 webview
    // 라이프사이클(reload)에서도 펼침/접힘 유지.
    function getCollapsedState() {
        const s = vscode.getState() || {};
        return s.collapsedSections || {};
    }
    function setCollapsedState(id, collapsed) {
        const s = vscode.getState() || {};
        s.collapsedSections = s.collapsedSections || {};
        s.collapsedSections[id] = collapsed;
        vscode.setState(s);
    }
    function attachCollapsibleHandlers(root) {
        const headers = (root || document).querySelectorAll('.collapsible-header');
        const saved = getCollapsedState();
        headers.forEach((header) => {
            if (header.dataset.collapsibleBound === '1') return;
            header.dataset.collapsibleBound = '1';
            const section = header.closest('.collapsible-section');
            if (!section) return;
            const id = header.dataset.toggleSection || section.id || 'unknown';
            // 저장된 상태 복원
            if (saved[id]) section.classList.add('collapsed');
            header.addEventListener('click', (e) => {
                // 헤더 안의 인터랙티브 자식(필터 버튼 등)은 자체 stopPropagation 처리
                if (e.target.closest('.ff-btn')) return;
                section.classList.toggle('collapsed');
                setCollapsedState(id, section.classList.contains('collapsed'));
            });
        });
    }
    // 페이지 초기화 시점에 정적 collapsible(progress-section 등)에 핸들러 부착
    attachCollapsibleHandlers();

    // 초기 상태 알림
    vscode.postMessage({ type: 'webview_ready' });
})();
