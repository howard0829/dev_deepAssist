/**
 * G-TAS 채팅 컨트롤러.
 *
 * 사이드바 view와 editor 영역 panel이 같은 채팅 세션을 공유할 수 있도록
 * 상태(apps, 첨부, 활성 파일, 연결 정보)와 webview ↔ ws-client 메시지 라우팅을
 * 한 인스턴스에 집중시킨다.
 *
 * - attach(webview): WebviewView 또는 WebviewPanel의 webview를 등록.
 *   반환된 Disposable로 dispose 시 자동 분리.
 * - postMessage(msg): 모든 attached webview에 broadcast. attached가 없으면 pending에 큐잉.
 * - webview_ready 수신 시: 첫 attach면 pending flush, 이후엔 송신 webview에 스냅샷 sync
 *   (apps 카드 + 컨텍스트 + 연결 상태). 늦게 attach한 panel도 즉시 정상 상태로 진입.
 */

import * as vscode from 'vscode';
import { WSClient, WSMessage, ConnectionInfo } from '../connection/ws-client';
import { resolveWorkspace } from '../util/workspace-default';

/** editor에서 선택한 코드 영역. user_message.attached_snippets로 서버 전달. */
export interface SnippetAttachment {
    file: string;        // 절대 경로
    start_line: number;  // 1-based
    end_line: number;    // 1-based, inclusive
    text: string;        // 선택 영역 본문 (서버가 prompt에 직접 임베드)
}

export class ChatController {
    private targets: Set<vscode.Webview> = new Set();
    private firstFlushDone = false;
    private pendingMessages: WSMessage[] = [];

    private apps: any[] = [];
    private currentApp: string = 'deep_assist';
    private attachedPaths: string[] = [];
    private attachedSnippets: SnippetAttachment[] = [];
    private lastConnectionInfo: ConnectionInfo | null = null;
    private lastSessionInit: WSMessage | null = null;

    constructor(
        private wsClient: WSClient,
        private onUserMessageHandler?: () => void,
        private onModifiedFileAction?: (action: string, path: string, extra?: { reason?: string | null }) => void,
        private onResetChat?: () => void,
        private onOpenSettings?: () => void,
    ) {}

    /**
     * webview를 등록. WebviewView/WebviewPanel 양쪽 모두 호출자가
     * 자체 dispose 훅에서 반환 Disposable을 dispose해야 함.
     */
    attach(webview: vscode.Webview): vscode.Disposable {
        this.targets.add(webview);
        const sub = webview.onDidReceiveMessage(async (msg) => {
            await this._handleWebviewMessage(msg, webview);
        });
        return new vscode.Disposable(() => {
            this.targets.delete(webview);
            sub.dispose();
        });
    }

    /** Extension → 모든 webview 메시지 broadcast. attached가 없으면 pending에 누적. */
    postMessage(msg: WSMessage): void {
        if (msg.type === 'session_init') this.lastSessionInit = msg;
        if (this.targets.size === 0) {
            this.pendingMessages.push(msg);
            return;
        }
        for (const w of this.targets) w.postMessage(msg);
    }

    /** 연결 상태 변경 — ConnectionInfo 전체를 broadcast (단, session_init과 분리) */
    notifyConnection(info: ConnectionInfo): void {
        this.lastConnectionInfo = info;
        const msg: WSMessage = { type: 'connection_state' as any, payload: info as any };
        if (this.targets.size === 0) {
            this.pendingMessages.push(msg);
            return;
        }
        for (const w of this.targets) w.postMessage(msg);
    }

    getApps(): any[] { return this.apps; }
    getCurrentApp(): any { return this.apps.find((a) => a.id === this.currentApp); }
    setApps(apps: any[]): void { this.apps = apps; }

    switchApp(appId: string): void {
        this.currentApp = appId;
        this.postMessage({
            type: 'app_switched' as any,
            payload: { app: appId },
        });
    }

    /** 현재 등록된 모든 webview에 input 포커스 요청 — 사이드바 view는 호출자가 별도 show() */
    focusInput(): void {
        this.postMessage({ type: 'focus_input' as any, payload: {} });
    }

