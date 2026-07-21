/**
 * G-TAS 상태바.
 * - 평상시: $(hubot) G-TAS
 * - 실행 중: $(sync~spin) Phase Name 3/37
 * - 끊김: $(hubot) G-TAS ⚠
 */

import * as vscode from 'vscode';

export class GtasStatusBar {
    private item: vscode.StatusBarItem;
    private connected = false;
    private running = false;

    constructor() {
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        this.item.text = '$(hubot) G-TAS';
        this.item.tooltip = 'G-TAS Agent Platform';
        this.item.command = 'gtas.sendPrompt';
        this.item.show();
    }

    setConnected(connected: boolean): void {
        this.connected = connected;
        this._render();
    }

    setRunning(phase?: string, turn?: number, maxTurns?: number): void {
        this.running = !!phase;
        if (phase) {
            const turnStr = turn && maxTurns ? ` ${turn}/${maxTurns}` : '';
            this.item.text = `$(sync~spin) ${phase}${turnStr}`;
            this.item.tooltip = `G-TAS — ${phase} 진행 중`;
        } else {
            this._render();
        }
    }

    setIdle(): void {
        this.running = false;
        this._render();
    }

    private _render(): void {
        if (!this.connected) {
            this.item.text = '$(hubot) G-TAS ⚠';
            this.item.tooltip = 'G-TAS — 연결 끊김';
        } else {
            this.item.text = '$(hubot) G-TAS';
            this.item.tooltip = 'G-TAS — 연결됨';
        }
    }

    dispose(): void {
        this.item.dispose();
    }
}
