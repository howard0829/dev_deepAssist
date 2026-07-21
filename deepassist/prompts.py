"""시스템 프롬프트 보강 (§9.1).

내장 워크스페이스 도구를 비활성화하고 위임형 MCP 도구(mcp__deepassist__*)로
대체하므로, claude_code 프리셋이 지칭하는 "Bash/Read/Edit" 이름과 어긋난다.
프리셋에 아래 지침을 append하여 위임 도구를 쓰도록 유도한다.

⚠ 이 프롬프트는 구현 초기 튜닝 대상(§11 검증 항목 3).
"""

DEEPASSIST_TOOL_GUIDE = """
[워크스페이스 도구 안내]
이 환경에서 파일과 셸은 사용자의 원격 워크스페이스에서 실행된다. 표준 내장 도구
(Bash/Read/Write/Edit/Glob/Grep)는 비활성화되어 있으니, 대신 아래 위임 도구를 사용하라.
서버 로컬 파일시스템에는 사용자 파일이 없다 — 반드시 위임 도구로만 워크스페이스에 접근하라.

- mcp__deepassist__bash   : 워크스페이스에서 셸 명령 실행
- mcp__deepassist__read   : 파일 읽기
- mcp__deepassist__write  : 파일 생성/덮어쓰기
- mcp__deepassist__edit   : 파일 문자열 치환 (수정 전 read로 현재 내용을 확인할 것)
- mcp__deepassist__glob   : 패턴으로 파일 찾기
- mcp__deepassist__grep   : 정규식으로 내용 검색

지식/문서 검색이 필요하면 mcp__knowledge__* 도구를 사용하라.
""".strip()
