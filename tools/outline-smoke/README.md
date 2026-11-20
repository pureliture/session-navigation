# Outline Smoke Sandbox

## 샌드박스 시드 (`seed.py`)

스모크 하네스([`run.py`](run.py))가 기대하는 격리 Paseo 데몬과 읽기 전용 스냅샷 DB 환경을 구성·검증합니다. 실DB(`~/.hermes/profiles/atlas/state.db`), `~/.paseo`, 실행 중인 Hermes gateway에는 쓰기 작업을 수행하지 않습니다.

### 실행 방법

```bash
python3 tools/outline-smoke/seed.py --root /tmp/paseo-sandbox
```

- `--root`: 샌드박스 루트 경로(기본값: `/tmp/paseo-sandbox`).
- `--reset`: 기존 샌드박스 데몬(`$ROOT/home`)을 중지한 뒤 `$ROOT/home`, `$ROOT/fakehome/.omp`, `$ROOT/fakehome/.hermes/profiles/default`를 정리하고 처음부터 다시 시드합니다.
- 멱등 실행: `--reset` 없이 재실행하면 기존 시드 DB(`sessions=1`, `messages=1089`)와 실행 중인 데몬을 재사용하고, 데몬이 꺼져 있으면 기동한 뒤 검증 게이트를 통과해야 URL을 출력합니다.

### 구성 단계

1. **`fakehome` OMP 세션 복사**: 실세션 JSONL(`~/.omp/agent/sessions/-Projects/2026-11-15T01-37-28-038Z_01a1dcda-2be6-71ff-adad-5dd591ed6d51.jsonl`)을 `$ROOT/fakehome/.omp/agent/sessions/-Projects/`로 복사합니다.
2. **Hermes DB 읽기 전용 스냅샷 및 프루닝**: `~/.hermes/profiles/atlas/state.db`를 `file:...?mode=ro`로 열어 `$ROOT/fakehome/.hermes/profiles/default/state.db`로 `VACUUM INTO` 복사한 뒤 대상 세션(`local-19b60bfd28c6c4fb469bd8ad331ff646dfec6c3e9ebd3ed3f1e2419e0ca59826`)만 남기고 정리합니다.
   - 삭제 순서: `worker_receipts`, `worker_executions`, `session_admissions` → `session_model_usage` → `messages` → `sessions`(`sessions_runtime_ledger_delete_guard` 트리거 우회) → `messages_fts` / `messages_fts_trigram` rebuild → `VACUUM`.
   - `~/.hermes/profiles/default/profile.yaml`을 `$ROOT/fakehome/.hermes/profiles/default/`로 복사하고, `.env`는 실제 파일을 복사하지 않고 합성 샌드박스 내용으로 생성합니다(권한 `0600`, 시크릿 없음).
3. **샌드박스 Paseo 설정(`$ROOT/home/config.json`)**: `daemon.listen`=`127.0.0.1:17680`(루프백 전용), `pluginsEnabled=true`, `plugins.paseo-plugin`(저장소의 `paseo-plugin/` 디렉터리), `agents.providers.omp`/`hermes`/`hermes-default`(`extends: "acp"`, `label` 포함)를 기록합니다.
4. **에이전트 및 워크스페이스 레코드**: `$ROOT/home/agents/Users-<user>-Projects/`에 OMP 클론(`5c4bc793-eb5d-40c4-9dc2-1fe5f3f4ff4f`, `nativeHandle`은 샌드박스 JSONL 경로로 치환, `runtimeInfo.provider="omp"`)과 Hermes 신규 레코드(`7b2e4a11-9c3d-4e5f-8a6b-1d2f3a4b5c6d`, `provider="hermes-default"`, `model="opencode-go:beam-free"`, `thinking="max"`, `persistence.metadata.profile="default"`, `workspaceId="wks_6e914dd0930622d7"`)를 생성하고, `projects/projects.json`·`projects/workspaces.json`에 각 `workspaceId`를 등록합니다.
5. **격리 데몬 기동**: `HOME=$ROOT/fakehome`, `PASEO_HOME=$ROOT/home`, `PASEO_WEB_UI_ENABLED=true`, `SESSION_NAVIGATION_STATE_PATH=$ROOT/home/nav-state/state.sqlite3` 환경으로 `paseo daemon run --home $ROOT/home`을 백그라운드 기동하고, 로그의 `Agent registry loaded`·`Server listening` 및 `/api/health`와 `paseo agent ls -a --home $ROOT/home --json` 2건 노출을 확인합니다.
6. **검증 게이트 (`ServiceClient`)**: `paseo-plugin/server/client.ts`의 `ServiceClient`로 `scopes`(`hermes:default:local-19b60bfd28c6c4fb469bd8ad331ff646dfec6c3e9ebd3ed3f1e2419e0ca59826:unknown` ↔ `7b2e4a11-...`, `omp:default:01a1dcda-2be6-71ff-adad-5dd591ed6d51:default` ↔ `5c4bc793-...`)와 `list(limit=150)`(`items=150`, `has_older=true`, `totals.total_rows=755`)을 통과한 경우에만 `PASEO_WEB_UI_URL`, `PASEO_WORKSPACE_URL`, `PASEO_SERVER_ID`, `AGENTS` 및 JSON 요약을 stdout으로 출력합니다.

### 주의사항

- `fakehome`에 `$HOME/.hermes` 전체 런타임(가상환경/툴)을 복제하지 않으므로 `HOME=$ROOT/fakehome hermes -p default acp --help`는 `no dependency environment is committed for this install; run hermes pm repair`로 종료할 수 있습니다(스모크 시드·`ServiceClient`·정적 히스토리 조회에는 불필요).
- `--reset` 없이 재실행 시 기존 실행 중인 샌드박스 데몬이 유지됩니다.
- CDP 포트 `19322`를 사용하는 작업은 한 번에 하나만 실행하세요. 실데몬 스모크는 기존 페이지를 사용하고 샌드박스 스모크는 저장소가 분리된 Chrome browser context를 사용합니다.

### 하네스 실행

```sh
uv run --with websockets tools/outline-smoke/run.py --url http://127.0.0.1:17680/ --out /tmp/outline-smoke --scenario all
```

각 시나리오의 판정과 수치는 `results.json`, 화면은 `<시나리오>.png`에 저장됩니다. `--server-id`, `--hermes-workspace`, `--omp-workspace`, `--hermes-agent`, `--omp-agent`, `--paseo-home`으로 시드 대상을 지정할 수 있습니다.
