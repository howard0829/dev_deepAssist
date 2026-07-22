# RAG 모듈

FAISS + BM25 하이브리드 Retrieval-Augmented Generation 패키지.
마크다운 기술문서와 소스코드를 지원합니다.

## 아키텍처

```
BaseRAG (base.py)             -- 공통 인프라: 임베딩, FAISS/BM25, 앙상블, Reranker
  ├── MarkdownRAG (markdown.py)  -- 마크다운 기술문서 (헤더 경계 청킹, 용어 인덱스)
  └── CodeRAG (code.py)          -- 소스코드 (tree-sitter AST 청킹, 심볼/파일/함수 인덱스)

search.py                     -- 검색 핵심 로직: DB 검색, 웹 검색/스크래핑, Wikipedia
config.py                     -- 임베딩 & Knowledge DB & Reranker 설정 (환경변수 기반)
constants.py                  -- 공유 상수, 정규식, tree-sitter 언어 레지스트리
utils.py                      -- BM25 전처리, 청크 문맥 추출 공용 함수
__main__.py                   -- CLI (query / interactive / list / 테스트)
download_reranker.py          -- Reranker 모델 로컬 다운로드/체크 스크립트
```

### 클래스 계층

**BaseRAG** (`base.py`):
- 임베딩 모델 초기화 (Ollama 또는 Gemini)
- FAISS 벡터 스토어 + BM25 인덱스 구축/저장/로드
- 앙상블 리트리버 설정 (BM25:FAISS 가중치 기본 0.6:0.4, k=8)
- 배치 FAISS 임베딩으로 메모리 효율 확보 (`FAISS_BATCH_SIZE = 10000`)
- Cross-encoder Reranker (로컬 자동 다운로드, `RERANKER_MODEL` 환경변수로 경로 지정 가능). 각 문서에 `rerank_score` 메타데이터 기록

**MarkdownRAG** (`markdown.py`):
- 헤더 경계 청킹: 마크다운 헤더(`#` ~ `######`) 기준 분할, 테이블 구조 보존
- 2단계 분할: 1차 헤더 경계 → 2차 `RecursiveCharacterTextSplitter`로 대형 청크 재분할
- 용어 인덱스: Requirement ID (예: `TEL-6`, `STD-LOG-23` 등 다중 하이픈 ID 지원)와 약어 (예: `NVMe`)를 청크에 매핑하여 정확 매칭 지원
- 하이브리드 검색: 키워드 직접 매칭 상위 고정(pinned, `MAX_TERM_RATIO=0.5`) → 앙상블(FAISS + BM25) 보충 → Reranker로 나머지 슬롯 채움. pinned 초과 시 Reranker로 관련성 높은 것만 선별

**CodeRAG** (`code.py`):
- tree-sitter AST 기반 청킹 (미설치 시 regex 폴백)
- 3단계 청크 체계:
  - **L1** 파일 요약: import 목록, 선언 개요, 라인 수
  - **L2** 함수/클래스: 전체 소스 + 시그니처, 계층 경로, Requirement ID
  - **L3** 서브 청크: 대형 함수를 컨텍스트 프리픽스 보존하며 추가 분할
- 5종 인덱스: 심볼 인덱스, 파일 경로 인덱스, 함수 ID 인덱스, Requirement ID 인덱스, 파일 매니페스트
- 서브 청크 재조립: 검색 결과에서 분할된 서브 청크를 원본 함수로 자동 재조립
- 지원 언어: Python, C, C++, Java (`_LANGUAGE_CONFIG` in `constants.py`에서 확장 가능)

### 검색 모듈 (`search.py`)

MCP 어댑터(`mcp/server.py`)와 도구 어댑터(`tools/knowledge_tools.py`)가 공유하는 공개 API:

