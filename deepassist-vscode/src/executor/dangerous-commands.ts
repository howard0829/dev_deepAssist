/**
 * 재앙 명령 차단 패턴.
 *
 * 정책: **재앙적 명령(시스템 파괴, 디스크 wipe, fork bomb)만 차단**.
 * 그 외 모든 명령은 허용 — 사용자 머신, 사용자 책임. 워크스페이스 경계,
 * 외부 네트워크(curl/wget/ssh), cd, chmod, 패키지 매니저는 모두 OK.
 *
 * 기존 서버 측 _ESCAPE_PATTERNS(cd/curl/wget/ssh/mount/crontab 차단)는
 * 의도적으로 이식하지 않음. 단일 사용자 로컬 신뢰 모델.
 *
 * 위협 모델:
 *   - 의도된 위협자 X — 사용자 본인 머신
 *   - 가드 목적: LLM의 변덕으로 인한 우발적 시스템 파괴 방지
 */

const CATASTROPHIC_PATTERNS_POSIX: RegExp[] = [
    /\brm\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)+\/\s*(?:$|;|&|\|)/,    // rm -rf / (단독)
    /\brm\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)+\/\*/,                  // rm -rf /*
    /\bmkfs\.[a-z0-9]+\s/,                                            // mkfs.ext4 등
    /\bdd\s+[^|;&]*\bof=\/dev\/(sd|nvme|hd|xvd|mmcblk)/,              // dd of=/dev/sda
    /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,                // fork bomb :(){ :|:& };:
    /\bchmod\s+-R\s+[0-7]{3,4}\s+\/\s*(?:$|;|&|\|)/,                  // chmod -R 777 /
    /\bchown\s+-R\s+\S+\s+\/\s*(?:$|;|&|\|)/,                         // chown -R user /
    />\s*\/dev\/(sd|nvme|hd|xvd|mmcblk)/,                             // > /dev/sda
    /\b(shutdown|reboot|halt|poweroff)\b\s+(-[a-zA-Z]+|now)?/,       // 시스템 종료
    /\bsudo\s+rm\s+(?:-[a-zA-Z]*[rRfF][a-zA-Z]*\s+)+\//,              // sudo rm -rf /
];

const CATASTROPHIC_PATTERNS_WINDOWS: RegExp[] = [
    /\bformat\s+[a-zA-Z]:\s*\/[qfsxq]/i,                               // format c: /q
    /\bdel\s+\/[sf]\s+\/[qf]\s+[a-zA-Z]:\\?(\s|$)/i,                  // del /s /q C:\
    /\brmdir\s+\/[sq]\s+\/[sq]\s+[a-zA-Z]:\\?(\s|$)/i,                // rmdir /s /q C:\
    /\bcipher\s+\/w:[a-zA-Z]:/i,                                       // cipher /w:C:
    /\bdiskpart\b[\s\S]*\bclean\b/i,                                   // diskpart ... clean
    /Remove-Item\s+[^\n]*-Recurse[^\n]*-Force[^\n]*[a-zA-Z]:\\?(\s|"|\$|$)/i,  // PowerShell 재귀 삭제 루트
    /\bshutdown\s+\/[sr]\b/i,                                          // shutdown /s
    /\bsdelete\b\s+-[a-zA-Z]*[rRsS]/i,                                 // sdelete -r/s (Sysinternals)
];

/**
 * 명령이 재앙적인지 검사.
 *
 * @param command 실행될 명령 문자열
 * @param shellKind 셸 종류 (POSIX/Windows 패턴 중 어느 것을 우선 적용할지 결정)
 * @returns 차단 사유(string) 또는 null(허용)
 */
export function checkCatastrophic(command: string, shellKind: string): string | null {
    if (!command) return null;
    // POSIX 셸 환경(bash, git-bash, wsl-bash)에서는 POSIX 패턴 + Windows 패턴 양쪽 검사
    // (혼합 경우 안전을 위해). PowerShell/cmd 환경에서도 양쪽 검사 동일.
    const allPatterns = shellKind === 'powershell' || shellKind === 'cmd'
        ? [...CATASTROPHIC_PATTERNS_WINDOWS, ...CATASTROPHIC_PATTERNS_POSIX]
        : [...CATASTROPHIC_PATTERNS_POSIX, ...CATASTROPHIC_PATTERNS_WINDOWS];
    for (const pat of allPatterns) {
        if (pat.test(command)) {
            return `재앙적 명령으로 차단됨 (패턴: ${pat.source})`;
        }
    }
    return null;
}
