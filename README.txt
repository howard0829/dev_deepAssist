DeepAssist — 실행 방식
======================

DeepAssist는 원격 Ubuntu 서버에서 동작하고, 클라이언트는 Windows 또는 Linux의
VSCode 확장이다. vLLM과 LiteLLM은 이 리포 밖에서 "따로" 실행하며, DeepAssist는
.env 의 ANTHROPIC_BASE_URL 로 그 LiteLLM 에 접속한다.
(설계/아키텍처 상세는 docs/design/architecture.md, CLAUDE.md 참고)


[서버 실행]

0) 의존성 설치
     pip install -r requirements.txt

1) (외부) vLLM 실행 — 모델 서빙, OpenAI 호환, 포트 8080
     예) python -m vllm.entrypoints.openai.api_server \
           --model <모델경로/ID> --served-model-name minimax-m2.5 --port 8080
     DeepAssist 는 서빙 모델명을 VLLM_BASE_URL/v1/models 로 읽는다.

2) (외부) LiteLLM 실행 — Anthropic /v1/messages 를 vLLM/OpenAI 로 변환, 포트 4000
     이 리포는 LiteLLM 설정/기동을 관리하지 않는다. 직접 실행하고,
     아래 .env 의 ANTHROPIC_BASE_URL 이 그 주소를 가리키게 한다.

3) .env 설정
     cp .env.sample .env
       - ANTHROPIC_BASE_URL : 따로 실행한 LiteLLM 접속 URL (예: http://localhost:4000)
       - LITELLM_MASTER_KEY : LiteLLM 인증 토큰 (= Agent SDK 토큰)
       - DEEPASSIST_MODEL   : 외부 LiteLLM 의 model_name (기본 deepassist)
       - VLLM_BASE_URL      : vLLM 주소 (모델명 조회용, 기본 http://localhost:8080)

4) DeepAssist 실행 — 포트 8000
     ./start.sh                 (DeepAssist 만 기동)
     또는  python -m deepassist.main
     상태 확인:  curl http://localhost:8000/api/health


[클라이언트(VSCode 확장) 설치]

1) vsix 빌드 (Node 20+)
     ./build_client.sh          ->  deepassist-vscode/*.vsix

2) 설치
     code --install-extension deepassist-vscode/<파일>.vsix

3) VSCode 설정
     gtas.serverUrl = ws://<서버-IP>:8000      (localhost 아님, 서버 IP)


[참고]
- 서버는 클라이언트 워크스페이스를 직접 만지지 않는다.
  파일/셸 도구는 확장이 사용자 워크스페이스에서 native 실행(위임)한다.
- localhost/127.0.0.1 표기는 모두 서버 호스트 기준이다.
