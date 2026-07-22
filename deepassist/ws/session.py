"""Session — 연결 1개의 상태.

브리지(위임 왕복), 워크스페이스 메타, Agent SDK 세션 연속성(resume용
session_id), 그리고 이번 턴의 수정 파일/diff 누적을 보관한다.
"""

from __future__ import annotations

from .bridge import AsyncBridge


class Session:
    def __init__(self, bridge: AsyncBridge):
        self.bridge = bridge
        self.workspace: str = ""
        self.workspace_meta: dict = {}
        self.provider_config: dict = {}
        # UI 첨부 컨텍스트 (user_message마다 갱신).
        self.attached_paths: list[str] = []        # 클라 절대경로 (위임 도구로 열람)
        self.attached_snippets: list[dict] = []    # {file,start_line,end_line,text}
        # Agent SDK 세션 연속성 (다음 턴 resume). init/result에서 채움.
        self.sdk_session_id: str | None = None
        # 이번 실행에서 위임 도구가 보고한 부수효과.
        self.modified_files: set[str] = set()
        self.diffs: dict[str, str] = {}

    async def send(self, msg_type: str, payload: dict) -> None:
        await self.bridge.send(msg_type, payload)

    def update_from_user_message(self, payload: dict) -> None:
        self.workspace = payload.get("workspace", self.workspace)
        self.provider_config = payload.get("provider_config", self.provider_config)
        self.attached_paths = payload.get("attached_paths", []) or []
        self.attached_snippets = payload.get("attached_snippets", []) or []

    def begin_turn(self) -> None:
        self.modified_files.clear()
        self.diffs.clear()

    def reset(self) -> None:
        self.sdk_session_id = None
        self.begin_turn()
