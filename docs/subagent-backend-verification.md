# Passive subagent backend verification (Step 6b)

This supersedes the inert-child backend checkpoint in
[the earlier fallback probe](subagent-live-verification.md). It does **not**
implement a child-following Paseo panel or an opener for child tabs.

## Contract and implementation

- Normal OMP/Hermes scope formats are unchanged. Adapter capabilities JSON stores
  `linkage.parent_scope`, `linkage.tool_call_id` and `linkage.subagent_id`; old
  rows expose null fields. No physical schema or protocol bump is needed.
- Python `child_scopes`, TS `childScopes` and the existing `session-nav.scopes`
  RPC expose linkage. The RPC accepts an optional exact `parent_scope` filter.
- OMP resolves the parent's native ID from the persisted `parentSession` header,
  not the registry label `Main`. Ownership is session-specific. Eligible child
  targets are published for RPC mutations even without a main-session JSONL.
- The live probe exposed an initialization race: the asynchronous parent task
  result can precede child registration. Both engines now preserve unmatched
  provider IDs in the parent's `pending_children` capabilities map. Registration
  consumes the binding atomically; the reverse ordering updates existing children.
- Hermes captures the delegate call in a plugin-owned ContextVar, then binds
  public `subagent_start` parent/child session and provider-child IDs. Source and
  vendor mirrors remain identical. Child outgoing copies omit navigation tools,
  supervision guidance and reminders, including when projection is disabled.
- Neither child adapter installs model-facing navigation tools or a TUI overlay.
  Both can summarize through their own session model, so child summarize remains
  enabled when that adapter's session-model capability is available.

## Live check

All traffic used the loopback SSE stub on port 52088. Paseo 0.15.3 used the
isolated `phase5-live` home, packed Paseo plugin and packed OMP extension; Hermes
used the isolated `phase6-live/hermes-home` Python plugin. No paid model calls or
default-home changes were made.

For each host the stub held a child request after its first file read. While the
child was still running, the existing Paseo RPC listed its own target, hid it,
unhid it and requested a pending summary. Captured later requests demonstrated:

1. The original read result was initially present.
2. Hide projected `[hidden:item_…]` into the next request.
3. Unhide restored the exact original without rerunning that read call.
4. Summarize settled through the child's session model and projected:
   `Canned session summary: owner Orchid; audit complete; retain seal harbor-91.`
5. No child request advertised navigation tools or a context-navigation reminder.

OMP provider child `SufficientWhippet` registered:

```text
parent: omp:default:01a1c631-1ec1-7454-bd34-e9c9e8819243:default
child:  omp:default:01a1c631-1ff1-720c-9b8e-c3c98e7074b7:default
call:   parent-delegate
```

The final Hermes delegation registered provider child `sa-0-52073d9c`:

```text
parent: hermes:default:local-68fb7d08d5810a1d01e5e14d28c1f3912f3a127b309ae9e1e145b5284f29b642:unknown
child:  hermes:default:20261110_080415_92c734:unknown
call:   parent-delegate
```

Both hosts' child scopes exposed the correct parent and exact `parent-delegate`
call while the stub was paused. Parent filtering returned only matching child
scopes. The OMP native JSONL retained its entire saved original prefix. Stored
adapter targets retained the exact original read for both hosts; Hermes's native
child read row also retained the original text, not the hidden/summary replacement.

Reusable scripts, packed artifacts, RPC replies, captured requests and evidence:
`/Users/devin/nav-phase0-gates/phase6b-backend/` (`live.mjs`, `stub.ts`,
`rpc.jsonl`, `requests.jsonl`, `omp-evidence.json`, `hermes-evidence.json`).

## Checks and limits

Final check output:

```text
Paseo embedded Node worker: built
Paseo: 123 pass / 0 fail; embedded Node worker: 8 pass / 0 fail
Core Node: 18 pass / 0 fail; Core Bun: 18 pass / 0 fail
OMP: 51 pass / 0 fail
350 passed, 11 skipped in 31.23s
PASS differential Python vs TS+node: canonical, policy, summaries, mutations, replacements and final rows
PASS cross-writer Python -> TS+node -> Python and reverse
PASS differential Python vs TS+bun: canonical, policy, summaries, mutations, replacements and final rows
PASS cross-writer Python -> TS+bun -> Python and reverse
```

All three TypeScript typechecks exited successfully. Source/vendor parity and
`git diff --check` were clean.

The core Node/Bun tests cover old rows, reopen, heartbeat preservation, empty child
lists and both linkage orderings. Differential and cross-writer conformance covers
linkage and pending registration. OMP tests cover simultaneous parent/child
ownership, passive projection, repeated session starts and a fresh extension
reopening the same child scope with hidden state intact. Hermes tests cover
concurrent batches with copied contexts, nested delegates, unrelated calls and
both chat-completions and responses request filtering.

Live parked/revived OMP execution, concurrent Hermes delegation, and child
real-provider model quality were not tested. Revival and concurrency are unit
coverage only; live summaries used the stub. The panel remains the earlier
fallback UI and was not visually rechecked at this backend-only checkpoint.
Step 6c subsequently added OMP child-tab following/opening and OMP/Hermes inline
outlines; see the [current support table](../README.md#subagent-support).
Hermes still has no native Paseo provider-child tab bridge.