- **`search_knowledge(query, db_path, top_k)`** — Knowledge DB에서 하이브리드 검색. 복수 DB Fan-out + RRF 병합 지원. 포맷된 문자열 반환
- **`search_knowledge_docs(query, db_path, top_k)`** — 위와 동일한 검색이지만 `Document` 리스트를 그대로 반환. `pinned`, `rerank_score` 등 메타데이터에 접근 가능 (에이전트 자동 선행 검색에서 관련성 판단용)
- **`build_knowledge_db(source_path, db_path, force_rebuild)`** — 파일/폴더에서 벡터 DB 구축. 소스 타입(마크다운/코드) 자동 감지
- **`list_knowledge_dbs()`** — `KNOWLEDGE_BASE_DIR` 아래 구축된 모든 Knowledge DB 목록 반환
- **`search_web_and_scrape(query, max_results)`** — DuckDuckGo 웹 검색 + 페이지 스크래핑 (requests+BS4, trafilatura 폴백)
- **`search_wikipedia(query, lang, top_k, mode)`** — Wikipedia 검색 (MediaWiki API, 요약/전문 모드, 자동 ko→en 폴백)

## 설정

모든 설정은 환경변수에서 로드됩니다 (`.env` 지원):

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `EMBEDDING_PROVIDER` | `ollama` | 임베딩 프로바이더: `ollama` 또는 `gemini` |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama 서버 URL |
| `OLLAMA_EMBEDDING_MODEL` | `bge-m3:latest` | Ollama 임베딩 모델명 |
| `GEMINI_API_KEY` | (빈 값) | Google Gemini API 키 |
| `GEMINI_EMBEDDING_MODEL` | `models/text-embedding-004` | Gemini 임베딩 모델명 |
| `CODE_EMBEDDING_MODEL` | (빈 값) | CodeRAG 전용 임베딩 모델 오버라이드 |
| `KNOWLEDGE_BASE_DIR` | `~/.deepassist/knowledge` | 구축된 DB 저장 디렉토리 |
| `RERANKER_MODEL` | `cross-encoder/ms-marco-MiniLM-L-6-v2` | Reranker 모델 ID 또는 로컬 경로 |
| `SEARCH_PROXY` | (빈 값) | 웹 검색용 프록시 (예: `socks5://host:port`) |

## 사용법

### Python API

```python
from rag import MarkdownRAG, CodeRAG

# --- 마크다운 RAG ---
md_rag = MarkdownRAG(db_store_path="./my_knowledge_db")

# 단일 .md 파일 또는 .md 파일 폴더에서 구축
md_rag.build_or_load("/path/to/documents")

# 검색
results = md_rag.retrieve("큐 제출 메커니즘은 어떻게 동작하나요?", top_k=6)
for doc in results:
    print(doc.metadata["section"], doc.page_content[:200])

# --- 코드 RAG ---
code_rag = CodeRAG(db_store_path="./my_code_db")

# 프로젝트 디렉토리에서 구축 (.py, .c, .cpp, .h, .hpp, .cc, .java 지원)
code_rag.build_or_load("/path/to/project")

# 심볼, 함수명, 자연어로 검색
results = code_rag.retrieve("allocate_block", top_k=6)
for doc in results:
    print(doc.metadata.get("signature", ""), doc.metadata.get("hierarchy", ""))
```

### 검색 모듈 사용

```python
from rag.search import search_knowledge, build_knowledge_db, list_knowledge_dbs

# Knowledge DB 구축 (마크다운/코드 자동 감지)
print(build_knowledge_db("/path/to/source"))

# 구축된 DB 목록 확인
print(list_knowledge_dbs())

# 전체 DB 검색 (쿼리 키워드로 관련 DB 자동 선택)
print(search_knowledge("NVMe 큐 메커니즘"))

# 특정 DB 검색
print(search_knowledge("allocate_block", db_path="/path/to/db1,/path/to/db2"))

# 웹 검색 + 스크래핑
from rag.search import search_web_and_scrape
print(search_web_and_scrape("Python async 모범 사례", max_results=3))

# Wikipedia 검색
from rag.search import search_wikipedia
print(search_wikipedia("NVMe", lang="en", mode="full"))
```

