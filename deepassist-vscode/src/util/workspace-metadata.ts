/**
 * 클라이언트 환경 메타데이터 빌더.
 *
 * 워크스페이스 라벨, 클라이언트 OS, 셸, DeepAssist.md 본문, 테스트 러너 hint를
 * 한 번에 묶어 서버에 전달할 페이로드로 만든다.
 *
 * 호출 시점: WS 연결 성공 직후 (extension.ts의 onConnectionChange(connected=true))
 *
 * 셸 자동 감지 우선순위:
 *   - Linux/macOS: /bin/bash 고정
 *   - Windows: WSL → Git Bash → PowerShell. 모두 부재면 cmd
 *
 * 서버는 이 메타를 시스템 프롬프트(클라이언트 OS·셸 안내)와 DeepAssist.md
 * 로드, test_loop 자동 감지에 활용. 서버는 클라이언트 워크스페이스를
 * 직접 만지지 않으므로 이 메시지가 유일한 메타 채널.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { WorkspaceMetadata } from '../connection/ws-client';
import { resolveWorkspace } from './workspace-default';
import { isWslUsable } from '../executor/shell-detector';

type ClientOS = 'windows' | 'linux' | 'macos';
type ShellKind = 'bash' | 'git-bash' | 'wsl-bash' | 'powershell' | 'cmd';

function detectClientOS(): ClientOS {
    if (process.platform === 'win32') return 'windows';
    if (process.platform === 'darwin') return 'macos';
    return 'linux';
}

function detectShell(clientOS: ClientOS): ShellKind {
    if (clientOS !== 'windows') return 'bash';
    // Windows — WSL → Git Bash → PowerShell → cmd.
    // wsl.exe 존재가 아니라 설치된 배포판 실검증(isWslUsable) — shell-detector와 동일 로직·캐시 공유
    // (cross-cutting: 실행부/보고부가 같은 셸을 가리켜야 서버 POSIX 경고가 정합).
    if (isWslUsable()) return 'wsl-bash';
    const gitBashCandidates = [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ];
    for (const p of gitBashCandidates) {
        try { if (fs.existsSync(p)) return 'git-bash'; } catch (_) { /* 무시 */ }
    }
    // PowerShell은 Win10+ 기본 포함. 별도 검증 없이 가정
    return 'powershell';
}

/** 워크스페이스 루트의 DeepAssist.md 본문을 읽음. 없거나 실패하면 null. */
function readDeepAssistMd(workspaceLabel: string): string | null {
    if (!workspaceLabel) return null;
    try {
        const mdPath = path.join(workspaceLabel, 'DeepAssist.md');
        if (!fs.existsSync(mdPath)) return null;
        const content = fs.readFileSync(mdPath, 'utf-8');
        // 너무 큰 파일은 자름 — 시스템 프롬프트 폭증 방지
        return content.length > 20000 ? content.slice(0, 20000) + '\n\n... (DeepAssist.md가 20000자에서 잘렸습니다)' : content;
    } catch (_) {
        return null;
    }
}

/** 마커 파일로 테스트 러너 자동 감지. 없으면 null. */
function detectTestRunnerHint(workspaceLabel: string): string | null {
    if (!workspaceLabel) return null;
    const checks: { file: string; hint: string }[] = [
        { file: 'pytest.ini', hint: 'pytest' },
        { file: 'pyproject.toml', hint: 'pytest' },  // [tool.pytest] 가능. coarse hint
        { file: 'package.json', hint: 'jest' },       // 정확도는 떨어지지만 hint 용도
        { file: 'Cargo.toml', hint: 'cargo' },
        { file: 'go.mod', hint: 'go-test' },
    ];
    for (const c of checks) {
        try {
            if (fs.existsSync(path.join(workspaceLabel, c.file))) return c.hint;
        } catch (_) { /* 무시 */ }
    }
    return null;
}

export function buildWorkspaceMetadata(): WorkspaceMetadata {
    const clientOS = detectClientOS();
    const workspaceLabel = resolveWorkspace();
    return {
        workspace_label: workspaceLabel,
        client_os: clientOS,
        shell: detectShell(clientOS),
        deepassist_md: readDeepAssistMd(workspaceLabel),
        test_runner_hint: detectTestRunnerHint(workspaceLabel),
        protocol_version: 1,
    };
}
