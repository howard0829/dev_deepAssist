/**
 * G-TAS Server WebSocket 클라이언트
 *
 * 기능:
 *   - 자동 재연결 (지수 백오프)
 *   - 메시지 타입별 이벤트 핸들러
 *   - 요청-응답 매칭 (request_id)
 *   - Ping/Pong 하트비트
 */

import * as vscode from 'vscode';

// WebSocket 메시지 타입 (shared/protocol.py와 동일)
export type MessageType =
    // Client → Server
    | 'user_message' | 'tool_result' | 'stop_request'
    | 'workspace_metadata' | 'workspace_event' | 'session_reset'
    | 'tool_progress'                                              // 장시간 도구 heartbeat
    | 'approval_response'                                          // Plan Mode 사용자 결정
    | 'clarification_response'                                     // AskUser 질문에 대한 사용자 답변
    | 'user_reject_change'                                         // 사용자가 파일 변경 거부·되돌림
    | 'test_llm_connection'                                        // 설정 패널 연결 테스트 (서버 경유)
    | 'fetch_ollama_models'                                        // Ollama 모델 목록 조회 (서버 경유)
    | 'fetch_vllm_models'                                          // vLLM 모델 목록 조회 (서버 경유)
    // Server → Client
    | 'tool_request' | 'status_update' | 'progress_update'
    | 'tool_call_update' | 'agent_text' | 'agent_complete' | 'finding_added'
    | 'config_push' | 'session_init' | 'error'
    | 'phase_enter' | 'phase_exit'                                 // phase 전환 명시
    | 'modified_file_diff'                                         // 즉시 발송 unified diff
    | 'approval_request'                                           // Plan Mode 승인 요청
    | 'approval_resolved'                                          // 승인 게이트 해소 통지 (카드 닫기)
    | 'clarification_request'                                      // AskUser — 구현 중 사용자에게 질문
    | 'test_llm_connection_result'                                 // 설정 패널 연결 테스트 응답
    | 'fetch_ollama_models_result'                                 // Ollama 모델 목록 응답
    | 'fetch_vllm_models_result'                                   // vLLM 모델 목록 응답
    // 양방향
    | 'ping' | 'pong';

/** 클라이언트 환경 메타데이터. 세션 시작 시 1회 + 재연결 시 재발송. */
export interface WorkspaceMetadata {
    workspace_label: string;
    client_os: 'windows' | 'linux' | 'macos';
    shell: 'bash' | 'git-bash' | 'wsl-bash' | 'powershell' | 'cmd';
    deepassist_md: string | null;
    test_runner_hint: string | null;
    protocol_version: number;
}

export interface WSMessage {
    type: MessageType;
    payload: Record<string, any>;
}

export interface WSRequest {
    type: MessageType;
    id: string;
    payload: Record<string, any>;
}

/** 연결 상태 정보 — UI가 진단 표시/액션 결정에 사용 */
export interface ConnectionInfo {
    connected: boolean;
    lastError: string;          // 마지막 연결 실패 사유 (사람-읽기 형태)
    reconnectAttempt: number;   // 현재까지 시도한 횟수 (burst 단계에서만 의미; polling 단계에선 maxBurstAttempts에 고정)
    maxBurstAttempts: number;   // burst exp-backoff 한도 (이후 idle polling)
    isPolling: boolean;         // burst 한도 초과 후 long-interval polling 단계인지
    hasEverConnected: boolean;  // 세션 중 한 번이라도 성공한 적 있는지 (첫 실패 안내용)
}

type MessageHandler = (msg: WSMessage) => void | Promise<void>;

export class WSClient {
    private ws: WebSocket | null = null;
    private url: string;
    private token: string;
    private handlers: Map<string, MessageHandler[]> = new Map();
    private reconnectAttempts = 0;
    private readonly maxBurstAttempts = 10;
    private readonly burstMaxDelay = 30000;  // burst 단계 최대 지연 30s
    private readonly idlePollDelay = 60000;  // burst 후 무한 폴링 60s 간격
    private isPolling = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private connected = false;
    private lastError = '';
    private hasEverConnected = false;
    private notifiedPollingOnce = false;
    private _onConnectionChange: ((info: ConnectionInfo) => void) | null = null;