### CLI — 구축된 DB에 바로 쿼리

DB가 이미 구축되어 있으면 코드 작성 없이 CLI에서 바로 검색할 수 있습니다.

```bash
# 구축된 DB 목록 확인
python -m rag list

# 단일 쿼리 (DB 1개면 자동 선택, 여러 개면 번호 선택)
python -m rag query "TEL-3 설명"

# DB 직접 지정 + top_k 변경
python -m rag query "큐 제출 메커니즘" --db ~/.deepassist/knowledge/nvme_abc12345 --top_k 8

# 인터랙티브 모드 (연속 쿼리, quit으로 종료)
python -m rag interactive
python -m rag interactive --db /path/to/db --top_k 4
```

인터랙티브 모드에서는 프롬프트가 나타나서 계속 쿼리를 입력할 수 있습니다:
```
🔎 쿼리 (6): STD-LOG-23 설명
[Q1] 🔍 쿼리: STD-LOG-23 설명
  📊 결과: 6건 (pinned: 2건)
============================================================
  결과 1 [📌 pinned] | 문서: spec.md | 섹션: Logging > STD-LOG-23
  내용: ...
  --------------------------------------------------------
  결과 2 [📌 pinned] | 문서: spec.md | 섹션: Logging > Overview
  내용: ...
  --------------------------------------------------------
  결과 3 [score: 3.45] | 문서: spec.md | 섹션: Logging > Architecture
  내용: ...
📊 6개 결과 (top_k=6 | pinned: 2 | max_score: 3.45)

🔎 쿼리 (6): /top_k 8     ← top_k 실시간 변경
🔎 쿼리 (8): NVMe 큐 메커니즘
  ... 검색 결과 ...
🔎 쿼리 (8): quit          ← 종료
```

### 배치 테스트 스크립트

프로젝트 루트의 `rag_test.sh`로 여러 쿼리를 미리 적어두고 순차 실행할 수 있습니다.

```bash
# 기본 실행
./rag_test.sh

# DB 지정 + top_k 변경
./rag_test.sh --db /path/to/db --top_k 8
```

스크립트 내 `QUERIES` 배열을 편집하여 테스트 쿼리를 관리합니다:

```bash
QUERIES=(
    "TEL-3 설명"
    "큐(Queue) 제출 메커니즘은 어떻게 동작하나요?"
    "NVMe 네임스페이스 관리"
    # 원하는 만큼 추가 가능
)
```

### TESTS 기반 테스트 (기존 방식)

```bash
# __main__.py TESTS 리스트에 정의된 전체 테스트 실행
python -m rag

# 마크다운 또는 코드 테스트만 실행
python -m rag markdown
python -m rag code
```

`rag/__main__.py`의 `TESTS` 리스트를 편집하여 소스 경로와 쿼리를 설정하세요.

### Reranker 모델 관리

`start.sh` 실행 시 로컬에 Reranker 모델이 없으면 자동 다운로드합니다.
수동으로 관리하려면:

```bash
# 존재 여부 확인
python -m rag.download_reranker --check

# 수동 다운로드
python -m rag.download_reranker

# 저장 경로 지정
python -m rag.download_reranker --output /path/to/local/reranker
```

다운로드 후 `.env`에 `RERANKER_MODEL=경로`를 설정하면 네트워크 없이도 Reranker가 동작합니다.

## 검색 파이프라인 상세

### Query → 결과 전체 흐름

