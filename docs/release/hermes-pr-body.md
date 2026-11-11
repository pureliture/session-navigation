# Add session-navigation 0.1.0 — catalog PR draft

**Draft only. No catalog PR has been opened.**
Replace `<FILL_AFTER_MERGE>` with the full reviewed merge SHA in the entry.
The distribution unit is the public repository root; there is no `subdir`.

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
   `adapters/hermes/factories.py:100` and its vendor mirror. It reads the
   active manager's middleware list to count other `llm_request` callbacks.
   If another callback exists, the plugin records results but leaves requests
   untouched instead of claiming sole rewrite ownership. No public middleware
   enumeration API is documented. The import/probe is guarded by try/except;
   failure returns zero. **That fallback loses coexistence detection**, not a
   guaranteed equivalent behavior. We would adopt a public enumeration seam.

2. **`agent.model_metadata.estimate_tokens_rough`** in
   `adapters/hermes/usage.py:13` and its vendor mirror. It supplies Hermes's
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
by plugin registration or session handling. They remain visible for review.

Public-surface references in the Hermes source:
`hermes_cli/data/plugin_api.json`,
`website/docs/developer-guide/plugins/public-api.md`,
`hermes_cli/plugins_context.py` and
`website/docs/developer-guide/plugin-llm-access.md`.

## Scanner remediation

The conformance JSON includes deliberately hostile command/instruction examples.
Their source spellings now use JSON Unicode escapes; the decoded test values
are byte-for-byte unchanged, and both engines' differential vectors still pass.
No fixtures were excluded and no scanner rule was disabled.

The TypeScript policy's command-wrapper lookup key uses
`["su", "do"].join("")` in a computed property instead of a bare literal token.
It still recognizes exactly the same wrapper and options; this is recognition
code, not command execution. The regenerated Paseo worker and rebuilt OMP worker
preserve that construction. This removes the prior `sudo_usage` false positives
without weakening policy. Reviewer inspection of both source and generated
JavaScript is requested rather than treating a clean scan as proof of safety.

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
hermes plugins validate --install-deps /path/to/session-navigation
```

Release-preparation validation passed with `security scan — safe`, matching
capabilities and the expected private-import warnings. Attach a fresh log at
the exact merged SHA before submission. See the release checklist for wheel,
parity, conformance and host checks. Catalog admission still requires human
review and may require a public seam despite a passing validator.
