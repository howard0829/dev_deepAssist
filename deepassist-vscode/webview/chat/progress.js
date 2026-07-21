/*
 * Progress UI — 8 시각 기능.
 * 원본 core/chat_ui.py의 render_progress() + _render_status_panel()를 포팅.
 *
 * 입력 데이터 (서버가 status_update / progress_update / tool_call_update / agent_text로 push):
 *   - status_update.payload: {message, phase, activity, turn, max_turns}
 *   - progress_update.payload: {phases: [...], sub_tasks: [...]}
 *   - tool_call_update.payload: {tool_name, arguments, result_preview, duration}
 *   - agent_text.payload: {text, is_final}
 */

(function () {
    'use strict';

    const ACTIVITY_MAP = {
        analyzing:  ['🤔', '분석 중...'],
        searching:  ['🔍', '검색 중...'],
        coding:     ['⌨️', '코드 작성 중...'],
        testing:    ['🧪', '검증 중...'],
        thinking:   ['💭', '생각 중...'],
        error:      ['😓', '오류 발생'],
        stopped:    ['⏹️', '중지됨'],
        done:       ['🎉', '완료!'],
        idle:       ['🤖', '대기 중'],
    };

    const THINKING_MESSAGES = {
        research:       '코드를 분석하고 있어요...',
        synthesis:      '설계 전략을 수립하고 있어요...',
        implementation: '코드를 작성하고 있어요...',
        review:         '코드를 리뷰하고 있어요...',
        debug:          '버그를 추적하고 있어요...',
        default:        '생각하고 있어요...',
    };

    const TOOL_ICONS = {
        Read: '📄', Write: '✏️', Edit: '✏️',
        Bash: '🖥️', Grep: '🔍', Glob: '📂',
        SearchWeb: '🌐', SearchWikipedia: '📚', SearchKnowledge: '🧠',
        LookupSymbol: '🔤', FileOutline: '📋', CallGraph: '🕸',
    };

    const STATUS_ICONS = {
        completed: '✅',
        in_progress: '🔄',
        failed: '❌',
        skipped: '⏭️',
        pending: '⬜',
    };

    /**
     * 진행 상태 컨테이너. 메시지 핸들러가 update*() 메서드를 호출하면
     * 내부 상태가 누적되고 render()에서 DOM을 갱신.
     */
    class ProgressTracker {
        constructor(container) {
            this.container = container;
            this.reset();
        }

        reset() {
            this.state = {
                activity: 'idle',
                phase: '',
                isThinking: false,
                startTime: 0,
                toolCallCount: 0,
                llmCallCount: 0,
                currentTurn: 0,
                maxTurns: 0,
                toolEntries: [],
                lastDiff: null,
                lastAgentSummary: '',
                phases: [],
                subTasks: [],
            };
            this.timerHandle = null;
        }

        start() {
            this.reset();
            this.state.startTime = Date.now();
            this.container.classList.add('visible');
            // collapsible wrapper의 visible도 같이 토글 (헤더+본문 표시)
            const section = document.getElementById('progress-section');
            if (section) section.classList.add('visible');
            if (this.timerHandle) clearInterval(this.timerHandle);
            this.timerHandle = setInterval(() => this.render(), 1000);
            this.render();
        }

        stop() {
            if (this.timerHandle) {
                clearInterval(this.timerHandle);
                this.timerHandle = null;
            }
        }

        hide() {
            this.stop();
            this.container.classList.remove('visible');
            const section = document.getElementById('progress-section');
            if (section) section.classList.remove('visible');
        }

        /** status_update 메시지 처리 */
        onStatus(payload) {
            const { phase, activity, turn, max_turns, message } = payload || {};
            if (phase) this.state.phase = phase;
            if (activity) this.state.activity = activity;
            if (typeof turn === 'number') this.state.currentTurn = turn;
            if (typeof max_turns === 'number') this.state.maxTurns = max_turns;
            // LLM 대기 토글 + 호출 카운트 — 서버가 _call_llm 진입 시점에 매번 1회 발송
            if (message && message.includes('LLM 응답 대기')) {
                this.state.isThinking = true;
                this.state.activity = 'thinking';
                this.state.llmCallCount += 1;
            } else if (message && message.includes('LLM 응답 수신')) {
                this.state.isThinking = false;
            }
            this.render();
        }

        /** phase_enter 메시지 처리. 정규식 매칭 의존 없이 정확.
         *
         * 서버가 _enter_phase()로 발송. payload: {phase, label, activity, turn, max_turns, timestamp}.
         * 기존 onStatus의 정규식 매칭은 미마이그레이션 사이트(direct on_status 호출만)
         * 폴백으로 남아 있음. 양쪽이 같은 phase를 보내도 마지막 호출이 이김 (멱등).
         */
        onPhaseEnter(payload) {
            const { phase, activity, turn, max_turns } = payload || {};
            if (phase) this.state.phase = phase;
            if (activity) this.state.activity = activity;
            if (typeof turn === 'number') this.state.currentTurn = turn;
            if (typeof max_turns === 'number') this.state.maxTurns = max_turns;
            this.render();
        }

        /** phase_exit 메시지 처리. duration_seconds로 phase별 누적 시간 표시 가능.
         * 현재는 state 변경 없이 수신만 (향후 phase별 duration 시각화 시 활용). */
        onPhaseExit(_payload) {
            // 현재는 phase가 끝났음을 알리지만 상태 변경은 다음 phase_enter나 progress_update로
            // 처리. 단순 수신 + 디버그 로그.
        }

        /** progress_update 메시지 처리 — Phase + sub_tasks 계층 */
        onProgress(payload) {
            this.state.phases = (payload && payload.phases) || [];
            this.state.subTasks = (payload && payload.sub_tasks) || [];
            this.render();
        }

        /** tool_call_update 메시지 처리 — 타임라인 + diff */
        onToolCall(payload) {
            const { tool_name, arguments: args = {}, duration = 0 } = payload || {};
            const summary = this._toolSummary(tool_name, args);
            this.state.toolEntries.push({
                tool: tool_name,
                summary,
                duration,
                timestamp: Date.now(),
            });
            this.state.toolCallCount += 1;
            this.state.isThinking = false;

            if (tool_name === 'Edit') {
                this.state.lastDiff = {
                    type: 'edit',
                    file_path: args.file_path || '',
                    old_text: args.old_text || args.old_string || '',
                    new_text: args.new_text || args.new_string || '',
                };
            } else if (tool_name === 'Write') {
                const content = args.content || '';
                this.state.lastDiff = {
                    type: 'write',
                    file_path: args.file_path || '',
                    content_preview: content.split('\n').slice(0, 5).join('\n'),
                };
            }
            this.render();
        }

        /** agent_text 메시지 처리 — 행동 요약 카드 */
        onAgentText(payload) {
            const text = (payload && payload.text) || '';
            this.state.isThinking = false;
            // <think> 블록 제거
            const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            if (!clean) return;
            const lines = clean.split('\n')
                .map((l) => l.trim())
                .filter((l) => l && !l.startsWith('```'));
            let preview = lines.slice(0, 3).join('\n');
            if (lines.length > 3) preview += ' …';
            this.state.lastAgentSummary = preview;
            this.render();
        }

        incrementLlmCount() {
            this.state.llmCallCount += 1;
            this.render();
        }

        _toolSummary(toolName, args) {
            if (!toolName) return '도구';
            if (['Read', 'Write', 'Edit'].includes(toolName)) {
                const p = args.file_path || args.path || '';
                const short = p.split('/').pop() || '';
                return `${toolName} — ${short}`;
            }
            if (toolName === 'Bash') {
                const cmd = (args.command || '').slice(0, 50);
                return `Bash — ${cmd}`;
            }
            if (toolName === 'Glob' || toolName === 'Grep') {
                const pat = (args.pattern || '').slice(0, 40);
                return `${toolName} — ${pat}`;
            }
            if (toolName.startsWith('Search')) {
                const q = (args.query || args.keyword || '').slice(0, 40);
                return `${toolName} — ${q}`;
            }
            return toolName;
        }

        render() {
            const html = [];
            html.push(this._renderAvatar());
            html.push(this._renderMetricsAndRing());
            if (this.state.isThinking) html.push(this._renderThinkingBubble());
            html.push(this._renderToolTimeline());
            if (this.state.lastDiff) html.push(this._renderDiffPreview());
            if (this.state.phases.length || this.state.subTasks.length) {
                html.push(this._renderPhaseProgress());
            }
            // 답변 요약(행동 요약 카드)은 progress 로그 맨 하단에 — 도구
            // 타임라인/Phase Progress 사이에 끼면 "답변이 로그 중간에 나온다"는
            // UX 저하. 최신 답변이 로그의 결말로 읽히도록 마지막에 push.
            if (this.state.lastAgentSummary) html.push(this._renderAgentSummary());
            this.container.innerHTML = html.filter(Boolean).join('');
        }

        _renderAvatar() {
            const [emoji, text] = ACTIVITY_MAP[this.state.activity] || ACTIVITY_MAP.idle;
            let extraCls = '';
            if (this.state.activity === 'done') extraCls = ' av-done';
            else if (['error', 'stopped'].includes(this.state.activity)) extraCls = ' av-error';
            const phaseHtml = this.state.phase
                ? `<span class="av-phase">${escapeHtml(this.state.phase)}</span>`
                : '';
            return `
                <div class="agent-avatar${extraCls}">
                    <span class="av-emoji">${emoji}</span>
                    <span class="av-text">${escapeHtml(text)}</span>
                    ${phaseHtml}
                </div>
            `;
        }

        _renderMetricsAndRing() {
            const elapsed = this.state.startTime
                ? Math.floor((Date.now() - this.state.startTime) / 1000)
                : 0;
            const mins = Math.floor(elapsed / 60);
            const secs = elapsed % 60;
            const cur = this.state.currentTurn;
            const max = this.state.maxTurns;
            const pct = max > 0 ? Math.min(Math.floor((cur / max) * 100), 100) : 0;
            const conic = `conic-gradient(var(--vscode-textLink-foreground) ${pct}%, var(--vscode-panel-border) ${pct}%)`;
            return `
                <div class="metrics-row">
                    <div class="metric-card">
                        <div class="m-value">${mins}:${String(secs).padStart(2, '0')}</div>
                        <div class="m-label">경과</div>
                    </div>
                    <div class="metric-card">
                        <div class="m-value">${this.state.toolCallCount}</div>
                        <div class="m-label">도구</div>
                    </div>
                    <div class="metric-card">
                        <div class="m-value">${this.state.llmCallCount}</div>
                        <div class="m-label">LLM</div>
                    </div>
                    <div class="progress-ring-wrap">
                        <div class="progress-ring" style="background: ${conic};">
                            <div class="progress-ring-inner">
                                <span class="pr-pct">${pct}%</span>
                                <span class="pr-label">${cur}/${max}</span>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }

        _renderThinkingBubble() {
            const key = this.state.phase || 'default';
            const msg = THINKING_MESSAGES[key] || THINKING_MESSAGES.default;
            return `
                <div class="thinking-bubble">
                    <div class="thinking-dots"><span></span><span></span><span></span></div>
                    <span class="thinking-text">${escapeHtml(msg)}</span>
                </div>
            `;
        }

        _renderAgentSummary() {
            const txt = escapeHtml(this.state.lastAgentSummary).replace(/\n/g, '<br>');
            return `
                <div class="agent-summary">
                    <span class="as-icon">💬</span>
                    <span class="as-text">${txt}</span>
                </div>
            `;
        }

        _renderToolTimeline() {
            const recent = this.state.toolEntries.slice(-8);
            if (!recent.length) return '';
            const rows = recent.map((e) => {
                const icon = TOOL_ICONS[e.tool] || '🔧';
                let cls = `tl-${(e.tool || '').toLowerCase()}`;
                if (e.tool && e.tool.startsWith('Search')) cls = 'tl-search';
                const dur = e.duration > 0 ? `${e.duration.toFixed(1)}s` : '...';
                return `
                    <div class="tl-entry ${cls}">
                        <span class="tl-icon">${icon}</span>
                        <span class="tl-info">${escapeHtml(e.summary)}</span>
                        <span class="tl-time">${dur}</span>
                    </div>
                `;
            }).join('');
            return `<div class="tool-timeline">${rows}</div>`;
        }

        _renderDiffPreview() {
            const d = this.state.lastDiff;
            const fname = (d.file_path || '').split('/').pop();
            let body = '';
            if (d.type === 'edit') {
                body += `<div class="diff-hdr">✏️ ${escapeHtml(fname)}</div>`;
                (d.old_text || '').split('\n').slice(0, 4).forEach((line) => {
                    body += `<div class="diff-del">- ${escapeHtml(line)}</div>`;
                });
                (d.new_text || '').split('\n').slice(0, 4).forEach((line) => {
                    body += `<div class="diff-add">+ ${escapeHtml(line)}</div>`;
                });
            } else {
                body += `<div class="diff-hdr">📝 ${escapeHtml(fname)}</div>`;
                (d.content_preview || '').split('\n').slice(0, 5).forEach((line) => {
                    body += `<div class="diff-add">+ ${escapeHtml(line)}</div>`;
                });
            }
            return `<div class="diff-preview">${body}</div>`;
        }

        _renderPhaseProgress() {
            const all = [...this.state.phases, ...this.state.subTasks];
            const total = all.length;
            const done = all.filter((t) => t.status === 'completed').length;
            const failed = all.filter((t) => t.status === 'failed').length;
            const skipped = all.filter((t) => t.status === 'skipped').length;
            const finished = done + failed + skipped;
            const pct = total > 0 ? (finished / total) * 100 : 0;

            const childrenByPhase = new Map();
            for (const t of this.state.subTasks) {
                const pn = t.phase_num || 0;
                if (!childrenByPhase.has(pn)) childrenByPhase.set(pn, []);
                childrenByPhase.get(pn).push(t);
            }

            const lines = [];
            for (const p of this.state.phases) {
                lines.push(this._renderPhaseLine(p, childrenByPhase.get(p.num) || []));
            }
            const orphans = childrenByPhase.get(0) || [];
            for (const t of orphans) lines.push(this._renderSubTaskLine(t));

            return `
                <div class="phase-progress">
                    <div class="phase-progress-header">📋 Progress (${finished}/${total})</div>
                    <div class="phase-progress-bar"><div style="width: ${pct}%"></div></div>
                    <div class="phase-list">${lines.join('')}</div>
                </div>
            `;
        }

        _renderPhaseLine(phase, children) {
            const status = phase.status || 'pending';
            const icon = STATUS_ICONS[status] || '';
            const text = escapeHtml(phase.text || '');
            const num = phase.num || '';
            const collapsed = ['completed', 'failed', 'skipped'].includes(status);
            const cls = collapsed ? 'phase-item done' : 'phase-item';
            const summary = collapsed && children.length
                ? ` <small>(${children.filter((c) => ['completed', 'skipped'].includes(c.status)).length}/${children.length})</small>`
                : '';
            const head = `
                <div class="${cls}">
                    <span class="icon">${icon}</span>
                    <span class="label"><strong>Phase ${num}</strong> ${text}${summary}</span>
                </div>
            `;
            if (collapsed) return head;
            const sub = children.map((t) => this._renderSubTaskLine(t)).join('');
            return head + sub;
        }

        _renderSubTaskLine(item) {
            const status = item.status || 'pending';
            const icon = STATUS_ICONS[status] || '';
            const num = item.num || '';
            const text = escapeHtml(item.text || '');
            const cls = ['completed', 'failed', 'skipped'].includes(status)
                ? 'phase-item sub-task done'
                : 'phase-item sub-task';
            return `
                <div class="${cls}">
                    <span class="icon">${icon}</span>
                    <span class="label">Task ${num} ${text}</span>
                </div>
            `;
        }
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    window.GtasProgress = { ProgressTracker };
})();
