# session-navigation Spec (locked 2026-11-08)

User-locked decisions D1–D10. Implementation contracts below are binding.

## Overall goal (locked)

> session-navigation 전체 목표: tool-result의 hide·unhide·rehide·manage가 SQLite
> 영속화로 프로세스 재시작과 세션 fork 이후에도 유지되고, Hermes terminal·OMP
> read·bash 포함 자동관리와 Paseo Explorer·OMP TUI·Hermes TUI 3개 UI에서의 동일
> 조작을 제공하며, E2E(재시작·fork·DB오류·비대화형·3UI 동시조작·대용량)와 전체 회귀
> green(기저 결함 수정 포함)을 통과한다. 범위 밖: 메시지 row 수동숨김,
> remove(영구삭제), 설치본 배포, 운영 런북. 성능: 목록 1000건 <1s, 요약 timeout 25s,
> DB 용량 상한 없음.

## D1. No remove — hide/unhide only

- `hide_context`, `summarize_context`, `unhide_context`, `list_context_items`, `manage_context`.
- Hide = summary replaces body in **outgoing request copy only**; host history immutable.
- No permanent delete. Palantir's "remove completely" is out of scope.

## D2. Row tokens — observatory method, no estimation

Three paths kept separate (agent-observatory design):

1. **Session totals**: provider log call ledger, session-ID join, call-unit dedupe
   (message/response-ID key), then sum. OMP: JSONL `message.usage`. Hermes: `ctx.llm` response usage.
2. **Row tokens**: distribute the call's measured usage to that turn's rows by
   character count. Measured distribution, not estimation. Source label: "실측 배분".
3. **Missing data**: display `—`, never 0. Never sum `lastUsage` snapshots together.
4. Costs: show `lastUsage.totalCostUsd` only; never self-estimate.
5. Quota windows (`listUsage`) are a separate UI concern; never used for row tokens.

## D3. System prompt row — not shown

- No system-prompt row in outline (Palantir parity dropped for system).

## D4. manage_context: repeated, agent-scoped cleanup

- After completing a unit of work, the agent judges which results from that work
  later steps will not need and supplies their `tool_call_ids`. Repeat throughout
  the session, not as a one-shot whole-session summary.
- Non-empty IDs are required (`tool_call_ids_required`); there is no per-call ID
  cap or deterministic subtask/time boundary. No implicit all-results fallback.
- `action=auto` prefers session-model summaries with rule fallback; `hide` is
  rule-only and `summarize` requires the session model. Hidden/ineligible IDs are
  skipped before model invocation. OMP uses four model workers and batches IPC
  internally; Hermes processes chosen IDs sequentially.
- `list_context_items(view=candidates, limit=30)` discovers visible eligible
  results newest first, with ID, tool, command/path hint, and byte size (hosts
  currently provide no measured per-result tokens). Limit is 1–200 for discovery
  only: any eligible confirmed/transmitted ID can be managed without listing it.
- Returns per-item results; partial failure never reports full success.

## D5. Summarizer — session model only

- OMP: extension-side `completeSimple` + `ctx.modelRegistry.resolver` (target text only).
- Hermes: `ctx.llm` path.
- REMOVE: daemon `SESSION_NAVIGATION_*` local-model settings, Hermes
  `summary_mode/base_url/model` config, `_make_configured_summarizer` wiring.
- `summarize_context` without session model → `summarizer_unavailable`.

## D6. list_context_items shows hidden + unhidden

- Status column distinguishes; unhidden rows are re-hide targets.

## D7. Single SQLite file

- Path: `~/.local/share/session-navigation/state.sqlite3` (XDG data, host-local).
- Profile isolation via `scope_key`, not separate files. No cross-machine sync.
- WAL mode only on SQLite ≥ 3.51.3 (or backported 3.44.6/3.50.7); else rollback journal.
- No TTL expiry, no capacity cap on live hidden items. Disk-full → fail with
  explicit error, never silent evict.

## D8. Destructive-command denylist

- `rm`, `git reset --hard`, and equivalents: excluded from auto-manage,
  manual hide only. Implemented in `policy.py` (command-based gate, in addition
  to existing content-based protection).

## D9. DB error handling — user choice, non-interactive aborts

- Interactive: user picks abort-request or send-original.
- Non-interactive (pipe/background): abort. Never silently send originals.
- DB failure is reported as failure, never as hide success. Model request
  fail-open (original preserved) is separate from persistence failure reporting.
