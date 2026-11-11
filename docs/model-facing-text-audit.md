# Model-facing text audit (Step 6c)

Compared `origin/main` with the shared-core branch, including the removed Python
CLI/OMP daemon, old `extensions/pi/session-navigation.ts`, Python engine, Hermes
plugin and its vendor copy. This is a wording/schema audit, not a promise that
every possible runtime error or model response was exercised live.
The comparison base was `ddc6dcb3e02904bf565dce1ab9e140f1cb95091e`.
The RCA fix audit repeats the comparison against both `37348b8` and
`origin/main` (`ddc6dcb3e02904bf565dce1ab9e140f1cb95091e`).

## Correction to the original audit

The earlier conclusion, “No unintentional wording/schema difference was found,”
was incomplete. It missed **OMP's actual model-facing navigation-tool exposure
order** and **Hermes's missing Python-toolchain environment-probe line**. Source
tool metadata alone did not establish parity of the complete host-built request.
Both omissions are fixed:

- OMP now registers `list_context_items`, `manage_context`, `hide_context`,
  `summarize_context`, `unhide_context`, pinning the order in the captured old v4
  requests. The `37348b8` and main **source registration** sequence was hide,
  summarize, unhide, list, manage; the captured historical **host exposure** was
  list, manage, hide, summarize, unhide. Those are different observations, and
  this fix explicitly targets the captured model-facing order, not the old source
  sequence. Both package/shim load orders have a registration-order regression;
  the local SDK capture test also pins the actual outgoing tool-array order.
- The matched Hermes evaluator puts its controller interpreter's directory first
  on terminal `PATH`, warms the host environment probe before agent construction,
  and checks that the stock system prompt includes that exact probe line before
  any generation. This restores the historical line with the actual 3.12.15
  terminal toolchain, rather than injecting a stale machine fact into the plugin:

  ```text
  Python toolchain: python3=3.12.15 (no pip module), pip=missing, PEP 668=yes (use venv or uv), uv=installed.
  ```

  The Hermes engine's isolated 3.14.9 interpreter is unchanged. A clean/different
  terminal toolchain that produces no probe line now refuses the matched campaign
  explicitly; it cannot silently run without this historical prompt control.
  Regression tests pin the line and missing-line refusals. A network-free check
  of the real Hermes `AIAgent` stock prompt also contained it verbatim.

## Unchanged text

- All five OMP tool names, labels and parameter schemas are unchanged:
  `hide_context`, `summarize_context`, `unhide_context`, `list_context_items`,
  `manage_context`. AST extraction compared name/label/description and normalized
  schema tokens (ignoring formatting/trailing commas). Descriptions match
  `origin/main`; relative to `37348b8`, `manage_context` has the intended
  `270353f` per-target keep-lines/ignored-entry description change. Exposure order
  is checked separately above.
- OMP `CLEANUP_GUIDANCE` and the complete `[context-navigation]` reminder header
  are byte-identical. Reminder row fields, limits and threshold tiers are unchanged.
- OMP's session-model prompt remains:
  `Summarize this tool result in one paragraph. State only facts present in the result.`
  followed by two newlines and the **complete source**, subject to the new explicit
  byte budget below, rather than a silently truncated prefix.
- Hermes advertised tool schemas and human-supervision text match both bases,
  except the same intended `270353f` `manage_context` description difference
  against `37348b8`. Reminder wording and the session-summary system instruction
  remain unchanged. Host-built environment text is checked separately above.
- Hidden/summary wrapper wording, `Original excerpt:`, restore instructions and
  existing error vocabulary are retained. Python and TS now share the explicit
  summary-source budget, numeric-spelling normalization and broad-retention error.
  Differential Node/Bun conformance compares these alongside replacements,
  mutation results and persistence.

## Intentional differences