    constructor(url: string, token: string = '') {
        this.url = url;
        this.token = token;
    }

    private getInfo(): ConnectionInfo {
        return {
            connected: this.connected,
            lastError: this.lastError,
            reconnectAttempt: this.reconnectAttempts,
            maxBurstAttempts: this.maxBurstAttempts,
            isPolling: this.isPolling,
            hasEverConnected: this.hasEverConnected,
        };
    }

    private notifyState(): void {
        try { this._onConnectionChange?.(this.getInfo()); }
        catch (_) { /* 무시 */ }
    }

    private formatError(err: any): string {
        if (!err) return '알 수 없는 오류';
        if (typeof err === 'string') return err;
        const code = err.code || err.errno;
        const msg = err.message || String(err);
        return code ? `${code}: ${msg}` : msg;
    }

    /**
     * 서버에 WebSocket 연결
     */
    async connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                const wsUrl = this.token
                    ? `${this.url}?token=${this.token}`
                    : this.url;

                // Node.js 환경 (VSCode extension)
                const WebSocketImpl = require('ws') as typeof WebSocket;
                this.ws = new WebSocketImpl(wsUrl) as any;

                this.ws!.onopen = () => {
                    this.connected = true;
                    this.hasEverConnected = true;
                    this.reconnectAttempts = 0;
                    this.isPolling = false;
                    this.notifiedPollingOnce = false;
                    this.lastError = '';
                    this.notifyState();
                    this.startPingPong();
                    resolve();
                };

                this.ws!.onmessage = (event: MessageEvent) => {
                    try {
                        const data: WSMessage = JSON.parse(
                            typeof event.data === 'string' ? event.data : event.data.toString()
                        );
                        this.handleMessage(data);
                    } catch (e) {
                        console.error('메시지 파싱 오류:', e);
                    }
                };

                this.ws!.onclose = () => {
                    this.connected = false;
                    this.notifyState();
                    this.stopPingPong();
                    this.scheduleReconnect();
                };

