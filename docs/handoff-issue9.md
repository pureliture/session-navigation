# Issue 9: 공통 코어 작업 인계

> Live follow-up: Step 1 fixed the recorded Node/Python failures; Step 2 verified
> the packed Paseo/OMP integration. Step 3 verified Hermes ACP mutations, resume,
> native fork/import, in-place compression, shared-DB writers, and one real
> session-model summary per host. See [Phase 6 live evidence](phase6-live-verification.md)
> for observed behavior and remaining limits. The original snapshot below is historical.

## 현재 상태와 시작점

- 저장소: `/Users/devin/repos/session-navigation`
- 인계 브랜치: `devin/1794316415-issue9-common-core`
- 기반 HEAD: `420f78cb0c61dc1d076b829507867981f41a5347`
- Phase 5 WIP: `1929ed496f770efd07e6ea440151c888d167a866`
- **Phase 5는 완료가 아니다.** 중단 요청에 따라 구현을 그대로 커밋했다.
  테스트 실패를 고치지 않고 인계한다. 실제 Paseo smoke는 아직 실행하지 않았다.
- 이 문서는 별도 후속 커밋이다. 브랜치는 위 기반까지의 승인된 커밋을 모두 포함한다.
- 제품 목표: 원본 보존, outgoing request 복사본만 변경, 결정론적 rule Hide,
  session LLM Summarize, 도구 재실행 없는 Unhide. 정리 대상/시점은 에이전트가 선택한다.
  작업 답변을 먼저 끝내고 필요하면 한 번에 정리한다. 정리 뒤에도 완전한 답을 다시 제공한다.
  모든 model-facing 텍스트는 영어다.

## Phase 0–8 계획과 상태

| 단계 | 상태 | 내용 / 근거 |
| --- | --- | --- |
| 0 | 완료; 추가 probe 필요 | 실제 host feasibility gate 4개 통과. Node 22.13 및 subagent probe는 미완료 |
| 1 | 완료 | `8c20187`: contract, Python schema/protocol migration, DELETE 정책, Hermes registry/targets/pending summary |
| 2–3 | 완료 | `e26ed8e`, readability 후속 `56c43af`: shared TS core, Node/Bun drivers, differential/cross-writer harness |
| 4 | 완료 | `420f78c`: OMP Bun Worker service, npm-style package, projection/tools/TUI, packed real-OMP test, subagent inert gate |
| 5 | 진행 중, WIP | Paseo Node Worker 통합, history/list/mutations, DB scopes, capabilities, UI gates. 아래 잔여 작업/실패 참조 |
| 6 | 미시작 | Hermes 남은 live ACP mapping/Hide, resume/fork/compression identity 검증. Phase 1의 synthetic 테스트와 구분 |
| 7 | 진행 중 | core conformance/cross-writer 및 packed OMP는 통과. 최종 integration/race/failure matrix와 real-Paseo smoke는 미완료 |
| 8 | 진행 중, 일부 앞당김 | CLI/daemon 삭제와 문서 변경을 Phase 5 요청으로 WIP에 포함. Python 잔여 의존성, migration 안내, 최종 검증 미완료 |

## Phase 0에서 확인한 사실

원시 근거와 throwaway 코드는 **저장소 밖** `/Users/devin/nav-phase0-gates/`에 있다.

1. Bun 기본 SQLite 정수 읽기는 `9007199254740993`을 `9007199254740992`로 조용히 반올림했다.
   Bun driver는 `safeIntegers`, Node driver는 `setReadBigInts(true)`와 안전한 정수 정규화가 필요하다.
2. 측정한 Bun SQLite는 **3.51.0**, WAL safety gate보다 낮다. 공통 DB 기본 journal은 **DELETE**다.
   기존 WAL은 안전하게 변환하거나 해당 runtime의 쓰기를 명확히 거부해야 한다.
3. Hermes가 실제로 쓰는 scope suffix는 **`:unknown`**이다. `:default`는 discovery alias이고
   실제 저장된 scope가 우선한다. 기존 hidden state를 새 identity로 덮어쓰지 않는다.
