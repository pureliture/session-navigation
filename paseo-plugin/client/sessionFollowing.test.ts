import { acceptWorkspaceAgentId, boundRootSessions, hasDomDocument, nextWorkspaceTrackedAgent, readSessionTimelineIds, resolveSessionTarget, resolveWorkspaceSessionState, selectMainOrFallbackAgent, sessionFollowCandidates, workspaceHeaderText } from "./sessionFollowing";
import { QueryClient } from "@tanstack/react-query";
import { defaultWorkspaceState, selectWorkspaceAgent, workspaceTabSchema } from "./workspaceState";

const candidates = ["a", "b"];
const timelineIds = async (id: string) => id === "a" ? ["a-message"] : ["b-call"];
const restored = (state: unknown) => workspaceTabSchema.parse(JSON.parse(JSON.stringify(state)));
const follow = (state: typeof defaultWorkspaceState, visibleValues: string[] | null, load = timelineIds) => resolveSessionTarget({
  followVisible: !state.agentId, boundAgentId: state.agentId ?? "", visibleValues, candidates, timelineIds: load,
});

test("workspace defaults to following the visible session without a picker selection", async () => {
  const state = restored(defaultWorkspaceState);
  expect(state.agentId).toBeNull();
  expect(await follow(state, ["message-a-message"])).toBe("a");
  expect(await follow(state, ["agent_tool_b-call"])).toBe("b");
});

test("default follow is unbound for non-session tabs, empty chats and unmatched chats", async () => {
  expect(await follow(defaultWorkspaceState, null)).toBeNull();
  expect(await follow(defaultWorkspaceState, [])).toBeNull();
  expect(await follow(defaultWorkspaceState, ["unbound-message"])).toBeNull();
});

test("pin survives restoration and overrides visible-session matching without fetching timelines", async () => {
  const state = restored(selectWorkspaceAgent("b"));
  let calls = 0;
  const load = async () => { calls++; return []; };
  expect(await follow(state, ["message-a-message"], load)).toBe("b");
  expect(await follow(state, null, load)).toBe("b");
  expect(calls).toBe(0);
});

test("unpin persists follow mode and resumes switching and unbound behavior", async () => {
  const pinned = restored(selectWorkspaceAgent("b"));
  expect(await follow(pinned, ["message-a-message"])).toBe("b");
  const state = restored(selectWorkspaceAgent(null));
  expect(await follow(state, ["message-a-message"])).toBe("a");
  expect(await follow(state, ["agent_tool_b-call"])).toBe("b");
  expect(await follow(state, null)).toBeNull();
});

test("a failed candidate does not prevent following another candidate", async () => {
  expect(await follow(defaultWorkspaceState, ["agent_tool_b-call"], async (id) => {
    if (id === "a") throw new Error("offline");
    return timelineIds(id);
  })).toBe("b");
});

test("unpinning a workspace panel does not wait for unrelated global scope timelines", async () => {
  const peer = "b6066745-20f3-4fcd-bffb-fe1a3888bb54";
  const main = "18a1458f-c28b-4c56-b58d-3749899f0944";
  const unrelated = "b4ce974f-be72-4364-b0d3-4f7fff0f8088";
  const ids = ["c852fb19", "gen-1794224260-5CkaaM84iPOsEpqrDZnK"];
  const state = restored(selectWorkspaceAgent(null));
  const calls: string[] = [];
  let release!: (ids: string[]) => void;
  const blocked = new Promise<string[]>((resolve) => { release = resolve; });
  let matched: string | null | undefined;
  const result = resolveSessionTarget({
    followVisible: !state.agentId, boundAgentId: state.agentId ?? "", visibleValues: ids,
    candidates: sessionFollowCandidates([peer, main], [unrelated, main, peer]),
    timelineIds: async (id) => { calls.push(id); return id === unrelated ? blocked : id === peer ? ids : ["main-message"]; },
  }).then((id) => { matched = id; return id; });
  try {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(matched).toBe(peer);
    expect(calls).toEqual([peer, main]);
  } finally { release([]); await result; }
});

test("workspace candidate discovery remains authoritative while empty; agent panels retain scope discovery", () => {
  expect(sessionFollowCandidates([], ["other-workspace"])).toEqual([]);
  expect(sessionFollowCandidates(undefined, ["a", "b"])).toEqual(["a", "b"]);
});

test("agent-bound follow mode unbinds for an empty chat rather than guessing its original agent", async () => {
  expect(await resolveSessionTarget({ followVisible: true, boundAgentId: "a", visibleValues: [], candidates, timelineIds })).toBeNull();
});

