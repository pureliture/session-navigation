# Add session-navigation 0.1.0 — catalog PR draft

**Draft only. No catalog PR has been opened.**
Replace `<FILL_AFTER_MERGE>` with the full reviewed merge SHA in the entry.
The distribution unit is `hermes-plugin/`, selected by `subdir: hermes-plugin`.
It contains the manifest, loader, MIT LICENSE and vendored Python runtime only.
Canonical engine/adapter sources remain in `src/session_navigation/` and
`adapters/hermes/`; `tools/sync_hermes_vendor.py --check` verifies both mirrors.
The runtime adapter equivalent is `vendor/session_navigation_hermes/` within
that subdirectory. No duplicate editable adapter tree is shipped.

## Purpose and declared surfaces

Reversible request-side context management: deterministic Hide, active-session-model
Summarize, exact Unhide without tool reruns, plus list/manage tools and `/nav`.
Original host history is not mutated. The entry declares all five tools, hooks
`post_api_request`/`subagent_start`, middleware `llm_request`/`tool_request`,
and no required environment secrets. Minimum Hermes is >=0.20.1 by source/API
availability; this is not a live qualification of that old release.

## Retained private API warnings — requesting explicit review

We intentionally retain these dependencies, with no claim that warning-level
validation waives catalog rule 9:

1. **`hermes_cli.plugins._delivery_manager`** in
   canonical `adapters/hermes/factories.py:100` and its identical runtime mirror
   `hermes-plugin/vendor/session_navigation_hermes/factories.py:100`. It reads the
   active manager's middleware list to count other `llm_request` callbacks.
   If another callback exists, the plugin records results but leaves requests
   untouched instead of claiming sole rewrite ownership. No public middleware
   enumeration API is documented. The import/probe is guarded by try/except;
   failure returns zero. **That fallback loses coexistence detection**, not a
   guaranteed equivalent behavior. We would adopt a public enumeration seam.

2. **`agent.model_metadata.estimate_tokens_rough`** in
   canonical `adapters/hermes/usage.py:13` and its identical runtime mirror
   `hermes-plugin/vendor/session_navigation_hermes/usage.py:13`. It supplies Hermes's
   Unicode-aware token estimates for item allocation, savings/footer information
   and pressure reminders. No public token-estimation helper is documented.
   ImportError falls back to ceiling(character count/4), which is less accurate
   for non-ASCII text. Exact restoration does not depend on that estimate.

These two lookups are **in-process only**, initiate **no network request**, and
do not mutate core methods or registry dictionaries. Their guarded fallbacks
preserve operation but have the limitations stated above. They are private and
can break on a future release; we request a maintainer decision on these seams.

Other warnings are from `eval/{hermes,quality_hermes,v2_hermes}.py`
(`AIAgent`, discovery and manager access) and
`tools/probe_{plugin_manager,supervision}.py` (`PluginManager`).
Those are development-only evaluation/probe programs, not imports performed
by plugin registration or session handling. They remain in the public repository
for review but are outside the installed/scanned subdirectory. Admission reports
two runtime import sites, both in the vendor adapter; their canonical sources
are retained outside the distribution.

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
validator with dependency preparation and a safe security verdict.

Three medium `sudo_usage` notes remain in
`vendor/session_navigation/policy.py:350,352,368` (paths relative to the plugin
directory). These are a flag-parser comment, a quoted wrapper-option key and
quoted wrapper-name membership. They are legitimate detection logic, not
execution. The unmodified scanner's comment/whole-literal context rules demote
them to medium; they are retained in the scan report and are verdict-neutral.

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

Clean committed-subdirectory release-preparation validation passed with `security scan — safe`, matching
capabilities and the expected private-import warnings. Attach a fresh log at
the exact merged SHA before submission. See the release checklist for wheel,
parity, conformance and host checks. Catalog admission still requires human
review and may require a public seam despite a passing validator.
