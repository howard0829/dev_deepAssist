"""
RAG 전용 설정 — 임베딩, Knowledge DB 경로

이 모듈은 rag/ 패키지가 프로젝트 루트의 config.py에 의존하지 않고
독립적으로 동작할 수 있도록 합니다.
mcp/ + rag/ 폴더만 복사하면 다른 환경에서 바로 사용 가능합니다.
"""

import os

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # python-dotenv 미설치 시 환경변수 직접 사용

# ──────────────────────────────────────────────
# 임베딩 설정
# ──────────────────────────────────────────────

OLLAMA_BASE_URL: str = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_EMBEDDING_MODEL: str = os.getenv("OLLAMA_EMBEDDING_MODEL", "bge-m3:latest")
CODE_EMBEDDING_MODEL: str = os.getenv("CODE_EMBEDDING_MODEL", "")

# ──────────────────────────────────────────────
# Knowledge DB 설정
# ──────────────────────────────────────────────

KNOWLEDGE_BASE_DIR: str = os.path.expanduser(
    os.getenv("KNOWLEDGE_BASE_DIR", "~/.deepassist/knowledge")
)

# ──────────────────────────────────────────────
# Reranker 설정
# ──────────────────────────────────────────────

# ──────────────────────────────────────────────
# 코드 청킹 설정
# ──────────────────────────────────────────────

CHUNK_SEARCH_BUDGET: int = int(os.getenv("CHUNK_SEARCH_BUDGET", "256"))
"""검색 청크 예산 (비공백 문자 기준, 기본 256 × 4 = 1024자 초과 시 분할)."""

CHUNK_MIN_SIZE: int = int(os.getenv("CHUNK_MIN_SIZE", "64"))
"""최소 청크 크기 (비공백 문자 기준, 이보다 작으면 인접 청크와 병합)."""

LARGE_FUNCTION_THRESHOLD: int = int(os.getenv("LARGE_FUNCTION_THRESHOLD", "500"))
"""대형 함수 판정 기준 (라인 수). 이상이면 2-level 분할."""

HUGE_FUNCTION_THRESHOLD: int = int(os.getenv("HUGE_FUNCTION_THRESHOLD", "1000"))
"""초대형 함수 판정 기준 (라인 수). 이상이면 3-level 분할."""

CHUNK_AUTO_MERGE_RATIO: float = float(os.getenv("CHUNK_AUTO_MERGE_RATIO", "0.6"))
"""인접 소형 청크 자동 병합 비율."""

# ──────────────────────────────────────────────
# 검색 설정
# ──────────────────────────────────────────────

RETRIEVAL_INITIAL_TOP_K: int = int(os.getenv("RETRIEVAL_INITIAL_TOP_K", "100"))
"""하이브리드 검색 시 초기 후보 수."""

RETRIEVAL_RRF_K: int = int(os.getenv("RETRIEVAL_RRF_K", "60"))
"""RRF (Reciprocal Rank Fusion) 파라미터."""

# ──────────────────────────────────────────────
# Reranker 설정
# ──────────────────────────────────────────────

RERANKER_MODEL: str = os.getenv(
    "RERANKER_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2"
)
"""Reranker 모델명 또는 로컬 경로.
HuggingFace 모델 ID (예: 'cross-encoder/ms-marco-MiniLM-L-6-v2') 또는
로컬 디렉토리 경로 (예: '~/.deepassist/models/ms-marco-MiniLM-L-6-v2').
로컬 경로 지정 시 네트워크 없이 동작합니다.
"""
