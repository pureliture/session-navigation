# Changelog

## 0.1.0 — release preparation

Publication and registry/catalog approval are separate steps; see
[the release checklist](docs/release/checklist.md).

### Distribution and migration

- Prepare public npm packages `@pureliture/session-navigation-omp` and
  `@pureliture/session-navigation-paseo`, both version 0.1.0.
- Prepare Paseo reviewed-registry slug `pureliture/session-navigation` and
  the Hermes `session-navigation` catalog entry, pinned to a reviewed full SHA
  with `subdir: hermes-plugin`.
- Retire the standalone Python CLI and OMP Python daemon. OMP and Paseo use
  the bundled TypeScript core and need no Python installation. Hermes keeps
  the Python engine and synchronized vendor mirror.
- Stop sessions, back up/preserve the SQLite state, remove the old manually
  copied OMP extension in each profile, install the new host packages, and
  fully restart hosts/gateways. Use `uv tool uninstall session-navigation`
  only to remove an existing legacy uv tool installation.
- Import preserved legacy `pi:` state into new `omp:` scopes once, without
  deleting or modifying the original legacy rows.
- Distribute Hermes from `hermes-plugin/`, containing only its loader, manifest,
  MIT LICENSE and unchanged vendored Python runtime. Preserve all detection
  strings; repository fixtures and TypeScript packages remain outside that unit.
  Canonical engine/adapter sources stay in `src/session_navigation/` and
  `adapters/hermes/`; `tools/sync_hermes_vendor.py` synchronizes both mirrors and
  `--check` supplies the parity gate. Direct Git installs must select the subdir.
- Include the plugin root's adjacent vendor tree in Python wheels so fresh
  wheel imports work. A wheel alone does not register a Hermes plugin.

### Summaries and safety

- Send the whole original tool result to Summarize, including facts beyond
  character 12,000. Enforce a **32,768-byte UTF-8 source cap** and return
  `input_too_large` rather than silently truncating the source.
- Explicit Summarize upgrades an existing rule Hide replacement to an
  accepted LLM summary. Reusing an accepted LLM summary is idempotent and
  makes no new model call.
- Retry factual-validation failures exactly once with English feedback
  identifying missing/altered facts or numbers. Count both calls in usage.
  Final failure returns an error and preserves an existing Hide replacement.
- Preserve CAS/version fences across retries, concurrent mutations and
  session changes. Unhide restores the original without a work-tool rerun.
- Return `keep_lines_too_broad` for a selection that cannot provide the
  required reduction; do not silently claim successful compaction.
- Validate comma-grouped numbers alongside other literal facts.
- Keep original host history and stored originals unchanged; apply all
  exclusions/replacements only to outgoing request copies.
- Harden Hermes Off toggling and multi-profile `config.yaml` updates in Paseo:
  - Record live `protection_only` and import-time `RUNTIME_BUNDLE_FINGERPRINT`
    markers in `adapter_sessions.capabilities`, fail closed in
    `_is_effectively_enabled` on `adapter_control` lookup errors, break the
    `.schemas`/`.handlers` import cycle, and enforce strict 5-tuple invocation,
    shifted-position `(call_id, content_sha256)`, exact-`visible` precedence,
    and `unknown`/`default` branch-alias fences in both `middleware_step` and
    `_protection_only_rewrite`.
  - Switch Hermes Off in Paseo Settings to DB-control-only (`adapter_control` +
    `adapter_sessions` updated in a single SQLite transaction while leaving
    `config.yaml` enabled so legacy/frozen Hermes processes never disable
    middleware protection), always report `protectionVerified: false` given
    durable `adapter_sessions` cannot enumerate live OS processes, and surface
    accurate reinstall/full-restart, `PluginContext.get_config`, and D9 SQLite
    fail-open guidance.
  - Linearize both Hermes On and Off toggles under a single fail-closed
    cooperative lock (`O_CREAT | O_EXCL`, verified on release by inode/nonce/PID
    without time-based stale reclamation, with explicit manual crash-recovery
    guidance) held through SQLite `setAdapterControl` and journal cleanup; protect
    multi-profile YAML writes with persisted crash-recovery journaling,
    symlink rejection, full-document `yaml` AST parsing/validation (preserving
    unrelated anchors/aliases, comments, flow maps, multiline scalars, and `...`
    end markers while propagating parse/validation errors to inspection and
    failing closed on duplicate keys, multi-doc streams, merge keys, or
    target-spine anchors/aliases, plus verifying semantic invariance of all
    unrelated keys), SHA-256 conflict
    SQLite failure, and non-rollback residual-journal reporting if post-commit
    journal cleanup fails (documenting OS limits against non-cooperative
    writers and mid-rename crashes).
- Tighten `protected_error` and `sensitive_invocation` matchers to same-line
  domain+state co-occurrence and credential-bearing keys/tokens so ordinary
  code, Korean prose, and CLI flags remain eligible, replace per-turn/50-75-90%
  reminder nagging with a post-tool phase-aligned >=32 KiB accumulation trigger
  (re-arming on cleanup or +100 KiB intra-turn growth, silent on user/chat turns,
  decoupled from context-occupancy %, listing all candidate IDs directly, and
  suppressing Unhide growth), pin OMP context tools as top-level `essential`
  tools, broaden OMP/Paseo read-only query tool collection (`grep`, `glob`,
  `web_search`, agent/model inspection), and instruct consolidated `manage_context`
  batch cleanup with bounded head/keep/tail fallback on dense pipe/path outputs.
