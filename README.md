# session-navigation

호스트 중립적인 도구 결과 숨김/요약/복원(Context Compaction) 공통 엔진.

## SQLite 상태 저장
- 기본 경로: `~/.local/share/session-navigation/state.sqlite3`
- `XDG_DATA_HOME` 설정 시: `$XDG_DATA_HOME/session-navigation/state.sqlite3`
- 명시적 경로: `SESSION_NAVIGATION_STATE_PATH` 환경 변수 또는 생성자 인자로 override (테스트는 tmp 경로 사용).
- WAL 모드는 SQLite >= 3.51.3 (또는 3.44.6/3.50.7)에서만 활성화되며, 그 외에는 rollback journal을 사용합니다. `busy_timeout=5000`.

## 지원 도구 범위
- OMP 확장은 `read`와 `bash` 도구 결과를 수집/숨김 대상으로 다룹니다.
- bash 명령은 D8 denylist(`rm`, `git reset --hard` 등)에 해당하면 자동 관리에서 제외되며 수동 숨김은 허용됩니다.

## 세션 모델 요약 (D5)
- OMP는 확장 측 `completeSimple` + `ctx.modelRegistry.resolver`를 사용해 대상 텍스트만 요약합니다.
- 데몬에 `SESSION_NAVIGATION_*` 로컬 모델 설정은 없습니다. 세션 모델이 없으면 `summarize_context`는 `summarizer_unavailable`을 반환합니다.

## 반복적인 작업 단위 정리
- OMP/Hermes 에이전트는 작업 단위를 끝낼 때마다 이후 작업에 필요 없는 해당 작업의 결과를 판단해 `manage_context({tool_call_ids: [...], action: "hide"})`로 정리합니다. 세션 전체를 한 번에 요약하는 기능이 아닙니다.
- 비어 있지 않은 ID 목록은 필수이며 개수 상한은 없습니다. `hide`는 규칙 기반, `summarize`는 세션 모델 요약, 기본 `auto`는 모델 요약 우선·규칙 대체입니다. OMP 모델 호출은 최대 4개 동시 실행합니다. 이미 숨겼거나 부적격인 결과는 모델 호출 전에 제외합니다.
- `list_context_items({view: "candidates", limit: 30})`는 보이는 적격 결과를 최신순으로 보여주며 도구 호출 ID, 도구명, 명령/경로 힌트, 바이트 크기를 제공합니다. 현재 호스트는 결과별 측정 토큰을 제공하지 않아 바이트로 표시합니다. 목록은 발견용이며 목록에 없는 적격 ID도 정리할 수 있습니다.

## DB 오류 처리 (D9)
- 대화형: abort-request 또는 send-original 중 선택.
- 비대화형(pipe/background): abort. 원본을 조용히 전송하지 않습니다.
- DB 실패는 숨김 성공이 아닌 실패로 보고됩니다.

## 개발 및 테스트
```bash
uv sync --dev
uv run pytest tests/test_omp_daemon.py tests/test_omp_sqlite_e2e.py
uv build
```