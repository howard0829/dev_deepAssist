"""
rag — FAISS + BM25 하이브리드 RAG 패키지 (마크다운 + 소스코드 통합)

아키텍처:
  BaseRAG          — 공통 인프라 (임베딩, FAISS/BM25, 앙상블 검색, Reranker)
  ├── MarkdownRAG  — 마크다운 기술문서 전용 (헤더 경계 청킹, 용어 인덱스)
  └── CodeRAG      — 소스코드 전용 (AST 청킹, 심볼/파일/함수 인덱스, 그래프 스토어)

서브패키지:
  parser/          — 언어별 tree-sitter 기반 코드 파서 (Python, C)
  chunker/         — AST 기반 계층적 청킹 + 대형 함수 분할기
  storage/         — 인메모리 그래프/독 스토어
  enricher.py      — 메타데이터 추출 및 그래프 엣지 생성
  models.py        — 핵심 데이터 모델 (UnifiedASTNode, Chunk, GraphEdge 등)

기존 import 호환:
  from rag import MarkdownRAG, CodeRAG, BaseRAG
"""

from rag.base import BaseRAG
from rag.markdown import MarkdownRAG
from rag.code import CodeRAG

# pickle 역직렬화 호환: 기존 .pkl 파일에 rag.bm25_preprocessor /
# rag.code_bm25_preprocessor 경로로 저장된 함수 참조를 유지
from rag.utils import bm25_preprocessor
from rag.code import code_bm25_preprocessor

__all__ = [
    "BaseRAG",
    "MarkdownRAG",
    "CodeRAG",
    "bm25_preprocessor",
    "code_bm25_preprocessor",
]
