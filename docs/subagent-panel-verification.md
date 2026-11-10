# Step 6c: child outlines in the Paseo panel

Verified on 2026-11-10 with Paseo **0.15.3**, OMP **18.18.3**, and the isolated
Hermes ACP provider. All model requests used the loopback stub at `127.0.0.1:52088`;
no paid-provider requests or default-home changes were made.

## Implementation

`paseo-plugin/client/hostCompat.ts` isolates the private length-prefixed selected
tab parser, optional host-version lookup, and native child-tab opener. Known
versions other than 0.15.3 refuse child following/opening. Where version metadata
is unavailable, the strict DOM/visibility/uniqueness guards still apply. Missing,
malformed, or ambiguous identity never enables child mutations. A known main
agent is retained for fallback rather than blanking the panel.

The selected OMP child resolves through the registered parent's scope and an
exact, unique `subagent_id` match. Actions use the child's scope and capabilities.
Parent call rows link children by `tool_call_id`; inline children have independent
outline state. Hermes has no native child-tab action.

One live Hermes detail required a client fix: `delegate_task` was not an eligible
adapter target, so the parent adapter list was empty despite an actual delegation
in Paseo's timeline. The panel now merges only exactly linked missing call rows
from the public timeline as **display-only parent rows**, without inventing
mutable targets. This permits inline expansion even when the parent has no
eligible read results. Existing managed call rows are not duplicated.

The native opener uses an existing child tab first, then the parent's native
subagent track. It avoids reopening an already-focused parent and lets the
initiating event settle before activating the native popup. If opening fails,
the inline expansion remains available. Child scrolling accepts exactly one
visible chat root; it never selects a hidden parent chat or guesses between panes.

## Live observations

OMP parent Paseo agent: `29e68bc9-4846-4713-849d-5e772cf4c9da`.
Its task call `parent-delegate` linked `GrandLeopon` to
`omp:default:01a1c63b-5052-7613-a4cb-8e3d914db82a:default`.

- Focused child tab showed `Outline · subagent: GrandLeopon`, the child's read
  result, and child-scoped controls rather than the parent's outline.
- Clicking panel Hide replaced the result in the next child request with
  `[hidden:item_5a550e87a67d5067]`. Clicking Unhide restored the exact initial
  content in the subsequent request. The child remained alive at stub checkpoints;
  no tool was rerun for restoration. Its requests did not advertise `manage_context`.
- The parent's task row expanded to the inline child outline. The Open tab action
  focused the existing tab and reopened a closed child through the native track.
- Clicking a child read row scrolled a target inside `provider-subagent-panel`,
  not the hidden parent chat.

After reloading the final packed client and restarting the isolated daemon, the
native opener was checked again with fresh child `SuperiorConstrictor` under
Paseo parent `b19dbcf6-3c52-437b-a854-846a12f2fb0f`. This avoids mistaking the
host's lost in-memory subagent index after restart for a client opener failure.

Hermes parent Paseo agent: `ef979ae1-5e69-456c-a8df-398a2c8d2950`.
Its `parent-delegate` call linked `sa-0-aa09eb21` to
`hermes:default:20261110_081550_a40cdf:unknown`.

- Parent `delegate_task` row expanded to the child's `read_file` outline and
  Hide/Summarize controls. No native Open tab action was offered.
- This step verifies Hermes inline UI; child request projection/session-model
  summary was already live-verified in [Step 6b](subagent-backend-verification.md).

Fallback used a real OMP provider variant with the navigation extension disabled:
Paseo parent `7904eac2-5c71-4980-b9c1-dca5040f641d`, child `GivenFlea`, no
registered parent or child adapter scope. Focused child showed the main outline,
the exact notice **`subagent context is not managed`**, and no mutation controls.
Clicking its parent user row opened the main tab and scrolled message `7e701f2a`.
This verifies the missing-registration path, not a live OpenCode Go deployment.

## Evidence and checks

Persistent scratch: `/Users/devin/nav-phase0-gates/phase7-subagents/`.
Outgoing assertions: `step6c-outgoing-assertions.log`; requests are recorded in
`/Users/devin/nav-phase0-gates/phase6b-backend/requests.jsonl`.

Screenshots under `/Users/devin/nav-phase0-gates/screens/`:

- `subagent-tab-child-outline.png`
- `parent-row-expanded-omp.png`
- `parent-row-expanded-hermes.png`
- `subagent-fallback.png`
- `subagent-native-open.png` (additional final-client native opener/scroll check)

Paseo typecheck and embedded-worker build succeeded. Final client-inclusive suite:
**131 pass, 0 fail**, plus **8 Node worker tests**. Core Node/Bun: **18 each**;
OMP: **51**; Python: **350 passed, 11 skipped**; all four Node/Bun differential
and cross-writer checks passed. The final client changes were checked again with
Paseo's suite; unchanged core/OMP/Python inputs were not rerun unnecessarily.
Source/vendor parity and `git diff --check` were clean.

Parser, scope ambiguity/missing registration, version gating, opener errors, and
hidden/multiple-chat-root safety have unit coverage. Split panes, compact layouts,
actual OpenCode Go delegation, and arbitrary other Paseo versions were not live
tested. Hermes intentionally remains inline-only. Child panel Summarize uses the
existing scoped capability gates; this step did not repeat Step 6b's live child
session-model summary test.

See [model-facing text audit](model-facing-text-audit.md) for the comparison with
`origin/main`, unchanged text categories, and intentional runtime differences.
