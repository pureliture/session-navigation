# A/B 실행기

본 평가 모델: `z-ai/glm-5.3-flash` 하나. `results/setup-glm/` 및 `results/smoke/`는 설치 점검으로 본 통계에 포함하지 않는다.

```bash
python3 eval/fixtures/build.py
python3 -m unittest discover -s eval/tests -v
# OPENROUTER_API_KEY는 이미 환경에 있어야 한다. 명령행·파일에 key를 넣지 않는다.
python3 eval/probe.py
python3 eval/run.py --output eval/results/YYYY-MM-DD
python3 eval/analyze.py eval/results/YYYY-MM-DD
```

`--hosts omp,hermes`, `--cases 03-logs,05-protected`, `--arms A,B`, `--repetitions 3`, `--label retry-`로 범위를 지정한다.
완료 status가 있는 세션은 재실행하지 않는다. 중단된 작업공간은 덮어쓰지 않으며 새 label로 별도 실행한다.
기존 결과의 실패를 삭제하고 성공으로 교체하지 않는다.
작업공간은 `~/.session-navigation-eval/`에 남고, 정답은 에이전트에 전달하지 않는다.

필수: Python 3.11+, Bun, 저장소 `.venv/bin/session-navigation-daemon`, 설치된 OMP SDK 및 Hermes Python 환경.
`OMP_PACKAGE`, `HERMES_SOURCE`, `HERMES_PYTHON`으로 호스트 위치를 바꿀 수 있다.
기본 OMP는 이 VM의 18.18.3이며 SDK 예제의 옛 `ModelRegistry.create` 대신 실제 생성자를 사용한다.
Hermes는 소스 `109fd81`의 `AIAgent.run_conversation`와 실제 plugin discovery를 사용한다.
B는 `plugins.enabled`와 내부 `settings.enabled`를 모두 켜며 5개 도구/1개 middleware 로드를 assert한다.
Hermes의 progressive tool discovery는 호스트 기본값이며 B에만 직접 도구 노출을 강제하지 않는다.
GLM endpoint는 reasoning이 필수이므로 Hermes에서 reasoning을 끄지 않는다.

실제 설정을 바꾸지 않고 격리 HOME을 사용한다. 원래 설정은 hash를 전후 대조한다.
자식 프로세스에는 OS 실행에 필요한 환경만 전달하고 실제 API key를 전달하지 않는다.
loopback proxy만 key를 환경에서 읽으며 다른 model selector는 upstream으로 보내지 않는다.
클라이언트 요청과 실제 upstream 요청(`usage.include=true`, `stream=false`), 응답/usage, 재시도를 압축 JSONL로 캡처한다.
스트리밍 호스트에는 완성 응답을 SSE로 변환하므로 스트리밍 지연 자체를 평가하지 않는다.
proxy가 429/5xx를 2·4·8·16·32·64초(또는 Retry-After, 최대 120초) 간격으로 재시도하며 실패도 기록한다.
요약은 제품의 25초 예산을 그대로 사용하므로 긴 backoff에서는 fallback/실패가 가능하다.

설계/평가 한계는 [design](../docs/evaluation/design.md), 수치는 [results](../docs/evaluation/results.md)를 참고한다.
