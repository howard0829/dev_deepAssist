"""
Reranker 모델 로컬 다운로드 스크립트

네트워크가 되는 환경에서 실행하여 모델을 로컬에 저장합니다.
이후 RERANKER_MODEL 환경변수에 저장 경로를 지정하면 오프라인으로 동작합니다.

사용법:
    # 존재 여부 확인 (start.sh에서 사용)
    python -m rag.download_reranker --check

    # 다운로드
    python -m rag.download_reranker
    python -m rag.download_reranker --output ~/.deepassist/models/reranker
    python -m rag.download_reranker --model cross-encoder/ms-marco-MiniLM-L-6-v2
"""

import argparse
import os
import sys

DEFAULT_MODEL = "cross-encoder/ms-marco-MiniLM-L-6-v2"
DEFAULT_OUTPUT = os.path.expanduser("~/.deepassist/models/reranker")


def is_reranker_ready(output: str = DEFAULT_OUTPUT) -> bool:
    """로컬 Reranker 모델이 사용 가능한 상태인지 확인한다."""
    output = os.path.expanduser(output)
    if not os.path.isdir(output):
        return False
    # config.json이 있으면 유효한 모델 디렉토리로 판단
    return os.path.exists(os.path.join(output, "config.json"))


def download(model: str = DEFAULT_MODEL, output: str = DEFAULT_OUTPUT) -> bool:
    """Reranker 모델을 다운로드하여 로컬에 저장한다. 성공 시 True 반환."""
    try:
        from sentence_transformers import CrossEncoder
    except ImportError:
        print("❌ sentence-transformers 패키지가 설치되지 않았습니다.")
        print("   pip install sentence-transformers")
        return False

    output = os.path.expanduser(output)
    print(f"📥 Reranker 모델 다운로드 중: {model}")
    print(f"   저장 경로: {output}")

    try:
        ce = CrossEncoder(model)
        os.makedirs(output, exist_ok=True)
        ce.save(output)
        print(f"✅ Reranker 다운로드 완료!")
        return True
    except Exception as e:
        print(f"❌ 다운로드 실패: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description="Reranker 모델 로컬 다운로드")
    parser.add_argument(
        "--check", action="store_true",
        help="로컬 모델 존재 여부만 확인 (exit code: 0=있음, 1=없음)",
    )
    parser.add_argument(
        "--model", default=DEFAULT_MODEL,
        help=f"HuggingFace 모델 ID (기본: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--output", default=DEFAULT_OUTPUT,
        help=f"로컬 저장 경로 (기본: {DEFAULT_OUTPUT})",
    )
    args = parser.parse_args()

    if args.check:
        if is_reranker_ready(args.output):
            print(f"✅ Reranker 모델 존재: {args.output}")
            sys.exit(0)
        else:
            print(f"❌ Reranker 모델 없음: {args.output}")
            sys.exit(1)

    if is_reranker_ready(args.output):
        print(f"✅ Reranker 모델이 이미 존재합니다: {args.output}")
        return

    if not download(args.model, args.output):
        sys.exit(1)

    print(f"\n💡 .env 파일에 다음을 추가하세요:")
    print(f"   RERANKER_MODEL={args.output}")


if __name__ == "__main__":
    main()
