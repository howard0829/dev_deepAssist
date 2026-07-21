"""DeepAssist 서버 — FastAPI + WebSocket 엔트리포인트.

기동:  python -m deepassist.main   (또는 start.sh)
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from . import __version__, config
from .ws.handler import WSHandler

logger = logging.getLogger(__name__)

# Agent SDK 서브프로세스가 프로세스 환경도 참조할 수 있으므로 fallback 주입.
os.environ.setdefault("ANTHROPIC_BASE_URL", config.ANTHROPIC_BASE_URL)
os.environ.setdefault("ANTHROPIC_AUTH_TOKEN", config.ANTHROPIC_AUTH_TOKEN)
os.environ.setdefault("ANTHROPIC_API_KEY", config.ANTHROPIC_AUTH_TOKEN)
os.environ.setdefault("ANTHROPIC_SMALL_FAST_MODEL", config.SMALL_MODEL)
os.environ.setdefault("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", config.DISABLE_NONESSENTIAL_TRAFFIC)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(
        f"DeepAssist 시작 (port={config.DEEPASSIST_PORT}, model={config.DEEPASSIST_MODEL}, "
        f"base_url={config.ANTHROPIC_BASE_URL})")
    yield
    logger.info("DeepAssist 종료")


app = FastAPI(title="DeepAssist Server", version=__version__, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await WSHandler(websocket).handle()


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "service": "DeepAssist",
        "version": __version__,
        "model": config.DEEPASSIST_MODEL,
        "anthropic_base_url": config.ANTHROPIC_BASE_URL,
    }


def main() -> None:
    import uvicorn
    logging.basicConfig(
        level=getattr(logging, config.LOG_LEVEL, logging.INFO),
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )
    uvicorn.run(app, host=config.DEEPASSIST_HOST, port=config.DEEPASSIST_PORT)


if __name__ == "__main__":
    main()