| Surface | Difference and reason |
| --- | --- |
| Whole-source summaries | No 12,000-character slice. A complete source of at most 32,768 UTF-8 bytes is passed unchanged; a larger source is refused with `input_too_large` before a model call. OMP additionally respects a known small model window. Explicit Summarize does not fall back; auto/queued summaries may retain the existing rule fallback. See `contracts/summary-input.md`. |
| Numeric spelling and broad retention | Correctly grouped thousands commas are equivalent only for numeric-token validation. Keep-lines resolves back to the verbatim source spelling. Paths, identifiers, units, exit status and injection checks remain strict. A matching keep-lines substring that exceeds the existing excerpt budget returns `keep_lines_too_broad`, not a generic verification failure or silently dropped rows. |
| Filtered listing | OMP constructs its recorded-call set before applying the display query, so a query-excluded stored item is not emitted as unrecorded/unhidden. Shipping Python/Hermes listing already filtered stored rows without synthesizing such rows; regression coverage pins that behavior. |
| Child OMP requests | The old extension registered cleanup tools and prompt guidance immediately without distinguishing child sessions. Linked children now project their own scope but receive **none** of the five navigation tools, cleanup guidance, reminders or TUI overlay. Unlinked children remain inert. User-directed passive-child design. |
| Child Hermes requests | Child requests now remove navigation tools and the exact supervision section, and do not append navigation reminders. Parent wording/schemas are unchanged. User-directed passive-child design. |
| Newly supported pending-summary paths | Hermes panel-queued summaries and passive child summaries now run through the owning session's model on a subsequent outgoing request. The old OMP parent pending path already did this. Session-model prompts are unchanged; successful panel settlement uses the raw summary text (as the old OMP daemon did), rather than the engine's model-tool summary wrapper. Failed settlement retains the existing rule replacement. Intentional cross-surface coordination, not new model guidance. |
| OMP transport errors | Python subprocess-specific `spawn_error`, `daemon_exit`, `stdout_closed`, `stdout_error`, `write_failed`, `ping_failed`, `rpc_error`, and `protocol_mismatch` no longer describe the transport. Worker lifecycle failures use `worker_error`, `invalid_response`, `shutdown`, `timeout`, `cancelled`, `cooldown`; incompatible engine/schema/journal errors are explicit (`engine_protocol_incompatible`, `unsafe_journal_mode`). Intentional runtime migration and safer failure handling. |
| OMP headless abort exception | The old generic `session-navigation: db_error (aborted)` now identifies the actual fatal error, e.g. `session-navigation: worker_error (aborted)`. Interactive abort text remains unchanged. Intentional diagnostic improvement; no original request is silently sent for these structural failures. |
| OMP cancellation/generation errors | `cancelled` / `unconfirmed_snapshot` can now be returned after waiting for a session-model summary or between management batches if the snapshot changed. They existed as error codes; the additional fences prevent late writes to a different session. Intentional safety behavior. |
| Retired CLI/parser surface | CLI-only argument/help errors (`--expected-version requires --item-id`, `invalid --items-json: …`, argparse usage) and daemon JSON-line framing errors are absent from the packaged OMP runtime. They were human/transport errors, not advertised tool parameter docs. Model tool validation still uses structured engine/service error codes. Intentional removal of the obsolete CLI/daemon. |

The old daemon and new OMP service retain the existing validation vocabulary:
`invalid_params`, `invalid_session`, `unconfirmed_snapshot`, `invalid_snapshot`,
`invalid_record`, `snapshot_too_large`, `invalid_version`, `unknown_method`,
`not_found`, `summarizer_unavailable`, `verification_failed`, `invalid_limit`,
`invalid_tool_call_ids`, `tool_call_ids_required`, `invalid_action`,
`invalid_keep_lines_action`, `invalid_summaries`, plus engine policy/CAS/DB errors.
The shared core's additional capability/registration errors are backend/panel
contracts, not added descriptions or instructions in the model's tools.

The repeated AST/token and Python-constant comparisons found only the intentional
description difference listed above; order, summary-source semantics and host
prompt construction are audited separately rather than inferred from that
metadata comparison. Deterministic reminder/replacement equivalence from the RCA
is retained; this does not establish equality of stochastic future model choices.
The UI notice and tab-opening errors are human-facing only.