test.each(["", "a"])("a navigator opened with agent %s clears its previous match on an empty chat", async (boundAgentId) => {
  const resolve = (visibleValues: string[] | null) => resolveSessionTarget({
    followVisible: true, boundAgentId, visibleValues, candidates, timelineIds,
  });
  expect(await resolve(["message-a-message"])).toBe("a");
  expect(await resolve([])).toBeNull();
  expect(await resolve(["agent_tool_b-call"])).toBe("b");
  expect(await resolve([])).toBeNull();
  expect(await resolve(null)).toBeNull();
  expect(await resolve(["message-a-message"])).toBe("a");
});

test("follow matches older visible messages outside the last 200 events and caches all identities", async () => {
  const all = Array.from({ length: 1400 }, (_, i) => ({ item: { type: "user_message", messageId: `a-message-${i}` } }));
  const calls: any[] = [];
  const timeline = { refetch: async (input: any): Promise<any> => {
    calls.push(input);
    const end = input.direction === "tail" ? all.length : input.cursor.seq;
    const start = Math.max(0, end - input.limit);
    return { entries: all.slice(start, end), hasOlder: start > 0, startCursor: { epoch: "e", seq: start } };
  } };
  const client = new QueryClient();
  const load = async (id: string) => (await client.fetchQuery({ queryKey: ["session-nav-follow", id],
    staleTime: (query) => query.state.data?.complete ? 10_000 : 0,
    queryFn: () => id === "a" ? readSessionTimelineIds(timeline) : Promise.resolve({ ids: ["b-call"], complete: true }) })).ids;
  try {
    expect(await follow(defaultWorkspaceState, ["message-a-message-1399"], load)).toBe("a");
    const fetched = calls.length;
    expect(await follow(defaultWorkspaceState, ["message-a-message-0"], load)).toBe("a");
    expect(calls.length).toBe(fetched);
    expect(calls.map((call) => call.direction)).toEqual(["tail", "before"]);
    expect(await follow(defaultWorkspaceState, ["agent_tool_b-call"], load)).toBe("b");
    expect(await follow(defaultWorkspaceState, null, load)).toBeNull();
    expect(await follow(defaultWorkspaceState, ["unknown"], load)).toBeNull();
  } finally { client.clear(); }
});

test("session identity history handles empty timelines, canonical identity kinds and fetch errors", async () => {
  const read = (page: any) => readSessionTimelineIds({ refetch: async (): Promise<any> => page });
  expect(await read({ entries: [], hasOlder: false })).toEqual({ ids: [], complete: true });
  expect(await read({ entries: [{ item: { messageId: "message" } }, { item: { callId: "call" } },
    { item: { id: "row", messageId: 0 } }], hasOlder: false })).toEqual({ ids: ["message", "call", "row"], complete: true });
  await expect(read({ error: "offline" })).rejects.toThrow("offline");
  await expect(readSessionTimelineIds({ refetch: async () => { throw new Error("offline"); } })).rejects.toThrow("offline");
});

test.each(["payload", "rejection"])("an older-page %s failure keeps the recent chat matched", async (failure) => {
  const timeline = { refetch: async (input: any): Promise<any> => {
    if (input.direction === "tail") return { entries: [{ item: { messageId: "a-message" } }],
      hasOlder: true, startCursor: { epoch: "e", seq: 10 } };
    if (failure === "rejection") throw new Error("older page offline");
    return { error: "older page offline" };
  } };
  expect(await follow(defaultWorkspaceState, ["message-a-message"], async (id) =>
    id === "a" ? (await readSessionTimelineIds(timeline)).ids : ["b-call"])).toBe("a");
});

test("incomplete identity history retries immediately, then caches the recovered full history", async () => {
  let calls = 0;
  let failOlder = true;
  const timeline = { refetch: async (input: any): Promise<any> => {
    calls++;
    if (input.direction === "tail") return { entries: [{ item: { messageId: "a-message" } }],
      hasOlder: true, startCursor: { epoch: "e", seq: 10 } };
    if (failOlder) { failOlder = false; return { error: "older page offline" }; }
    return { entries: [{ item: { messageId: "old-message" } }], hasOlder: false };
  } };
  const client = new QueryClient();
  const options = { queryKey: ["session-nav-follow", "a"],
    staleTime: (query: { state: { data?: { complete: boolean } } }) => query.state.data?.complete ? 10_000 : 0,
    queryFn: () => readSessionTimelineIds(timeline) };
  try {
    expect(await client.fetchQuery(options)).toEqual({ ids: ["a-message"], complete: false });
    expect(calls).toBe(2);
    expect(await client.fetchQuery(options)).toEqual({ ids: ["old-message", "a-message"], complete: true });
    expect(calls).toBe(4);
    await client.fetchQuery(options);
    expect(calls).toBe(4);
  } finally { client.clear(); }
});

