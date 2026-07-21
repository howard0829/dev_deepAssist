/**
 * G-TAS 설정 webview.
 *
 * - LLM 프로바이더 + 모델 + URL + API Key
 * - 연결 테스트 (서버 경유 WS 메시지 — test_llm_connection)
 * - VSCode Settings의 gtas.* 와 양방향 동기화
 */

import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { loadWebviewHtml } from '../util/webview-html';
import { WSClient } from '../connection/ws-client';

interface PendingTest {
    resolve: (result: { ok: boolean; message: string }) => void;
    timer: ReturnType<typeof setTimeout>;
}

interface ProviderMeta {
    id: string;
    visible: boolean;
    enabled: boolean;
    default_url: string;
    models?: string[];
    default_model: string;
}

const DEFAULT_PROVIDERS: ProviderMeta[] = [
    {
        id: 'Ollama',
        visible: true,
        enabled: true,
        // base_url·model은 서버 .env 단일 출처 — 클라 하드코딩 기본값 제거(빈값).
        // 실제 값은 session_init.providers(서버 LLM_PROVIDERS)로 hydrate.
        default_url: '',
        default_model: '',
    },
    {
        id: 'vLLM',
        visible: true,
        enabled: true,
        default_url: '',
        default_model: '',
    },
    {
        id: 'OpenAI',
        visible: true,
        enabled: true,
        default_url: 'https://api.openai.com/v1',
        default_model: 'gpt-4o-mini',
    },
];

