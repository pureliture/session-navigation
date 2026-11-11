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

### Scopes and compatibility

- Discover registered subagent scopes and render child-scoped controls in
  Paseo. Unsupported or unregistered children show **subagent context is not
  managed**, rather than applying parent-scope mutations to a child.
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