test("hasDomDocument detects a DOM-like document", () => {
  expect(hasDomDocument({ querySelectorAll: () => [] })).toBe(true);
  expect(hasDomDocument({})).toBe(false);
  expect(hasDomDocument(undefined)).toBe(false);
  expect(hasDomDocument(null)).toBe(false);
});

test("boundRootSessions keeps only root scopes with agents and prefers omp over pi aliases", () => {
  const scopes = [
    { scope_key: "pi:default:a:default", agent_id: "a", items: 5 },
    { scope_key: "omp:default:a:default", agent_id: "a", items: 1 },
    { scope_key: "omp:default:child:default", parent_scope: "omp:default:a:default", agent_id: "child", items: 9 },
    { scope_key: "omp:default:noagent:default", items: 9 },
    { scope_key: "omp:default:empty:default", agent_id: "", items: 9 },
    { scope_key: "hermes:default:b:unknown", agent_id: "b", items: 3 },
  ];
  expect(boundRootSessions(scopes)).toEqual([
    { agentId: "b", scopeKey: "hermes:default:b:unknown", items: 3, adapter: "hermes" },
    { agentId: "a", scopeKey: "omp:default:a:default", items: 1, adapter: "omp" },
  ]);
});

test("boundRootSessions breaks adapter ties by items then scope key", () => {
  const byItems = [
    { scope_key: "omp:default:a:one", agent_id: "a", items: 1 },
    { scope_key: "omp:default:a:two", agent_id: "a", items: 4 },
  ];
  expect(boundRootSessions(byItems)).toEqual([{ agentId: "a", scopeKey: "omp:default:a:two", items: 4, adapter: "omp" }]);
  const byKey = [
    { scope_key: "omp:default:a:b", agent_id: "a", items: 2 },
    { scope_key: "omp:default:a:a", agent_id: "a", items: 2 },
  ];
  expect(boundRootSessions(byKey)).toEqual([{ agentId: "a", scopeKey: "omp:default:a:a", items: 2, adapter: "omp" }]);
});

test("boundRootSessions filters and orders by workspaceAgentIds", () => {
  const scopes = [
    { scope_key: "omp:default:a:default", agent_id: "a", items: 1 },
    { scope_key: "omp:default:b:default", agent_id: "b", items: 1 },
    { scope_key: "omp:default:c:default", agent_id: "c", items: 1 },
  ];
  expect(boundRootSessions(scopes, undefined).map((s) => s.agentId)).toEqual(["a", "b", "c"]);
  expect(boundRootSessions(scopes, [])).toEqual([]);
  expect(boundRootSessions(scopes, ["b", "a"]).map((s) => s.agentId)).toEqual(["b", "a"]);
});

test("native follow tracks the focused workspace agent across switches and non-agent tabs", () => {
  const two = [
    { agentId: "a", scopeKey: "omp:default:a:default", items: 1, adapter: "omp" },
    { agentId: "b", scopeKey: "omp:default:b:default", items: 1, adapter: "omp" },
  ];
  const base = { pinnedAgentId: null, hasDocument: false, demandedAgentIds: [] as string[], boundSessions: two, workspaceAgentIds: ["a", "b"] as const };
  expect(resolveWorkspaceSessionState({ ...base, trackedAgentId: null, hasTrackerSignal: false, trackerSupported: true }))
    .toEqual({ mode: "chooser", effectiveAgentId: null, unavailablePin: false });
  expect(resolveWorkspaceSessionState({ ...base, trackedAgentId: "a", hasTrackerSignal: true, trackerSupported: true }))
    .toEqual({ mode: "follow", effectiveAgentId: "a", unavailablePin: false });
  expect(resolveWorkspaceSessionState({ ...base, trackedAgentId: "b", hasTrackerSignal: true, trackerSupported: true }))
    .toEqual({ mode: "follow", effectiveAgentId: "b", unavailablePin: false });
  expect(resolveWorkspaceSessionState({ ...base, trackedAgentId: null, hasTrackerSignal: true, trackerSupported: true }))
    .toEqual({ mode: "chooser", effectiveAgentId: null, unavailablePin: false });
});

