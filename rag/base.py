"""
rag/base.py — BaseRAG 공통 인프라

임베딩 모델 초기화, FAISS/BM25 벡터 스토어 관리, 앙상블 검색 설정 등
MarkdownRAG와 CodeRAG의 공통 기반 클래스.
"""

import logging
import os
import pickle
import tempfile
from typing import List, Optional

from tqdm import tqdm

from langchain_community.vectorstores import FAISS
from langchain_community.retrievers import BM25Retriever
from langchain.retrievers import EnsembleRetriever
from langchain_core.documents import Document
from langchain_ollama import OllamaEmbeddings

from rag.config import (
    OLLAMA_BASE_URL, OLLAMA_EMBEDDING_MODEL,
    RERANKER_MODEL,
)

logger = logging.getLogger(__name__)

# ── Cross-encoder Reranker (선택적 의존성) ────────────────────
_RERANKER_AVAILABLE = False
_reranker_model = None

try:
    from sentence_transformers import CrossEncoder
    _RERANKER_AVAILABLE = True
except ImportError:
    pass


def _init_reranker(model_name: str = ""):
    """Cross-encoder reranker를 초기화한다. 미설치 시 None 반환.

    로드 우선순위:
      1. model_name 파라미터 (명시적 지정)
      2. RERANKER_MODEL 환경변수/config 값
      3. 기본값 'cross-encoder/ms-marco-MiniLM-L-6-v2'

    로컬 디렉토리 경로를 지정하면 네트워크 없이 동작합니다.
    """
    global _reranker_model
    if not _RERANKER_AVAILABLE:
        return None
    if _reranker_model is None:
        resolved = model_name or RERANKER_MODEL or "cross-encoder/ms-marco-MiniLM-L-6-v2"
        resolved = os.path.expanduser(resolved)
        try:
            _reranker_model = CrossEncoder(resolved)
            logger.info(f"✅ Reranker 로드 완료: {resolved}")
        except Exception as e:
            logger.warning(f"⚠️ Reranker 로드 실패: {e}")
            return None
    return _reranker_model


def rerank_documents(query: str, docs: List[Document], top_k: int) -> List[Document]:
    """Cross-encoder로 문서를 재순위화한다.

    각 문서의 metadata["rerank_score"]에 점수를 기록한다.
    reranker 미설치 시 원본 그대로 반환 (점수 없음).
    """
    if not docs or len(docs) <= top_k:
        return docs
    reranker = _init_reranker()
    if reranker is None:
        return docs[:top_k]
    try:
        pairs = [(query, doc.page_content[:512]) for doc in docs]
        scores = reranker.predict(pairs)
        scored_docs = sorted(zip(scores, docs), key=lambda x: x[0], reverse=True)
        result = []
        for score, doc in scored_docs[:top_k]:
            doc.metadata["rerank_score"] = float(score)
            result.append(doc)
        return result
    except Exception as e:
        logger.warning(f"⚠️ Rerank 실패, 원본 순서 유지: {e}")
        return docs[:top_k]


