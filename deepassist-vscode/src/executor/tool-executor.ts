/**
 * G-TAS 도구 실행기 — VSCode API + 클라이언트 OS의 native 파일시스템 활용
 *
 * 서버가 tool_request로 위임한 도구를 클라이언트에서 실행.
 *
 * 파일/탐색 도구 5종(Read/Write/Edit/Glob/Grep)도 클라이언트 위임으로
 * 활성화. Windows 경로 native 처리. 워크스페이스 외부 접근도 허용 (재앙 명령만
 * 차단하는 정책과 일관). Bash도 활성화 예정.
 *
 * VSCode-only 도구:
 *   - GetDiagnostics, GetSelection, RunInTerminal
 *   - GetOutline, FindSymbol, FindReferences, GoToDefinition
 *
 * 파일 시스템 도구:
 *   - Read, Write, Edit — fs/promises 직접 호출
 *   - Glob, Grep — JS 자체 구현 (Windows 호환, child_process 의존 없음)
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import * as readline from 'readline';
import * as path from 'path';
import * as cp from 'child_process';
import { detectShell } from './shell-detector';
import { checkCatastrophic } from './dangerous-commands';

export interface ToolResult {
    output: string;
    success: boolean;
    duration: number;
    /** 도구 부수 효과. agent_complete의 modified_files 카드에 사용. */
    side_effects?: {
        modified_files?: string[];
        created_files?: string[];
        deleted_files?: string[];
        /**
         * 수정된 파일별 unified diff. Edit/Write/MultiEdit가 채움.
         * 키는 절대경로, 값은 unified diff 문자열 (`--- a/... +++ b/... @@ ... @@`).
         * 2주차 webview diff 카드 렌더링의 데이터 의존.
         */
        diffs?: Record<string, string>;
    };
}

export class ToolExecutor {
    /**
     * 같은 세션 내 변경 전 콘텐츠 캐시. VSCode native diff 버튼이
     * 클릭 시 untitled URI로 변경 전 콘텐츠를 띄우는 데 사용.
     * 키=절대경로, 값=변경 직전 콘텐츠. 같은 파일이 여러 번 수정되면 *최초 변경 전*
     * 상태를 보존(가장 보수적인 비교 시점). 단순 in-memory — 세션 종료 시 휘발.
     * 디스크 기반 영속화는 USER_REJECT_CHANGE 프로토콜과 함께 도입 예정.
     */
    private _beforeContentCache: Map<string, string> = new Map();

    /**
     * 되돌리기 취소(재적용)용 변경 *후* 콘텐츠 캐시. revertFile이 디스크를 변경 전으로
     * 덮어쓰기 직전, 현재(변경 후) 콘텐츠를 캡처해 보관. unrevertFile이 이 값으로 재적용.
     * 메모리 only — 세션 종료 시 휘발. _beforeContentCache와 짝.
     */
    private _afterContentCache: Map<string, string> = new Map();
    // collectGlobMatches가 walk 예산(시간/방문수) 초과로 부분 결과를 반환했는지 — globFiles가 표기.
    private _lastGlobTruncated = false;

    constructor(private workspace: string) {}

