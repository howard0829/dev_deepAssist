"""
rag/parser — 언어별 tree-sitter 기반 코드 파서 패키지

아키텍처:
  BaseParser           — 공통 인터페이스 (추상 클래스)
  ├── PythonParser     — Python 소스 파싱
  ├── CParser          — C/C++ 소스 파싱
  └── LanguageRegistry — 파일 확장자 기반 파서 자동 선택
"""
