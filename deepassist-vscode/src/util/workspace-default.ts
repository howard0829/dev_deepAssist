/**
 * 워크스페이스 경로 결정.
 *
 * VSCode에 워크스페이스 폴더가 열려 있으면 그것(`uri.fsPath`)을, 없으면
 * 사용자 홈의 `~/gtas_workspace`로 폴백. 폴백 경로는 없으면 자동 생성.
 *
 * 반환 경로는 클라이언트 OS의 native 형식:
 *   - Windows: `D:\\Users\\Alice\\proj` 또는 `D:\\Users\\Alice\\gtas_workspace`
 *   - Linux: `/home/alice/proj` 또는 `/home/alice/gtas_workspace`
 *   - macOS: `/Users/alice/proj` 또는 `/Users/alice/gtas_workspace`
 * `os.homedir()` + `path.join`은 Node.js가 OS별로 자동 처리.
 *
 * 서버는 이 경로를 라벨로만 사용 (시스템 프롬프트 텍스트 + 세션 식별).
 * 실제 파일 작업은 클라이언트 위임 도구가 자기 OS에서 native로 수행.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const DEFAULT_DIR_NAME = 'gtas_workspace';

export function resolveWorkspace(): string {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws) {
        return ws;
    }
    const fallback = path.join(os.homedir(), DEFAULT_DIR_NAME);
    try {
        fs.mkdirSync(fallback, { recursive: true });
    } catch (_) {
        // 권한 등으로 실패해도 경로 자체는 반환 — 후속 도구 호출이 같은 위치에서
        // 다시 시도하면서 적절한 에러 메시지를 사용자에게 보여줌
    }
    return fallback;
}
