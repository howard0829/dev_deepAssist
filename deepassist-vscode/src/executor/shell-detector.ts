/**
 * OS별 셸 자동 감지.
 *
 * Linux/macOS: /bin/bash 고정.
 * Windows 우선순위: WSL → Git Bash → PowerShell (Win10+ 기본 포함).
 *
 * `workspace_metadata`에서 보고하는 `shell` 필드도 같은 우선순위로
 * `util/workspace-metadata.ts:detectShell()`이 결정. 이 모듈은 실행 시점에
 * spawn 인자를 만드는 책임. 두 모듈은 같은 우선순위를 따라 일관성 유지.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as cp from 'child_process';

export type ShellKind = 'bash' | 'git-bash' | 'wsl-bash' | 'powershell' | 'cmd';

export interface ShellSpec {
    kind: ShellKind;
    executable: string;
    /** 셸이 명령을 실행하기 위해 받는 prefix args. 마지막 자리에 명령 문자열이 추가됨. */
    argsPrefix: string[];
    label: string;
}

const GIT_BASH_CANDIDATES = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
];

function safeExists(p: string): boolean {
    try { return fs.existsSync(p); } catch (_) { return false; }
}

const WSL_PATH = 'C:\\Windows\\System32\\wsl.exe';
let _wslUsableCache: boolean | undefined;

/**
 * wsl.exe 존재만으론 WSL bash를 쓸 수 없다 — Win10 2004+/11은 배포판 없이도 wsl.exe
 * 스텁을 기본 포함하므로 존재 검사는 오탐한다(배포판 없으면 `wsl bash -c`가 행/실패 → 타임아웃).
 * `wsl -l -q`가 실제 배포판을 반환할 때만 true. 출력은 UTF-16LE + NUL 패딩. 짧은 타임아웃으로
 * 행 방지, 결과 1회 캐시(매 Bash 호출마다 spawn하지 않도록).
 */
export function isWslUsable(): boolean {
    if (_wslUsableCache !== undefined) return _wslUsableCache;
    _wslUsableCache = false;
    try {
        if (os.platform() !== 'win32' || !safeExists(WSL_PATH)) return _wslUsableCache;
        const r = cp.spawnSync(WSL_PATH, ['-l', '-q'], { timeout: 2500, windowsHide: true });
        if (r.status === 0 && r.stdout) {
            const out = r.stdout.toString('utf16le').replace(/\0/g, '').trim();
            _wslUsableCache = out.length > 0;   // 배포판 이름이 하나라도 있으면 사용 가능
        }
    } catch (_) {
        _wslUsableCache = false;
    }
    return _wslUsableCache;
}

export function detectShell(): ShellSpec {
    if (os.platform() !== 'win32') {
        return { kind: 'bash', executable: '/bin/bash', argsPrefix: ['-c'], label: '/bin/bash' };
    }
    // WSL — wsl.exe 존재만으론 부족(Win10+ 기본 스텁). 설치된 배포판이 있을 때만.
    if (isWslUsable()) {
        return { kind: 'wsl-bash', executable: WSL_PATH, argsPrefix: ['bash', '-c'], label: 'WSL bash' };
    }
    // Git Bash
    for (const p of GIT_BASH_CANDIDATES) {
        if (safeExists(p)) {
            return { kind: 'git-bash', executable: p, argsPrefix: ['-c'], label: `Git Bash (${p})` };
        }
    }
    // PowerShell (Win10+ 기본 포함, 별도 검증 없이 가정)
    return {
        kind: 'powershell',
        executable: 'powershell.exe',
        argsPrefix: ['-NoProfile', '-NonInteractive', '-Command'],
        label: 'PowerShell',
    };
}