export class SettingsViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'gtas.settingsView';

    private view?: vscode.WebviewView;
    private providers: ProviderMeta[] = [...DEFAULT_PROVIDERS];
    private pendingTests: Map<string, PendingTest> = new Map();
    private pendingOllamaFetch: string | null = null;  // 최신 요청 id만 추적 (이전 요청 결과 무시)
    private pendingVllmFetch: string | null = null;    // vLLM 모델 조회 최신 요청 id

    constructor(
        private context: vscode.ExtensionContext,
        private wsClient: WSClient,
    ) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'webview'),
            ],
        };

        webviewView.webview.html = this._getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'webview_ready':
                    this._sendInit();
                    break;

                case 'persist_config':
                    await this._persistConfig(msg.config);
                    break;

                case 'request_ollama_models':
                    await this._fetchOllamaModels();
                    break;

                case 'request_vllm_models':
                    await this._fetchVllmModels();
                    break;

                case 'test_connection':
                    await this._testConnection(msg);
                    break;
            }
        });
    }

    /** session_init.payload.config의 LLM_PROVIDERS를 webview에 전달 */
    setProvidersFromServer(providers: ProviderMeta[]): void {
        this.providers = providers;
        this.view?.webview.postMessage({
            type: 'session_config',
            payload: { providers },
        });
    }

    private _sendInit(): void {
        const cfg = vscode.workspace.getConfiguration('gtas');
        this.view?.webview.postMessage({
            type: 'init',
            payload: {
                config: {
                    serverUrl: cfg.get<string>('serverUrl', ''),
                    llmProvider: cfg.get<string>('llmProvider', 'Ollama'),
                    ollamaUrl: cfg.get<string>('ollamaUrl', ''),
                    vllmUrl: cfg.get<string>('vllmUrl', ''),
                    openaiBaseUrl: cfg.get<string>('openaiBaseUrl', 'https://api.openai.com/v1'),
                    apiKey: cfg.get<string>('apiKey', ''),
                    model: cfg.get<string>('model', ''),
                },
                providers: this.providers,
            },
        });
    }

    private async _persistConfig(c: any): Promise<void> {
        const cfg = vscode.workspace.getConfiguration('gtas');
        // provider 전환 감지 → gtas.model 리셋(빈값). gtas.model은 Ollama/OpenAI가
        // 공유하는 단일 설정이라, 다른 provider에서 고른 stale 모델이 따라가면 서버 _pick이
        // 그 값을 .env보다 우선 적용해 Ollama 404(model not found)가 난다. 전환 시 비워
        // 미선택 상태로 만들면 서버가 .env(OLLAMA_DEFAULT_MODEL 등)로 폴백. 같은 provider에서
        // 모델만 바꾸는 경우(provider 동일)는 리셋하지 않아 'override 유지'와 양립.
        if (c.llmProvider !== undefined && c.llmProvider !== cfg.get<string>('llmProvider', '')) {
            c.model = '';
        }
        const keys: [string, any][] = [
            ['serverUrl', c.serverUrl],
            ['llmProvider', c.llmProvider],
            ['ollamaUrl', c.ollamaUrl],
            ['vllmUrl', c.vllmUrl],
            ['openaiBaseUrl', c.openaiBaseUrl],
            ['apiKey', c.apiKey],
            ['model', c.model],
        ];
        for (const [key, value] of keys) {
            if (value === undefined) continue;
            try {
                // Global을 단일 출처로 영속화.
                await cfg.update(key, value, vscode.ConfigurationTarget.Global);
            } catch (_) {
                // openaiBaseUrl 등 package.json에 없으면 무시
            }
            // 워크스페이스/폴더 스코프에 남은 값을 제거해 Global을 가리지 못하게 한다.
            // 이 값이 남아 있으면 sendPrompt의 cfg.get(병합 읽기)이 Global보다 워크스페이스를
            // 우선 적용해, 연결 테스트(라이브 selection)는 vLLM인데 실제 실행은 Ollama로 가
            // localhost:11434/api/chat 404가 나던 회귀가 발생한다. 단일 사용자 로컬 모델
            // 가정상 provider/URL/모델의 per-workspace 분리는 사용하지 않음.
            for (const scope of [
                vscode.ConfigurationTarget.Workspace,
                vscode.ConfigurationTarget.WorkspaceFolder,
            ]) {
                try {
                    const inspected = cfg.inspect(key);
                    const shadowing = scope === vscode.ConfigurationTarget.Workspace
                        ? inspected?.workspaceValue !== undefined
                        : inspected?.workspaceFolderValue !== undefined;
                    if (shadowing) {
                        await cfg.update(key, undefined, scope);
                    }
                } catch (_) {
                    // 워크스페이스 미오픈 등으로 쓰기 불가 시 무시
                }
            }
        }
    }

    /**
     * Ollama 모델 목록을 서버 경유로 조회.
     *
     * Settings 패널에서 Ollama 선택 시 URL이 숨겨지므로 클라이언트는 빈 ollama_url로
     * 요청 → 서버가 .env(OLLAMA_BASE_URL)로 폴백. WS 미연결이면 빈 목록.
     */
    private _fetchOllamaModels(): void {
        if (!this.wsClient.isConnected) {
            this.view?.webview.postMessage({
                type: 'ollama_models',
                payload: { models: [] },
            });
            return;
        }
        const id = randomUUID();
        this.pendingOllamaFetch = id;
        // Ollama URL은 항상 서버 .env(OLLAMA_BASE_URL)로 위임 — stale 값 차단(계약 동기화 방어선).
        const sent = this.wsClient.send('fetch_ollama_models', id, {
            ollama_url: '',
        });
        if (!sent) {
            this.pendingOllamaFetch = null;
            this.view?.webview.postMessage({
                type: 'ollama_models',
                payload: { models: [] },
            });
        }
    }

    /** wsClient의 fetch_ollama_models_result 메시지 라우터에서 호출. */
    handleOllamaModelsResult(id: string, models: string[]): void {
        // 사용자가 URL을 빠르게 바꿔 여러 요청을 보낸 경우, 마지막 요청 결과만 반영
        if (id !== this.pendingOllamaFetch) return;
        this.pendingOllamaFetch = null;
        this.view?.webview.postMessage({
            type: 'ollama_models',
            payload: { models },
        });
    }

    /**
     * vLLM 모델 목록을 서버 경유로 조회 (OpenAI 호환 /v1/models).
     *
     * vLLM URL은 서버 .env(VLLM_BASE_URL)가 단일 출처라 클라이언트는 빈 vllm_url로
     * 요청 → 서버가 .env로 폴백. Ollama 조회와 동일 패턴. WS 미연결이면 빈 목록.
     */
    private _fetchVllmModels(): void {
        if (!this.wsClient.isConnected) {
            this.view?.webview.postMessage({
                type: 'vllm_models',
                payload: { models: [] },
            });
            return;
        }
        const id = randomUUID();
        this.pendingVllmFetch = id;
        // vLLM URL은 항상 서버 .env(VLLM_BASE_URL)로 위임 — stale 값 차단(계약 동기화 방어선).
        const sent = this.wsClient.send('fetch_vllm_models', id, {
            vllm_url: '',
        });
        if (!sent) {
            this.pendingVllmFetch = null;
            this.view?.webview.postMessage({
                type: 'vllm_models',
                payload: { models: [] },
            });
        }
    }

    /** wsClient의 fetch_vllm_models_result 메시지 라우터에서 호출. */
    handleVllmModelsResult(id: string, models: string[]): void {
        if (id !== this.pendingVllmFetch) return;
        this.pendingVllmFetch = null;
        this.view?.webview.postMessage({
            type: 'vllm_models',
            payload: { models },
        });
    }

    /**
     * 연결 테스트 — 서버 경유.
     *
     * 클라이언트에서 직접 LLM 엔드포인트에 붙는 대신 G-TAS Server에 위임. vLLM이
     * 서버 사내망에만 있고 클라이언트는 외부에서 WS만 붙는 토폴로지에서도 실제
     * Agent 실행과 동일한 망에서 검증된다.
     *
     * WS 미연결 시는 명시 에러 — 직접 HTTP 폴백 안 함(테스트 의미 흐려짐 방지).
     */
    private async _testConnection(req: any): Promise<void> {
        const provider = req.provider as string;
        let result: { ok: boolean; message: string };

        if (!this.wsClient.isConnected) {
            result = { ok: false, message: '서버 미연결 — 먼저 서버에 연결한 뒤 다시 시도하세요.' };
        } else if (provider === 'OpenAI' && !req.apiKey) {
            result = { ok: false, message: 'API Key가 비어 있습니다' };
        } else {
            try {
                result = await this._testViaServer(provider, req);
            } catch (e: any) {
                result = { ok: false, message: `연결 오류: ${e.message || e}` };
            }
        }
        this.view?.webview.postMessage({
            type: 'connection_test_result',
            payload: result,
        });
    }

    private _testViaServer(provider: string, req: any): Promise<{ ok: boolean; message: string }> {
        return new Promise((resolve, reject) => {
            const id = randomUUID();
            const timer = setTimeout(() => {
                this.pendingTests.delete(id);
                reject(new Error('타임아웃 (15초) — 서버가 LLM 엔드포인트에 응답하지 못했습니다'));
            }, 15000);
            this.pendingTests.set(id, { resolve, timer });

            // Ollama·vLLM URL은 서버 .env로 위임 — 빈값으로 보내야 서버 _pick이 .env로
            // 폴백한다. 모델은 Ollama·vLLM 모두 라이브 조회 셀렉트에서 고른 값을 그대로
            // 검증(실재 모델이라 404 없음). 미선택이면 빈값 → 서버가 사용 가능 목록만 회신.
            // openai_base_url/api_key는 사용자 입력값이라 그대로 통과.
            const model = req.model || '';
            const sent = this.wsClient.send('test_llm_connection', id, {
                provider,
                ollama_url: '',
                vllm_url: '',
                openai_base_url: req.openaiBaseUrl || '',
                api_key: req.apiKey || '',
                model,
            });
            if (!sent) {
                clearTimeout(timer);
                this.pendingTests.delete(id);
                reject(new Error('WebSocket 전송 실패'));
            }
        });
    }

    /** wsClient의 test_llm_connection_result 메시지 라우터에서 호출. */
    handleTestResult(id: string, ok: boolean, message: string): void {
        const pending = this.pendingTests.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingTests.delete(id);
        pending.resolve({ ok, message });
    }

    private _getHtml(webview: vscode.Webview): string {
        const extUri = this.context.extensionUri;
        return loadWebviewHtml({
            htmlPath: vscode.Uri.joinPath(extUri, 'webview', 'settings', 'index.html'),
            webview,
            extensionUri: extUri,
            resources: {
                THEME_CSS: ['webview', 'shared', 'theme.css'],
                STYLES_CSS: ['webview', 'settings', 'styles.css'],
                MAIN_JS: ['webview', 'settings', 'main.js'],
            },
        });
    }
}
