/**
 * 공통 webview HTML 로더.
 * - 디스크의 HTML 파일을 읽어 {{토큰}}을 webview URI로 치환
 * - CSP nonce 발행
 */

import * as vscode from 'vscode';
import * as fs from 'fs';

export function generateNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

export interface WebviewHtmlOptions {
    htmlPath: vscode.Uri;
    webview: vscode.Webview;
    extensionUri: vscode.Uri;
    /** {{토큰}} → 디스크 상대 경로 매핑. 자동으로 webview URI로 치환됨. */
    resources: Record<string, string[]>;
}

/**
 * 디스크 HTML을 읽어 webview용 URI로 토큰 치환 후 반환.
 * CSP는 자동 생성되며 {{CSP}} 토큰을 치환.
 */
export function loadWebviewHtml(opts: WebviewHtmlOptions): string {
    const { htmlPath, webview, extensionUri, resources } = opts;
    const raw = fs.readFileSync(htmlPath.fsPath, 'utf8');
    const nonce = generateNonce();

    let html = raw;
    for (const [token, segments] of Object.entries(resources)) {
        const uri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...segments));
        html = html.replace(new RegExp(`{{${token}}}`, 'g'), uri.toString());
    }

    const csp = [
        `default-src 'none'`,
        `img-src ${webview.cspSource} https: data:`,
        `script-src ${webview.cspSource}`,
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `font-src ${webview.cspSource}`,
    ].join('; ');
    html = html.replace(/{{CSP}}/g, csp).replace(/{{NONCE}}/g, nonce);

    return html;
}