```
에이전트 → SearchKnowledge(query, top_k)
             │
             ▼
        search.py: DB 자동 선택
        ├─ db_path 지정 시 → 해당 DB만 검색
        └─ db_path 미지정 시 → 쿼리 키워드로 DB명/폴더명 매칭 → 관련 DB 선별
             │
             ▼
        MarkdownRAG/CodeRAG.retrieve(query, top_k)
             │
             ▼
        ┌─────────────────────────────────────────┐
        │ ① Term 추출                              │
        │   ├─ Requirement ID: TEL-3, STD-LOG-23   │
        │   │   (다중 하이픈 지원)                  │
        │   ├─ 약어: NVMe, PCIe 등 (대문자 2자+)  │
        │   └─ 심볼: snake_case, CamelCase 패턴    │
        │                                          │
        │ ② 희귀 용어 판정 (히트 ≤ 10건)          │
        │   ├─ [있음] → 직접 매칭 → pinned         │
        │   │   (metadata["pinned"]=True 태깅)     │
        │   └─ [없음] → Ensemble 검색만 수행       │
        │                                          │
        │ ③ pinned 상한 적용 (MAX_TERM_RATIO=0.5)  │
        │   ├─ 상한 이내 → 그대로 상위 고정        │
        │   └─ 초과 → Reranker로 상위만 선별       │
        │                                          │
        │ ④ Ensemble 검색 (pinned 중복 제거)       │
        │   ├─ FAISS: 벡터 유사도 (k=8)           │
        │   ├─ BM25: 어휘 매칭 (k=8)              │
        │   └─ 가중 병합: BM25 0.6 + FAISS 0.4    │
        │                                          │
        │ ⑤ [CodeRAG만] 서브 청크 재조립           │
        │   └─ function_id_index로 분할된 서브 청크 │
        │      → 원본 함수 소스로 병합             │
        │                                          │
        │ ⑥ Cross-encoder Reranking (Ensemble만)   │
        │   ├─ 모델: ms-marco-MiniLM-L-6-v2       │
        │   │   (로컬 자동 다운로드, RERANKER_MODEL)│
        │   ├─ (query, doc) 쌍의 관련성 점수 계산  │
        │   ├─ metadata["rerank_score"] 기록        │
        │   └─ 나머지 슬롯(top_k - pinned) 채움    │
        │                                          │
        │ ⑦ 최종 병합: pinned + reranked = top_k   │
        └─────────────────────────────────────────┘
             │
             ▼
        [복수 DB 시] RRF 병합
        score(doc) = Σ 1/(60 + rank + 1) (각 DB의 순위별)
             │
             ▼
        _format_results() → 포맷된 문자열로 에이전트에 반환
```

### 구축 파이프라인

1. **소스 감지**: 파일 확장자 분포로 마크다운/코드 자동 판별
2. **청킹**:
   - 마크다운: 헤더 경계 분할 → 대형 청크 2차 분할
   - 코드: tree-sitter AST 파싱 → L1 파일 요약 + L2 함수/클래스 + L3 서브 청크
3. **인덱싱**:
   - FAISS 벡터 인덱스 (배치 임베딩, `FAISS_BATCH_SIZE = 10000`)
   - BM25 어휘 인덱스 (도메인 특화 전처리)
   - 용어/심볼 인덱스 (정확 매칭용)
4. **영속화**: 모든 인덱스를 `db_store_path`에 FAISS 인덱스 + pickle 파일로 저장

### 검색 결과 형식

#### 마크다운 RAG 결과

```
[결과 1] 문서: NVMe_OCP_2.6spec | 파일: /path/to/spec.md | 섹션: 3.2 TEL-3 Temperature
NVMe OCP 2.6 spec에서 TEL-3는 Temperature Telemetry...
(청크 본문)
--------------------------------------------------
[결과 2] 문서: NVMe_OCP_2.6spec | 파일: /path/to/spec.md | 섹션: 4.1 Telemetry Overview
...
```

**metadata 필드**:

| 필드 | 설명 |
|------|------|
| `source` | 원본 파일 경로 |
| `doc_name` | 문서명 (파일명 기반) |
| `section` | 마크다운 헤더 (소속 섹션) |
| `page` | 페이지 번호 (있는 경우) |
| `pinned` | 키워드 직접 매칭 여부 (`True`/없음) |
| `rerank_score` | Cross-encoder 관련성 점수 (Reranker 통과 시) |

#### 코드 RAG 결과

