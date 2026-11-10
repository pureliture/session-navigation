import { expect, test } from "bun:test";
import { focusedSessionTab, parseSessionTab, subagentMainTarget } from "./subagents";

const providerTab = "workspace-tab-provider_subagent_36_c7e0cdbf-afd3-4fec-8d4f-028d234bdf09_13_AmusedWarbler";
test("reads the live OMP provider-internal tab without treating its child ID as a Paseo agent", () => {
  expect(parseSessionTab(providerTab)).toEqual({ kind: "provider_subagent", parentAgentId: "c7e0cdbf-afd3-4fec-8d4f-028d234bdf09", subagentId: "AmusedWarbler" });
  expect(parseSessionTab("workspace-tab-provider_subagent_3_a_b_3_c_d")).toEqual({ kind: "provider_subagent", parentAgentId: "a_b", subagentId: "c_d" });
  expect(parseSessionTab("workspace-tab-agent_child")).toEqual({ kind: "agent", agentId: "child" });
});

test.each(["", "workspace-tab-agent_", "workspace-tab-files", "workspace-tab-provider_subagent_0__1_c",
  "workspace-tab-provider_subagent_01_a_1_c", "workspace-tab-provider_subagent_5_a_1_c", "workspace-tab-provider_subagent_1_a_1_c_trailing",
  "workspace-tab-provider_subagent_99999999999999999999_a_1_c"])("refuses malformed or non-session targets: %s", (value) => {
  expect(parseSessionTab(value)).toBeNull();
});

test("focused tab discovery ignores mounted hidden tabs and never guesses ambiguous panes", () => {
  const node = (id: string, visible = true) => ({ getAttribute: () => id, getClientRects: () => visible ? [{}] : [] });
  const doc = (nodes: any[]) => ({ querySelectorAll: () => nodes });
  expect(focusedSessionTab(doc([node("workspace-tab-agent_other", false), node(providerTab)]))?.kind).toBe("provider_subagent");
  expect(focusedSessionTab(doc([node("workspace-tab-agent_a"), node(providerTab)]))).toEqual({ kind: "unresolved_subagent" });
  expect(focusedSessionTab(doc([node("workspace-tab-provider_subagent_invalid")]))).toEqual({ kind: "unresolved_subagent" });
  expect(focusedSessionTab(doc([]))).toBeNull();
  expect(focusedSessionTab(undefined)).toBeNull();
});

test("provider child fallback resolves the actual parent's root, not a previous visible or pinned agent", async () => {
  const calls: string[] = [];
  expect(await subagentMainTarget({ kind: "provider_subagent", parentAgentId: "parent", subagentId: "child" }, async (id) => {
    calls.push(id); return id === "parent" ? "main" : null;
  })).toEqual({ agentId: "main", subagent: true });
  expect(calls).toEqual(["parent", "main"]);
});

test("SDK child snapshots follow parentAgentId while ordinary main, empty and non-session tabs retain normal following", async () => {
  expect(await subagentMainTarget({ kind: "agent", agentId: "child" }, async (id) => id === "child" ? "main" : null))
    .toEqual({ agentId: "main", subagent: true });
  expect(await subagentMainTarget({ kind: "agent", agentId: "main" }, async () => null)).toEqual({ agentId: null, subagent: false });
  expect(await subagentMainTarget(null, async () => { throw new Error("must not load"); })).toEqual({ agentId: null, subagent: false });
  expect(await subagentMainTarget({ kind: "unresolved_subagent" }, async () => { throw new Error("must not guess"); }))
    .toEqual({ agentId: null, subagent: true });
});

test("missing parents and cycles fail closed instead of displaying another scope", async () => {
  const tab = { kind: "provider_subagent", parentAgentId: "parent", subagentId: "child" } as const;
  expect(await subagentMainTarget(tab, async () => { throw new Error("offline"); })).toEqual({ agentId: null, subagent: true });
  expect(await subagentMainTarget(tab, async (id) => id === "parent" ? "other" : "parent")).toEqual({ agentId: null, subagent: true });
});
