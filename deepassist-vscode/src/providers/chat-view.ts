/**
 * G-TAS 채팅 사이드바 view.
 *
 * 상태와 메시지 라우팅은 ChatController가 보유. 이 클래스는 사이드바 webview의
 * 라이프사이클(생성/표시/dispose)만 담당하고, webview를 controller에 attach.
 * editor 영역에서 같은 채팅을 띄우는 ChatPanelProvider도 동일 controller를 공유.
 */

import * as vscode from 'vscode';
import { ChatController } from './chat-controller';
import { loadWebviewHtml } from '../util/webview-html';

export class ChatViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'gtas.chatView';

    private view?: vscode.WebviewView;
    private attachSub?: vscode.Disposable;

    constructor(
        private context: vscode.ExtensionContext,
        private controller: ChatController,
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

        this.attachSub = this.controller.attach(webviewView.webview);
        webviewView.onDidDispose(() => {
            this.attachSub?.dispose();
            this.attachSub = undefined;
            this.view = undefined;
        });
    }

    /** 사이드바 view를 보이게 + input 포커스 요청 */
    show(): void {
        this.view?.show?.(true);
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