4. 수동 복사한 legacy OMP extension과 npm package는 동시에 로드된다.
   새 shim/package의 중복 guard는 있지만 과거 Python-spawning 복사본은 별도로 제거해야 한다.
5. Paseo bundle evaluator에서는 일반적인 `import.meta.url` / `__dirname` 기반 worker 경로가 실패했다.
   별도 CJS bundle을 source로 내장하고 **`new Worker(src, { eval: true })`**로 실행한다.
   generated export도 Paseo의 `server/` module boundary 안에 있어야 한다.
   contribution은 Promise가 아닌 **동기 cleanup 함수**를 반환해야 한다.
6. 실제 fresh Hermes ACP 세션에서 Paseo persisted/runtime session ID, ACP response ID,
   middleware가 받은 session ID가 일치했다. **resume/fork/compression은 확인하지 않았다.**
7. configured Paseo provider ID와 `runtimeInfo.provider`는 다를 수 있다.
   custom provider ID는 예를 들어 `phase0-hermes`, runtime transport는 `acp`였다.
8. Python `sqlite3.executescript()`는 진행 중인 transaction을 먼저 commit한다.
   migration은 명시적으로 transaction을 소유하고 개별 statement를 실행한다.
9. **Node 22.13 자체는 테스트하지 않았다.** 실제 검증 runtime은 Node 24.21.0이다.
   API floor를 선언/검사한 것과 최소 버전 acceptance를 통과한 것은 다르다.

Phase 0 evidence 예: `logs/paseo-gate-final.log`, `logs/paseo-managed-layout.log`,
`logs/paseo-installed-final.json`, `logs/omp-gate.log`, `logs/hermes-identities.jsonl`.

## 확정한 설계 / 호환성 결정

- Paseo와 OMP는 **같은 TS core**를 사용한다. 각각 Node/Bun driver를 Worker에서 실행한다.
  neutral core는 두 runtime driver를 정적으로 import하지 않는다.
- **Hermes의 Python engine과 adapter는 유지한다.** 범위에는 **Paseo에서 Hermes Hide**도 포함된다.
  Hermes mutable originals는 `adapter_targets`에서 읽는다. 빈 replacement로 `items`를 seed하지 않는다.
- schema version `2`, engine protocol `1`, adapter protocol `1`.
  freshness는 참고 정보일 뿐 capability gate가 아니다.
- scope 목록은 DB `adapter_sessions`와 실제 저장 state에서 만든다.
  zero-item 등록 scope도 보인다. **`items: 1` placeholder는 사용하지 않는다.**
- display는 adapter 없이 가능하다. Hide/Summarize는 등록된 compatible/enabled adapter가
  해당 capability를 광고할 때만 가능하다. **기존 hidden item의 Unhide는 adapter 없이 허용한다.**
  이 제한은 UI뿐 아니라 single/batch/group/manage/fork mutation의 서버 경로에도 적용한다.
- 새 OMP scope는 `omp:<profile>:<session>:default`.
  Phase 4는 빈 목적지에만 legacy `pi:` state를 한 방향으로 import하며 원본 legacy rows는 남긴다.
  이후 양쪽 state를 동기화하지 않는다. Paseo는 등록된 `omp:`를 우선하고 legacy `pi:`는
  display/Unhide용으로만 사용한다.
- 지원 경로: **OMP는 Paseo built-in OMP RPC provider**, **Hermes는 custom ACP provider**.
  title/cwd/model argument/executable 이름으로 scope identity를 추정하지 않는다.
  4-part scope의 session은 `parts[2]`다.
- `session-navigation` CLI와 `session-navigation-daemon` entry point를 제거한다.
  `pyproject.toml` scripts, `src/session_navigation/cli.py`, vendor CLI mirror,
  `src/session_navigation_omp/`가 WIP에서 삭제됐다. Python engine/Hermes vendor mirror는 유지한다.
- 업그레이드 안내에 **`uv tool uninstall session-navigation`**를 포함해야 한다.
  더 이상 필요 없는 독립 CLI 설치를 제거하는 명령이다. **이 VM에서는 실행하지 않았다.**
  `.venv/bin/`와 `~/.local/bin/`에는 과거 CLI/daemon executable이 아직 남아 있다.
  파일이 남아 있다고 현재 source가 entry point를 제공한다고 판단하지 말 것.
