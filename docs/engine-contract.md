# Shared engine contract

This is the persistence and mutation reference for the Python Hermes engine and
the TypeScript Node/Paseo and Bun/OMP engines. Implementations must produce the
same identities, replacement bytes, errors and durable state. Hosts retain their
original histories. Only outgoing request copies are projected. Unhide never
executes a tool. Hide is deterministic; Summarize uses the owning session model.

## Versions and adoption

`meta` is a key/value table (`key TEXT PRIMARY KEY, value TEXT`). Current values:

| Key | Value | Meaning |
| --- | --- | --- |
| `schema_version` | `2` | Physical additive schema |
| `engine_protocol_version` | `1` | Shared identity, mutation and policy contract |

Adapter protocol is independently versioned, currently integer `1`. The legacy
OMP JSONL daemon protocol remains `3`; it is not an engine or adapter version.
Only engine protocol 1 is compatible. Unknown, malformed or newer protocols and
unknown schemas fail with `engine_protocol_incompatible` before any DB writes,
including journal changes. Long-lived engine writers recheck before writing.

An existing schema-1 file without engine metadata is adopted **at the same path**.
Migration uses `BEGIN IMMEDIATE`, checks versions again under the lock, creates
missing tables/indexes, updates both metadata keys and commits once. Every DDL
statement is executed individually: Python `executescript()` must not commit a
migration halfway through. Failure rolls back the entire migration. Concurrent
initialization serializes on the same lock. No error may trigger an empty-file
fallback, replacement DB, deletion of originals or silent path change.

## Journal and numeric policy

Default journal mode is **DELETE**, synchronous FULL, busy timeout 5000 ms.
Attempt `PRAGMA journal_mode=DELETE` on open, outside a transaction. SQLite handles
the necessary WAL transition/checkpoint under its own locks. Do not manually
remove WAL/SHM files. If a live reader prevents conversion, inspect the actual
mode. A safe runtime may continue in verified WAL, synchronous NORMAL; retry
conversion on a later open. An unsafe runtime must refuse opening for engine
writes with `unsafe_journal_mode`, not silently continue writing WAL. Recheck on
subsequent writes, since another process can change the mode.

The WAL gate is SQLite >= 3.51.3, or the explicit backports 3.44.6 and 3.50.7.
Bun's Phase-0 SQLite 3.51.0 fails this gate. Journal mode is per database, not per
connection; capability records do not certify that every writer is WAL-safe.

All identifiers and hashes are TEXT; timestamps are Unix seconds (REAL), JSON
columns are TEXT, booleans are INTEGER 0/1. Versions, sequence numbers and counts
are INTEGER. JS drivers must use exact integer reads and reject unsafe Number
conversions; Python ints must not silently become rounded JS Numbers. SQLite
bindings use SQL NULL, not JS undefined. Normalize affected-row counts and busy
errors across drivers. Own transaction boundaries explicitly; Node/Bun autocommit
and Python's implicit DML transactions are not interchangeable APIs.

## Existing durable tables

The following columns remain unchanged by adoption. Composite keys are shown in
parentheses. Absent values retain the existing SQL defaults/NULL semantics.

| Table / key | Columns |
| --- | --- |
| `items (scope_key,item_id)` | `scope_key TEXT`, `item_id TEXT`, `tool_call_id TEXT`, `result_position INTEGER DEFAULT 0`, `content_sha256 TEXT`, `invocation_digest TEXT NOT NULL`, `original TEXT`, `compacted TEXT`, `excerpt_lines TEXT DEFAULT '[]'`, `visibility TEXT DEFAULT 'hidden'` (hidden/visible), `version INTEGER DEFAULT 1`, `tool_name TEXT`, `compaction_source TEXT`, `invocation_snapshot TEXT`, `context_hint TEXT`, `invocation_options_omitted INTEGER DEFAULT 0`, `created_at REAL`, `updated_at REAL` |
| `identities (scope_key,tool_call_id,content_sha256,invocation_digest,result_position)` | key columns TEXT except `result_position INTEGER DEFAULT 0`; `item_id TEXT`, `version INTEGER DEFAULT 1`, `updated_at REAL` |
| `units (scope_key,unit_id)` | `scope_key TEXT`, `unit_id TEXT`, `message_uid TEXT`, `kind TEXT` (user/assistant/tool_call/tool_result), `parent_unit_id TEXT`, `tool_call_id TEXT`, `content_sha256 TEXT`, `char_count INTEGER DEFAULT 0`, `tokens_display TEXT DEFAULT '—'`, `visibility TEXT DEFAULT 'visible'`, `version INTEGER DEFAULT 1`, `updated_at REAL` |
| `calls (scope_key,call_key)` | `scope_key TEXT`, `call_key TEXT`, `prompt_tokens INTEGER`, `completion_tokens INTEGER`, `total_tokens INTEGER`, `cost_usd REAL`, `recorded_at REAL` |

