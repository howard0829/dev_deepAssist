/**
 * G-TAS VSCode 확장 — 진입점.
 *
 * - WSClient: 서버 통신
 * - ChatController: 채팅 상태 + webview 메시지 라우팅 (사이드바 view + editor panel 공유)
 * - ChatViewProvider: 사이드바 webview view (Activity Bar의 G-TAS 컨테이너)
 * - ChatPanelProvider: editor 영역 WebviewPanel — gtas.openChatInEditor 명령으로 호출
 * - SettingsViewProvider: 설정 webview (사이드바)
 * - OutputChannelLogger: 상태 로그 누적 + 파일 저장
 * - GtasStatusBar: 상태바
 * - ToolExecutor: 위임 도구 실행 (LLM 호출은 서버 측 직접 — chat·agent 모드 모두)
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { WSClient } from './connection/ws-client';
import { AuthManager } from './connection/auth';
import { ChatController } from './providers/chat-controller';
import { ChatViewProvider } from './providers/chat-view';
import { ChatPanelProvider } from './providers/chat-panel';
import { SettingsViewProvider } from './providers/settings-view';
import { OutputChannelLogger } from './providers/output-channel';
import { GtasStatusBar } from './providers/status-bar';
import { ToolExecutor } from './executor/tool-executor';
import { resolveWorkspace } from './util/workspace-default';
import { buildWorkspaceMetadata } from './util/workspace-metadata';

export async function activate(context: vscode.ExtensionContext) {
    const config = vscode.workspace.getConfiguration('gtas');
    // 우선순위: VSCode 설정 gtas.serverUrl → 환경변수 GTAS_SERVER_URL → 코드 기본값.
    // Settings webview의 서버 URL 입력란이 숨겨져 있으므로, 외부 배포 환경에서는
    // GTAS_SERVER_URL 환경변수로 설정하거나 settings.json에 직접 기재. 둘 다 없으면
    // 아래 DEFAULT_SERVER_WS_URL이 사용됨 (배포 머신 IP에 맞춰 코드 갱신).
    const DEFAULT_SERVER_WS_URL = 'ws://10.138.152.73:8000/ws';
    const cfgServerUrl = (config.get<string>('serverUrl', '') || '').trim();
    const envServerUrl = (process.env.GTAS_SERVER_URL || '').trim();
    const serverUrl = cfgServerUrl || envServerUrl;

    const auth = new AuthManager(context);
    const token = await auth.ensureAuthenticated(serverUrl);

    const wsClient = new WSClient(
        serverUrl ? `${serverUrl}/ws` : DEFAULT_SERVER_WS_URL,
        token,
    );

    // VSCode 워크스페이스 폴더가 없으면 ~/gtas_workspace로 폴백 (자동 생성).
    // 도구 실행과 user_message.workspace 둘 다 같은 경로를 사용하도록 보장.
    const workspace = resolveWorkspace();
    const toolExecutor = new ToolExecutor(workspace);

    const logger = new OutputChannelLogger('G-TAS');
    const statusBar = new GtasStatusBar();
    context.subscriptions.push(statusBar, logger);

    // ── 채팅 컨트롤러 + view + panel ──
    // 사이드바 view와 editor panel이 동일 controller를 공유 → 메시지 broadcast.
    const chatController = new ChatController(
        wsClient,
        () => statusBar.setRunning('실행 중'),
        (action, filepath, extra) => handleModifiedFileAction(action, filepath, workspace, toolExecutor, wsClient, chatController, extra),
        () => {
            // 새로고침: UI는 webview에서 이미 clearMessages()로 비웠음. 서버 세션 리셋 →
            // WebSocket 재연결. 리셋 메시지가 close 전에 서버에 도달하지 못해도 새 연결은
            // 새 session_id를 발급받으므로 안전 (구 세션은 서버 TTL로 정리).
            logger.log('새로고침 — UI 초기화 + 서버 세션 리셋 + 재연결');
            wsClient.sendSessionReset();
            wsClient.manualReconnect();
        },
        () => vscode.commands.executeCommand('gtas.openSettingsView'),
    );

    const chatViewProvider = new ChatViewProvider(context, chatController);
    const chatPanelProvider = new ChatPanelProvider(context, chatController);
    const settingsProvider = new SettingsViewProvider(context, wsClient);

    // webviewOptions.retainContextWhenHidden — 사이드바 view를 사용자가 "Move G-TAS
    // into Editor Area"로 옮기거나 다른 위치(panel, secondary sidebar)로 끌어다 놓을 때
    // webview의 DOM/JS 상태(채팅 히스토리, 진행 패널, 발견사항)를 유지. VSCode는 view를
    // 옮길 때 일시적으로 hidden 상태를 거치는데, 이 옵션이 없으면 매번 webview가 재생성되어
    // 사용 중이던 대화가 사라진 것처럼 보임.
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ChatViewProvider.viewType,
            chatViewProvider,
            { webviewOptions: { retainContextWhenHidden: true } },
        ),
        vscode.window.registerWebviewViewProvider(
            SettingsViewProvider.viewType,
            settingsProvider,
            { webviewOptions: { retainContextWhenHidden: true } },
        ),
        vscode.window.registerWebviewPanelSerializer(ChatPanelProvider.viewType, chatPanelProvider),
    );

    // ── 서버 → 클라이언트 핸들러 ──

    wsClient.on('tool_request', async (msg) => {
        const requestId: string = msg.payload.id;
        const toolName: string = msg.payload.tool_name || '';
        // 장시간 도구는 25s 간격 heartbeat로 서버 bridge timeout 연장.
        // Bash/RunInTerminal은 빌드 등 분 단위 작업 가능. GetDiagnostics/Glob/Grep도
        // 대형 코드베이스에서 길어질 수 있어 포함. Read/Write/Edit 등 즉답 도구는 제외.
        const HEARTBEAT_TOOLS = new Set([
            'Bash', 'RunInTerminal',
            'GetDiagnostics', 'Glob', 'Grep', 'GetOutline', 'FindReferences',
        ]);
        let heartbeatTimer: NodeJS.Timeout | undefined;
        let heartbeatStart = Date.now();
        if (HEARTBEAT_TOOLS.has(toolName)) {
            heartbeatTimer = setInterval(() => {
                const elapsed = (Date.now() - heartbeatStart) / 1000;
                wsClient.sendToolProgress(requestId, elapsed);
            }, 25_000);
        }
        let result;
        try {
            result = await toolExecutor.execute(msg.payload as any);
        } finally {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
        }
        wsClient.send('tool_result', requestId, result);
        if (['Write', 'Edit'].includes(msg.payload.tool_name) && msg.payload.arguments?.file_path) {
            try {
                const uri = vscode.Uri.file(
                    path.resolve(workspace, msg.payload.arguments.file_path)
                );
                await vscode.window.showTextDocument(uri, { preview: true });
            } catch (_) { /* 무시 */ }
        }
    });

    wsClient.on('status_update', (msg) => {
        logger.log(msg.payload.message || '');
        chatController.postMessage(msg);
        if (msg.payload.phase) {
            statusBar.setRunning(msg.payload.phase, msg.payload.turn, msg.payload.max_turns);
        }
    });

    wsClient.on('agent_text', (msg) => chatController.postMessage(msg));
    wsClient.on('progress_update', (msg) => chatController.postMessage(msg));
    wsClient.on('tool_call_update', (msg) => chatController.postMessage(msg));
    wsClient.on('finding_added', (msg) => chatController.postMessage(msg));
    wsClient.on('phase_enter' as any, (msg) => chatController.postMessage(msg));
    wsClient.on('phase_exit' as any, (msg) => chatController.postMessage(msg));
    // 도구 호출 직후 즉시 발송된 unified diff. webview가 누적해 카드 펼침 영역에 사용.
    wsClient.on('modified_file_diff' as any, (msg) => chatController.postMessage(msg));
    // Plan Mode 승인 요청. webview가 Approval Card 렌더 → 응답을 wsClient로 송신.
    wsClient.on('approval_request' as any, (msg) => chatController.postMessage(msg));
    // 승인 게이트 해소 통지(현상 5) — timeout 자동승인·오류 폴백 포함. webview가 카드를 닫음.
    wsClient.on('approval_resolved' as any, (msg) => chatController.postMessage(msg));
    // AskUser 질문. webview가 Clarification Card 렌더 → 답변을 wsClient로 송신.
    wsClient.on('clarification_request' as any, (msg) => chatController.postMessage(msg));

    wsClient.on('agent_complete', (msg) => {
        chatController.postMessage(msg);
        statusBar.setIdle();
        // git.refresh는 호출하지 않음 — git 저장소 없는 워크스페이스에서 VSCode Git
        // 확장이 "There are no available repositories" 알림을 띄움. SCM 뷰는 파일시스템
        // 감시로 자동 갱신되므로 명시 refresh 불필요.
        // 사용자 정책: 워크스페이스에 status_log_*.txt를 생성하지 않음.
        // 상태 로그는 OutputChannel(View)에만 누적 — 'G-TAS: Show Logs' 명령으로 확인.
    });

    wsClient.on('session_init', (msg) => {
        chatController.setApps(msg.payload.apps || []);
        chatController.postMessage(msg);
        // session_init.config의 LLM_PROVIDERS를 설정 webview에 전달
        const cfg = msg.payload.config || {};
        if (cfg.providers || cfg.LLM_PROVIDERS) {
            settingsProvider.setProvidersFromServer(cfg.providers || cfg.LLM_PROVIDERS);
        }
    });

    wsClient.on('test_llm_connection_result' as any, (msg) => {
        const p = msg.payload || {};
        settingsProvider.handleTestResult(p.id || '', !!p.ok, p.message || '');
    });

    wsClient.on('fetch_ollama_models_result' as any, (msg) => {
        const p = msg.payload || {};
        settingsProvider.handleOllamaModelsResult(p.id || '', Array.isArray(p.models) ? p.models : []);
    });

    wsClient.on('fetch_vllm_models_result' as any, (msg) => {
        const p = msg.payload || {};
        settingsProvider.handleVllmModelsResult(p.id || '', Array.isArray(p.models) ? p.models : []);
    });

    wsClient.on('error', (msg) => {
        const m = msg.payload.message || '알 수 없는 에러';
        logger.log(`❌ ${m}`);
        vscode.window.showErrorMessage(`G-TAS: ${m}`);
    });

    wsClient.onConnectionChange((info) => {
        statusBar.setConnected(info.connected);
        chatController.notifyConnection(info);
        // 연결 성공 시마다 환경 메타 push (재연결 후 서버 재시작 시도 시도 양쪽 커버)
        if (info.connected) {
            try {
                const meta = buildWorkspaceMetadata();
                wsClient.sendWorkspaceMetadata(meta);
                logger.log(`✓ workspace_metadata 전송 [os=${meta.client_os} shell=${meta.shell}]`);
            } catch (e: any) {
                logger.log(`⚠️ workspace_metadata 빌드 실패: ${e?.message || e}`);
            }
        }
    });

    // ── 명령 등록 ──
    context.subscriptions.push(
        vscode.commands.registerCommand('gtas.sendPrompt', () => {
            chatViewProvider.show();
            chatController.focusInput();
        }),
        vscode.commands.registerCommand('gtas.openChatInEditor', () => {
            chatPanelProvider.revealOrCreate(vscode.ViewColumn.Beside);
        }),
        vscode.commands.registerCommand('gtas.stop', () => {
            wsClient.send('stop_request', '', {});
        }),
        vscode.commands.registerCommand('gtas.switchApp', async () => {
            const apps = chatController.getApps();
            const picked = await vscode.window.showQuickPick(
                apps.filter((a) => a.enabled !== false).map((a) => ({
                    label: `${a.icon} ${a.name}`,
                    description: a.description,
                    appId: a.id,
                })),
                { placeHolder: 'Agent App 선택' },
            );
            if (picked) {
                chatController.switchApp((picked as any).appId);
            }
        }),
        vscode.commands.registerCommand('gtas.configure', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'gtas');
        }),
        vscode.commands.registerCommand('gtas.openSettingsView', () => {
            vscode.commands.executeCommand('gtas.settingsView.focus');
        }),
        vscode.commands.registerCommand('gtas.showLogs', () => {
            logger.show();
        }),
        // 컨텍스트 첨부 — explorer 우클릭(uri, uris) + editor 우클릭(uri) 양쪽 수용.
        // editor 우클릭이고 텍스트가 선택되어 있으면 path 대신 *스니펫*으로 첨부 —
        // 선택한 코드 본문을 LLM 프롬프트에 직접 임베드하여 "이 부분 무슨 내용?" 같은
        // 질문에 정확히 답하게 함. explorer 다중 선택은 기존대로 path 첨부.
        vscode.commands.registerCommand(
            'gtas.attachToContext',
            (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
                // 1) explorer 다중 선택 — 그대로 path 첨부
                if (uris && uris.length > 0) {
                    const paths = uris
                        .filter((u) => u.scheme === 'file')
                        .map((u) => u.fsPath);
                    if (paths.length > 0) {
                        chatController.attachPaths(paths);
                        revealChat(chatViewProvider);
                        return;
                    }
                }

                // 2) 단일 uri 또는 활성 에디터
                const editor = vscode.window.activeTextEditor;
                const targetUri = uri || editor?.document?.uri;
                if (!targetUri || targetUri.scheme !== 'file') {
                    vscode.window.showWarningMessage('G-TAS: 첨부할 파일/폴더를 찾을 수 없습니다.');
                    return;
                }

                // 3) editor 컨텍스트에서 호출됐고 선택 영역이 있으면 → 스니펫 첨부
                const isSameDoc = editor && editor.document.uri.toString() === targetUri.toString();
                if (isSameDoc && editor && !editor.selection.isEmpty) {
                    const sel = editor.selection;
                    const text = editor.document.getText(sel);
                    chatController.attachSnippet({
                        file: targetUri.fsPath,
                        start_line: sel.start.line + 1,  // 1-based
                        end_line: sel.end.line + 1,
                        text,
                    });
                    revealChat(chatViewProvider);
                    return;
                }

                // 4) 선택 없음 — 단순 path 첨부 (기존 동작)
                chatController.attachPaths([targetUri.fsPath]);
                revealChat(chatViewProvider);
            },
        ),
    );

    // ── 활성 에디터 자동 추적 제거 ──
    // 활성 파일 자동 첨부는 폐지: 거대/부하 큰 파일이 활성 에디터일 때 매턴 prefetch
    // 재-Read + VSCode 자체 부하가 단일 스레드 확장 호스트를 굶겨 Bash/Read/Glob이
    // 균일 타임아웃 나던 문제(96 KI). 컨텍스트 첨부는 명시적 직접 추가(📎 경로/📋 스니펫)만 유지.

    // ── 워크스페이스 변경 이벤트 발송 (서버 측 도구 캐시 무효화) ──
    // 디바운스 100ms — 자동 저장 multi-file 시 폭발 방지.
    let pendingPaths = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushWorkspaceEvents = () => {
        flushTimer = null;
        for (const p of pendingPaths) {
            wsClient.sendWorkspaceEvent('file_changed', p);
        }
        pendingPaths.clear();
    };
    const queueWorkspaceEvent = (filePath: string) => {
        pendingPaths.add(filePath);
        if (flushTimer === null) {
            flushTimer = setTimeout(flushWorkspaceEvents, 100);
        }
    };
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument((doc) => {
            if (doc.uri.scheme === 'file') queueWorkspaceEvent(doc.uri.fsPath);
        }),
        vscode.workspace.onDidDeleteFiles((e) => {
            for (const f of e.files) {
                if (f.scheme === 'file') wsClient.sendWorkspaceEvent('file_deleted', f.fsPath);
            }
        }),
        vscode.workspace.onDidRenameFiles((e) => {
            // 이름 변경은 양쪽 path를 캐시 무효화 (이전 키 + 새 키)
            for (const r of e.files) {
                if (r.oldUri.scheme === 'file') wsClient.sendWorkspaceEvent('file_deleted', r.oldUri.fsPath);
                if (r.newUri.scheme === 'file') wsClient.sendWorkspaceEvent('file_changed', r.newUri.fsPath);
            }
        }),
    );

    // ── 서버 연결 ──
    try {
        await wsClient.connect();
        logger.log('G-TAS Server 연결 성공');
    } catch (e: any) {
        logger.log(`G-TAS Server 연결 실패: ${e.message}`);
        vscode.window.showWarningMessage(
            `G-TAS 서버 연결 실패. Settings에서 서버 주소를 확인하세요. (${e.message})`,
        );
    }
}

