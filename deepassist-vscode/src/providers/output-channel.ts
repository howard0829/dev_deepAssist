/**
 * G-TAS 출력 채널 — 상태 로그를 VSCode OutputChannel View에 누적.
 *
 * 사용자 정책으로 워크스페이스에 로그 파일(`status_log_*.txt`)을 생성하지 않음.
 * `saveToFile()` 메서드는 호환을 위해 유지하지만 기본 호출 경로(extension.ts의
 * agent_complete 핸들러)에서는 호출되지 않음. 사용자가 직접 명시적으로 저장이
 * 필요하면 명령으로 호출하는 형태로만 사용 가능.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class OutputChannelLogger {
    private channel: vscode.OutputChannel;
    private buffer: string[] = [];

    constructor(name: string = 'G-TAS') {
        this.channel = vscode.window.createOutputChannel(name);
    }

    log(message: string): void {
        const ts = new Date().toLocaleTimeString();
        const line = `[${ts}] ${message}`;
        this.channel.appendLine(line);
        this.buffer.push(line);
        if (this.buffer.length > 5000) {
            this.buffer = this.buffer.slice(-3000);
        }
    }

    show(): void { this.channel.show(); }

    clear(): void {
        this.channel.clear();
        this.buffer = [];
    }

    /** 워크스페이스 루트에 status_log_YYYYMMDD_HHMMSS.txt 저장. */
    async saveToFile(): Promise<string | null> {
        if (!this.buffer.length) return null;
        const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!ws) return null;

        const now = new Date();
        const stamp = [
            now.getFullYear(),
            String(now.getMonth() + 1).padStart(2, '0'),
            String(now.getDate()).padStart(2, '0'),
            '_',
            String(now.getHours()).padStart(2, '0'),
            String(now.getMinutes()).padStart(2, '0'),
            String(now.getSeconds()).padStart(2, '0'),
        ].join('');
        const filename = `status_log_${stamp}.txt`;
        const filepath = path.join(ws, filename);
        try {
            await fs.promises.writeFile(filepath, this.buffer.join('\n'), 'utf8');
            this.log(`📁 상태 로그 저장: ${filename}`);
            return filepath;
        } catch (e: any) {
            this.log(`❌ 상태 로그 저장 실패: ${e.message}`);
            return null;
        }
    }

    dispose(): void {
        this.channel.dispose();
    }
}