- 기존 CLI의 자동 target scan과 달리 새 Paseo `manage`는 명시적인 `tool_call_ids`를 요구한다.
  의도적인 선택이며 자동 강제 정리를 금지하는 원칙을 따른다. API 호환성은 최종 리뷰해야 한다.

## Phase 5: 구현되어 있는 부분

아래는 **코드가 존재한다**는 뜻이며 production/real-host 검증 완료를 뜻하지 않는다.

### Server, Worker, packaging

- `paseo-plugin/server/history.ts`
  - `findSession`, `readHistory`, `loadTimeline`: OMP JSONL, wrapped/direct messages,
    boundaries/reminders, message IDs, read/bash eligibility, duplicate/error/display-only rows,
    1,000-record / 4 MiB mutation bounds와 전체 outline 유지.
  - `preview`, `summaryLine`, `messageKey`, `measuredTokens`: UTF-8 preview 제한,
    token allocation, mutation/compaction invalidation, model context-window lookup.
- `paseo-plugin/server/service.ts`: `PaseoService`
  - `handle`, `capabilities`, `resolveScope`, `scopes`, `timeline`, `list`.
  - `mutate`, `batch`, `manage`, `gate`, `failure`: Hide/Unhide, pending Summarize,
    message visibility, CAS, per-item commit/partial failure, fork, DB recovery choices.
  - Hermes published targets의 text hash / invocation / item identity 확인.
  - 원본 tool input preview를 저장된 filtered invocation으로 덮어쓰던 문제를 수정했다.
    async mutation rejection도 `handle`의 error response로 전달하도록 수정했다.
- `paseo-plugin/server/worker.ts`: Node driver를 lazy-open하고 request queue로 serialize한다.
- `paseo-plugin/server/client.ts`: `ServiceClient`, `runtimeSupported`.
  Embedded Worker, correlation, timeout, worker failure/shutdown, Node floor message가 있다.
- `paseo-plugin/build.ts`, `server/worker-source.ts`: esbuild CJS source를 base64로 내장한다.
  generated file은 **런타임 배포에 필요한 제품 artifact**이지 scratch/log가 아니다.
  core/service/worker 변경 후 반드시 `npm run build`로 다시 생성할 것.
- `server/sessionNav.ts`는 CLI wrapper 대신 Worker RPC adapter다. `invokeCli`/`execFileSync` 제거.
  `closeService`를 `index.server.ts`의 동기 cleanup에서 호출한다.

### Scopes, capabilities, UI

- `server/mapping.ts`의 `bindAgents`: persisted provider/session/profile metadata 및
  configured `extends: "acp"`를 사용해 DB scope와 agent를 연결한다. synthetic test만 통과했다.
- `shared/sessionNav.ts`: capability schemas, list/scope response fields,
  `manageItemsRpc`의 explicit `tool_call_ids` 등.
- `client/capabilities.ts`: `actionAllowed`, `capabilityNotice`.
  missing adapter/install hint, disabled/incompatible adapter, DB/runtime 오류 문구를 구분한다.
- `client/sessionNavPanel.tsx`: single/group mutation gates, scope capability fallback,
  notice를 추가했다. token footer 계산은 바꾸지 않는 방향이다.
  **화면을 실제로 렌더링하거나 시각 검증하지 않았다.**
- `package.json`, lockfile, `tsconfig.json`, manifest: build/test scripts, esbuild,
  Node >=22.13 metadata. Paseo 0.15.3의 `requirements`는 `paseo`만 지원하므로 Node floor는
  informational `engines`/설명과 server runtime guard로 표현했다. loader가 metadata를 강제하는 것은 아니다.

### Tests / Python 제거 / docs

- `server/service.test.ts`: Python CLI 행동 사양을 옮긴 19개 test.
  batches/CAS/partial failure, previews/empty/UTF-8, message visibility, long history,
  token allocation, registry/zero counts, target aliases, manage/fork/D9, readonly DB, mapping.
