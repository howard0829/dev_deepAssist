/**
 * G-TAS 인증 관리
 *
 * 단일 사용자 로컬 모델 — 인증 미사용. globalState에 토큰 자리만 유지.
 */

import * as vscode from 'vscode';

export class AuthManager {
    private context: vscode.ExtensionContext;
    private static TOKEN_KEY = 'gtas.authToken';

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    /**
     * 인증 토큰 확보. 현재는 빈 문자열 반환 (인증 미사용).
     */
    async ensureAuthenticated(serverUrl: string): Promise<string> {
        // 인증 스킵
        const stored = this.context.globalState.get<string>(AuthManager.TOKEN_KEY);
        if (stored) {
            return stored;
        }
        return '';
    }

    /**
     * 토큰 저장
     */
    async saveToken(token: string): Promise<void> {
        await this.context.globalState.update(AuthManager.TOKEN_KEY, token);
    }

    /**
     * 토큰 삭제 (로그아웃)
     */
    async clearToken(): Promise<void> {
        await this.context.globalState.update(AuthManager.TOKEN_KEY, undefined);
    }
}
