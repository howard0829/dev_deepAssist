/*
 * 설정 webview 진입점.
 * - LLM 프로바이더 라디오 (visible/enabled 패턴)
 * - 모델 셀렉트박스 (Ollama·vLLM 라이브 조회) / 입력 (OpenAI)
 * - 연결 테스트
 */

(function () {
    'use strict';

    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);

    // 기본 프로바이더 메타. 서버 session_init.config에서 덮어씀.
    let providers = [
        { id: 'Ollama', visible: true, enabled: true,
            default_url: 'http://localhost:11434', models: [], default_model: 'gemma3:27b' },
        { id: 'vLLM', visible: true, enabled: true,
            default_url: 'http://localhost:8080', default_model: '' },
        { id: 'OpenAI', visible: true, enabled: true,
            default_url: 'https://api.openai.com/v1', default_model: 'gpt-4o-mini' },
    ];
    let currentProvider = 'Ollama';
    let currentConfig = {};

    // ── Extension → Webview ──
    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.type) {
            case 'init':
                currentConfig = msg.payload.config || {};
                if (msg.payload.providers) providers = msg.payload.providers;
                hydrate();
                break;
            case 'session_config':
                if (msg.payload && msg.payload.providers) {
                    providers = msg.payload.providers;
                    // 서버 .env가 갱신되어 새 default_url이 도착한 경우, 사용자가
                    // persist한 값이 없으면 UI에 반영. 사용자 입력은 항상 우선.
                    if (!currentConfig.ollamaUrl)
                        $('ollama-url').value = providerDefault('Ollama', 'default_url', 'http://localhost:11434');
                    if (!currentConfig.vllmUrl)
                        $('vllm-url').value = providerDefault('vLLM', 'default_url', 'http://localhost:8080');
                    if (!currentConfig.openaiBaseUrl)
                        $('openai-url').value = providerDefault('OpenAI', 'default_url', 'https://api.openai.com/v1');
                    renderProviderRadios();
                    onProviderChange(currentProvider);
                }
                break;
            case 'connection_test_result':
                showTestResult(msg.payload.ok, msg.payload.message);
                break;
            case 'ollama_models':
                populateModelSelect(msg.payload.models || []);
                break;
            case 'vllm_models':
                populateModelSelect(msg.payload.models || []);
                break;
        }
    });

    /** providers[id].key를 안전 조회 — 서버 session_init이 아직 안 왔으면 fallback. */
    function providerDefault(id, key, fallback) {
        const p = providers.find((x) => x.id === id);
        return (p && p[key]) || fallback;
    }

    function hydrate() {
        $('server-url').value = currentConfig.serverUrl || '';
        // URL 초기값은 서버 .env(LLM_PROVIDERS.default_url) → 사용자 persisted 값 우선
        $('ollama-url').value = currentConfig.ollamaUrl
            || providerDefault('Ollama', 'default_url', 'http://localhost:11434');
        $('vllm-url').value = currentConfig.vllmUrl
            || providerDefault('vLLM', 'default_url', 'http://localhost:8080');
        $('openai-url').value = currentConfig.openaiBaseUrl
            || providerDefault('OpenAI', 'default_url', 'https://api.openai.com/v1');
        $('api-key').value = currentConfig.apiKey || '';
        $('model-input').value = currentConfig.model || '';
        currentProvider = currentConfig.llmProvider || 'Ollama';
        renderProviderRadios();
        onProviderChange(currentProvider);
    }

    function renderProviderRadios() {
        const container = $('provider-radios');
        const visible = providers.filter((p) => p.visible !== false);
        container.innerHTML = visible.map((p) => {
            const disabled = p.enabled === false;
            const active = p.id === currentProvider;
            const cls = ['provider-pill', active ? 'active' : ''].filter(Boolean).join(' ');
            return `<button class="${cls}" data-provider="${p.id}" ${disabled ? 'disabled' : ''}>${p.id}</button>`;
        }).join('');
        container.querySelectorAll('.provider-pill').forEach((el) => {
            el.addEventListener('click', () => {
                if (el.disabled) return;
                currentProvider = el.dataset.provider;
                container.querySelectorAll('.provider-pill').forEach((x) => {
                    x.classList.toggle('active', x.dataset.provider === currentProvider);
                });
                onProviderChange(currentProvider);
                persistConfig();
            });
        });
    }

    function onProviderChange(provider) {
        const isOllama = provider === 'Ollama';
        const isVllm = provider === 'vLLM';
        const isOpenAI = provider === 'OpenAI';

        // Ollama·vLLM은 URL을 서버 .env(OLLAMA_BASE_URL/VLLM_BASE_URL)에 위임 — UI 숨김
        $('row-ollama-url').style.display = 'none';
        $('row-vllm-url').style.display = 'none';
        $('row-openai-url').style.display = isOpenAI ? '' : 'none';
        $('row-api-key').style.display = isOpenAI ? '' : 'none';

        // Ollama·vLLM: 모델 셀렉트박스(라이브 조회), OpenAI: 모델 입력
        $('model-select').parentElement.style.display = (isOllama || isVllm) ? '' : 'none';
        $('row-model-input').style.display = isOpenAI ? '' : 'none';

        if (isOllama) {
            requestOllamaModels();
        } else if (isVllm) {
            requestVllmModels();
        }
    }

    function requestOllamaModels() {
        // Ollama URL은 서버 .env(OLLAMA_BASE_URL)로 위임 — 항상 빈값. 숨겨진 #ollama-url의
        // stale DOM 값(특히 1.0.0 업그레이드 시 gtas.ollamaUrl에 남은 실제 URL)을 보내면
        // 모델 목록을 .env와 다른 서버에서 가져와 사용자가 없는 모델을 고르게 된다.
        vscode.postMessage({
            type: 'request_ollama_models',
            ollamaUrl: '',
        });
    }

    function requestVllmModels() {
        // vLLM URL도 서버 .env(VLLM_BASE_URL) 단일 출처 — 빈값으로 요청.
        // 서버가 /v1/models를 호출해 실제 서빙 중인 모델(보통 1개)을 회신.
        vscode.postMessage({
            type: 'request_vllm_models',
            vllmUrl: '',
        });
    }

    function populateModelSelect(models) {
        const select = $('model-select');
        const current = currentConfig.model || '';
        if (!models.length) {
            select.innerHTML = '<option value="">(모델을 가져올 수 없음)</option>';
            return;
        }
        select.innerHTML = models.map((m) => {
            const sel = m === current ? 'selected' : '';
            return `<option value="${m}" ${sel}>${m}</option>`;
        }).join('');
    }

    function showTestResult(ok, message) {
        const el = $('test-result');
        el.className = 'test-result visible ' + (ok ? 'ok' : 'err');
        el.textContent = message;
    }

    function showPending() {
        const el = $('test-result');
        el.className = 'test-result visible pending';
        el.textContent = '🔄 연결 테스트 중...';
    }

    function persistConfig() {
        // Ollama·vLLM 선택 시 URL을 비워서 서버 .env(OLLAMA_BASE_URL/VLLM_BASE_URL)로 위임.
        // 모델은 Ollama·vLLM 모두 라이브 조회 셀렉트에서 사용자가 고른 값을 전송(실재 모델
        // 보장 → 404 없음). 미선택이면 빈값 → 서버 _pick(client → env → default) 폴백.
        const isOllama = currentProvider === 'Ollama';
        const isVllm = currentProvider === 'vLLM';
        const cfg = {
            serverUrl: $('server-url').value,
            llmProvider: currentProvider,
            ollamaUrl: isOllama ? '' : $('ollama-url').value,
            vllmUrl: isVllm ? '' : $('vllm-url').value,
            openaiBaseUrl: $('openai-url').value,
            apiKey: $('api-key').value,
            model: (isOllama || isVllm) ? $('model-select').value
                : $('model-input').value,
        };
        currentConfig = cfg;
        vscode.postMessage({ type: 'persist_config', config: cfg });
    }

    // 입력 변화 시 저장
    ['server-url', 'ollama-url', 'vllm-url', 'openai-url', 'api-key', 'model-input']
        .forEach((id) => {
            $(id).addEventListener('change', persistConfig);
        });
    $('model-select').addEventListener('change', persistConfig);
    $('ollama-url').addEventListener('change', requestOllamaModels);

    $('connection-test-btn').addEventListener('click', () => {
        showPending();
        // Ollama·vLLM URL은 서버 .env로 위임(빈값) — sendPrompt·persistConfig와 동일.
        // 모델은 Ollama·vLLM 모두 라이브 조회 셀렉트 선택값으로 검증(실재 모델). 숨겨진
        // 입력란(#ollama-url/#vllm-url)의 stale DOM URL을 보내면 테스트가 agent 실제 실행과
        // 다른 엔드포인트를 검증해 오탐을 낸다. openai_url/api_key는 사용자 입력값이라 그대로 전송.
        vscode.postMessage({
            type: 'test_connection',
            provider: currentProvider,
            ollamaUrl: '',
            vllmUrl: '',
            openaiBaseUrl: $('openai-url').value,
            apiKey: $('api-key').value,
            model: (currentProvider === 'Ollama' || currentProvider === 'vLLM')
                ? $('model-select').value
                : $('model-input').value,
        });
    });

    vscode.postMessage({ type: 'webview_ready' });
})();