- `client/capabilities.test.ts`: helper-level capability/notice tests.
- `server/worker-lifecycle.node.ts`: real Node Worker lifecycle/responsiveness tests를 추가했으나
  **runner가 아직 시작조차 하지 못한다**. 아래 실패를 먼저 해결해야 한다.
- OMP의 `test/session-navigation-cleanup.test.ts`와 `session-navigation-3ui.test.ts`는
  제거된 CLI 호출 대신 TS core/Paseo service로 seed/검증한다. 현재 OMP 50 tests는 통과한다.
- Python `tests/test_cli_*.py`, daemon/pending/SQLite entry-point tests를 삭제했다.
  일부 `test_e2e_persistence.py` entry-point 의존 test와 `test_perf.py` daemon import도 제거했다.
  **잔여 import 때문에 Python suite가 현재 collection 단계에서 실패한다.**
- `tools/benchmark_omp_prepare.ts`도 Bun Worker 기반으로 옮겼지만 **benchmark는 실행하지 않았다**.
- `README.md`, `paseo-plugin/OVERVIEW.md`에 Node Worker/no-Python 설명을 반영했다.
  `docs/README.ko.md`에는 구형 설치 설명에 대한 경고를 추가했을 뿐 전체 번역을 갱신하지 않았다.

## 현재 테스트 결과: 성공/실패를 구분할 것

다음은 중단 직전/인계 시의 **현재 WIP** 결과다. 과거 Phase 4의 Python `414 passed`를
현재 성공으로 재사용하면 안 된다. 전체 suite를 green이라고 보고하지 말 것.

먼저 이 VM의 TS compiler는 Paseo package에만 설치되어 있어 core/OMP 단독 `npm run typecheck`는
처음에 `sh: tsc: command not found`였다. 환경을 한 번 다음과 같이 로드하고 재실행하니 통과했다.
source/config는 바꾸지 않았다.

```sh
export PATH="/Users/devin/repos/session-navigation/paseo-plugin/node_modules/.bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
```

| 위치 / 실제 command | 최신 결과 |
| --- | --- |
| `paseo-plugin`: `npm run build` | 성공: `Paseo embedded Node worker: built` |
| `paseo-plugin`: `npm run typecheck` | 성공: `tsc --noEmit`, exit 0 |
| `paseo-plugin`: `npm test` | **실패**. Bun `105 pass`, `0 fail`, `465 expect() calls`; 뒤이어 Node runner 1 fail |
| `packages/core`: `npm run typecheck && npm test && npm run test:bun` | 성공: Node `tests 17`, `pass 17`, `fail 0`; Bun `17 pass`, `0 fail` |
| `packages/omp`: `npm run typecheck && npm test` | 성공: `50 pass`, `0 fail`, `498 expect() calls`, 10 files |
| repo: `.venv/bin/python tools/core_conformance.py node bun` | 성공: 아래 4개 PASS |
| repo: `.venv/bin/python -m pytest -q` | **실패**: collection error 1개, tests 실행 전 중단 |
| real-Paseo loader + isolated home + OMP stub smoke | **미실행** |
| UI visual check | **미실행** |
| `git diff --check` (WIP commit 직전) | **실패**: `tests/test_e2e_persistence.py:194: new blank line at EOF.` |

Conformance 출력:

```text
PASS differential Python vs TS+node: canonical, policy, summaries, mutations, replacements and final rows
PASS cross-writer Python -> TS+node -> Python and reverse
PASS differential Python vs TS+bun: canonical, policy, summaries, mutations, replacements and final rows
PASS cross-writer Python -> TS+bun -> Python and reverse
```

OMP suite에는 실제 packed-package 검증도 포함되어 통과했다:

```text
(pass) packed OMP package projects original, hidden and restored outgoing requests
50 pass
0 fail
```

### 현재 실패 1: Node lifecycle runner의 TypeScript 실행 방식

`npm test`의 후반 command:

```sh
node --experimental-strip-types --test server/worker-lifecycle.node.ts
```

