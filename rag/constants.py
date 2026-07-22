"""
rag/constants.py — 공통 상수, 정규식 패턴, tree-sitter 언어 레지스트리

마크다운/코드 RAG 양쪽에서 공유하는 상수와 tree-sitter 관련 초기화를 담당한다.
"""

import logging
import re
from typing import Dict

logger = logging.getLogger(__name__)

# ── tree-sitter (선택적 의존성 — 미설치 시 regex 폴백 사용) ───
_TREE_SITTER_AVAILABLE = False
try:
    from tree_sitter import Language as TSLanguage, Parser as TSParser
    _TREE_SITTER_AVAILABLE = True
except ImportError:
    pass

# ══════════════════════════════════════════════════════════════
# 공통 상수 및 정규식 패턴
# ══════════════════════════════════════════════════════════════

# ── 마크다운 전용 패턴 ─────────────────────────────────────────
_HEADER_RE = re.compile(r'^(#{1,6})\s+(.*)')
_PAGE_RE = re.compile(r'<!--\s*page:\s*(\d+)\s*-->')
_TABLE_ROW_RE = re.compile(r'^\|(?![-|:\s]+\|$)')
_TABLE_SEP_RE = re.compile(r'^\|[-|:\s]+\|$')

# ── 공통 패턴 (마크다운 + 코드 모두 사용) ─────────────────────
# 경계: `\b`는 한글을 `\w`로 취급해 `STD-LOG-23을` 같은 한글 조사 인접 시 매칭 실패.
# lookaround로 ASCII letter/digit/underscore 인접만 차단(기존 `\b`와 동일 의미)하면
# 한글·공백·구두점·하이픈은 통과. 하이픈은 차단하지 않아 부분 매칭(`STD-LOG-23-9` → `STD-LOG-23`) 보존.
_REQ_ID_RE = re.compile(r'(?<![A-Za-z0-9_])([A-Z]{2,}[A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d+)(?![A-Za-z0-9_])')
_REQ_ID_EXCLUDE = {'UTF-8', 'AES-128', 'AES-256', 'SHA-256', 'SHA-384', 'SHA-512',
                    'FIPS-140', 'IEEE-1667', 'SP-800', 'X-509',
                    'JESD218B-02', 'JESD218A-01'}
_ABBR_DEF_RE = re.compile(r'([A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)*)\s*\(([A-Z][A-Z0-9]{1,})\)')

# ── 코드 전용 패턴 ────────────────────────────────────────────
_CODE_REQ_PATTERN = re.compile(r'\b([A-Z]{2,}[A-Z0-9]*(?:_[A-Z][A-Z0-9]*)*)_(\d+)\b')

# ── tree-sitter 언어 레지스트리 ────────────────────────────────
_LANGUAGE_CONFIG = {
    ".py": {
        "name": "python",
        "grammar_module": "tree_sitter_python",
        "func_types": ["function_definition", "decorated_definition"],
        "class_types": ["class_definition"],
        "namespace_types": [],
        "import_types": ["import_statement", "import_from_statement"],
        "decorator_aware": True,
        "body_types": ["block"],
    },
    ".c": {
        "name": "c",
        "grammar_module": "tree_sitter_c",
        "func_types": ["function_definition"],
        "class_types": ["struct_specifier", "enum_specifier"],
        "namespace_types": [],
        "import_types": ["preproc_include"],
        "decorator_aware": False,
        "body_types": ["compound_statement"],
    },
    ".h": {
        "name": "c",
        "grammar_module": "tree_sitter_c",
        "func_types": ["function_definition"],
        "class_types": ["struct_specifier", "enum_specifier"],
        "namespace_types": [],
        "import_types": ["preproc_include"],
        "decorator_aware": False,
        "body_types": ["compound_statement"],
    },
    ".cpp": {
        "name": "cpp",
        "grammar_module": "tree_sitter_cpp",
        "func_types": ["function_definition"],
        "class_types": ["class_specifier", "struct_specifier"],
        "namespace_types": ["namespace_definition"],
        "import_types": ["preproc_include"],
        "decorator_aware": False,
        "body_types": ["compound_statement", "field_declaration_list"],
    },
    ".hpp": {
        "name": "cpp",
        "grammar_module": "tree_sitter_cpp",
        "func_types": ["function_definition"],
        "class_types": ["class_specifier", "struct_specifier"],
        "namespace_types": ["namespace_definition"],
        "import_types": ["preproc_include"],
        "decorator_aware": False,
        "body_types": ["compound_statement", "field_declaration_list"],
    },
    ".cc": {
        "name": "cpp",
        "grammar_module": "tree_sitter_cpp",
        "func_types": ["function_definition"],
        "class_types": ["class_specifier", "struct_specifier"],
        "namespace_types": ["namespace_definition"],
        "import_types": ["preproc_include"],
        "decorator_aware": False,
        "body_types": ["compound_statement", "field_declaration_list"],
    },
    ".java": {
        "name": "java",
        "grammar_module": "tree_sitter_java",
        "func_types": ["method_declaration", "constructor_declaration"],
        "class_types": ["class_declaration", "interface_declaration", "enum_declaration"],
        "namespace_types": [],
        "import_types": ["import_declaration"],
        "decorator_aware": False,
        "body_types": ["block"],
    },
}

# ── tree-sitter 그래머 캐시 ────────────────────────────────────
_TS_LANGUAGES: Dict[str, 'TSLanguage'] = {}
_TS_PARSERS: Dict[str, 'TSParser'] = {}


def _init_ts_grammars() -> None:
    """설치된 tree-sitter 언어 그래머를 감지하여 로드한다."""
    if not _TREE_SITTER_AVAILABLE:
        return

    loaded = set()
    for ext, config in _LANGUAGE_CONFIG.items():
        module_name = config["grammar_module"]
        if module_name in loaded:
            for other_ext, other_config in _LANGUAGE_CONFIG.items():
                if other_config["grammar_module"] == module_name and other_ext in _TS_LANGUAGES:
                    _TS_LANGUAGES[ext] = _TS_LANGUAGES[other_ext]
                    break
            continue
        try:
            mod = __import__(module_name)
            lang = TSLanguage(mod.language())
            _TS_LANGUAGES[ext] = lang
            loaded.add(module_name)
        except (ImportError, AttributeError, OSError):
            pass


# 모듈 로드 시 한 번만 실행
_init_ts_grammars()
