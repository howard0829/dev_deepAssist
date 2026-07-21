/**
 * G-TAS 채팅 패널 — main editor 영역에 표시되는 WebviewPanel 싱글턴.
 *
 * 사이드바 ChatViewProvider와 동일한 ChatController를 공유 — 두 webview가 동시에
 * 열려 있어도 서버 메시지가 양쪽에 broadcast된다. 사용자는 편한 위치를 선택.
 *
 * - revealOrCreate(): 패널이 이미 있으면 reveal, 없으면 createWebviewPanel.
 * - retainContextWhenHidden:true — 다른 탭으로 이동해도 webview JS 상태(채팅 히스토리,
 *   진행 패널) 유지. 메모리 비용은 단일 사용자 환경에서 허용 가능.
 * - WebviewPanelSerializer 구현 — 윈도우 reload 후 패널 자동 복원.
 */

import * as vscode from 'vscode';
import { ChatController } from './chat-controller';
import { loadWebviewHtml } from '../util/webview-html';

export class ChatPanelProvider implements vscode.WebviewPanelSerializer {
    public static readonly viewType = 'gtas.chatPanel';

    private panel?: vscode.WebviewPanel;
    private attachSub?: vscode.Disposable;

    constructor(
        private context: vscode.ExtensionContext,
        private controller: ChatController,
    ) {}

    /** 패널이 이미 있으면 reveal, 없으면 새로 생성. column 미지정 시 Active 옆(Beside). */
    revealOrCreate(column?: vscode.ViewColumn): void {
        const target = column ?? vscode.ViewColumn.Beside;
        if (this.panel) {
            this.panel.reveal(target);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            ChatPanelProvider.viewType,
            'G-TAS Chat',
            target,
            this._panelOptions(),
        );
        this._adopt(panel);
    }

    /** WebviewPanelSerializer — 윈도우 reload 시 호출. 기존 panel 인스턴스를 인계받음. */
    async deserializeWebviewPanel(panel: vscode.WebviewPanel, _state: unknown): Promise<void> {
        // reload 후에는 webview.options가 휘발될 수 있으므로 다시 설정
        panel.webview.options = this._webviewOptions();
        this._adopt(panel);
    }

    private _adopt(panel: vscode.WebviewPanel): void {
        // 이전 panel이 살아 있으면 분리 (싱글턴 보장)
        if (this.panel && this.panel !== panel) {
            this.attachSub?.dispose();
            this.panel.dispose();
        }
        this.panel = panel;
        panel.iconPath = vscode.Uri.joinPath(
            this.context.extensionUri, 'media', 'g-tas-icon.svg',
        );
        panel.webview.html = this._getHtml(panel.webview);
        this.attachSub = this.controller.attach(panel.webview);
        panel.onDidDispose(() => {
            this.attachSub?.dispose();
            this.attachSub = undefined;
            this.panel = undefined;
        });
    }

    private _webviewOptions(): vscode.WebviewOptions {
        return {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'webview'),
            ],
        };
    }

    private _panelOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
        return {
            ...this._webviewOptions(),
            retainContextWhenHidden: true,
        };
    }

    private _getHtml(webview: vscode.Webview): string {
        const extUri = this.context.extensionUri;
        return loadWebviewHtml({
            htmlPath: vscode.Uri.joinPath(extUri, 'webview', 'chat', 'index.html'),
            webview,
            extensionUri: extUri,
            resources: {
                THEME_CSS:        ['webview', 'shared', 'theme.css'],
                STYLES_CSS:       ['webview', 'chat', 'styles.css'],
                LIB_MARKED:       ['webview', 'lib', 'marked.min.js'],
                LIB_PURIFY:       ['webview', 'lib', 'purify.min.js'],
                SHARED_MARKDOWN:  ['webview', 'shared', 'markdown.js'],
                PROGRESS_JS:      ['webview', 'chat', 'progress.js'],
                DIFF_RENDERER_JS: ['webview', 'chat', 'diff-renderer.js'],
                MAIN_JS:          ['webview', 'chat', 'main.js'],
            },
        });
    }
}
