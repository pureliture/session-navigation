# Phase 6 live verification

Verified on 2026-11-10 with Paseo 0.15.3, OMP 18.18.3, and Hermes source
`cdf7ea4d0893e3cdd4ea9b2c12a554bda1164dd8`. These observations supersede the
unverified Phase 5/6 status in the original issue 9 handoff, not the remaining
Phase 7 failure/race matrix or minimum-Node-version gate.

## Installation and isolation

- Reused the packed Paseo plugin, packed OMP extension, isolated Paseo home,
  loopback daemon, and shared SQLite DB from the Phase 5 smoke.
- Hermes PM provisioned an isolated Python 3.14 runtime/venv under
  `/Users/devin/nav-phase0-gates/phase6-live/hermes-home`; explicitly selected
  the `acp` extra. The Hermes plugin root, manifest, and `vendor/` were copied
  into that home's `plugins/session-navigation` directory and enabled through
  `hermes plugins enable session-navigation`, with `settings.enabled: true`.
- Paseo provider `hermes` uses `extends: "acp"` and an isolated `hermes-acp`
  launcher. Python is used by Hermes, not by Paseo or OMP.
- Daemon PATH excluded both `.venv/bin` and `~/.local/bin`. Relay was disabled.
  Default Paseo/Hermes homes were not configured or used for the smoke.

## Observed behavior

1. A fresh Hermes session published `hermes:default:<ACP session ID>:unknown`.
   Paseo bound the custom provider agent to that scope using ACP persistence
   metadata. The read-file target appeared with Hide/Summarize capabilities
   `ready`. The small terminal result was not an eligible target; the Hermes
   panel lists published targets, not a complete user/assistant transcript.
2. Paseo Hide changed the outgoing read result from 7,047 characters to a
   deterministic hidden replacement retaining the owner/seal evidence. Unhide
   restored the exact original. Summarize returned `summarize_pending`, then
   settled to `llm_summary` through Hermes `ctx.llm`; the same outgoing request
   contained the canned summary. Persisted Hermes message originals were
   compared before/after and remained unchanged.
3. Detaching and resuming through Paseo preserved the native session ID, scope,
   hidden item ID/version, and projected summary.
4. Paseo `/branch` returned the Hermes instruction to use ACP `session/fork`.
   The tested Paseo client exposes fork-context construction, not a native ACP
   fork action. A separate real ACP client loaded the persisted parent, called
   `session/fork`, and prompted the child. The child had a distinct ID/scope and
   initially transmitted the original, not the parent's hidden summary. The
   fork was subsequently resumed/imported through Paseo. No automatic copying
   of navigation state to the child is claimed.
5. Manual `/compress here 1` through Paseo reported 14 -> 12 messages and kept
   the ACP session ID stable. A subsequent turn completed and the retained read
   target still projected its summary without changing its stored original.
   This is **in-place compression**, not a verified compression-created scope
   rotation. The read target survived this compression: removal of an eligible
   target by compression, stale-target eviction, automatic overflow compression,
   and concurrent compression/mutation remain unverified live cases.
6. One shared daemon/DB listed both OMP and Hermes scopes. On the fork's actual
   published target, the Python engine's rule Hide matched the Paseo TS rule
   replacement byte-for-byte after normalizing only scope-derived item IDs.
   Paseo observed/projected the Python-written Hide, and its TS Unhide restored
   the child original without changing the parent summary. Source labels differ
   intentionally here (`rule` for engine Hide, `explicit_user_hide` for Paseo).

## Real session-model summaries

Exactly two requests were forwarded to OpenRouter's
`google/gemini-2.5-flash-lite`: one OMP session-model summary and one Hermes
session-model summary. Both sessions were launched through Paseo. A loopback
recording proxy stubbed ordinary turns/tools and forwarded only the adapter's
summary prompt, with a two-request hard budget. The session's configured model
ID was the real model, not the stub model. This verifies the actual host summary
paths; it is not an end-to-end real-model tool-selection test.

The proxy read `OPENROUTER_API_KEY` from its process environment. The key was
never placed in config, logs, or the repository; request capture excludes HTTP
authorization headers. Both calls returned HTTP 200, settled to `llm_summary`,
and their exact English summaries appeared in the next outgoing tool-result
slot. Both retained `Orchid` and `harbor-91`. The Hermes model incorrectly counted
161 rows/range 0-160 rather than 160 rows/range 0-159: settlement is not a
general factual-correctness guarantee. No retry was purchased to improve prose.

## Evidence and reproduction entry points

Persistent machine-local artifacts (not required by CI) are under
`/Users/devin/nav-phase0-gates/phase6-live/`:

- `hermes-acp`, `stub.ts`, `probe.mjs`, `mutations.mjs`, `lifecycle.mjs`:
  isolated runtime launcher, SSE server, fresh session, mutations, resume/compress.
- `fork.py`, `cross-writer.py`, `fork-paseo.mjs`: native ACP fork and shared-DB
  writer checks. These depend on the preceding session artifacts and installed
  runtime paths; they are smoke probes, not standalone unit tests.
- `real-provider.ts`, `real.mjs`: opt-in two-host real-summary probe. Do not rerun
  with a key unless two additional paid requests are explicitly authorized.
- `evidence.json`, `rpc.jsonl`, `requests.jsonl`, `lifecycle.log`,
  `cross-writer-evidence.json`, `fork-paseo.json`, `real-omp.json`,
  `real-hermes.json`, `real-responses.jsonl`: responses and payload evidence.

The actual Paseo web panel was visually checked for the Hermes session:
`/Users/devin/nav-phase0-gates/screens/paseo-hermes-outline.png` and
`paseo-hermes-real-summary.png` (expanded sent-to-model/original preview).
All isolated processes are stopped after verification; homes and evidence stay
available for subsequent phases.
