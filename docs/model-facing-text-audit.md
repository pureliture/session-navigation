# Model-facing text audit (Step 6c)

Compared `origin/main` with the shared-core branch, including the removed Python
CLI/OMP daemon, old `extensions/pi/session-navigation.ts`, Python engine, Hermes
plugin and its vendor copy. This is a wording/schema audit, not a promise that
every possible runtime error or model response was exercised live.
The comparison base was `ddc6dcb3e02904bf565dce1ab9e140f1cb95091e`.

## Unchanged text

- All five OMP tool names, labels, descriptions and parameter schemas are unchanged:
  `hide_context`, `summarize_context`, `unhide_context`, `list_context_items`,
  `manage_context`. AST extraction compared name/label/description and normalized
  schema tokens (ignoring formatting/trailing commas).
- OMP `CLEANUP_GUIDANCE` and the complete `[context-navigation]` reminder header
  are byte-identical. Reminder row fields, limits and threshold tiers are unchanged.
- OMP's session-model prompt remains:
  `Summarize this tool result in one paragraph. State only facts present in the result.`
  followed by two newlines and the first 12,000 characters of the result.
- Hermes `schemas.py`, `reminders.py`, `llm.py`, `presentation.py` and `allowlist.py`
  have no diff: tool names/descriptions/parameter docs, human-supervision protocol,
  reminder wording, session-model prompt and user/model result presentation are unchanged.
- Python engine/policy/config source has no diff. Hidden and summary replacement
  text, `Original excerpt:`, restore instructions, evidence/keep-line rejection
  reasons and policy errors are retained by the TS port. Differential Node/Bun
  conformance compares replacements and error/mutation results against that engine.

## Intentional differences

| Surface | Difference and reason |
| --- | --- |
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

No unintentional wording/schema difference was found; no model-facing text was
changed for Step 6c. The UI notice and tab-opening errors are human-facing only.
