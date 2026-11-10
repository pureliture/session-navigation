import { expect, test } from "bun:test";
import { focusedSessionTab, openProviderSubagent, supportedHostVersion } from "./hostCompat";
import { subagentMainTarget } from "./subagents";

const parent = "parent", child = "Bird";
const childId = "workspace-tab-provider_subagent_6_parent_4_Bird";
function fixture() {
  let selected = "workspace-tab-agent_parent";
  let opened = false;
  const clicked: string[] = [];
  const node = (id: string) => ({ getAttribute: () => id, click: () => {
    clicked.push(id);
    if (id.startsWith("workspace-tab-")) selected = id;
    if (id === "subagents-track-header") opened = true;
    if (id === "subagents-track-row-Bird") selected = childId;
  } });
  const doc = { querySelectorAll: (selector: string) => selector.includes("aria-selected") ? [node(selected)] :
    [node(selected), node("subagents-track-header"), ...(opened ? [node("subagents-track-row-Bird")] : [])] };
  return { doc, clicked, select: (id: string) => { selected = id; } };
}

test("known untested versions disable following/opening; unknown hosts require structural guards", async () => {
  expect(supportedHostVersion("0.15.3")).toBe(true);
  expect(supportedHostVersion(null)).toBe(true);
  expect(supportedHostVersion("0.16.0")).toBe(false);
  const f = fixture(); f.select(childId);
  const unsupported = focusedSessionTab(f.doc, "0.16.0");
  expect(unsupported).toEqual({ kind: "unresolved_subagent", parentAgentId: parent });
  expect(await subagentMainTarget(unsupported, async () => null)).toEqual({ agentId: parent, subagent: true });
  expect(await openProviderSubagent(f.doc, parent, child, { version: "0.16.0", openParent() {} })).toBe(false);
  expect(f.clicked).toEqual([]);
  const versioned = { ...f.doc, defaultView: { location: { pathname: "/h/host/workspace/w" },
    __paseoHostRuntimeStore: { getClient: () => ({ getLastServerInfoMessage: () => ({ version: "0.16.0" }) }) } } };
  expect(focusedSessionTab(versioned)).toEqual({ kind: "unresolved_subagent", parentAgentId: parent });
  expect(await openProviderSubagent(versioned, parent, child, { openParent() {} })).toBe(false);
});

test("opener clicks an existing tab or safely opens the parent's native track", async () => {
  const f = fixture(); f.select(childId);
  expect(await openProviderSubagent(f.doc, parent, child, { openParent() {} })).toBe(true);
  expect(f.clicked).toEqual([]);
  f.select("workspace-tab-agent_other");
  expect(await openProviderSubagent(f.doc, parent, child, { openParent: () => f.select("workspace-tab-agent_parent"), wait: async () => {} })).toBe(true);
  expect(f.clicked).toEqual(["subagents-track-header", "subagents-track-row-Bird"]);
});

test("opening from the parent settles the initiating event without reopening the parent", async () => {
  const f = fixture();
  let settled = false;
  expect(await openProviderSubagent(f.doc, parent, child, {
    openParent() { throw new Error("must not navigate again and dismiss the native popup"); },
    wait: async () => { settled = true; },
  })).toBe(true);
  expect(settled).toBe(true);
  expect(f.clicked).toEqual(["subagents-track-header", "subagents-track-row-Bird"]);
});

test("an inactive existing child tab is clicked without opening the parent's track", async () => {
  let selected = "workspace-tab-agent_parent";
  const node = (id: string) => ({ getAttribute: () => id, click: () => { selected = id; } });
  const doc = { querySelectorAll: (selector: string) => selector.includes("aria-selected") ? [node(selected)] : [node(childId)] };
  expect(await openProviderSubagent(doc, parent, child, { openParent() { throw new Error("not needed"); } })).toBe(true);
  expect(selected).toBe(childId);
});

test("missing track, ambiguous selection, and click errors fail closed", async () => {
  const options = { openParent() {}, wait: async () => {} };
  expect(await openProviderSubagent({}, parent, child, options)).toBe(false);
  const doc = { querySelectorAll: () => ["workspace-tab-agent_parent", childId].map((id) => ({ getAttribute: () => id })) };
  expect(await openProviderSubagent(doc, parent, child, options)).toBe(false);
  const f = fixture();
  f.select("workspace-tab-agent_other");
  expect(await openProviderSubagent(f.doc, parent, child, { ...options, openParent() { throw new Error("offline"); } })).toBe(false);
});