class BaseRAG:
    """MarkdownRAG와 CodeRAG의 공통 기반 클래스.

    임베딩 모델 초기화, FAISS/BM25 벡터 스토어 관리, 앙상블 검색 설정 등
    양쪽 RAG에서 동일하게 사용하는 인프라를 제공한다.
    """

    def __init__(self, db_store_path: str = "./knowledge_base",
                 embedding_model_override: Optional[str] = None):
        """BaseRAG 초기화.

        Args:
            db_store_path: DB를 저장/로드할 디렉토리 경로
            embedding_model_override: 기본 임베딩 모델 대신 사용할 모델명
        """
        if not db_store_path or not db_store_path.strip():
            raise ValueError("db_store_path가 비어 있습니다. DB 저장 경로를 지정하세요.")
        self.db_store_path = db_store_path
        self.faiss_path = os.path.join(self.db_store_path, "faiss_index")
        self.bm25_path = os.path.join(self.db_store_path, "bm25_retriever.pkl")

        self.vector_store: Optional[FAISS] = None
        self.bm25_retriever: Optional[BM25Retriever] = None
        self.ensemble_retriever: Optional[EnsembleRetriever] = None

        self.embeddings = self._init_embeddings(embedding_model_override)

    def _init_embeddings(self, model_override: Optional[str] = None):
        """Ollama 임베딩 모델을 초기화한다."""
        model = model_override or OLLAMA_EMBEDDING_MODEL
        if not model:
            raise ValueError("OLLAMA_EMBEDDING_MODEL 값이 설정되지 않았습니다.")
        # URL 정규화 — 끝 슬래시/잘못된 suffix로 인한 임베딩 404 차단. rag 패키지는
        # 서버 config(normalize_ollama_url)에 비의존(순환 의존 회피)이라 인라인 처리.
        base_url = (OLLAMA_BASE_URL or "http://localhost:11434").strip().rstrip("/")
        return OllamaEmbeddings(base_url=base_url, model=model)

    def _setup_ensemble(self, faiss_k: int = 8, bm25_k: int = 8,
                        weights: Optional[List[float]] = None):
        """FAISS와 BM25를 묶어 Hybrid Retriever를 구성한다."""
        if weights is None:
            weights = [0.4, 0.6]
        faiss_retriever = self.vector_store.as_retriever(search_kwargs={"k": faiss_k})
        self.bm25_retriever.k = bm25_k
        self.ensemble_retriever = EnsembleRetriever(
            retrievers=[self.bm25_retriever, faiss_retriever],
            weights=weights,
        )

    # FAISS 배치 빌드 크기 (대규모 문서셋에서 메모리 효율 향상)
    FAISS_BATCH_SIZE = 10000

    def _save_vector_stores(self, all_splits: List[Document],
                            bm25_preprocess_func=None):
        """FAISS 벡터 DB와 BM25 인덱스를 구축하고 디스크에 저장한다."""
        total_chunks = len(all_splits)
        logger.info(f"총 {total_chunks}개의 청크(Chunk)로 분할되었습니다. 임베딩 진행 중...")
        os.makedirs(self.db_store_path, exist_ok=True)

        # 배치 단위로 FAISS에 추가 (메모리 효율)
        total_batches = (total_chunks - 1) // self.FAISS_BATCH_SIZE + 1
        vs = None
        with tqdm(total=total_chunks, desc="📦 FAISS 임베딩", unit="chunk") as pbar:
            for i in range(0, total_chunks, self.FAISS_BATCH_SIZE):
                batch = all_splits[i:i + self.FAISS_BATCH_SIZE]
                if vs is None:
                    vs = FAISS.from_documents(batch, self.embeddings)
                else:
                    vs.add_documents(batch)
                pbar.update(len(batch))
        self.vector_store = vs
        self.vector_store.save_local(self.faiss_path)

        logger.info("🔤 BM25 인덱스 구축 중...")
        kwargs = {}
        if bm25_preprocess_func:
            kwargs["preprocess_func"] = bm25_preprocess_func
        self.bm25_retriever = BM25Retriever.from_documents(all_splits, **kwargs)

        # atomic write — temp 파일에 쓴 뒤 rename. 중간 crash 시 기존 파일 보존
        _dir = os.path.dirname(self.bm25_path) or "."
        _fd, _tmp = tempfile.mkstemp(dir=_dir, prefix=".bm25.", suffix=".tmp")
        try:
            with os.fdopen(_fd, "wb") as f:
                pickle.dump(self.bm25_retriever, f)
            os.replace(_tmp, self.bm25_path)
        except BaseException:
            try:
                os.unlink(_tmp)
            except OSError:
                pass
            raise

    def _load_vector_stores(self):
        """디스크에서 FAISS 벡터 DB와 BM25 인덱스를 로드한다."""
        self.vector_store = FAISS.load_local(
            self.faiss_path, self.embeddings, allow_dangerous_deserialization=True,
        )
        with open(self.bm25_path, "rb") as f:
            self.bm25_retriever = pickle.load(f)
