import { expect, test } from "bun:test";
import { childrenForCall, hasMissingLinkedChildren, linkedTimelineFetchNeeded, scopeForAgent } from "./subagents";

test("scope binding is exact and refuses ambiguous matches", () => {
  const parent = { scope_key: "omp:default:parent:default", agent_id: "parent" };
  const child = { scope_key: "omp:default:child:default", parent_scope: parent.scope_key, subagent_id: "Bird", tool_call_id: "task-call" };
  const scopes = [parent, child];
  expect(scopeForAgent(scopes, "parent")).toBe(parent.scope_key);
  expect(scopeForAgent([...scopes, { ...parent, scope_key: "omp:default:other:default" }], "parent")).toBeNull();
  expect(scopeForAgent([], "missing")).toBeNull();
  expect(scopeForAgent([{ scope_key: "pi:default:agent-1:default" }], "agent-1")).toBe("pi:default:agent-1:default");
  expect(scopeForAgent([{ scope_key: "paseo:default:agent-1:default" }], "agent-1")).toBe("paseo:default:agent-1:default");
});

test("childrenForCall matches exact linked calls and refuses anything else", () => {
  const parent = { scope_key: "omp:default:parent:default", agent_id: "parent" };
  const child = { scope_key: "omp:default:child:default", parent_scope: parent.scope_key, subagent_id: "Bird", tool_call_id: "task-call" };
  const scopes = [parent, child];
  expect(childrenForCall(scopes, parent.scope_key, "task-call")).toEqual([child]);
  expect(childrenForCall(scopes, parent.scope_key, "unrelated")).toEqual([]);
  const hermes = { ...child, scope_key: "hermes:default:child:unknown", parent_scope: "hermes:default:parent:unknown" };
  expect(childrenForCall([hermes], hermes.parent_scope, "task-call")).toEqual([hermes]);
});

test("rotation fallback matches h-new subagent children while the panel addresses h-old", () => {
  const oldParent = "hermes:default:session-old:unknown";
  const newParent = "hermes:default:session-new:unknown";
  const rotated = { scope_key: "hermes:default:child:unknown", parent_scope: newParent, tool_call_id: "call-1", subagent_id: "sa-1" };
  // Rotation-moved child resolves under the pre-rotation parent scope.
  expect(childrenForCall([rotated], oldParent, "call-1")).toEqual([rotated]);
  // Exact parent_scope matches always win; the fallback never merges in.
  const exact = { scope_key: "hermes:default:child2:unknown", parent_scope: oldParent, tool_call_id: "call-1", subagent_id: "sa-2" };
  expect(childrenForCall([rotated, exact], oldParent, "call-1")).toEqual([exact]);
  // Mismatched call ids and other profiles never match.
  expect(childrenForCall([rotated], oldParent, "call-other")).toEqual([]);
  const otherProfile = { ...rotated, parent_scope: "hermes:atlas:session-new:unknown" };
  expect(childrenForCall([otherProfile], oldParent, "call-1")).toEqual([]);
  // OMP scopes keep exact matching only (no rotation fallback).
  const ompParent = "omp:default:parent:default";
  const ompChild = { scope_key: "omp:default:child:default", parent_scope: "omp:default:other:default", tool_call_id: "call-1", subagent_id: "Bird" };
  expect(childrenForCall([ompChild], ompParent, "call-1")).toEqual([]);
});

test("hasMissingLinkedChildren ignores server-owned rows and rotation-moved in-flight calls", () => {
  const oldParent = "hermes:default:session-old:unknown";
  const newParent = "hermes:default:session-new:unknown";
  const rotated = { scope_key: "hermes:default:child:unknown", parent_scope: newParent, tool_call_id: "call-1", subagent_id: "sa-1" };
  expect(hasMissingLinkedChildren([], [rotated], oldParent)).toBe(true);
  // Server already owns the row (e.g. toolResult landed): nothing missing.
  expect(hasMissingLinkedChildren([{ tool_call_id: "call-1" }], [rotated], oldParent)).toBe(false);
  // No linked children at all.
  expect(hasMissingLinkedChildren([], [], oldParent)).toBe(false);
  expect(hasMissingLinkedChildren([], [{ scope_key: "hermes:default:x:unknown", parent_scope: oldParent }], oldParent)).toBe(false);
});

test("linkedTimelineFetchNeeded fetches only for resolved scopes with server-missing linked rows", () => {
  const scope = "omp:default:parent:default";
  const linked = [{ scope_key: "omp:default:child:default", parent_scope: scope, tool_call_id: "call-1", subagent_id: "Bird" }];
  // Linked call missing from the server list: fetch the merge source.
  expect(linkedTimelineFetchNeeded(true, scope, [], linked)).toBe(true);
  // No linked targets: ordinary server sessions trigger no additional reads.
  expect(linkedTimelineFetchNeeded(true, scope, [], [])).toBe(false);
  expect(linkedTimelineFetchNeeded(true, scope, [{ tool_call_id: "other" }], linked)).toBe(true);
  // Server already owns every linked row.
  expect(linkedTimelineFetchNeeded(true, scope, [{ tool_call_id: "call-1" }], linked)).toBe(false);
  // List not loaded or scope unresolved: nothing to merge against.
  expect(linkedTimelineFetchNeeded(false, scope, [], linked)).toBe(false);
  expect(linkedTimelineFetchNeeded(true, null, [], linked)).toBe(false);
});