Items also have a unique full-identity tuple matching the identities key.
`units(scope_key,message_uid)` is indexed. Runtime-only host handles and expiry
fields are not durable columns. `excerpt_lines`, invocation snapshots and context
hints use JSON; `original` and `compacted` are literal text, not JSON strings.

## Canonical identities

Scope keys are `adapter:profile:session:branch`. Never infer them from model
arguments, titles, working directories or executable names. The TS OMP adapter uses
`omp:default:<session>:default`; the legacy Python daemon uses
`pi:default:<session>:default`. On first valid processing, the TS adapter imports
legacy state only into an entirely empty destination scope, under one transaction.
Item IDs and identity references are recomputed for the destination scope; original
legacy rows are preserved. Registrations/target caches are not imported. Subsequent
mutations use only the `omp:` scope: this is not an alias or live synchronization.
Discovery must prefer the registered OMP scope over a legacy history-only scope.
Hermes's canonical branch remains **unknown**:
`hermes:<profile>:<session>:unknown`. Keeping this suffix preserves existing
item hashes and hidden state. A compression-created session ID is a new scope.

For adapter discovery, `:default` and `:unknown` are Hermes aliases. Exact stored
scope wins; only when absent may discovery consult the other suffix. Return the
resolved stored scope to callers, who must use it **before hashing or mutations**.
Never rewrite stored scopes/item IDs, merge two existing scopes, duplicate hidden
items or treat other adapters' branch names as aliases. Ordinary item access
remains exact-scope access; aliases do not change generic `Scope` semantics.

Canonical JSON is exactly Python's
`json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))`.
Object keys sort by Unicode code point, arrays retain order, text is not Unicode
normalized, UTF-8 is used without a BOM. Preserve Python-compatible number and
escape rendering (including integral floats); plain JS `JSON.stringify` is not
a sufficient general-purpose replacement. Adapter-filtered invocations normally
contain strings, booleans and bounded integers. Non-finite numbers and invalid
UTF-8 cannot be interoperable invocation inputs.

* `content_sha256 = SHA256(UTF8(original))`, lowercase 64-character hex.
* Invocation is the adapter-filtered `{tool_name,arguments}` object. Digest its
  canonical JSON, adding `omitted_options` only when the omitted-options object
  is nonempty. Do not hash an empty omitted-options object.
* Item hash input is `scope + NUL + call_id + NUL + content_sha256 + NUL +
  invocation_digest + NUL + decimal(result_position)`. ID is `item_` plus the
  first 16 hex characters of SHA256. Result positions are zero-based.
* Message ID: `msg_` + first 16 hex characters of SHA256 of
  `scope + NUL + 'msg' + NUL + message_uid`.
* Pair ID: `pair_` + first 16 hex characters of SHA256 of
  `scope + NUL + 'pair' + NUL + call_id + NUL + content_sha256`.

Full identity, not the shortened item ID or content hash alone, fences mutations
and projection. Original SHA must match the outgoing slot before replacement.
Adapters reject ambiguous/unpaired calls, unsupported invocations and failed tool
results; engine protection rules still apply to published targets.

## Adapter registration

`adapter_sessions` columns are all NOT NULL except that SQLite's TEXT primary-key
semantics apply: `scope_key TEXT PRIMARY KEY`, `adapter_id TEXT`,
`adapter_protocol INTEGER`, `capabilities TEXT`, `enabled INTEGER CHECK(0,1)`,
`instance_id TEXT`, `last_seen REAL`. Capabilities is canonical JSON containing
boolean `hide`, `summarize`, `unhide` keys. Unknown capability names grant nothing.

Adapters publish their own registrations, never Paseo's history scanner. Upsert
on first sight for a scope/instance, any capability/protocol/enabled change, or
after **300 seconds**; unchanged observations before then do not update the row.
Instance IDs distinguish adapter registration lifetimes. Last seen is informative
only, never a TTL or proof of process liveness. Eligibility requires a matching
record, compatible adapter protocol, enabled=true and the requested capability.
Unhide of an already-hidden item remains allowed without a live registration.
Do not copy registrations or target caches on fork; child adapters publish anew.