```text
file:///Users/devin/repos/session-navigation/paseo-plugin/server/client.ts:18
  constructor(
    readonly home = homedir(),
             ^^^^^^^^^^^^^^^^
SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode
Node.js v24.21.0
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

이는 `ServiceClient`의 parameter-property를 strip-only runner가 처리하지 못한 것이다.
esbuild를 사용하는 실제 plugin 경로가 실패했다는 증거는 아니다. 다만 lifecycle assertions는
아직 실행되지 않았으므로 성공으로 간주할 수 없다. 다음 세션에서 명시적 fields로 바꾸거나
테스트용 transpilation 경로를 정하고, actual embedded Worker도 검증해야 한다.

### 현재 실패 2: Python에서 삭제한 daemon test helper를 아직 import함

```text
ERROR collecting tests/test_cleanup_improvements.py
tests/test_cleanup_improvements.py:12: in <module>
    from test_omp_daemon import Daemon, call, record
E   ModuleNotFoundError: No module named 'test_omp_daemon'
ERROR tests/test_cleanup_improvements.py
Interrupted: 1 error during collection
1 error in 0.27s
```

이 파일 전체를 지우면 안 된다. rule/keep-lines/English/reminder/Hermes regression도 들어 있다.
daemon 의존 test는 `test_daemon_hide_keep_lines_and_unlisted_targets`와
`test_batch_keep_lines_are_resolved_independently_for_each_target`(대략 162/183행)이다.
이를 TS service tests로 옮기거나 유용한 oracle이면 직접 engine 호출로 바꾸고 import를 제거한다.
그 뒤 전체 Python suite를 다시 실행해야 다른 실패 여부를 알 수 있다.

## 다음 세션의 우선 작업 / 알려진 위험

1. 위 Node runner와 Python collection 실패부터 해결한다. 요청받은 중단 이후에는 고치지 않았다.
2. `git diff --check` EOF whitespace와 아직 format하지 않은 OMP test/benchmark 변경을 검토한다.
   새 server/helper 소스는 Prettier 3.5.3으로 format했다. 기존 panel 전체를 재format하지는 않았다.
3. direct service tests가 actual RPC schema/plugin loader/relocation을 검증하는 것은 아니다.
   **real-Paseo smoke가 Phase 5의 필수 잔여 gate**다.
   isolated home + local stub + 실제 plugin loader에서 등록된 OMP session list → Hide → Unhide,
   adapter 없는 별도 session의 Hide 거부/disabled capability를 보여야 한다.
4. server gate의 single/batch/group/manage/fork 경로와 capability 제한, 원본 preview 복구,
   zero counts, aliases, incompatible/disabled adapter, DB/runtime 오류를 최종 리뷰한다.
   token footer와 provider metadata mapping은 실제 host에서 별도로 확인해야 한다.
5. worker lifecycle/timeout/crash/malformed response/shutdown/responsiveness assertions는 아직 미실행이다.
   재생성된 `worker-source.ts`와 source 동기화를 유지한다. standalone import와 Paseo loader 동작을 혼동하지 말 것.
6. Python CLI의 세부 float/Unicode/YAML parsing 및 token allocation edge parity는 추가 리뷰가 필요하다.
   이미 통과한 대표 CLI fixtures만으로 모든 입력이 동등하다고 단정하지 않는다.
7. Hermes `adapter_targets` 경로는 synthetic test만 있다. live Hide-from-Paseo 및 pending session-model
   summary settlement, fresh/resume/fork/compression scope 연속성과 concurrent Unhide 우선권을 검증한다.
8. scope counts와 legacy alias/one-way import, multi-writer/race, packed-plugin 설치를 통합 검증한다.
   기존 core conformance와 packed OMP 성공을 최종 Paseo race 성공으로 확대 해석하지 않는다.
9. entry-point 삭제를 마무리하고 `uv tool uninstall` migration 설명과 Korean guide를 갱신한다.
   Hermes가 필요한 Python engine 및 source/vendor mirror는 보존한다.
10. 모든 필수 검사 green 후 Phase 5 완료 커밋을 별도로 만들고 결과를 보고한다.
    WIP 커밋을 release-ready로 취급하지 않는다. push는 인계 브랜치에만 요청받았다.

## Subagent 요구사항 / Phase 0에 추가할 probe

아직 구현하지 않은 확장 범위다. 예상 **6–10시간**이며 아래 관찰/제약을 먼저 확인한다.

- 목표: 가능하면 **subagent별 outline + Hide/Unhide**.
- 불가능할 때 fallback: main session outline을 보여주고
  **`subagent context is not managed`**라고 명시한다.
  row click은 `navigation.openAgent`로 main agent를 연 뒤 해당 row로 scroll한다.
- OpenCode Go 같은 미지원 provider는 display-only. mutable이라고 광고하지 않는다.
- 현재 `client/sessionNavPanel.tsx`의 `setInView(!!id)` 부근은 subagent tab에서 panel을
  비우는 동작일 가능성이 있다. **관찰/검증하지 않은 가설**이다. 원래 약 165–188행이나 WIP로 행이 달라졌다.
- Paseo에는 구별할 두 형태가 있다:
  (a) `PluginAgentSnapshot.parentAgentId`로 연결되는 실제 agent,
  (b) 현재 client SDK에 노출되지 않는 `ProviderSubagentStore` 내부 subagent.
  두 종류를 같은 `params.agentId` identity로 가정하지 않는다. 이 구분의 실제 tab 경로도 probe한다.
- 이미 구현된 OMP 중앙 gate: `packages/omp/src/extension.ts`의 `session_start`에서
  **`ctx.agent?.kind === "sub"`면 완전 inert**. tools/hooks/rewrites/reminders/worker/DB writes가 없다.
  depth-zero clones/advisors를 포함한 synthetic test는 통과했다. live spawned subagent는 아직 검증하지 않았다.
- Hermes isolation은 synthetic test만 있다. 실제 delegation hook 및 scope ID 연결은 미검증이다.
- `manage_context`는 기본적으로 subagent에 노출하지 않는다.
- 추가 probe 목록:
  1. 실제 subagent tab kind, `params.agentId`, `parentAgentId`, main으로 navigation 가능 여부.
  2. OMP `ctx.agent` id/parentId/depth와 subagent session ID/JSONL의 실제 관계.
  3. persisted agent revive 후 동일 scope/parent linkage 연속성.
  4. Hermes delegation hook, child session ID 및 parent linkage, outgoing projection hook 실행 위치.
  5. 각 provider에서 request-copy rewrite와 capability registry가 실제로 도달 가능한지.

## 이 VM에만 있는 환경 / 재현 방법

### 설치된 runtime / 도구

| 항목 | 현재 VM |
| --- | --- |
| Node | `/opt/homebrew/bin/node`, `v24.21.0` |
| Bun | `/opt/homebrew/bin/bun`, `1.4.4` |
| Python tests | `/Users/devin/repos/session-navigation/.venv/bin/python`, Python `3.12.15`; symlink target `/opt/homebrew/opt/python@3.12/bin/python3.12` |
| system `python3` | `/usr/bin/python3`는 별도 구버전일 수 있음. 테스트에는 위 venv Python 사용 |
| Paseo | `/opt/homebrew/bin/paseo`, `0.15.3` |
| OMP | `/opt/homebrew/bin/omp`, `omp/18.18.3` |
| Hermes repo | `/Users/devin/repos/hermes-agent` |
| Prettier | `/Users/devin/nav-phase0-gates/format-tools/node_modules/.bin/prettier`, `3.5.3` |
| Ruff | `/Users/devin/.cache/uv/archive-v0/JzFGaSh09-JMT9Ri/bin/ruff`, `0.11.13` (cache 경로, 영구 의존성 아님) |
| TS compiler | `paseo-plugin/node_modules/.bin/tsc`; core/OMP에서는 위 PATH를 로드할 것 |

### Isolated homes / stub 원칙

- scratch root는 `/Users/devin/nav-phase0-gates/`이다. **어떤 파일도 저장소에 추가하지 않는다.**
  `/tmp` 대신 persistent home 아래를 써야 다음 session/VM snapshot에서 근거를 유지할 수 있다.
- Paseo: 별도 `HOME`, `PASEO_HOME=<isolated>`, `SESSION_NAVIGATION_STATE_PATH=<scratch DB>`를 지정한다.
  isolated `config.json`에서 loopback listen/free port와 relay disabled를 사용하고
  `paseo daemon run --home <isolated>` 또는 `paseo start --home <isolated>`로 실행한다.
  기본 `~/.paseo` config나 실행 중인 사용자 daemon은 건드리지 않는다.
- 실제 Paseo compiler/evaluator 근거 script: `paseo-probe.mjs`, `managed-layout.mjs`.
  host 내부 모듈 경로:
  `/opt/homebrew/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server/dist/server/server/plugins/`.
  `compileDirectoryPlugin`, `evaluateBundle`, `ManagedPluginSources.place`를 사용했다.
  **새 plugin의 RPC를 fake `{}` context로 evaluate하는 것만으로 smoke를 대체하지 말 것.**
  실제 daemon에 plugin을 설치하고 `DaemonClient.invokePluginRpc(pluginId, method, input)`를 호출할 수 있다.
  CLI의 `/opt/homebrew/lib/node_modules/@getpaseo/cli/dist/utils/client.js`에는
  `connectToDaemon({ target: { kind: "instance", home } })`가 있다. 버전 종속 경로다.
- OMP: 별도 `HOME`, `PI_CODING_AGENT_DIR=<home>/.omp/agent`, 동일한 state path를 사용한다.
  `bun pm pack` 후 isolated plugin directory에 Bun으로 archive를 설치한다.
  OMP 18.18.3 installer는 local tarball spec을 직접 받지 않아 Bun 설치를 사용했다.
  실제 예시는 `packages/omp/test/session-navigation.omp.test.ts`.
- stub은 `127.0.0.1`의 OpenAI-compatible SSE server, provider는 `pi.registerProvider`로 등록한다.
  `openai-completions`, local `baseUrl`, dummy `local-stub` key, `stub` model만 사용한다.
  model을 명시해 외부 paid provider로 fallback하지 않도록 한다.
- Hermes: 별도 `HERMES_HOME`/runtime directory에 plugin copy와 local stub config를 둔다.
  Paseo custom provider `extends: "acp"`가 `hermes-acp`를 실행한다.
  scratch `prepare-hermes.py`, `hermes-launch.py`, `identity-check.py`, `stub-server.ts`에 Phase 0 근거가 있다.
  gateway가 별도 process이므로 launcher-only monkeypatch로 middleware를 관찰할 수 없었다.
  env-gated debug는 scratch plugin copy에만 적용했으며 repo/Hermes core에 commit하지 않았다.
- Phase 0는 config 복원과 service 종료를 보고했다. Phase 5 WIP에서는 새 Paseo/Hermes daemon을 시작하지 않았다.
  재개 시 이 VM에 다른 작업의 process가 있을 수 있으므로 자기 isolated home/process만 정리한다.

### 최신 로그 위치 (커밋하지 않음)

- `/Users/devin/nav-phase0-gates/logs/paseo-phase5-final.log`: Bun 105 pass 후 Node runner 실패.
- `/Users/devin/nav-phase0-gates/logs/paseo-service-final.log`: service 19 pass.
- `/Users/devin/nav-phase0-gates/logs/issue9-omp-wip.log`: OMP 50 pass, packed smoke 포함.
- `/Users/devin/nav-phase0-gates/logs/issue9-python-wip.log`: Python collection error.
- core/conformance 최신 결과는 인계 세션 tool output에도 남아 있다. 이전 phase 로그와 혼동하지 말 것.

`.gitignore`는 `node_modules`, 일반 build/dist/cache 및 `docs/handoff-*.md`를 무시한다.
DB/log/tarball의 포괄적인 ignore rule은 없으므로 repository 안에 이런 artifact를 만들지 말 것.
이번 문서만 명시적 요청으로 `git add -f docs/handoff-issue9.md`로 추가한다.
scratch DB/log/tarball/node_modules/credentials를 stage하지 않는다.