```
[결과 1] 프로젝트: my_project | 파일: src/main.py | 언어: python | 유형: function | 라인: 45-78 | 계층: MyClass > process_data
  시그니처: def process_data(self, items: list) -> dict
(함수 소스코드)
--------------------------------------------------
[결과 2] 프로젝트: my_project | 파일: src/utils.py | 언어: python | 유형: file_summary
[src/utils.py | FILE_SUMMARY]
Language: python
Lines: 234
Imports: import os, from typing import List
```

**metadata 필드**:

| 필드 | 설명 |
|------|------|
| `source` | 프로젝트 루트 기준 상대 경로 |
| `project` | 프로젝트명 |
| `language` | 프로그래밍 언어 (python, c, cpp, java) |
| `chunk_type` | 청크 유형: `file_summary`, `function`, `class`, `subchunk` |
| `line_range` | `(시작줄, 끝줄)` 튜플 |
| `hierarchy` | 계층 경로 (예: `MyClass > inner_method`) |
| `signature` | 함수/클래스 시그니처 |
| `requirement_ids` | 코드 내 Requirement ID 목록 |
| `symbols_defined` | 정의된 심볼명 목록 |
| `is_subchunk` | 서브 청크 여부 |
| `function_id` | 서브 청크의 원본 함수 식별자 (재조립용) |
| `reassembled` | 서브 청크 재조립 여부 |
| `pinned` | 키워드 직접 매칭 여부 (`True`/없음) |
| `rerank_score` | Cross-encoder 관련성 점수 (Reranker 통과 시) |

### Document 객체 구조

검색 결과는 `langchain_core.documents.Document` 리스트로 반환됩니다:

```python
Document(
    page_content="실제 청크 텍스트 내용...",
    metadata={
        # 마크다운: source, doc_name, section, page
        # 코드: source, project, language, chunk_type,
        #       line_range, hierarchy, signature,
        #       requirement_ids, symbols_defined,
        #       is_subchunk, function_id, reassembled
        # 공통 (검색 시 추가): pinned, rerank_score
    }
)
```

### 의도별 top_k 권장값

에이전트가 의도 분류 결과에 따라 top_k 힌트를 제공합니다:

| 의도 | top_k | 이유 |
|------|:-----:|------|
| research, analyze | 8 | 넓은 맥락 파악, recall 우선 |
| implement, ideate, review, debug, plan | 6 | 균형 (기본값) |
| question, explain | 4 | 단일 개념, 정확한 소수 청크 |

### explain/question 자동 선행 검색

에이전트의 explain/question 의도에서는 파이프라인 시작 전 `search_knowledge_docs()`로 Knowledge DB를 자동 검색합니다. 관련성 게이트로 노이즈를 방지합니다:

- **pinned 문서 있음** → 무조건 컨텍스트 주입 (사용자가 명시한 term)
- **pinned 없음** → Reranker 최고 `rerank_score` ≥ `RAG_RELEVANCE_THRESHOLD`(0.0) → 주입
- **관련성 부족** → 주입하지 않음 (LLM 자체 지식으로 답변)

## 의존성

**필수:**
- `langchain-core`, `langchain-community`, `langchain-ollama` — 벡터 스토어, 리트리버, 임베딩
- `faiss-cpu` — 벡터 유사도 검색
- `rank-bm25` — BM25 어휘 검색
- `tqdm` — 진행률 표시

**선택:**
- `langchain-google-genai` — Gemini 임베딩 지원
- `sentence-transformers` — Cross-encoder Reranker (검색 정밀도 향상, `start.sh`에서 모델 자동 다운로드)
- `tree-sitter`, `tree-sitter-python`, `tree-sitter-c`, `tree-sitter-cpp`, `tree-sitter-java` — AST 기반 코드 청킹 (미설치 시 regex 폴백)
- `duckduckgo-search`, `requests`, `beautifulsoup4` — 웹 검색
- `trafilatura` — 웹 스크래핑 폴백