Hermes advertises only supported request modes while enabled and projecting.
Disabled/coexisting middleware revokes capabilities. Summarize is advertised only
with a session summarizer; Hide needs no LLM. Profile and session are bound by the
host callback. ACP launch/viewer processes alone must not advertise projection.

## Published targets

`adapter_targets` has primary key `(scope_key,item_id)`; all columns are NOT NULL:

| Columns | Type / meaning |
| --- | --- |
| `scope_key`, `item_id`, `tool_call_id` | TEXT, full owning scope and identity |
| `result_position` | INTEGER, zero-based |
| `invocation_digest`, `invocation_snapshot` | TEXT, verified digest and canonical filtered invocation JSON |
| `original`, `content_sha256`, `tool_name` | TEXT, literal original and verified SHA/name |
| `options_omitted` | INTEGER DEFAULT 0, whether identity includes omitted options |
| `created_at`, `seq` | REAL timestamp, INTEGER monotonically increasing insertion sequence within retained scope |

Index `(scope_key,seq)`. The adapter verifies SHA and invocation digest (including
omitted options) before publication. Publication requires an enabled compatible
Hide registration. Hermes publishes only successful, uniquely paired, supported,
policy-eligible fresh originals, excluding destructive commands and protected
errors. Invalid identity rejects the entire publication batch. Replays
do not overwrite an existing target or refresh its sequence/creation time.

Keep at most **256 targets / 4 MiB** of UTF-8 original plus invocation JSON bytes
per scope. Skip individual oversized targets; prune oldest insertions until both
bounds hold, in the same transaction as publication. This cache is not history:
eviction never deletes items/originals already hidden. Empty batches create no
items. **Never seed items with empty replacements.** A remote surface must resolve
the scope, require capability, read the verified target and apply normal policy,
identity fencing and CAS; it must not reconstruct host invocations from previews.

## Mutations, summaries and batches

New hidden items start at version 1. Original, replacement and identity fence are
persisted together. Concurrent insertion must not overwrite an item. Updates use
`WHERE scope_key=? AND item_id=? AND version=?`; zero affected rows is
`version_conflict`. Expected version against a missing item is also a conflict.
Successful transitions increment version exactly once. Callers that omit an
expected version still perform an optimistic CAS against their observed version.
Unhide changes visibility, not originals, and never re-executes a tool.

An explicit cross-surface Summarize first stores a valid rule hide with source
`summarize_pending` and its filtered invocation snapshot. The owning adapter
fulfils pending entries seen in its current verified request, using its existing
session model outside DB transactions. No available model, model failure or
invalid summary settles to `explicit_user_hide`, preserving the rule replacement.
Valid text settles to `llm_summary`. Both settlements require the captured pending
version and hidden visibility; an intervening unhide/re-hide wins. Revalidate
critical facts, grounding and smaller-than-original size before committing. The
same outgoing request must use the settled replacement (or originals after a
concurrent Unhide). Do not replay a settled model request on the next callback.

User-selected mutation batches deduplicate full target IDs, preserve caller order
and return a result per target; one refusal does not undo independent successes.
No implicit target selection, forced cleanup or model call in Hide. Publication
and migration are different: each is atomic as a whole, not partial-success.
Summary model calls never hold a SQLite transaction. CAS conflicts are returned,
not retried against a newly observed version without a new user decision.

## Error contract

| Code | Meaning |
| --- | --- |
| `engine_protocol_incompatible` | Unknown/malformed/newer engine or schema; no adoption or fallback DB |
| `unsafe_journal_mode` | WAL remains and runtime fails safety gate; refuse writes |
| `db_error`, `db_full` | Persistence/locking failure, disk full respectively |
| `version_conflict` | Missing/stale expected version or losing concurrent insert |
| `not_found`, `not_pending` | No target, or summary entry no longer pending |
| `adapter_unavailable` | Publication without a compatible enabled Hide owner |
| `invalid_adapter_registration`, `invalid_target_identity` | Invalid ownership or publication evidence |
| `verification_failed`, `summarizer_unavailable` | Invalid/model-unavailable summary; preserve rule hide |
| Policy/identity refusals | Existing `protected_*`, `unsupported_tool`, `invalid_invocation`, `invocation_conflict`, `ambiguous`, `keep_lines_conflict`, etc. retain their established meaning |

Python persistence exceptions expose `.code`; JSON transports preserve it rather
than relabel protocol/journal refusals as `db_error`. Busy errors normalize to
`db_error` with no successful mutation. Middleware persistence failures preserve
the outgoing originals and report loudly; host fail-open is not a persistence
success. Never log original result bodies or invocation arguments as diagnostics.