    /** 외부(우클릭 명령 등)에서 파일/폴더를 컨텍스트에 첨부. 중복 제거. */
    attachPaths(paths: string[]): void {
        const set = new Set(this.attachedPaths);
        for (const p of paths) set.add(p);
        this.attachedPaths = Array.from(set);
        this._broadcastContextUpdate();
    }

    /** editor에서 선택한 코드 영역을 스니펫으로 첨부. 같은 (file, range) 중복은 무시. */
    attachSnippet(snippet: SnippetAttachment): void {
        const dup = this.attachedSnippets.find(
            (s) => s.file === snippet.file
                && s.start_line === snippet.start_line
                && s.end_line === snippet.end_line,
        );
        if (dup) return;
        this.attachedSnippets.push(snippet);
        this._broadcastContextUpdate();
    }

    private _broadcastContextUpdate(): void {
        this.postMessage({
            type: 'context_update' as any,
            payload: this._buildContextPayload(),
        });
    }

    private _buildContextPayload(): Record<string, any> {
        return {
            attached_paths: this.attachedPaths,
            // 스니펫은 본문(text) 제외하고 메타만 전송 — webview 표시에는 라벨만
            // 필요하고 body는 전송 시 사용. 본문이 길면 webview 메모리 낭비.
            attached_snippets: this.attachedSnippets.map((s) => ({
                file: s.file,
                start_line: s.start_line,
                end_line: s.end_line,
                preview: s.text.slice(0, 80).replace(/\n/g, ' '),
            })),
        };
    }

    /**
     * webview 단일 인스턴스 동기화. 늦게 attach된 panel이 현재 세션 상태를 즉시
     * 반영할 수 있도록 apps(session_init) + 컨텍스트 + 연결 정보를 그 webview에만 보냄.
     */
    private _syncSnapshotTo(webview: vscode.Webview): void {
        if (this.lastSessionInit) {
            webview.postMessage(this.lastSessionInit);
        }
        webview.postMessage({
            type: 'context_update' as any,
            payload: this._buildContextPayload(),
        });
        if (this.lastConnectionInfo) {
            webview.postMessage({
                type: 'connection_state' as any,
                payload: this.lastConnectionInfo,
            });
        }
    }

