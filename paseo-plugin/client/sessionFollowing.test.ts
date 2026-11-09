import { expect, test } from "bun:test";
import { resolveSessionTarget } from "./sessionFollowing";
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