- Summarize `manage_context` batches chronologically using a hybrid sequence
  pipeline: bounded high-signal excerpts remove `input_too_large` refusals on
  >32 KiB items, rolling `sequence_summary` carry-over links multi-chunk runs,
  earlier slots store self-contained 1-line step traces, and the final slot
  appends the consolidated `[Sequence summary]` without coupling per-item Unhide.

### Scopes and compatibility

- Discover registered subagent scopes and render child-scoped controls in
  Paseo. Unsupported or unregistered children show **subagent context is not
  managed**, rather than applying parent-scope mutations to a child.
- Track active workspace sessions in Paseo Explorer across mobile/native and
  compact web layouts using guarded Paseo 0.15.3 focus/layout state, with a
  bound-session chooser fallback, native row-tap Preview, and own-scope routing
  for Paseo-spawned OMP subagents (#13).
- Bind Hermes custom-profile Paseo providers (`agents.providers`, `hermes-<profile>`,
  and `/.hermes/profiles/<profile>` cwds) to their registered `hermes:<profile>:...`
  SQLite scopes while preserving chronological `User`/`Assistant` timeline rows,
  strip leading blank lines and ACP Reasoning fences from outline message previews,
  and replace the generic file-sheet Summarize icon with a compression-arrows +
  4-point-star icon.
- Preserve Hermes `options_omitted` targets in Paseo (`service.ts`), display
  post-compaction `compacted_bytes_size` across hidden/summarized rows, groups,
  and saved-byte totals, fix Paseo old-to-new virtualized chat navigation and
  highlight timer races, auto-scroll the Outline to the latest entries when
  switching sessions, and accept empty `keep_lines: []` on strict-schema
  `manage_context` calls.
- Replace the hardcoded Paseo version whitelist (`0.15.3`/`0.15.4`) with a
  `>=0.15.3` semver floor backed by runtime structural guards, render
  `Loading outline…` without false `No session in view` or `Adapter not detected`
  banners while initial session/scope resolution settles, unify outline message
  labels to `User` / `Agent`, display single-unit `post/pre` sizes (`31.4/98.6 KiB`,
  `0.5/20.0 KiB`) on hidden/summarized rows and groups, format `manage_context`
  outputs with per-item `[hide]`/`[summarize]` mode, tool name, and `post/pre`
  sizes, make `manage_context` call history visible and searchable in Paseo's
  Outline, and harden desktop + mobile React Native scroll behavior (non-session
  tab remount reset, live `stick-to-bottom`, search scroll restore, bottom group
  expand / `PreviewDrawer` reveal, `cancelChatNavigation`, and Paseo chat
  `followOutput` release on older-row jumps).
- Raise `MAX_EVIDENCE_EXCERPTS` (`max_evidence_excerpts`) from `8` to `20` across
  the Python and TypeScript engines, allow explicit `summarize_context` (`allow_fallback=false`)
  to proceed even when rule-based baseline exceeds excerpt caps, and extend the
  explicit head/tail hide fallback to `hide_context` (`/nav hide`) in both Hermes
  and OMP so multi-file `git status` / `git diff --stat` outputs never fail with
  `verification_failed` or remain stranded in candidate reminders.
- Unify Paseo's Hermes timeline loading with OMP on the server (`server/hermesHistory.ts`)
  by reading `~/.hermes/.../state.db` in read-only mode (`DatabaseSync` `readOnly: true`),
  preserving full pre/post-interruption chronological history, Codex `codex_message_items`,
  `msg:*` prompt/response hide/unhide parity, manageable `terminal`/`read_file`/`search_files`
  records with `options_omitted`, and `_usage_anchor` context token totals (keeping ACP
  timeline merge only as a fallback when no local `state.db` is present).
- Close remaining OMP/Hermes/Paseo parity gaps (#1–#6): expand Hermes and OMP
  manageable tool allowlists (including `web_search`, `web_extract`, `execute_code`,
  `eval`, `vision_analyze`, `skill_view`, `tool_describe`, browser/Paseo inspection
  tools, read-only `mcp_*`/`brain_*` tools, and flexible `omitted` options on
  `search_files`), compose Hermes `llm_request` compaction cleanly alongside other
  middlewares instead of bypassing hidden items, support multi-block (`text + image`
  / multiple `text`) `toolResult` compaction in OMP, give queued `Summarize` jobs
  per-item deadlines with clear `"Summary queued — runs on next prompt"` UI status,
  raise discovery caps to `32 MiB / 5,000` newest-first with `records_capped`
  notices, and match `message_text` / `<paseo-system>` / extended tool hints in
  `chatNavigation.ts`.
- Keep child tools, guidance and reminders suppressed by default. OMP's
  standalone subagent activation remains gated; passive child support does
  not imply universal host/delegation support.
- Verify OMP 18.18.3 with Bun 1.4.4; require Bun >=1.4.4.
- Verify Paseo 0.15.3; require Paseo >=0.15.3 and Node >=22.13 for its worker.
  The Node 22.13 worker build/tests were verified, not full daemon/UI acceptance
  at that floor.
- Require Hermes >=0.20.1 based on hook/API availability; live verification
  used newer Hermes source. Keep guarded private middleware-count/token-estimate
  helpers pending public equivalents and maintainer review.
- Preserve the Paseo runtime ID `paseo-plugin` for installed state. The registry
  slug and npm package name do not rename that runtime identity.
- Upstream pi, other Paseo versions, and the complete live race/crash/nested
  delegation matrix are not claimed as verified.
