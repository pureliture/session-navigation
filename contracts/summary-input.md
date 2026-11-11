# Whole-source session summaries

Python/Hermes and the TypeScript core/OMP/Paseo use the same source contract:

- The complete original source is supplied to the session summarizer, unchanged.
  The maximum source is **32,768 UTF-8 bytes**, not characters or a prefix limit.
  Empty source remains empty; normal engine policy still rejects short results.
- Above that budget, refuse **before calling the model** with `input_too_large`.
  Never slice the source or substitute selected excerpts for the summary input.
  OMP additionally lowers the source budget for a known small model window,
  conservatively allowing one token per UTF-8 byte and reserving 8,192 tokens for
  request framing/output. Transport/provider errors remain explicit failures.
- Explicit Summarize does not silently fall back. Auto and already-queued panel
  summaries may retain the existing deterministic rule fallback, as before; no
  over-budget source is sent to the LLM. Originals remain authoritative and
  Unhide never reruns a tool. Paseo queues summaries for the owning OMP/Hermes
  session rather than calling a separate model itself.
- ASCII numeric tokens accept correctly grouped thousands commas, e.g.
  `1,234` and `1234`, including decimal fractions and existing units. This is
  spelling normalization only, not numerical rounding or unit conversion.
  Identifiers, paths, exit status, warnings and injection checks remain strict.
  Keep-lines normalization resolves equivalent numeric spelling back to the
  **verbatim source substring** and reports the normalization.
- A valid keep-lines substring that selects more text than the existing rule
  excerpt budget can retain returns `keep_lines_too_broad` when the baseline
  selection without keep-lines is valid. Nothing is silently discarded; narrow
  the substring or leave the original visible. Existing byte/line caps remain.

`fixtures/core.json` supplies byte-boundary, Unicode, late-fact, grouped-number,
malformed-number and broad-retention vectors to both Node and Bun differential
conformance against Python.

Explicit Summarize upgrades an existing Hide from its authoritative original;
accepted LLM summaries are reused without a model call. Commit only against the
captured version. A rejected upgrade leaves the prior Hide unchanged and returns
an explicit failure. Unhide always restores the same original bytes.

Factual validation failure permits exactly one correction request. Supply the
whole original again with English feedback identifying unsupported numeric,
identifier and path claims and required/critical source facts. Both requests
count toward usage/cost even when rejected. Do not retry transport, budget,
compression or CAS failures. The host adapter owns retries when it validates
responses itself; otherwise the engine owns them. `summary_upgrades` fixture
vectors cover upgrade, retry success/failure, fresh summary and a concurrent
Unhide, including idempotent reuse and version preservation.