    /**
     * fs/child I/O를 타임아웃으로 감싼다 — 행 걸린 fs(네트워크 마운트·죽은 심볼릭)에서 단일
     * 호출이 영영 안 끝나면 heartbeat 도구(Glob/Grep)가 서버 timeout 없이 무한 대기하던 갭 방어.
     * 초과 시 reject → 호출자가 그 항목만 스킵. (pending 원 호출은 leak되나 대기는 안 함.)
     */
    private _withTimeout<T>(p: PromiseLike<T>, ms: number, label: string): Promise<T> {
        return Promise.race([
            Promise.resolve(p),
            new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`${label}-timeout`)), ms)),
        ]);
    }

    /** 외부(extension)에서 VSCode native diff 표시 시 호출. cache miss → null. */
    getBeforeContent(absPath: string): string | null {
        return this._beforeContentCache.has(absPath)
            ? this._beforeContentCache.get(absPath)!
            : null;
    }

    private _captureBefore(absPath: string, content: string): void {
        // 최초 변경 전 상태만 보존 — 후속 변경에서는 덮어쓰지 않음
        if (!this._beforeContentCache.has(absPath)) {
            this._beforeContentCache.set(absPath, content);
        }
    }

    /**
     * 변경 전 콘텐츠로 파일 되돌리기.
     * cache miss 또는 쓰기 실패 시 false 반환.
     * 되돌린 후 _beforeContentCache 항목은 유지(같은 세션의 후속 native diff 표시용).
     */
    async revertFile(absPath: string): Promise<{ ok: boolean; error?: string }> {
        const before = this._beforeContentCache.get(absPath);
        if (before === undefined) {
            return { ok: false, error: '되돌릴 변경 전 콘텐츠가 없습니다 (다른 세션에서 변경되었거나 캐시 누락).' };
        }
        // 되돌리기 취소용으로 현재(변경 후) 콘텐츠 캡처. 단, 이미 되돌려진 상태
        // (파일==before)면 덮어쓰지 않음 — 반복 토글 시 after 캐시 손상 방지.
        let current = '';
        try { current = await fs.readFile(absPath, 'utf-8'); } catch { current = ''; }
        if (current !== before) {
            this._afterContentCache.set(absPath, current);
        }
        try {
            // 신규 생성된 파일이고 변경 전이 빈 문자열이면 파일 자체를 삭제하는 게 자연스럽지만,
            // "되돌리기"의 의미상 빈 콘텐츠로 쓰는 것도 허용. 사용자 혼란 방지를 위해 빈 문자열은 삭제.
            if (before === '') {
                return await this._deleteFileSynced(absPath);
            }
            const writeRes = await this._writeFileSynced(absPath, before);
            if (!writeRes.ok) {
                return { ok: false, error: writeRes.error };
            }
            return { ok: true };
        } catch (e: any) {
            return { ok: false, error: `되돌리기 실패: ${e?.message || e}` };
        }
    }

    /**
     * 되돌린 변경을 다시 적용(되돌리기 취소). revertFile이 캡처한 변경 후 콘텐츠로 복원.
     * after 캐시는 유지 — revert↔unrevert 반복 토글이 같은 콘텐츠로 계속 동작.
     * cache miss(되돌린 적 없거나 캐시 누락) 시 false.
     */
    async unrevertFile(absPath: string): Promise<{ ok: boolean; error?: string }> {
        const after = this._afterContentCache.get(absPath);
        if (after === undefined) {
            return { ok: false, error: '재적용할 변경 후 콘텐츠가 없습니다 (되돌린 적이 없거나 캐시 누락).' };
        }
        try {
            // 변경 후가 빈 문자열이면 파일 삭제(되돌리기의 빈 콘텐츠 대칭 처리).
            if (after === '') {
                return await this._deleteFileSynced(absPath);
            }
            const writeRes = await this._writeFileSynced(absPath, after);
            if (!writeRes.ok) {
                return { ok: false, error: writeRes.error };
            }
            return { ok: true };
        } catch (e: any) {
            return { ok: false, error: `되돌리기 취소 실패: ${e?.message || e}` };
        }
    }

    async execute(req: { tool_name: string; arguments: Record<string, any> }): Promise<ToolResult> {
        const start = Date.now();

        try {
            // 워크스페이스 경계 검사 폐기 (재앙 명령만 차단하는 정책과 일관).
            // 도구 핸들러는 path.resolve로 상대→절대 정규화만 수행. file_path 자체가
            // 절대경로면 그대로 사용, 상대경로면 workspace 기준으로 결합.

            let result: { output: string; success: boolean; side_effects?: ToolResult['side_effects'] };

            const args = req.arguments as any;
            switch (req.tool_name) {
                // VSCode 전용
                case 'GetDiagnostics':  result = await this.getDiagnostics(args); break;
                case 'GetSelection':    result = await this.getSelection(args); break;
                case 'RunInTerminal':   result = await this.runInTerminal(args); break;
                case 'GetOutline':      result = await this.getOutline(args); break;
                case 'FindSymbol':      result = await this.findSymbol(args); break;
                case 'FindReferences':  result = await this.findReferences(args); break;
                case 'GoToDefinition':  result = await this.goToDefinition(args); break;
                // 파일 시스템 (위임 활성)
                case 'Read':    result = await this.read(args); break;
                case 'Write':   result = await this.write(args); break;
                case 'Edit':    result = await this.edit(args); break;
                case 'MultiEdit': result = await this.multiEdit(args); break;
                case 'Glob':    result = await this.globFiles(args); break;
                case 'Grep':    result = await this.grep(args); break;
                case 'Bash':    result = await this.bash(args); break;
                default:
                    result = { output: `알 수 없는 도구: ${req.tool_name}`, success: false };
            }

            return { ...result, duration: (Date.now() - start) / 1000 };
        } catch (e: any) {
            return {
                output: `도구 실행 오류 (${req.tool_name}): ${e.message}`,
                success: false,
                duration: (Date.now() - start) / 1000,
            };
        }
    }

    /**
     * 파일 경로를 절대경로로 정규화. 워크스페이스 경계 검사 없음.
     * 절대경로면 그대로, 상대경로면 워크스페이스 기준으로 결합.
     * Windows의 D:\, Linux의 / 양쪽 모두 path.resolve가 native로 처리.
     */
    private resolvePath(filePath: string): string {
        return path.resolve(this.workspace || process.cwd(), filePath);
    }

    /**
     * Read. 서버 file_tools.read_file와 출력 형식 호환 유지.
     * 줄 수 캡은 args.max_lines(없으면 500). 서버가 implement/debug 의도에서 정책값을
     * 주입해 상향(리팩토링이 파일 전문을 보게).
     * ≤5MB는 전량 read+slice(정확한 total), >5MB는 readline 스트리밍으로 요청 범위만
     * 수집(전량 메모리 적재 회피). 200MB 초과는 거절.
     */
    private async read(args: { file_path: string; start_line?: number; end_line?: number; max_lines?: number }) {
        const fullPath = this.resolvePath(args.file_path);
        let sizeMB: number;
        try {
            const stat = await fs.stat(fullPath);
            sizeMB = stat.size / (1024 * 1024);
        } catch (e: any) {
            return { output: `❌ 파일을 찾을 수 없습니다: ${fullPath}`, success: false };
        }

        const start = Math.max(1, args.start_line || 1);
        // 줄 수 캡: 서버가 의도별로 주입한 max_lines 우선, 없으면 기본 500 (하위호환).
        const cap = (typeof args.max_lines === 'number' && args.max_lines > 0) ? args.max_lines : 500;

        // ≤5MB: 전량 read + slice (빠름, 정확한 total).
        if (sizeMB <= 5) {
            const content = await fs.readFile(fullPath, 'utf-8');
            const lines = content.split('\n');
            const total = lines.length;
            let end = Math.min(total, args.end_line || total);
            if (end - start + 1 > cap) end = start + cap - 1;
            const sliced = lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l.replace(/\s+$/, '')}`);
            const header = `📄 ${fullPath} (줄 ${start}-${end}/${total})`;
            return { output: `${header}\n${sliced.join('\n')}`, success: true };
        }

        // >5MB: 전량 메모리 적재를 피해 readline 스트리밍으로 [start, wantEnd] 윈도우만 수집.
        // 전체를 안 읽으므로 total 미상 — 끝은 end_line/cap으로 결정. HARD_MAX 초과는 거절.
        const HARD_MAX_MB = 200;
        if (sizeMB > HARD_MAX_MB) {
            return { output: `❌ 파일이 너무 큽니다: ${sizeMB.toFixed(1)}MB (최대 ${HARD_MAX_MB}MB). 범위를 지정해도 한도를 초과합니다.`, success: false };
        }
        const wantEnd = (typeof args.end_line === 'number' && args.end_line > 0)
            ? Math.min(args.end_line, start + cap - 1)
            : start + cap - 1;
        const collected: string[] = [];
        let lineNo = 0;
        await new Promise<void>((resolve, reject) => {
            const rl = readline.createInterface({
                input: createReadStream(fullPath, { encoding: 'utf-8' }),
                crlfDelay: Infinity,
            });
            rl.on('line', (line) => {
                lineNo++;
                if (lineNo >= start && lineNo <= wantEnd) {
                    collected.push(`${lineNo}\t${line.replace(/\s+$/, '')}`);
                }
                if (lineNo >= wantEnd) { rl.close(); }
            });
            rl.on('close', () => resolve());
            rl.on('error', reject);
        });
        if (collected.length === 0) {
            return { output: `📄 ${fullPath} (대용량 ~${sizeMB.toFixed(1)}MB) — 줄 ${start}부터 읽을 내용이 없습니다 (파일 ${lineNo}줄).`, success: true };
        }
        const actualEnd = start + collected.length - 1;
        const header = `📄 ${fullPath} (줄 ${start}-${actualEnd}, 대용량 ~${sizeMB.toFixed(1)}MB — start_line/end_line으로 범위 지정 권장)`;
        return { output: `${header}\n${collected.join('\n')}`, success: true };
    }

    /**
     * Write. 디렉토리 자동 생성. side_effects.modified_files로 파일 경로 보고.
     * 자동 에디터 오픈은 제거 (배치 작업 시 사용자 방해).
     */
    private async write(args: { file_path: string; content: string }) {
        const fullPath = this.resolvePath(args.file_path);
        const content = args.content || '';
        const sizeMB = Buffer.byteLength(content, 'utf-8') / (1024 * 1024);
        if (sizeMB > 10) {
            return { output: `❌ 내용 크기가 제한을 초과합니다: ${sizeMB.toFixed(1)}MB (최대 10MB)`, success: false };
        }
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        const isNew = !(await fs.stat(fullPath).then(() => true, () => false));
        // diff 생성용으로 변경 전 콘텐츠 보존 (신규 파일이면 빈 문자열)
        let beforeContent = '';
        if (!isNew) {
            try { beforeContent = await fs.readFile(fullPath, 'utf-8'); } catch { /* ignore */ }
        }
        // VSCode native diff용 메모리 캐시 (최초 변경 전 콘텐츠 보존)
        this._captureBefore(fullPath, beforeContent);
        const writeRes = await this._writeFileRobust(fullPath, content);
        if (!writeRes.ok) {
            return { output: writeRes.error, success: false };
        }
        const lineCount = (content.match(/\n/g) || []).length + (content && !content.endsWith('\n') ? 1 : 0);
        const diff = this._generateUnifiedDiff(beforeContent, content, fullPath);
        const sideEffects: NonNullable<ToolResult['side_effects']> = isNew
            ? { created_files: [fullPath], modified_files: [fullPath] }
            : { modified_files: [fullPath] };
        if (diff) sideEffects.diffs = { [fullPath]: diff };
        return {
            output: `✅ 파일 작성 완료: ${fullPath} (${lineCount}줄)`,
            success: true,
            side_effects: sideEffects,
        };
    }

    /**
     * Windows EPERM/EBUSY 대응 robust write.
     *
     * 흐름:
     *   1) `fs.writeFile` 시도 (가장 빠름)
     *   2) EPERM/EBUSY/EACCES 발생 시 100ms·300ms 두 번 재시도 (AV/OneDrive 일시 잠금 회피)
     *   3) 여전히 실패하면 읽기 전용 속성 해제 후 1회 재시도
     *   4) 그래도 실패하면 VSCode WorkspaceEdit 폴백 — VSCode가 파일을 직접 열고 있다면
     *      에디터 버퍼를 통해 쓰기 가능 (디스크 직접 접근 우회)
     *   5) 모두 실패 시 사용자 친화 에러 메시지로 가능한 원인 안내
     *
     * 다른 에러(ENOSPC 등)는 즉시 raw 메시지 반환.
     */
    /**
     * 되돌리기/취소용 쓰기 — 열린 에디터 버퍼까지 동기화.
     * fs.writeFile은 디스크만 바꿔, 파일이 에디터 탭에 열려 있으면(특히 dirty
     * 상태거나 자동 리로드가 안 되는 경우) "디스크는 되돌아갔는데 화면은 그대로"
     * 인 문제가 생긴다. 열려 있으면 WorkspaceEdit로 버퍼 전체를 교체하고 save해
     * 버퍼·디스크를 함께 맞춘다. 문서 계층 실패·미열림이면 _writeFileRobust(디스크
     * 직접)로 폴백 — 기존 동작 보존.
     */
    private async _writeFileSynced(
        absPath: string,
        content: string
    ): Promise<{ ok: true } | { ok: false; error: string }> {
        const uri = vscode.Uri.file(absPath);
        const openDoc = vscode.workspace.textDocuments.find(
            (d) => d.uri.fsPath === uri.fsPath
        );
        if (openDoc) {
            try {
                const edit = new vscode.WorkspaceEdit();
                const fullRange = new vscode.Range(0, 0, openDoc.lineCount, 0);
                edit.replace(uri, fullRange, content);
                const applied = await vscode.workspace.applyEdit(edit);
                if (applied) {
                    await openDoc.save();
                    return { ok: true };
                }
            } catch (_docErr: any) {
                // 문서 계층 실패 — 디스크 직접 쓰기로 폴백
            }
        }
        return this._writeFileRobust(absPath, content);
    }

    /**
     * 되돌리기/취소용 삭제 — 열린 에디터 탭까지 동기화 + 실패 시 ok:false.
     * 신규 생성 파일을 되돌리면 삭제가 자연스러운데, 기존엔 fs.unlink 에러를
     * catch로 삼켜 삭제 실패에도 ok:true를 반환 → "버튼은 바뀌는데 파일이 남는"
     * 문제가 있었다(갈래 B). 파일이 에디터에 열려 있으면 WorkspaceEdit.deleteFile로
     * 탭까지 닫고, 아니면 fs.unlink. 이미 없으면(ENOENT) 되돌리기 목표가 달성된
     * 것이므로 ok:true, 그 외 실패는 ok:false로 전파.
     */
    private async _deleteFileSynced(
        absPath: string
    ): Promise<{ ok: boolean; error?: string }> {
        const uri = vscode.Uri.file(absPath);
        const openDoc = vscode.workspace.textDocuments.find(
            (d) => d.uri.fsPath === uri.fsPath
        );
        if (openDoc) {
            try {
                const edit = new vscode.WorkspaceEdit();
                edit.deleteFile(uri, { ignoreIfNotExists: true });
                const applied = await vscode.workspace.applyEdit(edit);
                if (applied) {
                    return { ok: true };
                }
            } catch (_docErr: any) {
                // 문서 계층 실패 — fs.unlink로 폴백
            }
        }
        try {
            await fs.unlink(absPath);
            return { ok: true };
        } catch (e: any) {
            if (e?.code === 'ENOENT') {
                return { ok: true }; // 이미 없음 — 되돌리기 목표 달성
            }
            return { ok: false, error: `❌ 파일 삭제 실패: ${e?.message || e}` };
        }
    }

    private async _writeFileRobust(
        fullPath: string,
        content: string
    ): Promise<{ ok: true } | { ok: false; error: string }> {
        const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
        let lastErr: any = null;
        const delays = [0, 100, 300];

        for (const delay of delays) {
            if (delay > 0) await new Promise((r) => setTimeout(r, delay));
            try {
                await fs.writeFile(fullPath, content, 'utf-8');
                return { ok: true };
            } catch (e: any) {
                lastErr = e;
                if (!RETRYABLE.has(e.code)) {
                    return { ok: false, error: `❌ 파일 쓰기 실패: ${e.message}` };
                }
            }
        }

        // 읽기 전용 속성 해제 후 재시도 (Windows: 0o666 = read+write 권한)
        try {
            await fs.chmod(fullPath, 0o666);
            await fs.writeFile(fullPath, content, 'utf-8');
            return { ok: true };
        } catch (_chmodErr: any) {
            // chmod 실패 / 여전히 EPERM — WorkspaceEdit 폴백으로
        }

        // VSCode WorkspaceEdit 폴백: 파일이 VSCode에 열려 있다면 에디터 버퍼 통해 쓰기.
        // OneDrive/AV 일시 잠금이 풀리는 동안 VSCode 자체 save 메커니즘이 재시도해줌.
        try {
            const uri = vscode.Uri.file(fullPath);
            const doc = await vscode.workspace.openTextDocument(uri);
            const edit = new vscode.WorkspaceEdit();
            const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
            edit.replace(uri, fullRange, content);
            const applied = await vscode.workspace.applyEdit(edit);
            if (applied) {
                await doc.save();
                return { ok: true };
            }
        } catch (_vscErr: any) {
            // VSCode 폴백도 실패 — 원본 에러로 사용자 안내
        }

        const code = lastErr?.code || 'UNKNOWN';
        return {
            ok: false,
            error:
                `❌ 파일 쓰기 실패 (${code}): ${lastErr?.message || '알 수 없는 오류'}\n` +
                `\n가능한 원인:\n` +
                `  1. 파일이 다른 프로세스에서 잠금 중 (예: 빌드 watcher, 디버거)\n` +
                `  2. Windows Defender / 백신이 파일을 스캔 중 — 잠시 후 재시도\n` +
                `  3. OneDrive / Dropbox 등 클라우드 동기화가 파일을 잡고 있음\n` +
                `  4. 파일에 읽기 전용 속성 (R) 또는 시스템 속성 (S)이 설정됨\n` +
                `  5. 사용자 권한 부족 (Program Files 등 보호 디렉토리)\n` +
                `\n경로: ${fullPath}`,
        };
    }

    /**
     * Edit. old_text/old_string, new_text/new_string 모두 지원.
     * side_effects로 수정된 파일 보고.
     *
     * line-ending 정규화: Read 도구가 LLM에게 보여주는 콘텐츠는
     * `\r\n`을 `\s+$`로 제거하므로 LLM은 항상 `\n` 단일 라인 끝으로 인지.
     * Windows로 작성된 코드(CRLF) 파일에 LLM이 LF로만 구성된 old_text를 보내면
     * `indexOf`가 실패. 파일의 dominant EOL을 감지해 old_text/new_text를
     * 동일 convention으로 정규화 후 매칭 — 매치 성공률 회복 + 디스크 EOL 보존.
     */
    private async edit(args: {
        file_path: string;
        old_text?: string; new_text?: string;
        old_string?: string; new_string?: string;
        replace_all?: boolean;
    }) {
        const fullPath = this.resolvePath(args.file_path);
        const rawOld = args.old_string ?? args.old_text ?? '';
        const rawNew = args.new_string ?? args.new_text ?? '';
        if (!rawOld) return { output: `❌ old_string가 비어 있습니다`, success: false };
        let beforeContent: string;
        try { beforeContent = await fs.readFile(fullPath, 'utf-8'); }
        catch (e: any) { return { output: `❌ 파일을 찾을 수 없습니다: ${fullPath}`, success: false }; }
        this._captureBefore(fullPath, beforeContent);

        // 파일의 dominant EOL에 맞춰 old/new 정규화. 디스크 EOL은 그대로 보존.
        const fileEol = this._detectEol(beforeContent);
        const oldText = this._normalizeEol(rawOld, fileEol);
        const newText = this._normalizeEol(rawNew, fileEol);

        let content = beforeContent;
        let replacements = 0;
        if (args.replace_all) {
            const parts = content.split(oldText);
            replacements = parts.length - 1;
            if (replacements > 0) {
                content = parts.join(newText);
            } else {
                // #1 — 정확 매치 실패 → 트레일링 공백 허용 라인 매칭 폴백
                const t = this._editTrailingWsTolerant(content, oldText, newText, fileEol, true);
                if (t && 'content' in t) {
                    content = t.content; replacements = t.replaced;
                } else {
                    return { output: this._matchFailMessage('old_string', oldText, beforeContent, fileEol), success: false };
                }
            }
        } else {
            const idx = content.indexOf(oldText);
            if (idx !== -1) {
                content = content.slice(0, idx) + newText + content.slice(idx + oldText.length);
                replacements = 1;
            } else {
                // #1 — 정확 매치 실패 → 트레일링 공백 허용 라인 매칭 폴백
                const t = this._editTrailingWsTolerant(content, oldText, newText, fileEol, false);
                if (t && 'content' in t) {
                    content = t.content; replacements = t.replaced;
                } else if (t && 'ambiguousLines' in t) {
                    return {
                        output: `❌ old_string이 트레일링 공백을 무시하면 ${t.ambiguousLines.length}곳에서 매치됩니다 (lines ${t.ambiguousLines.join(', ')}). 앞뒤 줄을 추가해 고유하게 만들거나 replace_all=true로 시도하세요.`,
                        success: false,
                    };
                } else {
                    return { output: this._matchFailMessage('old_string', oldText, beforeContent, fileEol), success: false };
                }
            }
        }
        const writeRes = await this._writeFileRobust(fullPath, content);
        if (!writeRes.ok) {
            return { output: writeRes.error, success: false };
        }
        const diff = this._generateUnifiedDiff(beforeContent, content, fullPath);
        const sideEffects: NonNullable<ToolResult['side_effects']> = { modified_files: [fullPath] };
        if (diff) sideEffects.diffs = { [fullPath]: diff };
        return {
            output: `✅ 수정 완료: ${fullPath} (${replacements}건 교체)`,
            success: true,
            side_effects: sideEffects,
        };
    }

    /**
     * 파일의 dominant 줄바꿈 convention 감지.
     * `\r\n` 출현 횟수 > 단독 `\n` 출현 횟수면 CRLF, 아니면 LF.
     * 빈 파일 / 줄바꿈 없는 파일은 LF로 가정 (생성·확장에 안전).
     */
    private _detectEol(content: string): '\r\n' | '\n' {
        const crlf = (content.match(/\r\n/g) || []).length;
        const allLf = (content.match(/\n/g) || []).length;
        const loneLf = allLf - crlf;
        return crlf > loneLf ? '\r\n' : '\n';
    }

    /**
     * 임의 EOL 혼합 문자열을 target convention으로 정규화.
     * 1) `\r\n`을 `\n`으로 통일 (혼합 정리)
     * 2) `\n`을 target으로 통일
     * Idempotent — old/new가 이미 target이어도 안전.
     */
    private _normalizeEol(s: string, target: '\r\n' | '\n'): string {
        if (!s) return s;
        const lf = s.replace(/\r\n/g, '\n');
        return target === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;
    }

    /**
     * 매치 실패 시 LLM에 진단 힌트 동봉.
     * 파일 EOL이 CRLF이면 LLM이 LF로 보낸 것이라고 가정 후 정규화한 결과를 검색했으므로,
     * 이 시점까지 안 맞았으면 다른 원인(트레일링 공백/탭, 들여쓰기 차이, 콘텐츠 미일치)
     * — 그쪽으로 LLM 자체 수정을 유도.
     */
    private _matchFailMessage(
        argName: string,
        normalizedOld: string,
        beforeContent: string,
        fileEol: '\r\n' | '\n',
    ): string {
        const lines = normalizedOld.split('\n').length;
        const eolHint = fileEol === '\r\n' ? ' (파일은 CRLF, LLM의 LF는 자동 정규화됨)' : '';
        let hint = '';
        // 트레일링 공백 의심 — 첫 줄을 트림해 검색했을 때 매치되면 트레일링 공백 차이
        const firstLine = normalizedOld.split('\n')[0];
        if (firstLine && lines > 1) {
            const trimmedFirst = firstLine.replace(/\s+$/, '');
            if (
                trimmedFirst &&
                trimmedFirst !== firstLine &&
                beforeContent.includes(trimmedFirst)
            ) {
                hint = '\n힌트: 파일에 트레일링 공백/탭이 있을 수 있습니다 (Read 도구가 이를 자동 제거해 보여주므로 LLM의 old_string에는 누락). old_string을 1~2줄로 줄여 라인 경계를 피하거나 replace_all로 시도하세요.';
            }
        }
        if (!hint && lines > 3) {
            hint = '\n힌트: 다중 라인 매치는 들여쓰기·트레일링 공백·중간 빈 줄 같은 미세 차이에 민감합니다. old_string을 더 짧고 고유한 1~2줄 패턴으로 줄여 시도하세요.';
        }
        return `❌ ${argName}을 찾을 수 없습니다${eolHint}.${hint}`;
    }

    /**
     * #1 — 트레일링 공백 허용 라인 매칭 (Read↔Edit 디싱크 회복).
     * Read 도구가 줄 끝 공백/탭을 `\s+$`로 제거해 LLM에 보여주므로(이 클래스의 read()),
     * LLM의 old_string에는 줄 끝 공백이 누락된다. 정확 indexOf 매칭이 실패한 경우에만
     * 폴백으로 호출되어, 줄 단위로 트레일링 공백을 무시하고 일치하는 영역을 찾는다.
     *
     * 라인 경계 기준 full-line 비교이므로 mid-line 부분 문자열은 매치되지 않는다 —
     * 그런 케이스는 애초에 정확 indexOf가 성공했을 것이라 이 폴백은 보수적으로 동작한다.
     * 반환: 치환 적용된 content + 건수 / 비 replace_all에서 2곳+면 모호 줄번호 / 매치 없으면 null.
     */
    private _editTrailingWsTolerant(
        content: string,
        oldStr: string,
        newStr: string,
        eol: '\r\n' | '\n',
        replaceAll: boolean,
    ): { content: string; replaced: number } | { ambiguousLines: number[] } | null {
        const fileLines = content.split(eol);
        const oldLines = oldStr.split(eol);
        const rtrim = (s: string) => s.replace(/\s+$/, '');
        const fileRt = fileLines.map(rtrim);
        const oldRt = oldLines.map(rtrim);
        if (oldRt.length === 0) return null;
        const starts: number[] = [];
        for (let i = 0; i + oldRt.length <= fileRt.length; i++) {
            let ok = true;
            for (let j = 0; j < oldRt.length; j++) {
                if (fileRt[i + j] !== oldRt[j]) { ok = false; break; }
            }
            if (ok) {
                starts.push(i);
                if (starts.length > 5) break; // 메시지 폭주 방지
            }
        }
        if (starts.length === 0) return null;
        if (!replaceAll && starts.length > 1) {
            return { ambiguousLines: starts.map(s => s + 1) };
        }
        const newLines = newStr.split(eol);
        // replace_all이면 뒤에서부터 치환해 앞쪽 인덱스 안정성 확보
        const targets = replaceAll ? [...starts].reverse() : [starts[0]];
        let lines = fileLines;
        for (const s of targets) {
            lines = [...lines.slice(0, s), ...newLines, ...lines.slice(s + oldLines.length)];
        }
        return { content: lines.join(eol), replaced: targets.length };
    }

    /**
     * MultiEdit. 한 파일의 여러 위치를 원자적(all-or-nothing)으로 수정.
     *
     * 흐름:
     *   Phase 1 (검증) — 모든 edit를 in-memory simulated 콘텐츠에 순차 적용 시도.
     *                    매치 없음 / 모호 매치(2회+ 출현, replace_all=false) 시 실패 인덱스와
     *                    상세 안내 반환. 디스크 미변경.
     *   Phase 2 (적용) — 모든 검증 통과 시 atomic write로 일괄 적용.
     *                    실패 시 디스크는 변경 전 상태로 그대로 (atomic 보장).
     *
     * 모호 매치 처리: 즉시 reject가 아니라 "어디에 몇 번 매치됐는지"를 알려줌 — LLM이
     * 다음 turn에 더 긴 컨텍스트로 재호출해 자체 수정 가능. (LLM을 Write 우회로 몰아
     * 더 큰 사고를 만드는 것보다 친절한 신호가 더 안전.)
     */
    private async multiEdit(args: {
        file_path: string;
        // #2 — 정본은 old_string/new_string. Edit와의 혼동으로 LLM이 old_text/new_text를
        // 보내는 경우도 수용 (양쪽 옵셔널, 실행 시 둘 중 존재하는 값을 사용).
        edits?: Array<{ old_string?: string; new_string?: string; old_text?: string; new_text?: string; replace_all?: boolean }>;
    }) {
        const fullPath = this.resolvePath(args.file_path);
        const edits = args.edits || [];
        if (edits.length === 0) {
            return { output: `❌ edits 배열이 비어 있습니다`, success: false };
        }

        let beforeContent: string;
        try { beforeContent = await fs.readFile(fullPath, 'utf-8'); }
        catch (e: any) { return { output: `❌ 파일을 찾을 수 없습니다: ${fullPath}`, success: false }; }
        this._captureBefore(fullPath, beforeContent);

        // 파일 EOL 감지 후 모든 edit의 old_string/new_string을 동일 convention으로
        // 정규화. CRLF 파일에 LLM이 LF만 보내도 매치 성공. 디스크 EOL은 그대로 보존됨.
        const fileEol = this._detectEol(beforeContent);

        // Phase 1 — 검증 (in-memory simulated)
        let simulated = beforeContent;
        const validations: Array<{ index: number; replaced: number }> = [];
        for (let i = 0; i < edits.length; i++) {
            const e = edits[i];
            // #2 — old_string/new_string 정본, old_text/new_text도 수용 (Edit와 동일 관용)
            const rawOld = e ? (typeof e.old_string === 'string' ? e.old_string : e.old_text) : undefined;
            const rawNew = e ? (typeof e.new_string === 'string' ? e.new_string : e.new_text) : undefined;
            if (typeof rawOld !== 'string' || typeof rawNew !== 'string') {
                return { output: `❌ edits[${i}]: old_string과 new_string이 모두 string이어야 합니다`, success: false };
            }
            if (rawOld === '') {
                return { output: `❌ edits[${i}]: old_string이 비어 있습니다`, success: false };
            }
            const oldStr = this._normalizeEol(rawOld, fileEol);
            const newStr = this._normalizeEol(rawNew, fileEol);
            if (e.replace_all) {
                const parts = simulated.split(oldStr);
                const count = parts.length - 1;
                if (count > 0) {
                    simulated = parts.join(newStr);
                    validations.push({ index: i, replaced: count });
                } else {
                    // #1 — 정확 매치 실패 → 트레일링 공백 허용 라인 매칭 폴백
                    const t = this._editTrailingWsTolerant(simulated, oldStr, newStr, fileEol, true);
                    if (t && 'content' in t) {
                        simulated = t.content; validations.push({ index: i, replaced: t.replaced });
                    } else {
                        return {
                            output: `❌ edits[${i}]: ${this._matchFailMessage('old_string', oldStr, simulated, fileEol).replace(/^❌\s*/, '')}`,
                            success: false,
                        };
                    }
                }
            } else {
                // 모호성 검사 — 출현 횟수와 줄번호를 함께 보고하여 LLM 자체 수정을 유도
                const occurrences: number[] = [];
                let p = 0;
                while ((p = simulated.indexOf(oldStr, p)) !== -1) {
                    occurrences.push(p);
                    p += Math.max(1, oldStr.length);
                    if (occurrences.length > 5) break; // 메시지 폭주 방지
                }
                if (occurrences.length === 1) {
                    const idx = occurrences[0];
                    simulated = simulated.slice(0, idx) + newStr + simulated.slice(idx + oldStr.length);
                    validations.push({ index: i, replaced: 1 });
                } else if (occurrences.length > 1) {
                    const lineNumbers = occurrences.map(off => simulated.slice(0, off).split('\n').length);
                    return {
                        output:
                            `❌ edits[${i}]: ${occurrences.length}곳에서 매치됨 (lines ${lineNumbers.join(', ')}). ` +
                            `모두 바꾸려면 replace_all=true, 특정 위치만 바꾸려면 앞뒤 3~5줄을 추가해 패턴을 고유하게 만드세요.`,
                        success: false,
                    };
                } else {
                    // occurrences === 0 → #1 트레일링 공백 허용 폴백
                    const t = this._editTrailingWsTolerant(simulated, oldStr, newStr, fileEol, false);
                    if (t && 'content' in t) {
                        simulated = t.content; validations.push({ index: i, replaced: t.replaced });
                    } else if (t && 'ambiguousLines' in t) {
                        return {
                            output: `❌ edits[${i}]: old_string이 트레일링 공백을 무시하면 ${t.ambiguousLines.length}곳에서 매치됩니다 (lines ${t.ambiguousLines.join(', ')}). 앞뒤 줄을 추가해 고유하게 만들거나 replace_all=true로 시도하세요.`,
                            success: false,
                        };
                    } else {
                        return {
                            output: `❌ edits[${i}]: ${this._matchFailMessage('old_string', oldStr, simulated, fileEol).replace(/^❌\s*/, '')}`,
                            success: false,
                        };
                    }
                }
            }
        }

        // Phase 2 — 원자적 적용
        const writeRes = await this._atomicWrite(fullPath, simulated);
        if (!writeRes.ok) {
            return { output: writeRes.error, success: false };
        }

        const totalReplaced = validations.reduce((s, v) => s + v.replaced, 0);
        const diff = this._generateUnifiedDiff(beforeContent, simulated, fullPath);
        const sideEffects: NonNullable<ToolResult['side_effects']> = { modified_files: [fullPath] };
        if (diff) sideEffects.diffs = { [fullPath]: diff };
        return {
            output: `✅ MultiEdit 적용: ${fullPath} (${edits.length}개 edit, 총 ${totalReplaced}건 교체)`,
            success: true,
            side_effects: sideEffects,
        };
    }

    /**
     * atomic write (POSIX/NTFS 모두 atomic rename 지원).
     * temp 파일에 쓰고 rename — 도중 실패해도 원본은 손상되지 않음.
     * Windows EPERM/EBUSY 등 잠금 상황에서는 _writeFileRobust로 폴백.
     */
    private async _atomicWrite(
        targetPath: string,
        content: string
    ): Promise<{ ok: true } | { ok: false; error: string }> {
        const dir = path.dirname(targetPath);
        const base = path.basename(targetPath);
        const tmpPath = path.join(dir, `.${base}.gtas-tmp.${process.pid}.${Date.now()}`);
        try {
            await fs.writeFile(tmpPath, content, 'utf-8');
            await fs.rename(tmpPath, targetPath);
            return { ok: true };
        } catch (e: any) {
            // tmp 파일 정리 시도 (실패해도 무시 — 원본은 안전)
            try { await fs.unlink(tmpPath); } catch { /* ignore */ }
            // Windows EPERM/EBUSY 등은 _writeFileRobust의 5단계 폴백으로 회수 시도
            if (['EPERM', 'EBUSY', 'EACCES', 'EXDEV'].includes(e.code)) {
                return await this._writeFileRobust(targetPath, content)
                    .then(r => r.ok ? { ok: true as const } : { ok: false as const, error: r.error });
            }
            return { ok: false, error: `❌ atomic write 실패: ${e.message}` };
        }
    }

    /**
     * Unified diff 생성기. 외부 의존 없음.
     *
     * 알고리즘:
     *   1) 공통 prefix/suffix 라인을 trim
     *   2) interior(차이 영역)를 단일 hunk로 출력 — 모든 before 라인은 '-', 모든 after 라인은 '+'
     *   3) hunk 앞뒤로 contextLines(기본 3) 만큼 컨텍스트 동봉
     *
     * 한계: LCS 기반 최적 diff가 아니라 "변경 영역 단일 hunk" — 분리된 변경이 여러 곳에
     *       있어도 하나의 큰 hunk로 출력됨. 에이전트 코드 편집(보통 인접 영역 변경)에서는
     *       문제 없음. 향후 webview 렌더링이 더 세밀한 hunk를 요구하면 LCS로 업그레이드.
     */
    private _generateUnifiedDiff(
        before: string,
        after: string,
        filePath: string,
        contextLines: number = 3
    ): string {
        if (before === after) return '';
        const a = before.split('\n');
        const b = after.split('\n');

        // 공통 prefix
        let prefix = 0;
        const minLen = Math.min(a.length, b.length);
        while (prefix < minLen && a[prefix] === b[prefix]) prefix++;

        // 공통 suffix (prefix와 겹치지 않게)
        let suffix = 0;
        while (
            suffix < a.length - prefix &&
            suffix < b.length - prefix &&
            a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
        ) suffix++;

        const aInterior = a.slice(prefix, a.length - suffix);
        const bInterior = b.slice(prefix, b.length - suffix);
        if (aInterior.length === 0 && bInterior.length === 0) return '';

        // 컨텍스트 범위
        const ctxBeforeStart = Math.max(0, prefix - contextLines);
        const ctxAfterEndA = Math.min(a.length, prefix + aInterior.length + contextLines);
        const ctxAfterEndB = Math.min(b.length, prefix + bInterior.length + contextLines);
        const leadCtxLen = prefix - ctxBeforeStart;
        const trailCtxLen = ctxAfterEndA - (prefix + aInterior.length);
        // trail 길이는 a/b 동일해야 함 (suffix는 공통이므로) — 안전하게 min
        const trailCtxLenSafe = Math.min(trailCtxLen, ctxAfterEndB - (prefix + bInterior.length));

        const aHunkStart = ctxBeforeStart + 1; // 1-based
        const bHunkStart = ctxBeforeStart + 1; // prefix는 공통이라 시작 위치 동일
        const aHunkLen = leadCtxLen + aInterior.length + trailCtxLenSafe;
        const bHunkLen = leadCtxLen + bInterior.length + trailCtxLenSafe;

        const lines: string[] = [];
        // 선행 컨텍스트
        for (let i = ctxBeforeStart; i < prefix; i++) lines.push(' ' + a[i]);
        // 변경 영역 — before 전체 삭제, after 전체 추가
        for (const l of aInterior) lines.push('-' + l);
        for (const l of bInterior) lines.push('+' + l);
        // 후행 컨텍스트
        for (let i = prefix + aInterior.length; i < prefix + aInterior.length + trailCtxLenSafe; i++) {
            lines.push(' ' + a[i]);
        }

        const out = [
            `--- a/${filePath}`,
            `+++ b/${filePath}`,
            `@@ -${aHunkStart},${aHunkLen} +${bHunkStart},${bHunkLen} @@`,
            ...lines,
        ];
        return out.join('\n') + '\n';
    }

    /**
     * Glob. JS 자체 구현 (Windows 호환). path 인자가 워크스페이스 외부면 그쪽 검색.
     */
    private async globFiles(args: { pattern: string; path?: string; limit?: number }) {
        const searchPath = args.path ? this.resolvePath(args.path) : this.workspace;
        if (!searchPath) {
            return { output: `❌ 워크스페이스가 지정되지 않았습니다. path 인자로 명시 검색 경로 지정 필요.`, success: false };
        }
        const pattern = args.pattern || '**/*';
        // review 파이프라인 등이 대용량 디렉토리 펼침 시 args.limit으로
        // 명시 한도 지정 (기본 200, 최대 50000). LLM이 직접 호출하는 일반 Glob은
        // 인자 없이 200을 그대로 사용 (응답 폭증 방지).
        const requested = Math.max(1, Math.min(50000, args.limit || 200));
        const matches = await this.collectGlobMatches(searchPath, pattern, requested);
        if (matches.length === 0) {
            return { output: `🔍 패턴 '${pattern}'에 일치하는 파일이 없습니다. (검색 경로: ${searchPath})`, success: true };
        }
        // 출력 행 수: limit이 명시된 경우 결과 전부 노출 (review가 모든 파일을 알아야 함),
        // 그렇지 않으면 LLM 컨텍스트 폭증 방지로 100건만.
        const showAll = args.limit !== undefined;
        const visible = showAll ? matches : matches.slice(0, 100);
        const lines = [`🔍 ${matches.length}개 파일 발견 (패턴: ${pattern})`, ...visible];
        if (!showAll && matches.length > 100) lines.push(`... 외 ${matches.length - 100}개`);
        if (this._lastGlobTruncated) {
            lines.push(
                `⚠️ 디렉토리 트리가 커서 탐색을 부분에서 중단했습니다(부분 결과). `
                + `더 좁은 path 인자 또는 하위 디렉토리로 범위를 좁혀 다시 검색하세요.`
            );
        }
        return { output: lines.join('\n'), success: true };
    }

    /**
     * Grep. JS 자체 정규식 매칭. child_process 의존 제거 (Windows 호환).
     * include 패턴(예: "*.py")으로 파일 필터. 결과 캡은 args.max_matches(기본 200, 최대 2000).
     * 캡 도달 시 절단 사실을 출력에 명시 — cross-file 리팩토링에서 사용처 누락을 인지하도록.
     */
    private async grep(args: { pattern: string; path?: string; include?: string; max_matches?: number }) {
        const searchPath = args.path ? this.resolvePath(args.path) : this.workspace;
        if (!searchPath) {
            return { output: `❌ 워크스페이스가 지정되지 않았습니다. path 인자로 명시 검색 경로 지정 필요.`, success: false };
        }
        if (!args.pattern) return { output: `❌ pattern이 비어 있습니다`, success: false };

        let regex: RegExp;
        try { regex = new RegExp(args.pattern); }
        catch (e: any) { return { output: `❌ 잘못된 정규식: ${e.message}`, success: false }; }

        const includePattern = args.include || '**/*';
        const files = await this.collectGlobMatches(searchPath, includePattern, 5000);

        const matches: string[] = [];
        // 캡: cross-file 리팩토링은 모든 사용처가 필요하므로 50→기본 200으로 상향(최대 2000).
        const MAX_MATCHES = Math.max(1, Math.min(2000, (typeof args.max_matches === 'number' && args.max_matches > 0) ? args.max_matches : 200));
        // 시간 예산 + 파일별 I/O 타임아웃 — 행 걸린 fs·대량 파일에서 무한 대기(heartbeat 도구라
        // 서버 timeout 없음) 차단. 초과 시 부분 결과 반환(Glob과 동형).
        const PERFILE_MS = 3_000;
        const grepDeadline = Date.now() + 20_000;
        let truncated = false;
        for (const file of files) {
            if (matches.length >= MAX_MATCHES) { truncated = true; break; }
            if (Date.now() > grepDeadline) { truncated = true; break; }
            try {
                const stat = await this._withTimeout(fs.stat(file), PERFILE_MS, 'stat');
                if (!stat.isFile() || stat.size > 5 * 1024 * 1024) continue;  // 5MB 초과 파일 건너뜀
                const content = await this._withTimeout(fs.readFile(file, 'utf-8'), PERFILE_MS, 'readFile');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (regex.test(lines[i])) {
                        matches.push(`${file}:${i + 1}:${lines[i].trim()}`);
                        if (matches.length >= MAX_MATCHES) { truncated = true; break; }
                    }
                }
            } catch (_) { /* binary·행 파일·타임아웃 무시(스킵) */ }
        }
        if (matches.length === 0) {
            return { output: `🔍 패턴 '${args.pattern}'에 일치하는 결과가 없습니다.`, success: true };
        }
        const note = truncated ? ` — 상한/시간 초과로 일부 파일이 생략됐을 수 있음 (include로 범위를 좁히거나 max_matches 상향)` : '';
        return { output: `🔍 ${matches.length}건 발견 (패턴: ${args.pattern})${note}\n${matches.join('\n')}`, success: true };
    }

    /**
     * OS별 셸 자동 선택 + 재앙 명령 차단.
     * Linux: /bin/bash. Windows: WSL → Git Bash → PowerShell.
     * cwd는 워크스페이스. 출력 stdout+stderr 합쳐서 10000자 잘림.
     */
    private async bash(args: { command: string; timeout?: number }) {
        const command = args.command || '';
        if (!command.trim()) return { output: `❌ command가 비어 있습니다`, success: false };
        const shell = detectShell();
        // 재앙 명령 차단
        const violation = checkCatastrophic(command, shell.kind);
        if (violation) {
            return {
                output: `❌ ${violation}\n명령: ${command.slice(0, 200)}`,
                success: false,
            };
        }
        const timeoutMs = (args.timeout || 120) * 1000;
        const cwd = this.workspace || process.cwd();

        return new Promise<{ output: string; success: boolean }>((resolve) => {
            let stdout = '';
            let stderr = '';
            let resolved = false;
            const child = cp.spawn(shell.executable, [...shell.argsPrefix, command], {
                cwd,
                shell: false,
                windowsHide: true,
            });
            const timer = setTimeout(() => {
                if (resolved) return;
                resolved = true;
                try { child.kill('SIGKILL'); } catch (_) { /* 무시 */ }
                resolve({
                    output: `❌ 명령 타임아웃 (${args.timeout || 120}초 초과): ${command.slice(0, 80)}`,
                    success: false,
                });
            }, timeoutMs);
            child.stdout?.on('data', (d) => { stdout += d.toString(); });
            child.stderr?.on('data', (d) => { stderr += d.toString(); });
            child.on('error', (e) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timer);
                resolve({
                    output: `❌ 셸 실행 오류 (${shell.label}): ${e.message}`,
                    success: false,
                });
            });
            child.on('close', (code) => {
                if (resolved) return;
                resolved = true;
                clearTimeout(timer);
                let combined = '';
                if (stdout.trim()) combined += stdout.trim();
                if (stderr.trim()) combined += (combined ? '\n' : '') + `[stderr]\n${stderr.trim()}`;
                if (!combined) combined = '(출력 없음)';
                // 10000자 잘림 — 줄 경계
                if (combined.length > 10000) {
                    const head = combined.slice(0, 5000);
                    const tail = combined.slice(-3000);
                    const skipped = combined.length - head.length - tail.length;
                    combined = `${head}\n\n... (${skipped}자 생략) ...\n\n${tail}`;
                }
                if (code !== 0) {
                    resolve({ output: `⚠️ 종료 코드: ${code}\n${combined}`, success: false });
                } else {
                    resolve({ output: combined, success: true });
                }
            });
        });
    }

    /**
     * JS 자체 glob 매칭. node-glob 같은 외부 의존 없이 단순 패턴 처리.
     * 지원: **(임의 깊이), *(임의 문자), 정확 매칭. 흔한 케이스만 — node_modules/.git 자동 스킵.
     */
    private async collectGlobMatches(rootPath: string, pattern: string, limit: number): Promise<string[]> {
        const results: string[] = [];
        const SKIP_DIRS = new Set([
            'node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next',
            // C/C++·빌드·벤더 트리 — 대형 스토리지/커널 SDK(SPDK/DPDK/kernel 등)에서 수십만~
            // 수백만 파일을 유발해 walk가 폭주하던 원인. cmake-build-* 는 prefix로 별도 처리.
            'out', 'obj', 'bin', 'target', 'vendor', 'third_party', 'thirdparty', 'deps',
            '.deps', '.libs', 'CMakeFiles', '.cache', '.ccache', 'Debug', 'Release',
        ]);
        const regex = this.globToRegex(pattern);

        // walk 예산 — 대형 트리에서 무한정 걸리지 않도록 방문 수·시간 상한. 초과 시 부분 결과 반환.
        // 주기적으로 이벤트루프에 양보해 heartbeat(25s setInterval)가 실제로 발송되게 함
        // (거대 디렉토리의 동기 for 루프가 이벤트루프를 굶겨 서버 Glob 타임아웃되던 회귀 차단).
        const MAX_ENTRIES = 300_000;
        const MAX_MS = 20_000;
        const READDIR_TIMEOUT_MS = 4_000;   // 단일 디렉토리 readdir 상한(행 마운트·죽은 심볼릭 방어)
        const startTime = Date.now();
        const deadline = startTime + MAX_MS;
        let visited = 0;
        let hungSkip = false;               // 행 걸린 디렉토리를 스킵했는지(부분 결과 표기용)
        this._lastGlobTruncated = false;

        const walk = async (dir: string, depth: number): Promise<void> => {
            if (results.length >= limit || depth > 20 || this._lastGlobTruncated) return;
            if (Date.now() > deadline) { this._lastGlobTruncated = true; return; }   // 총 시간 예산
            let entries: { name: string; isDir: boolean }[];
            try {
                // readdir 타임아웃 — 행 걸린 fs에서 단일 readdir이 영영 안 끝나면 예산 루프가
                // 못 도는 갭 차단. 타임아웃/오류면 이 디렉토리만 스킵.
                const dirents = await this._withTimeout(
                    fs.readdir(dir, { withFileTypes: true }), READDIR_TIMEOUT_MS, 'readdir');
                entries = dirents.map(d => ({ name: d.name, isDir: d.isDirectory() }));
            } catch (_) { hungSkip = true; return; }
            for (const entry of entries) {
                if (results.length >= limit || this._lastGlobTruncated) return;
                if (++visited % 5000 === 0) {
                    if (visited > MAX_ENTRIES || (Date.now() - startTime) > MAX_MS) {
                        this._lastGlobTruncated = true;
                        return;
                    }
                    await new Promise<void>(r => setImmediate(r));   // 이벤트루프 양보(heartbeat)
                }
                const fullPath = path.join(dir, entry.name);
                if (entry.isDir) {
                    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')
                        || entry.name.startsWith('cmake-build')) continue;
                    await walk(fullPath, depth + 1);
                } else {
                    const rel = path.relative(rootPath, fullPath).split(path.sep).join('/');
                    if (regex.test(rel)) results.push(fullPath);
                }
            }
        };
        await walk(rootPath, 0);
        if (hungSkip) this._lastGlobTruncated = true;   // 행 걸린 디렉토리 스킵 → 부분 결과
        return results;
    }

    //
    // 단순 glob → 정규식 변환.
    //   doublestar (** ) = 임의 깊이 (/ 포함), single-star (*) = 같은 디렉토리 내 임의 문자,
    //   ? = 1자, 그 외 리터럴
    //   파일명만 매칭하는 단일 패턴(예: "*.py")이면 자동으로 "doublestar/*.py"로 확장
    //   "doublestar/" 다음 패턴은 루트도 매칭 (예: doublestar/foo.py는 foo.py도 매칭)
    //
    // 직접 토큰 단위 변환 (기존 escape→unescape 방식은 별·물음표가 escape set에서 누락되어
    // doublestar/* 같은 일반 패턴이 invalid regex로 떨어졌던 회귀 — review 디렉토리
    // 펼침 실패의 직접 원인).
    //
    // NOTE: 주석에서 doublestar 표기를 풀어쓴 이유는 JSDoc 블록(/**...*/) 안에서 doublestar +
    // slash 시퀀스가 주석을 조기 종료시키기 때문. // 일반 주석으로 전환하여 회피.
    private globToRegex(pattern: string): RegExp {
        let p = pattern || '**/*';
        if (!p.includes('/')) p = `**/${p}`;
        const REGEX_SPECIALS = '.+^${}()|[]\\/';
        let regex = '';
        for (let i = 0; i < p.length; i++) {
            const c = p[i];
            if (c === '*') {
                if (p[i + 1] === '*') {
                    // `**` — 임의 깊이. 뒤따르는 `/`도 같이 흡수해 루트 파일도 매칭
                    regex += '.*';
                    i++;
                    if (p[i + 1] === '/') i++;
                } else {
                    regex += '[^/]*';
                }
            } else if (c === '?') {
                regex += '[^/]';
            } else if (REGEX_SPECIALS.includes(c)) {
                regex += '\\' + c;
            } else {
                regex += c;
            }
        }
        return new RegExp('^' + regex + '$');
    }

    // ── VSCode 전용 도구 ────────────────────────────────────────

    private severityName(s: vscode.DiagnosticSeverity): string {
        switch (s) {
            case vscode.DiagnosticSeverity.Error:       return 'error';
            case vscode.DiagnosticSeverity.Warning:     return 'warning';
            case vscode.DiagnosticSeverity.Information: return 'info';
            case vscode.DiagnosticSeverity.Hint:        return 'hint';
            default: return 'unknown';
        }
    }

    private filterDiagBySeverity(
        diag: vscode.Diagnostic,
        filter: string,
    ): boolean {
        if (filter === 'all' || !filter) return true;
        return this.severityName(diag.severity) === filter;
    }

    private async getDiagnostics(
        args: { file_path?: string; severity?: string },
    ): Promise<{ output: string; success: boolean }> {
        const sev = args.severity || 'all';
        const lines: string[] = [];

        if (args.file_path) {
            const fullPath = path.resolve(this.workspace, args.file_path);
            const uri = vscode.Uri.file(fullPath);
            const diags = vscode.languages.getDiagnostics(uri);
            for (const d of diags) {
                if (!this.filterDiagBySeverity(d, sev)) continue;
                lines.push(this.formatDiag(args.file_path, d));
            }
        } else {
            // 워크스페이스 전체
            const allDiags = vscode.languages.getDiagnostics();
            for (const [uri, diags] of allDiags) {
                if (uri.scheme !== 'file') continue;
                const rel = path.relative(this.workspace, uri.fsPath);
                // 워크스페이스 외부 파일은 제외
                if (rel.startsWith('..')) continue;
                for (const d of diags) {
                    if (!this.filterDiagBySeverity(d, sev)) continue;
                    lines.push(this.formatDiag(rel, d));
                }
            }
        }

        if (lines.length === 0) {
            return { output: `(진단 ${sev === 'all' ? '' : sev + ' '}없음)`, success: true };
        }
        // 너무 많은 진단이 있으면 잘라냄
        const MAX = 200;
        let output = lines.slice(0, MAX).join('\n');
        if (lines.length > MAX) {
            output += `\n\n... (${lines.length - MAX}건 생략)`;
        }
        return { output, success: true };
    }

    private formatDiag(filePath: string, d: vscode.Diagnostic): string {
        const sev = this.severityName(d.severity).toUpperCase();
        const line = d.range.start.line + 1;
        const col = d.range.start.character + 1;
        const src = d.source ? ` [${d.source}]` : '';
        return `${filePath}:${line}:${col} ${sev}${src} ${d.message}`;
    }

    private async getSelection(
        _args: Record<string, never>,
    ): Promise<{ output: string; success: boolean }> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return {
                output: (
                    '⚠️ 활성 에디터 없음 — 사용자에게 어떤 코드를 가리키는지 명확히 ' +
                    '확인 요청하거나, 첨부된 파일 경로로 작업하세요.'
                ),
                success: false,
            };
        }
        const sel = editor.selection;
        if (sel.isEmpty) {
            const fp = editor.document.uri.scheme === 'file'
                ? path.relative(this.workspace, editor.document.uri.fsPath)
                : editor.document.uri.toString();
            return {
                output: (
                    `⚠️ 활성 에디터에 선택된 텍스트가 없습니다 ` +
                    `(커서만 있음: ${fp}:${sel.active.line + 1}:${sel.active.character + 1}). ` +
                    `사용자에게 코드를 드래그로 선택하거나 어떤 영역을 가리키는지 명확히 알려달라고 요청하세요.`
                ),
                success: false,
            };
        }
        const text = editor.document.getText(sel);
        const fp = editor.document.uri.scheme === 'file'
            ? path.relative(this.workspace, editor.document.uri.fsPath)
            : editor.document.uri.toString();
        const range = `${sel.start.line + 1}:${sel.start.character + 1}-${sel.end.line + 1}:${sel.end.character + 1}`;
        return {
            output: `## 선택 영역 (${fp} ${range})\n\n${text}`,
            success: true,
        };
    }

    private async runInTerminal(
        args: { command: string; name?: string; show?: boolean },
    ): Promise<{ output: string; success: boolean }> {
        if (!args.command) {
            return { output: '명령이 비어있습니다', success: false };
        }
        const name = args.name || 'G-TAS';
        let term = vscode.window.terminals.find((t) => t.name === name);
        if (!term) {
            term = vscode.window.createTerminal({ name, cwd: this.workspace });
        }
        if (args.show !== false) {
            term.show(true);
        }
        term.sendText(args.command, true);
        return {
            output: (
                `명령을 터미널 '${name}'에 전송했습니다.\n` +
                `명령: ${args.command}\n\n` +
                `⚠️ 이 도구는 출력을 캡처하지 않습니다. 사용자가 결과를 보고 알려주거나, ` +
                `결과 캡처가 필요하면 Bash 도구를 사용하세요.`
            ),
            success: true,
        };
    }

    private symbolKindName(kind: vscode.SymbolKind): string {
        const names = [
            'File', 'Module', 'Namespace', 'Package', 'Class', 'Method',
            'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function',
            'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array',
            'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event',
            'Operator', 'TypeParameter',
        ];
        return names[kind] || `Kind${kind}`;
    }

    private formatSymbolTree(
        symbols: vscode.DocumentSymbol[],
        depth: number = 0,
    ): string[] {
        const lines: string[] = [];
        const indent = '  '.repeat(depth);
        for (const s of symbols) {
            const range = `${s.range.start.line + 1}-${s.range.end.line + 1}`;
            lines.push(`${indent}${this.symbolKindName(s.kind)} ${s.name} (${range})`);
            if (s.children && s.children.length > 0) {
                lines.push(...this.formatSymbolTree(s.children, depth + 1));
            }
        }
        return lines;
    }

    private async getOutline(
        args: { file_path: string },
    ): Promise<{ output: string; success: boolean }> {
        const fullPath = path.resolve(this.workspace, args.file_path);
        const uri = vscode.Uri.file(fullPath);
        // 파일이 열려있지 않으면 LSP가 못 잡으므로 한 번 열어줌 (preview, 포커스 없음).
        // 행 걸린 fs·응답 없는 LSP에서 무한 대기(heartbeat 도구라 서버 timeout 없음) 방어 — 타임아웃 래핑.
        try {
            await this._withTimeout(vscode.workspace.openTextDocument(uri), 15_000, 'openDoc');
        } catch (e: any) {
            return { output: `파일 열기 실패/지연: ${e.message}`, success: false };
        }
        let symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined;
        try {
            symbols = await this._withTimeout(
                vscode.commands.executeCommand<vscode.DocumentSymbol[] | vscode.SymbolInformation[]>(
                    'vscode.executeDocumentSymbolProvider', uri),
                15_000, 'outline');
        } catch (e: any) {
            return { output: `Outline 조회 지연/실패: ${e.message}`, success: false };
        }
        if (!symbols || symbols.length === 0) {
            return {
                output: '(LSP outline 없음 — 언어 확장이 설치되었는지, 파일이 LSP가 인식하는 형식인지 확인하세요)',
                success: true,
            };
        }
        // SymbolInformation 또는 DocumentSymbol 두 형태 모두 처리
        if ('children' in symbols[0]) {
            const lines = this.formatSymbolTree(symbols as vscode.DocumentSymbol[]);
            return { output: lines.join('\n'), success: true };
        }
        const lines = (symbols as vscode.SymbolInformation[]).map((s) => {
            const range = `${s.location.range.start.line + 1}-${s.location.range.end.line + 1}`;
            return `${this.symbolKindName(s.kind)} ${s.name} (${range})`;
        });
        return { output: lines.join('\n'), success: true };
    }

    private async findSymbol(
        args: { query: string; max_results?: number },
    ): Promise<{ output: string; success: boolean }> {
        const max = args.max_results || 30;
        const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider', args.query,
        );
        if (!symbols || symbols.length === 0) {
            return { output: `(심볼 매칭 없음: "${args.query}")`, success: true };
        }
        const lines = symbols.slice(0, max).map((s) => {
            const fp = s.location.uri.scheme === 'file'
                ? path.relative(this.workspace, s.location.uri.fsPath)
                : s.location.uri.toString();
            const line = s.location.range.start.line + 1;
            const cls = s.containerName ? ` <${s.containerName}>` : '';
            return `${this.symbolKindName(s.kind)} ${s.name}${cls} — ${fp}:${line}`;
        });
        let output = lines.join('\n');
        if (symbols.length > max) {
            output += `\n\n... (${symbols.length - max}건 생략, max_results 늘려서 재호출 가능)`;
        }
        return { output, success: true };
    }

    /**
     * LLM이 1-based로 보낸 (line, character)를 VSCode `Position`(0-based)으로 변환하면서
     * 문서 범위 + 식별자 위치 검증. 어긋나면 명시적 에러 메시지를 반환하여 LLM이
     * "참조 없음" / "정의 없음"으로 오해하지 않도록 함.
     *
     * 반환:
     *   - 정상이면 [Position, null]
     *   - 검증 실패면 [null, 사용자에게 보낼 에러 메시지]
     */
    private async _resolvePositionFromOneBased(
        uri: vscode.Uri, oneBasedLine: number, oneBasedChar: number,
    ): Promise<[vscode.Position | null, string | null]> {
        let doc: vscode.TextDocument;
        try {
            // 행 걸린 fs·응답 없는 LSP에서 무한 대기 방어(FindReferences·GoToDefinition 공용).
            doc = await this._withTimeout(vscode.workspace.openTextDocument(uri), 15_000, 'openDoc');
        } catch (e: any) {
            return [null, `파일 열기 실패/지연: ${e.message}`];
        }
        // 1-based → 0-based
        const lineIdx = (oneBasedLine | 0) - 1;
        const charIdx = (oneBasedChar | 0) - 1;
        if (lineIdx < 0 || lineIdx >= doc.lineCount) {
            return [null, (
                `❌ 줄 번호가 파일 범위를 벗어납니다 — 입력 line=${oneBasedLine}, ` +
                `파일 총 ${doc.lineCount}줄. Grep/Read 결과의 줄 번호를 다시 확인하세요.`
            )];
        }
        const lineText = doc.lineAt(lineIdx).text;
        if (charIdx < 0 || charIdx > lineText.length) {
            return [null, (
                `❌ 컬럼이 줄 범위를 벗어납니다 — 입력 character=${oneBasedChar}, ` +
                `줄 ${oneBasedLine} 길이 ${lineText.length}자.`
            )];
        }
        const pos = new vscode.Position(lineIdx, charIdx);
        // 식별자 위치 확인 — 공백·주석·연산자 위에 있으면 LSP가 빈 결과를 줘도
        // 그게 "참조 없음"이 아니라 "위치가 잘못됨"임을 LLM에 명확히
        const wordRange = doc.getWordRangeAtPosition(pos);
        if (!wordRange) {
            return [null, (
                `⚠️ 해당 위치(${oneBasedLine}:${oneBasedChar})에 식별자가 없습니다 — ` +
                `공백·주석·연산자 위치일 수 있습니다. 함수·변수 이름의 정확한 줄/컬럼을 ` +
                `Grep으로 다시 확인하세요. 예: "grep -n 함수명 file" 결과의 줄/콜론 다음 컬럼.`
            )];
        }
        return [pos, null];
    }

    private async findReferences(
        args: { file_path: string; line: number; character: number },
    ): Promise<{ output: string; success: boolean }> {
        const fullPath = path.resolve(this.workspace, args.file_path);
        const uri = vscode.Uri.file(fullPath);
        const [pos, err] = await this._resolvePositionFromOneBased(uri, args.line, args.character);
        if (!pos) {
            return { output: err!, success: false };
        }
        let refs: vscode.Location[] | undefined;
        try {
            refs = await this._withTimeout(
                vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', uri, pos),
                15_000, 'references');
        } catch (e: any) {
            return { output: `참조 조회 지연/실패: ${e.message}`, success: false };
        }
        if (!refs || refs.length === 0) {
            return { output: '(참조 없음 — 식별자는 확인됐으나 LSP가 사용처를 찾지 못함)', success: true };
        }
        const lines = refs.map((r) => {
            const fp = r.uri.scheme === 'file'
                ? path.relative(this.workspace, r.uri.fsPath)
                : r.uri.toString();
            return `${fp}:${r.range.start.line + 1}:${r.range.start.character + 1}`;
        });
        return { output: lines.join('\n'), success: true };
    }

    private async goToDefinition(
        args: { file_path: string; line: number; character: number },
    ): Promise<{ output: string; success: boolean }> {
        const fullPath = path.resolve(this.workspace, args.file_path);
        const uri = vscode.Uri.file(fullPath);
        const [pos, err] = await this._resolvePositionFromOneBased(uri, args.line, args.character);
        if (!pos) {
            return { output: err!, success: false };
        }
        const defs = await vscode.commands.executeCommand<
            vscode.Location[] | vscode.LocationLink[]
        >('vscode.executeDefinitionProvider', uri, pos);
        if (!defs || defs.length === 0) {
            return { output: '(정의 위치를 찾을 수 없음 — 식별자는 확인됐으나 LSP 매칭 실패)', success: true };
        }
        const lines = defs.map((d) => {
            const u = 'targetUri' in d ? d.targetUri : d.uri;
            const r = 'targetRange' in d ? d.targetRange : d.range;
            const fp = u.scheme === 'file'
                ? path.relative(this.workspace, u.fsPath)
                : u.toString();
            return `${fp}:${r.start.line + 1}:${r.start.character + 1}`;
        });
        return { output: lines.join('\n'), success: true };
    }
}