- Hermes `llm_request` middleware exception (verified 2026-11-08, user decision):
  the host swallows middleware exceptions and proceeds with the original
  (`hermes_cli/plugins_dispatch.py` delivery contract); no abort hook exists.
  Middleware DB failure is therefore loud-report (error log + `db_error_pending`
  surfaced in list output + trace reason), not request abort. Tool paths
  still return `db_error` + choices.

## D10. UI order — Paseo → OMP TUI → Hermes TUI

- Paseo Explorer panel first (row-unit verification platform).
- Panel location (verified 2026-11-08, user requirement): Paseo 패널은 우측 워크스페이스 탭 영역(파일/변경사항 옆, Explorer 영역, AI FDE / sidechat 스타일)에 렌더링되어야 하며, `addAgentPanel` + `locations: ["explorer"]` (context: `"agent"`)로 등록하고 ⌘K (`open-session-nav`) 및 `/nav` 슬래시 커맨드로 `openPanel("session-nav", { location: "explorer" })`를 호출해 연다. 좌측 사이드바 항목(`addSidebarHeaderItem`/`addSidebarItem`)이나 전체 화면(`addScreen`)으로 등록해서는 안 된다 (`+` 탭 메뉴는 플러그인 패널 탐색 경로가 아님).
- Panel session binding (verified 2026-11-09, user requirement):
  - 우측 사이드 패널은 활성화된 에이전트(`agentId`)의 세션 스코프와만 1:1로 직접 바인딩된다.
  - 임의의 다른 세션을 고르는 드롭다운/모달(스코프 피커)을 두지 않으며, 세션이 없는 곳에서는 `No active session` 빈 화면을 표시한다.
  - Palantir AI FDE 스타일의 단일 연속 스크롤 목록으로 세션 전체 타임라인(User 질문/프롬프트 ◈, Assistant 모델 답변 ✦, Tool 도구 실행 결과 ◇)을 시간순으로 연속 렌더링한다.
  - 도구 결과 숨김(`Hide`) 시 행은 목록에서 사라지지 않고 그대로 유지되며, 취소선(`line-through`), 낮은 투명도, `[hidden · v{version}]` 뱃지 및 `Unhide` 버튼으로 전환된다. 사용자의 명시적 `Hide` 명령은 정책 거절(`sensitive_invocation`, `not_long`, `protected_error`) 없이 즉시 `hidden` 상태로 저장된다.
  - 하단 진행률 게이지 바는 모델의 실제 컨텍스트 윈도우(128k 토큰 ~ 512KB) 스케일 기준으로 활성 비율과 절감량을 시각화한다.
- Hermes TUI = `/nav` text command (verified 2026-11-08, user decision):
  list/hide/unhide/rehide/summarize/manage via `register_command` +
  `slash.exec`; no host changes required. The graphic widget bridge
  (widget↔gateway) needs host changes that cannot land on main and would
  be overwritten by updates; deferred.

## Outline rows (deferred 2026-11-08, user decision)

In-scope rows = tool-result units only (`item_` / `pair_`). The message-unit
outline (user / assistant / tool-call `msg_` rows) is deferred.
`message_unit_id()` / the `msg_` namespace and `units.message_uid` remain
reserved, unwired; production `units` rows are `pair_` tool-result rows only
(the schema permits other kinds for forward-compat; tests may seed them).
Per-message token attribution (D2.2 to message rows) is deferred with the
outline; tool-result rows show `—` until D2.2 is wired to them. D2.1 session
totals are unaffected.
- No turn grouping as identity unit.
- Tool hide is pair-atomic (call+result together); application is
  envelope-preserving text replacement, never deletion (deletion vs placeholder
  provider acceptance unverified).

## Identity contracts (enforced in SQLite phase)

- Item key: `(scope_key, tool_call_id, content_sha256, invocation_digest)` —
  never content-hash alone (Hermes `_call_id_for_plan` mis-substitution reproduced).
- OMP identity fence must be durable (restart reproduced patches 1→0 with
  memory-only identities).
- `pair_` namespace for tool call+result units (separate from `item_` prefix).
  `msg_` namespace reserved, deferred per Outline rows above.
- Concurrent writers: version CAS; stale writer rejected, UI refreshes.

## Migration

- No memory→SQLite import. Fresh start; host histories preserved.