/**
 * 컨텍스트 첨부 후 채팅 UI를 노출. 사이드바를 우선하되, 사이드바가 닫혀 있고
 * 패널이 열려 있는 경우에도 사용자에게 위치 변경 없이 진행되도록 단순히 view focus 명령을 실행.
 * (focus 명령은 view가 등록되어 있으면 활성화되고 그렇지 않으면 무동작)
 */
function revealChat(chatViewProvider: ChatViewProvider): void {
    chatViewProvider.show();
    vscode.commands.executeCommand('gtas.chatView.focus');
}

/**
 * modified_files 카드의 액션 처리.
 * action: 'open' → 파일 열기, 'diff' → SCM Diff 뷰, 'vscode_diff' → git 무관 임시 비교,
 *         'revert' → 변경 전 콘텐츠로 되돌리고 서버에 USER_REJECT_CHANGE 송신
 */
async function handleModifiedFileAction(
    action: string,
    filepath: string,
    workspace: string,
    toolExecutor?: ToolExecutor,
    wsClient?: any,
    chatController?: any,
    extra?: { reason?: string | null },
): Promise<void> {
    try {
        const absPath = path.isAbsolute(filepath)
            ? filepath
            : path.resolve(workspace, filepath);
        const uri = vscode.Uri.file(absPath);
        if (action === 'revert') {
            // 변경 전 콘텐츠로 되돌리기
            if (!toolExecutor) {
                vscode.window.showErrorMessage('되돌리기: ToolExecutor 미초기화');
                return;
            }
            const res = await toolExecutor.revertFile(absPath);
            if (!res.ok) {
                vscode.window.showErrorMessage(`되돌리기 실패: ${res.error || '원인 불명'}`);
                return;
            }
            // 서버에 USER_REJECT_CHANGE 송신 — agent의 다음 turn에 LLM 피드백 주입
            if (wsClient && typeof wsClient.send === 'function') {
                wsClient.send('user_reject_change', '', {
                    files: [absPath],
                    reason: extra?.reason ?? null,
                    timestamp: Date.now() / 1000,
                });
            }
            // webview에 시각 갱신 — 카드를 reverted 상태로 표시
            if (chatController && typeof chatController.postMessage === 'function') {
                chatController.postMessage({
                    type: 'modified_file_reverted' as any,
                    payload: { path: absPath },
                });
            }
            return;
        }
        if (action === 'unrevert') {
            // 되돌리기 취소 — revertFile이 캡처한 변경 후 콘텐츠로 재적용. 로컬 전용
            // (B-3): 서버엔 거부가 그대로 남아 LLM은 다음 턴까지 '거부됨'으로 인지.
            if (!toolExecutor) {
                vscode.window.showErrorMessage('되돌리기 취소: ToolExecutor 미초기화');
                return;
            }
            const res = await toolExecutor.unrevertFile(absPath);
            if (!res.ok) {
                vscode.window.showErrorMessage(`되돌리기 취소 실패: ${res.error || '원인 불명'}`);
                return;
            }
            if (chatController && typeof chatController.postMessage === 'function') {
                chatController.postMessage({
                    type: 'modified_file_unreverted' as any,
                    payload: { path: absPath },
                });
            }
            return;
        }
        if (action === 'vscode_diff') {
            // git 무관 native diff. tool-executor가 메모리에 보관한
            // 변경 전 콘텐츠를 임시 untitled URI로 띄우고 vscode.diff로 비교.
            // cache miss(toolExecutor가 없거나 before-content 부재) 시 일반 열기로 fallback.
            const before = toolExecutor?.getBeforeContent(absPath);
            if (before !== null && before !== undefined) {
                try {
                    const beforeUri = vscode.Uri.parse(`untitled:${absPath}.before`);
                    const doc = await vscode.workspace.openTextDocument(beforeUri);
                    const editor = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
                    if (doc.getText() !== before) {
                        await editor.edit((eb) => {
                            eb.replace(new vscode.Range(0, 0, doc.lineCount, 0), before);
                        });
                    }
                    const title = `${path.basename(absPath)} (변경 전 ↔ 변경 후)`;
                    await vscode.commands.executeCommand('vscode.diff', beforeUri, uri, title);
                    return;
                } catch (e: any) {
                    // diff 명령 실패 시 일반 열기로 fallback
                }
            }
            // before-content 없으면 일반 열기
            await vscode.window.showTextDocument(uri, { preview: false });
            return;
        }
        if (action === 'diff') {
            // git.openChange는 파일이 SCM에서 추적될 때 동작
            try {
                await vscode.commands.executeCommand('git.openChange', uri);
                return;
            } catch (_) {
                // git이 없거나 staging이 아니면 일반 열기로 fallback
            }
        }
        await vscode.window.showTextDocument(uri, { preview: false });
    } catch (e: any) {
        vscode.window.showErrorMessage(`파일 열기 실패: ${e.message}`);
    }
}

export function deactivate() {}