                this.ws!.onerror = (err: any) => {
                    // ws 라이브러리는 ErrorEvent에 .message/.error 둘 중 하나로 정보 제공
                    this.lastError = this.formatError(err?.error || err?.message || err);
                    if (!this.connected) {
                        reject(new Error(this.lastError || 'WebSocket 연결 실패'));
                    }
                };
            } catch (e) {
                reject(e);
            }
        });
    }

    /**
     * 메시지 타입별 핸들러 등록
     */
    on(type: MessageType, handler: MessageHandler): void {
        const existing = this.handlers.get(type) || [];
        existing.push(handler);
        this.handlers.set(type, existing);
    }

    /**
     * 서버에 메시지 전송.
     *
     * @returns 실제 송신 성공 여부. 미연결·직렬화/전송 실패 시 false — 호출자가
     *   사용자에게 가시 피드백을 줄 수 있도록 (예: approval_response의 ack 회신).
     *   기존 호출 사이트는 반환값 무시해도 호환.
     */
    send(type: MessageType, id: string, payload: Record<string, any>): boolean {
        if (!this.ws || !this.connected) {
            console.warn('WebSocket 미연결 상태에서 전송 시도');
            return false;
        }

        const message: WSMessage = {
            type,
            payload: { ...payload, id },
        };

        try {
            this.ws.send(JSON.stringify(message));
            return true;
        } catch (e) {
            console.error('WebSocket 전송 실패:', e);
            return false;
        }
    }

    /**
     * 사용자 프롬프트 전송.
     *
     * @param attachedPaths    사용자가 명시 첨부한 파일/폴더 절대 경로
     * @param activeFile       (폐지됨) 활성 파일 자동 첨부 제거 — 항상 null. 와이어 계약(active_file) 유지용 잔여 파라미터
     * @param attachedSnippets editor에서 선택한 코드 영역 본문 — 서버가 prompt에 직접 임베드
     */
    sendPrompt(
        prompt: string,
        app: string,
        workspace: string,
        os: string = 'macos',
        mode: string = 'agent',
        attachedPaths: string[] = [],
        activeFile: string | null = null,
        attachedSnippets: { file: string; start_line: number; end_line: number; text: string }[] = [],
    ): void {
        if (!this.ws || !this.connected) {
            vscode.window.showErrorMessage('G-TAS 서버에 연결되어 있지 않습니다.');
            return;
        }

        // Settings 패널의 LLM 프로바이더·모델·엔드포인트를 매 요청마다 동봉.
        // 서버 _run_agent_sync는 provider_config가 채워져 있으면 환경변수 기본값보다
        // 이쪽을 우선 적용 — 사용자가 패널에서 vLLM/Ollama/OpenAI를 토글하면 다음 프롬프트
        // 부터 즉시 반영. apiKey는 OpenAI HTTPS 엔드포인트에만 의미가 있으며, vLLM/Ollama
        // 호출 시 서버는 무시.
        const cfg = vscode.workspace.getConfiguration('gtas');
        // vLLM은 모델을 서버 .env(VLLM_DEFAULT_MODEL)에 위임한다(패널의 모델 입력란도 숨김).
        // 다른 프로바이더에서 고른 stale gtas.model이 남아 있으면 서버 _pick이 그 값을
        // .env보다 우선 적용해 .env 변경이 무시되므로, vLLM이면 전송 시점에 강제로 비운다.
        const provider = cfg.get<string>('llmProvider', '') || '';
        // Ollama·vLLM URL은 Settings 패널에서 hidden — 서버 .env(OLLAMA_BASE_URL/VLLM_BASE_URL)가
        // 단일 출처다. gtas.ollamaUrl/vllmUrl의 package.json 기본값(localhost)이나 settings.json에
        // 남은 stale 값을 보내면 서버 _pick이 그 값을 .env보다 우선 적용해 .env 변경이 무시된다
        // (model에서 고친 것과 동일한 회귀). 따라서 전송 시점에 항상 비워 .env로 위임한다.
        // openai_base_url은 OpenAI 선택 시 사용자가 직접 편집하는 값이라 그대로 전송.
        const providerConfig = {
            provider,
            model: provider === 'vLLM' ? '' : (cfg.get<string>('model', '') || ''),
            ollama_url: '',
            vllm_url: '',
            openai_base_url: cfg.get<string>('openaiBaseUrl', '') || '',
            api_key: cfg.get<string>('apiKey', '') || '',
        };

        const message: WSMessage = {
            type: 'user_message',
            payload: {
                prompt,
                app,
                workspace,
                os,
                mode,
                provider_config: providerConfig,
                conversation_history: [],
                attached_paths: attachedPaths,
                active_file: activeFile,
                attached_snippets: attachedSnippets,
            },
        };

        this.ws.send(JSON.stringify(message));
    }

    /**
     * 클라이언트 환경 메타데이터 전송.
     * 세션 시작 직후 + WS 재연결 직후 호출. 서버는 Session.workspace_meta에 캐싱.
     */
    sendWorkspaceMetadata(meta: WorkspaceMetadata): void {
        if (!this.ws || !this.connected) return;  // 재연결 직후 onopen에서 호출되므로 미연결 시 silent
        const message: WSMessage = { type: 'workspace_metadata', payload: { ...meta } };
        this.ws.send(JSON.stringify(message));
    }

    /**
     * 워크스페이스 변경 이벤트. 서버 측 도구 호출 캐시 무효화 트리거.
     */
    sendWorkspaceEvent(kind: 'file_changed' | 'file_deleted' | 'branch_switched', path?: string): void {
        if (!this.ws || !this.connected) return;
        const message: WSMessage = { type: 'workspace_event', payload: { kind, path: path ?? null } };
        this.ws.send(JSON.stringify(message));
    }

    /**
     * 새 대화 시작. 서버 세션의 대화 히스토리·review 누적 상태 비움.
     * workspace_meta·client_os 같은 환경 정보는 보존(재push 불필요).
     */
    sendSessionReset(): void {
        if (!this.ws || !this.connected) return;
        const message: WSMessage = { type: 'session_reset', payload: {} };
        this.ws.send(JSON.stringify(message));
    }

    /**
     * 장시간 도구 실행 중 heartbeat. 서버 bridge가 받으면 해당
     * request_id의 timeout deadline을 (now + initial_timeout)으로 갱신하여
     * 빌드/대용량 처리가 도구별 고정 timeout을 초과해도 timeout 폴백 회피.
     *
     * 클라이언트 tool-executor가 장시간 작업(Bash, RunInTerminal 등) 진행 중
     * 25초 간격으로 호출. id는 서버가 발송한 tool_request의 id.
     */
    sendToolProgress(id: string, elapsedSeconds: number, message: string = ''): void {
        if (!this.ws || !this.connected) return;
        const msg: WSMessage = {
            type: 'tool_progress',
            payload: { id, elapsed_seconds: elapsedSeconds, message },
        };
        try {
            this.ws.send(JSON.stringify(msg));
        } catch (_e) {
            // 전송 실패는 silent — 다음 heartbeat에서 다시 시도
        }
    }

    /**
     * 연결 상태 변경 콜백 등록. 콜백은 ConnectionInfo를 받음.
     */
    onConnectionChange(callback: (info: ConnectionInfo) => void): void {
        this._onConnectionChange = callback;
        // 등록 즉시 1회 통지 — UI 초기 상태 동기화
        this.notifyState();
    }

    /**
     * 사용자가 명시적으로 재연결 요청.
     * burst 카운터를 리셋하고 즉시 시도 — 이미 polling 중이거나 한도 초과 상태여도 재시작.
     */
    async manualReconnect(): Promise<void> {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.reconnectAttempts = 0;
        this.isPolling = false;
        this.notifiedPollingOnce = false;
        if (this.ws) {
            try { this.ws.close(); } catch (_) { /* 무시 */ }
            this.ws = null;
        }
        this.connected = false;
        this.notifyState();
        try {
            await this.connect();
        } catch (_) {
            // connect 실패 시 onclose가 scheduleReconnect 호출
        }
    }

    /**
     * 연결 종료
     */
    disconnect(): void {
        this.stopPingPong();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.connected = false;
    }

    get isConnected(): boolean {
        return this.connected;
    }

    // ── 내부 메서드 ──

    private handleMessage(msg: WSMessage): void {
        // ping-pong
        if (msg.type === 'ping') {
            this.send('pong', '', {});
            return;
        }

        const handlers = this.handlers.get(msg.type) || [];
        for (const handler of handlers) {
            try {
                handler(msg);
            } catch (e) {
                console.error(`핸들러 오류 (${msg.type}):`, e);
            }
        }
    }

    private scheduleReconnect(): void {
        let delay: number;
        if (this.reconnectAttempts < this.maxBurstAttempts) {
            // Burst 단계: 지수 백오프 1s,2s,4s,8s,16s,30s,30s,30s,30s,30s
            delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.burstMaxDelay);
            this.reconnectAttempts++;
            this.isPolling = false;
            console.log(`재연결 시도 ${this.reconnectAttempts}/${this.maxBurstAttempts} (${delay}ms 후)`);
        } else {
            // Polling 단계: 한도 초과 후 60s 간격 무한 시도
            delay = this.idlePollDelay;
            this.isPolling = true;
            if (!this.notifiedPollingOnce) {
                this.notifiedPollingOnce = true;
                vscode.window.showWarningMessage(
                    'G-TAS 서버 재연결 실패. 60초 간격으로 자동 재시도 — 상태 표시줄을 클릭하면 즉시 재시도.'
                );
            }
            console.log(`재연결 폴링 (${delay}ms 후)`);
        }

        this.notifyState();

        this.reconnectTimer = setTimeout(async () => {
            try {
                await this.connect();
            } catch (e: any) {
                this.lastError = this.formatError(e);
                // connect() 실패 시 onclose에서 다시 scheduleReconnect 호출됨
            }
        }, delay);
    }

    private startPingPong(): void {
        this.pingTimer = setInterval(() => {
            if (this.connected) {
                this.send('ping', '', {});
            }
        }, 30000); // 30초 간격
    }

    private stopPingPong(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }
}
