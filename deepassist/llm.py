"""vLLM 조회 유틸 (dev_agent_client 방식).

vLLM에서 서빙 중인 모델명을 선언하지 않고, /v1/models로 런타임에 읽어 사용한다.
설정 패널의 모델 목록 채움(fetch_vllm_models)에 쓰인다. 서버 망을 경유하므로
vLLM이 서버에만 있고 클라이언트는 외부에서 WS로 붙는 토폴로지에서도 동작한다.

stdlib urllib만 사용 — 추가 의존성 없음. 블로킹 호출은 스레드로 오프로드.
"""

from __future__ import annotations

import asyncio
import json
import urllib.request

from . import config


async def fetch_vllm_models(vllm_url: str = "") -> tuple[list[str], str]:
    """vLLM /v1/models 조회 → (모델 id 목록, 에러문자열).

    Args:
        vllm_url: base URL. 비우면 서버 .env(VLLM_BASE_URL)로 폴백.
    Returns:
        (models, error). error가 빈 문자열이면 성공.
    """
    base = (vllm_url or config.VLLM_BASE_URL).rstrip("/")
    url = f"{base}/v1/models"

    def _get() -> list[str]:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return [m.get("id", "") for m in (data.get("data") or []) if m.get("id")]

    try:
        return await asyncio.to_thread(_get), ""
    except Exception as e:  # noqa: BLE001
        return [], str(e)


async def test_llm_connection(
    provider: str,
    vllm_url: str = "",
    openai_base_url: str = "",
    api_key: str = "",
    model: str = "",
) -> tuple[bool, str]:
    """설정 패널 연결 테스트 (dev_agent_client 방식) — 서버 망에서 프로바이더 검증.

    Returns:
        (ok, message).
    """
    p = (provider or "").lower()

    if p == "vllm":
        models, error = await fetch_vllm_models(vllm_url)
        if error:
            return False, f"vLLM 연결 실패: {error}"
        if not models:
            return False, "vLLM 응답에 모델이 없습니다 (/v1/models 비어 있음)"
        if model and model not in models:
            return False, f"모델 '{model}' 미서빙. 사용 가능: {', '.join(models[:5])}"
        return True, f"vLLM 연결 OK — 서빙 모델: {', '.join(models[:5])}"

    if p == "openai":
        base = (openai_base_url or "https://api.openai.com/v1").rstrip("/")
        url = f"{base}/models"

        def _get() -> None:
            req = urllib.request.Request(
                url,
                headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                json.loads(resp.read().decode("utf-8"))

        try:
            await asyncio.to_thread(_get)
            return True, "OpenAI 호환 엔드포인트 연결 OK (/models 200)"
        except Exception as e:  # noqa: BLE001
            return False, f"OpenAI 연결 실패: {e}"

    return False, f"지원하지 않는 provider: {provider}"