test("native single bound session auto-selects without a focus signal", () => {
  const one = [{ agentId: "a", scopeKey: "omp:default:a:default", items: 2, adapter: "omp" }];
  expect(resolveWorkspaceSessionState({ pinnedAgentId: null, trackedAgentId: null, hasTrackerSignal: false,
    trackerSupported: false, hasDocument: false, demandedAgentIds: [], boundSessions: one }))
    .toEqual({ mode: "single-auto", effectiveAgentId: "a", unavailablePin: false });
  expect(resolveWorkspaceSessionState({ pinnedAgentId: null, trackedAgentId: null, hasTrackerSignal: false,
    trackerSupported: true, hasDocument: false, demandedAgentIds: [], boundSessions: one, workspaceAgentIds: ["a"] }))
    .toEqual({ mode: "single-auto", effectiveAgentId: "a", unavailablePin: false });
});

test("native demanded seed follows a single candidate but stays chooser when ambiguous", () => {
  const base = { pinnedAgentId: null, trackedAgentId: null, hasTrackerSignal: false, trackerSupported: true,
    hasDocument: false, boundSessions: [] as { agentId: string; scopeKey: string; items: number; adapter: string }[] };
  expect(resolveWorkspaceSessionState({ ...base, demandedAgentIds: ["a"] }))
    .toEqual({ mode: "follow", effectiveAgentId: "a", unavailablePin: false });
  expect(resolveWorkspaceSessionState({ ...base, demandedAgentIds: ["a", "b"] }))
    .toEqual({ mode: "chooser", effectiveAgentId: null, unavailablePin: false });
});

test("unavailable pinned sessions fall back to the chooser with a notice", () => {
  expect(resolveWorkspaceSessionState({ pinnedAgentId: "missing", trackedAgentId: null, hasTrackerSignal: false,
    trackerSupported: true, hasDocument: false, demandedAgentIds: [], boundSessions: [], workspaceAgentIds: ["a"] }))
    .toEqual({ mode: "chooser", effectiveAgentId: null, unavailablePin: true });
  expect(resolveWorkspaceSessionState({ pinnedAgentId: "a", trackedAgentId: null, hasTrackerSignal: false,
    trackerSupported: true, hasDocument: false, demandedAgentIds: [], boundSessions: [], workspaceAgentIds: ["a"] }))
    .toEqual({ mode: "pinned", effectiveAgentId: "a", unavailablePin: false });
});

test("web always follows the visible session when unpinned", () => {
  expect(resolveWorkspaceSessionState({ pinnedAgentId: null, trackedAgentId: "a", hasTrackerSignal: false,
    trackerSupported: true, hasDocument: true, demandedAgentIds: [], boundSessions: [] }))
    .toEqual({ mode: "follow", effectiveAgentId: "a", unavailablePin: false });
  expect(resolveWorkspaceSessionState({ pinnedAgentId: null, trackedAgentId: null, hasTrackerSignal: false,
    trackerSupported: true, hasDocument: true, demandedAgentIds: [], boundSessions: [] }))
    .toEqual({ mode: "follow", effectiveAgentId: null, unavailablePin: false });
});

test("acceptWorkspaceAgentId guards against cross-workspace leaks", () => {
  expect(acceptWorkspaceAgentId({ agentId: null, panelWorkspaceId: "w" })).toBe("reject");
  expect(acceptWorkspaceAgentId({ agentId: "a", agentWorkspaceId: "w", panelWorkspaceId: "w" })).toBe("accept");
  expect(acceptWorkspaceAgentId({ agentId: "a", agentWorkspaceId: "other", panelWorkspaceId: "w" })).toBe("reject");
  expect(acceptWorkspaceAgentId({ agentId: "a", workspaceCandidateIds: ["a"], panelWorkspaceId: "w" })).toBe("accept");
  expect(acceptWorkspaceAgentId({ agentId: "b", workspaceCandidateIds: ["a"], panelWorkspaceId: "w" })).toBe("reject");
  expect(acceptWorkspaceAgentId({ agentId: "a", panelWorkspaceId: "w" })).toBe("unknown");
  expect(acceptWorkspaceAgentId({ agentId: "a" })).toBe("accept");
});

