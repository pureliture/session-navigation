# session-navigation Spec (locked 2026-11-08)

User-locked decisions D1–D10. Implementation contracts below are binding.

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

## D4. manage_context defaults

- `action=auto` (model summary when summarizer configured, else rule hide),
  `max_items=20`, candidates = all recorded results of the confirmed snapshot.
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

## D10. UI order — Paseo → OMP TUI → Hermes TUI

- Paseo Explorer panel first (row-unit verification platform).
- Hermes needs widget-bridge host changes (verified); last.

## Outline rows — message units (Palantir parity)

- Row = one message: user / assistant / tool-call / tool-result(sub-row of call).
- Token per row per D2. No turn grouping as identity unit.
- Tool hide is pair-atomic (call+result together); application is
  envelope-preserving text replacement, never deletion (deletion vs placeholder
  provider acceptance unverified).

## Identity contracts (enforced in SQLite phase)

- Item key: `(scope_key, tool_call_id, content_sha256, invocation_digest)` —
  never content-hash alone (Hermes `_call_id_for_plan` mis-substitution reproduced).
- OMP identity fence must be durable (restart reproduced patches 1→0 with
  memory-only identities).
- `message_uid`-based `msg_`/`pair_` namespaces for message units (separate
  from `item_` prefix).
- Concurrent writers: version CAS; stale writer rejected, UI refreshes.

## Migration

- No memory→SQLite import. Fresh start; host histories preserved.
