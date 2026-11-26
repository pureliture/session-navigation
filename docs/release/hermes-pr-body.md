# Add session-navigation 0.1.0 — catalog PR draft

**Draft only. No catalog PR has been opened.**
Replace `<FILL_AFTER_MERGE>` with the full reviewed merge SHA in the entry.
The distribution unit is `hermes-plugin/`, selected by `subdir: hermes-plugin`.
It contains the manifest, loader, MIT LICENSE, THIRD_PARTY_NOTICES.md and vendored Python runtime only.
Canonical engine/adapter sources remain in `src/session_navigation/` and
`adapters/hermes/`; `tools/sync_hermes_vendor.py --check` verifies both mirrors.
The runtime adapter equivalent is `vendor/session_navigation_hermes/` within
that subdirectory. No duplicate editable adapter tree is shipped.

Hermes cleanup forces `manage_context` only after the session model explicitly
allows it (`cleanup_allowed`). Explicit `defer` or `restore` intent suppresses
both the trailing cleanup reminder and forced tool choice, while unclear, failed,
timed-out, or malformed classification leaves only the advisory note and preserves
host-specified tool choices.

## Purpose and declared surfaces

Reversible request-side context management: deterministic Hide, active-session-model
Summarize, exact Unhide without tool reruns, plus list/manage tools and `/nav`.
Original host history is not mutated. The entry declares all five tools, hooks
`post_api_request`/`subagent_start`, middleware `llm_request`/`tool_request`,
and no required environment secrets. Minimum Hermes is >=0.20.1 by source/API
availability; this is not a live qualification of that old release.

## Public surfaces only in the runtime distribution — known limitations

Both previously retained runtime private imports (`hermes_cli.plugins._delivery_manager`
and `agent.model_metadata.estimate_tokens_rough`) have been removed from
`adapters/hermes/` and its identical runtime mirror
`hermes-plugin/vendor/session_navigation_hermes/`:

1. **Middleware coexistence is unobserved and unguaranteed.** Hermes exposes no
   documented public API to enumerate other registered `llm_request` middleware
   callbacks. The plugin performs no private manager lookup, records
   `other_middlewares` as `None` (debug log `other_middlewares=unknown`, never
   fabricated as `0`), and applies request-copy rewrites when enabled. Because
   Hermes's `llm_request` middleware chain composes in registration order,
   neither safe coexistence nor exclusive rewrite ownership with other
   `llm_request` middlewares is guaranteed (a later callback can overwrite our
   replacements and vice versa).

2. **Token estimates are local, rough, display-only approximations.**
   `usage.py` implements a local, dependency-free Unicode-aware heuristic
   adapted from Hermes's MIT-licensed `estimate_tokens_rough` (attributed in
   `THIRD_PARTY_NOTICES.md`), used **only** for approximate `next ≈` footer
   deltas in `/nav`. It is **not** used for reminder trigger decisions (which
   are byte-based in `BoundaryReminders`), item allocation, or exact restoration
   (`unhide_context` / `/nav unhide`). Output is an approximation that differs
   from actual model tokenization and may drift from future Hermes host releases.

Other private-import findings in the repository are from
`eval/{hermes,quality_hermes,v2_hermes}.py`
(`AIAgent`, discovery and manager access) and
`tools/probe_{plugin_manager,supervision}.py` (`PluginManager`).
Those are development-only evaluation/probe programs, not imports performed
by plugin registration or session handling. They remain in the public repository
for review but are outside the installed/scanned subdirectory. Admission against
`hermes-plugin/` reports zero runtime private-import or private-attribute warnings.

Public-surface references in the Hermes source:
`hermes_cli/data/plugin_api.json`,
`website/docs/developer-guide/plugins/public-api.md`,
`hermes_cli/plugins_context.py` and
`website/docs/developer-guide/plugin-llm-access.md`.

## Distribution boundary and scan result

The repository-wide scan is dangerous because the conformance corpus contains
literal hostile instruction/command examples; the TypeScript policy also
contains a bare command-wrapper key. Those strings remain unmodified.
We do not escape, split or otherwise conceal detection strings, and no scanner
rule or exclusion setting has been changed.

The catalog installs only the Python runtime at `hermes-plugin/`. It does not
install the repository's tests, evaluation harnesses, TypeScript hosts, build
outputs or documentation. The committed subdirectory passes the real admission
validator with dependency preparation, zero runtime private-import warnings,
and a `safe` security scan verdict.

Three medium `sudo_usage` notes remain in
`vendor/session_navigation/policy.py:363,365,381` and one medium
`unicode_escape_chain` note appears in
`vendor/session_navigation_hermes/usage.py:18` for the CJK Unicode-range regex
(paths relative to the plugin directory). The `sudo_usage` hits are a
flag-parser comment, a quoted wrapper-option key and quoted wrapper-name
membership (legitimate detection logic, not execution); all four medium notes
are verdict-neutral under the unmodified scanner (`safe`).

## Risk/data disclosure

- Reads permitted session tool results and stores originals, replacements and
  state in local SQLite, shared with a local Paseo panel when used.
- Summarize sends the selected original to the user's configured model provider
  through public `ctx.llm.complete`, using host-owned credentials. It does not
  read credential files or select a separate fallback provider.
- No telemetry, self-updating code, shell execution, credential-store access,
  automatic dependency download during session handling, or remote state sync.
- Hide is not secret erasure. Original content remains in host history/state.
- Whole-source summaries have a 32,768-byte cap. Explicit failed upgrades return
  an error and keep an existing Hide; one factual-validation retry is counted.
- Hermes uses the vendored Python engine; TypeScript/Paseo/OMP files in the root
  repository are not executed by the Hermes plugin. The encoded Paseo worker
  is generated JavaScript text, with corresponding readable source in the repo.

## Evidence to attach at the pinned release SHA

```sh
hermes plugins validate --install-deps /path/to/session-navigation/hermes-plugin
```

Clean committed-subdirectory validation passes with `ok: true`, `security scan — safe`,
matching capabilities, and zero runtime private-import/attribute warnings (while
retaining the four verdict-neutral medium notes: three `sudo_usage` notes in
`vendor/session_navigation/policy.py` and one `unicode_escape_chain` note in
`vendor/session_navigation_hermes/usage.py`). Attach a fresh log at the exact
merged SHA before submission. See the release checklist for wheel, parity,
conformance and host checks. A passing validator (`ok: true`, `security scan — safe`)
is neither a guarantee of catalog admission nor a guarantee of safe coexistence
with other `llm_request` middlewares; catalog admission still requires human review.
