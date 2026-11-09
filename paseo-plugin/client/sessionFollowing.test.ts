import { expect, test } from "bun:test";
import { readSessionTimelineIds, resolveSessionTarget } from "./sessionFollowing";
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

test("existing agent-bound panel still supports an empty chat", async () => {
  expect(await resolveSessionTarget({ followVisible: true, boundAgentId: "a", visibleValues: [], candidates, timelineIds })).toBe("a");
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
  const load = (id: string) => client.fetchQuery({ queryKey: ["session-nav-follow", id], staleTime: 10_000,
    queryFn: () => id === "a" ? readSessionTimelineIds(timeline) : Promise.resolve(["b-call"]) });
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
  expect(await read({ entries: [], hasOlder: false })).toEqual([]);
  expect(await read({ entries: [{ item: { messageId: "message" } }, { item: { callId: "call" } },
    { item: { id: "row", messageId: 0 } }], hasOlder: false })).toEqual(["message", "call", "row"]);
  await expect(read({ error: "offline" })).rejects.toThrow("offline");
});
