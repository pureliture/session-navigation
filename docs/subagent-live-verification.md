# Subagent live verification and fallback

> Historical Step 4 checkpoint. Passive child backends were subsequently added in
> [Step 6b](subagent-backend-verification.md); the current provider support table
> and UI behavior are in [README](../README.md#subagent-support).

Verified on 2026-11-10 with Paseo 0.15.3, OMP 18.18.3 and the Phase 6
Hermes checkout. Both hosts used the loopback OpenAI-compatible stub at
`127.0.0.1:52088`, the isolated Phase 5/6 homes and shared SQLite DB.
Hermes retained a real-model *name* in its configuration, but its requests in
this probe went to the local stub; no paid provider was called.

## Decision

Use the explicit main-outline fallback for both hosts, not child mutations.
Distinct native child IDs alone do not establish a supported managed child
scope. OMP's current integration deliberately skips child activation; Hermes
does publish a native child scope, but Paseo exposes no child-to-scope/tab
binding for its delegation. Neither host demonstrated the complete chain from
a focused child tab to its own safely rewritten request. This is a conservative
support decision, not a claim that future per-child support is impossible.

On a focused provider-subagent tab, the panel resolves its main agent, shows
that agent's outline and the exact notice **subagent context is not managed**.
SDK child agents resolve `PluginAgentSnapshot.parentAgentId`'s underlying
`paseo.parent-agent-id` label recursively. Row presses use
`navigation.openAgent({ agentId: mainAgentId })`, wait for the main chat to
become visible and then use the existing identity/history-aware row scroll.
Hide/Unhide controls in this fallback operate on the displayed **main** scope,
not the child's context. No child tool surface was expanded.

The tab detector uses Paseo 0.15.3's rendered, length-prefixed target keys;
there is no public focused-provider-subagent API in the plugin SDK. It does
not inspect React private state, match titles, or treat provider-internal IDs
as SDK agent IDs. Malformed/ambiguous child tabs, parent lookup errors, cycles
and workspace-external roots fail closed rather than selecting a guessed scope.
This rendered-key dependency must be revisited if Paseo changes its tab format.

## OMP: observed live

- Real `task` delegation through Paseo produced provider children
  `AmusedWarbler` and, in the final unique-message probe, `PoisedTiglon`.
- Final parent Paseo agent: `b2f5aacd-04fd-47aa-952f-b92b3951009e`.
  The selected tab was
  `workspace-tab-provider_subagent_36_b2f5aacd-04fd-47aa-952f-b92b3951009e_12_PoisedTiglon`:
  kind `provider_subagent`, separate from ordinary SDK agent tabs.
- Temporary instrumentation of the installed packed panel observed
  `params.agentId: ""` in workspace follow mode, even with that child focused.
  The resolved main `PluginAgentSnapshot` had the parent Paseo UUID above and
  `parentAgentId: null`. The child is held in Paseo's ProviderSubagentStore;
  it is not a `PluginAgentSnapshot` whose `id` can be passed to `agents.ref`.
  The temporary instrumentation was removed from the installed package.
- The diagnostic OMP extension observed both `session_start` and `context`
  with `ctx.agent = {kind:"sub", id:"PoisedTiglon", name:"task", depth:1,
  parentId:"Main"}`. Parent native session ID:
  `01a1c5b9-ab17-73c0-99f8-1775c91d99be`; child native session ID:
  `01a1c5b9-aca4-741b-95c5-7d0f01f904e1`.
- Parent session file is `<parent timestamp>_<parent native ID>.jsonl`;
  child file is `<parent timestamp>_<parent native ID>/PoisedTiglon.jsonl`
  beneath the isolated `.omp/agent/sessions/` workspace directory.
- Generic child `context` callbacks execute. However, the shipped navigation
  extension's `session_start` guard returns for `ctx.agent.kind === "sub"`,
  before registering rewriting hooks, a worker, or tools. The child native ID
  had **zero** entries in `adapter_sessions`; child outgoing requests had no
  navigation reminder or advertised `manage_context` tool. Existing OMP tests
  also verify this inert behavior, including depth-zero clones.
- Thus a native child identity exists, but activating/registering it and binding
  it to Paseo would be new integration work. Safe child mutation/rewrite was
  not demonstrated by this probe; the inert guard remains unchanged.

## Hermes: observed live and limits

- A real `delegate_task` background delegation completed a child `read_file`
  and returned `CHILD_COMPLETE: inspected fixture, owner Orchid.` The parent
  Paseo agent was `620393fc-4d91-425c-ae6f-e1bfb82e3c50`.
- `listProviderSubagents(parentAgentId)` returned `subagents: []`, `error: null`,
  including after completion. No Hermes child tab or SDK child snapshot was
  exposed in this probe. There is therefore no child `params.agentId` or
  `PluginAgentSnapshot.parentAgentId` observation to report for Hermes.
- The shared DB contained the distinct child scope
  `hermes:default:20261110_054240_389a50:unknown`, with the `child-read` target.
  The captured child request included the navigation candidate reminder naming
  `child-read`. In `adapters/hermes/factories.py`, `make_middleware` derives
  scope from the dispatched `session_id`, registers it and runs `_engine_step`
  with `publish_targets=True` for supported modes. The DB target plus the
  outgoing reminder are evidence that this child traversed that middleware
  path, not evidence of a successful child Hide/Unhide round trip.
- Direct scratch callback logging did not produce a trace; it is not used as
  evidence that the callback was absent. Child mutation/replacement and a
  reliable Paseo-child-to-native-scope mapping remain **unverified**.
- No child request advertised `manage_context`. No extra tools, middleware,
  scopes or adapter capability claims were added by this change.
- Consequently Hermes's fallback on an actual child tab could not be visually
  exercised. The generic SDK child-parent path is unit-tested, not Hermes-live
  verified. Normal Hermes main-session behavior remains as documented in
  [Phase 6](phase6-live-verification.md).

## Blanking hypothesis and UI verification

The first scratch stub reused the completion ID `stub` across parent and child.
That collision accidentally let the old timeline matcher select a main session
on the child tab, without the required notice. Removing the collision in the
rendered DOM made the old panel blank; this was only a diagnostic, not the
final live reproduction. A fresh real OMP delegation with distinct stub
completion IDs then reproduced **No session in view** on the original packed
plugin. Its focused child identities matched none of the workspace SDK agents;
`resolveSessionTarget` returned null and `setInView(!!id)` hid the outline.

After rebuilding, packing and reloading the changed plugin into the isolated
daemon, that same child tab displayed the main outline and exact notice.
Clicking its main user row selected the main agent tab and invoked
`scrollIntoView` on the main message `cf75615a`, not the child. The target was
visible in the main chat; the notice cleared after following caught up and
there was no `Not loaded in chat` warning. The scroll method was instrumented
in the browser without replacing its behavior to record the target identity.

Screenshots outside the repository:

- `/Users/devin/nav-phase0-gates/screens/paseo-subagent-before-unique.png`
- `/Users/devin/nav-phase0-gates/screens/paseo-subagent-main-outline.png`
- `/Users/devin/nav-phase0-gates/screens/paseo-subagent-row-main-navigation.png`

Scratch scripts, request payloads, identities, panel props and navigation
results are retained under `/Users/devin/nav-phase0-gates/phase7-subagents/`.
The isolated homes remain available; default Paseo/Hermes configuration was
not edited.

## Automated checks

New unit coverage exercises the live tab shape, embedded underscores,
malformed/empty/ambiguous targets, hidden tabs, SDK parent chains, parent
lookup failure/cycles, and opening/waiting/scrolling the main chat. Navigation
throws and missing main-chat timeouts report failure instead of scrolling a
child. Existing normal-follow and OMP inert-child tests remain enabled.

After the final runtime edits: Paseo build/typecheck; 121 Paseo tests and 8 Node
worker tests; core typecheck and 17 Node / 17 Bun tests; OMP typecheck and 50
tests; all four Python/Node/Bun differential/cross-writer conformance checks;
Python suite 340 passed / 11 skipped. `git diff --check` was clean.