    private async _handleWebviewMessage(msg: any, source: vscode.Webview): Promise<void> {
        switch (msg.type) {
            case 'webview_ready':
                if (!this.firstFlushDone) {
                    this.firstFlushDone = true;
                    // 첫 webview ready — 누적된 pending을 모든 attached에 flush
                    for (const t of this.targets) {
                        for (const m of this.pendingMessages) t.postMessage(m);
                    }
                    this.pendingMessages = [];
                }
                // 송신 webview에 현재 스냅샷 sync (panel 늦게 합류 시에도 정상 진입)
                this._syncSnapshotTo(source);
                break;

            case 'manual_reconnect':
                this.wsClient.manualReconnect();
                break;

            case 'user_message': {
                // 워크스페이스 폴더 없으면 ~/gtas_workspace 폴백 (자동 생성)
                const workspace = resolveWorkspace();
                const os = process.platform === 'win32' ? 'windows'
                    : process.platform === 'darwin' ? 'macos' : 'linux';
                const mode = msg.mode === 'chat' ? 'chat' : 'agent';
                // 활성 파일 자동 첨부 폐지 — active_file은 항상 null(명시 직접 추가만 유지).
                this.wsClient.sendPrompt(
                    msg.prompt,
                    msg.app || this.currentApp,
                    workspace,
                    os,
                    mode,
                    [...this.attachedPaths],
                    null,
                    this.attachedSnippets.map((s) => ({ ...s })),
                );
                // 전송 후 명시 첨부·스니펫 비움 — 다음 턴에 의도치 않게 따라가지 않도록.
                this.attachedPaths = [];
                this.attachedSnippets = [];
                this._broadcastContextUpdate();
                this.onUserMessageHandler?.();
                break;
            }

            case 'remove_attached_path':
                this.attachedPaths = this.attachedPaths.filter((p) => p !== msg.path);
                this._broadcastContextUpdate();
                break;

            case 'clear_attached_paths':
                this.attachedPaths = [];
                this.attachedSnippets = [];
                this._broadcastContextUpdate();
                break;

            case 'remove_attached_snippet':
                this.attachedSnippets = this.attachedSnippets.filter(
                    (s) => !(s.file === msg.file && s.start_line === msg.start_line && s.end_line === msg.end_line),
                );
                this._broadcastContextUpdate();
                break;

            case 'stop_request':
                this.wsClient.send('stop_request', '', {});
                break;

            case 'switch_app':
                this.currentApp = msg.app;
                break;

            case 'modified_file_action':
                this.onModifiedFileAction?.(msg.action, msg.path, { reason: msg.reason });
                break;

            case 'request_input': {
                // VSCode webview sandbox는 window.prompt를 지원하지 않아 호출 즉시 null이
                // 돌아온다 → "수정 요청"/"되돌리기" 버튼이 무반응으로 보이는 회귀의 원인.
                // host의 vscode.window.showInputBox로 대체하고, payload.kind와 동봉된
                // 컨텍스트(requestId, path 등)를 그대로 echo하여 webview가 라우팅하도록.
                const inp = msg.payload || {};
                const value = await vscode.window.showInputBox({
                    prompt: inp.prompt || '',
                    placeHolder: inp.placeHolder || '',
                    value: inp.value || '',
                    ignoreFocusOut: true,
                });
                const cancelled = value === undefined;
                source.postMessage({
                    type: 'input_result',
                    payload: {
                        kind: inp.kind,
                        requestId: inp.requestId,
                        path: inp.path,
                        value: cancelled ? null : value,
                        cancelled,
                    },
                });
                break;
            }

            case 'approval_response': {
                // Plan Mode 사용자 결정 → 서버 bridge.deliver_response가 매칭 unblock.
                // 미연결 상태에서 send가 silent return되면 카드 시각만 잠긴 채 서버는 응답을
                // 받지 못해 120s 후 자동 승인되던 회귀 차단. send 결과를 받아
                // 송신 webview에 ack를 회신 — webview는 ack 도착 전까지 pending 표시.
                const ap = msg.payload || {};
                const requestId = ap.id || '';
                const ok = this.wsClient.send('approval_response', requestId, {
                    decision: ap.decision || 'approve',
                    feedback: ap.feedback ?? null,
                });
                source.postMessage({
                    type: 'approval_ack',
                    payload: {
                        id: requestId,
                        ok,
                        reason: ok ? null : '서버에 연결되지 않아 응답을 전송하지 못했습니다. 연결 복구 후 다시 눌러주세요.',
                    },
                });
                break;
            }

            case 'clarification_response': {
                // AskUser 질문에 대한 사용자 답변 → 서버 bridge.deliver_response가 매칭 unblock.
                // approval_response와 동일 패턴 — 미연결 시 ack ok=false로 webview에 재시도 유도.
                const cl = msg.payload || {};
                const requestId = cl.id || '';
                const ok = this.wsClient.send('clarification_response', requestId, {
                    answer: cl.answer ?? null,
                });
                source.postMessage({
                    type: 'clarification_ack',
                    payload: {
                        id: requestId,
                        ok,
                        reason: ok ? null : '서버에 연결되지 않아 답변을 전송하지 못했습니다. 연결 복구 후 다시 눌러주세요.',
                    },
                });
                break;
            }

            case 'reset_chat':
                // 새로고침 = 처음부터 모두 새로 시작. 첨부 path/스니펫 모두 비우고
                // broadcast로 다른 webview(사이드바/패널)에도 반영. 활성 파일은
                // 자동 추적이라 비우지 않음.
                this.attachedPaths = [];
                this.attachedSnippets = [];
                this._broadcastContextUpdate();
                this.postMessage({ type: 'reset_chat' as any, payload: {} });
                this.onResetChat?.();
                break;

            case 'open_settings':
                this.onOpenSettings?.();
                break;
        }
    }
}