test("visible-session follow tracks the focused agent tab and falls back to the resolved target", () => {
  expect(selectMainOrFallbackAgent({ tab: { kind: "agent", agentId: "agent-1" },
    followVisible: true, resolvedTarget: "target" }))
    .toEqual({ agentId: "agent-1", inView: true });
  expect(selectMainOrFallbackAgent({ tab: null, followVisible: true, resolvedTarget: "target" }))
    .toEqual({ agentId: "target", inView: true });
  expect(selectMainOrFallbackAgent({ tab: { kind: "agent", agentId: "agent-1" },
    followVisible: false, resolvedTarget: "pinned" }))
    .toEqual({ agentId: "pinned", inView: true });
  expect(selectMainOrFallbackAgent({ tab: null, followVisible: true, resolvedTarget: null }))
    .toEqual({ agentId: null, inView: false });
});

test("workspace header names the single-auto session instead of Follow visible session", () => {
  const pinned = workspaceHeaderText({ pinnedAgentId: "agent-1", pinnedTitle: "Alpha", mode: "pinned", hasDocument: true, effectiveAgentId: "agent-1", effectiveTitle: "Alpha" });
  expect(pinned).toBe("Pinned · Alpha ▾");
  const chooser = workspaceHeaderText({ pinnedAgentId: null, mode: "chooser", hasDocument: true, effectiveAgentId: null });
  expect(chooser).toBe("Choose a session ▾");
  // Desktop web (hasDocument) with followVisible=false resolves single-auto:
  // the header must name the session, matching the dropdown behavior.
  const singleAutoWeb = workspaceHeaderText({ pinnedAgentId: null, mode: "single-auto", hasDocument: true, effectiveAgentId: "agent-1", effectiveTitle: "Alpha" });
  expect(singleAutoWeb).toBe("Session · Alpha ▾");
  const singleAutoNative = workspaceHeaderText({ pinnedAgentId: null, mode: "single-auto", hasDocument: false, effectiveAgentId: "agent-1", effectiveTitle: "Alpha" });
  expect(singleAutoNative).toBe("Session · Alpha ▾");
  const followNative = workspaceHeaderText({ pinnedAgentId: null, mode: "follow", hasDocument: false, effectiveAgentId: "agent-1", effectiveTitle: "Alpha" });
  expect(followNative).toBe("Following · Alpha ▾");
  // Untitled agents fall back to the id prefix; empty follow state keeps the generic label.
  const untitled = workspaceHeaderText({ pinnedAgentId: null, mode: "single-auto", hasDocument: true, effectiveAgentId: "agent-123456" });
  expect(untitled).toBe("Session · agent-12 ▾");
  const emptyFollow = workspaceHeaderText({ pinnedAgentId: null, mode: "follow", hasDocument: true, effectiveAgentId: null });
  expect(emptyFollow).toBe("Follow visible session ▾");
});

test("workspace tracking resets last-valid state on workspace switch", () => {
  const base = {
    rawHasSignal: true,
    membership: "accept" as const,
    candidateAgentIds: ["a"],
    panelWorkspaceId: "w1",
    lookupWorkspaceId: null,
    lookupLoaded: true,
    workspaceChanged: false,
    lastValid: "a",
    tracked: "a",
  };
  expect(nextWorkspaceTrackedAgent({ ...base, rawFocusedId: "a" })).toEqual({ lastValid: "a", tracked: "a" });
  // Workspace switch drops stale selections even when the focus signal still names the old agent.
  expect(nextWorkspaceTrackedAgent({ ...base, rawFocusedId: "a", workspaceChanged: true })).toEqual({ lastValid: null, tracked: null });
  // Null focus with a signal clears; without a signal the previous tracking is preserved.
  expect(nextWorkspaceTrackedAgent({ ...base, rawFocusedId: null })).toEqual({ lastValid: null, tracked: null });
  expect(nextWorkspaceTrackedAgent({ ...base, rawFocusedId: null, rawHasSignal: false })).toEqual({ lastValid: "a", tracked: "a" });
  // Reject and unknown-with-loading hold the last valid agent instead of guessing.
  expect(nextWorkspaceTrackedAgent({ ...base, membership: "reject", rawFocusedId: "b" })).toEqual({ lastValid: "a", tracked: "a" });
  expect(nextWorkspaceTrackedAgent({ ...base, membership: "unknown", rawFocusedId: "b", lookupLoaded: false })).toEqual({ lastValid: "a", tracked: "a" });
  // Unknown membership resolves through the workspace lookup.
  expect(nextWorkspaceTrackedAgent({ ...base, membership: "unknown", rawFocusedId: "b", lookupWorkspaceId: "w1" })).toEqual({ lastValid: "b", tracked: "b" });
  expect(nextWorkspaceTrackedAgent({ ...base, membership: "unknown", rawFocusedId: "b", lookupWorkspaceId: "w2" })).toEqual({ lastValid: "a", tracked: "a" });
});
