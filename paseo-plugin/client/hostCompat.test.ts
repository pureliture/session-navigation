import { expect, test } from "bun:test";
import {
  demandedWorkspaceAgents,
  focusedSessionTab,
  installHostFocusTracker,
  openProviderSubagent,
  readHostFocus,
  readWebWorkspaceFocusedTab,
  strictSupportedHostVersion,
  subscribeHostFocus,
  supportedHostVersion,
} from "./hostCompat";
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

test("hosts below >=0.15.3 disable following/opening; >=0.15.3 hosts work automatically with structural guards", async () => {
  for (const v of ["0.15.3", "0.15.4", "0.16.0", "0.17.2", "1.0.0", "v0.16.1-rc.1"]) {
    expect(supportedHostVersion(v)).toBe(true);
  }
  expect(supportedHostVersion(null)).toBe(true);
  for (const v of ["0.15.2", "0.14.9", "unknown", ""]) {
    expect(supportedHostVersion(v)).toBe(false);
  }
  const f = fixture(); f.select(childId);
  expect(focusedSessionTab(f.doc, "0.16.0")).toEqual({ kind: "provider_subagent", parentAgentId: parent, subagentId: child });
  const unsupported = focusedSessionTab(f.doc, "0.15.2");
  expect(unsupported).toEqual({ kind: "unresolved_subagent", parentAgentId: parent });
  expect(await subagentMainTarget(unsupported, async () => null)).toEqual({ agentId: parent, subagent: true });
  expect(await openProviderSubagent(f.doc, parent, child, { version: "0.15.2", openParent() {} })).toBe(false);
  expect(f.clicked).toEqual([]);
  const preFloor = { ...f.doc, defaultView: { location: { pathname: "/h/host/workspace/w" },
    __paseoHostRuntimeStore: { getClient: () => ({ getLastServerInfoMessage: () => ({ version: "0.15.2" }) }) } } };
  expect(focusedSessionTab(preFloor)).toEqual({ kind: "unresolved_subagent", parentAgentId: parent });
  expect(await openProviderSubagent(preFloor, parent, child, { openParent() {} })).toBe(false);
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

test("a document-less opener fails before opening the parent or waiting", async () => {
  let opened = 0, waits = 0;
  expect(await openProviderSubagent(undefined, parent, child, {
    openParent() { opened++; },
    wait: async () => { waits++; },
  })).toBe(false);
  expect(opened).toBe(0);
  expect(waits).toBe(0);
});

test("strict host version accepts Paseo >=0.15.3 and rejects pre-0.15.3 or missing versions", () => {
  for (const version of ["0.15.3", "0.15.4", "0.16.0", "0.18.0", "1.2.3"]) {
    expect(strictSupportedHostVersion(version)).toBe(true);
  }
  for (const version of [null, undefined, "0.15.2", "0.14.0", "invalid"]) {
    expect(strictSupportedHostVersion(version)).toBe(false);
  }
});

type Heartbeat = { self: unknown; payload: unknown; extra: unknown };
function heartbeatClient(version: string | null) {
  const calls: Heartbeat[] = [];
  const client = {
    getLastServerInfoMessage: () => ({ version }),
    sendHeartbeat(this: unknown, payload: unknown, extra?: unknown) {
      calls.push({ self: this, payload, extra });
      return "sent";
    },
  };
  return { client, calls, original: client.sendHeartbeat };
}

function focusStore(version: string | null = "0.15.3") {
  const clients = new Map<string, ReturnType<typeof heartbeatClient>>();
  const allListeners = new Set<() => void>();
  const serverListeners = new Map<string, Set<() => void>>();
  const store = {
    hosts: [] as { serverId: string }[],
    getClient: (serverId: string) => clients.get(serverId)?.client ?? null,
    subscribeAll(listener: () => void) {
      allListeners.add(listener);
      return () => { allListeners.delete(listener); };
    },
    subscribe(serverId: string, listener: () => void) {
      const listeners = serverListeners.get(serverId) ?? new Set<() => void>();
      listeners.add(listener);
      serverListeners.set(serverId, listeners);
      return () => { listeners.delete(listener); };
    },
    connect(serverId: string, nextVersion: string | null = version) {
      const entry = heartbeatClient(nextVersion);
      clients.set(serverId, entry);
      store.hosts.push({ serverId });
      for (const listener of [...allListeners]) listener();
      for (const listener of [...(serverListeners.get(serverId) ?? [])]) listener();
      return entry;
    },
  };
  return store;
}

test("focus tracking refuses pre-0.15.3 or unversioned hosts and accepts >=0.16.0 hosts with heartbeat shape", () => {
  for (const version of [null, "0.15.2"]) {
    const store = focusStore(version);
    const { client, original } = store.connect("server");
    expect(readHostFocus("server", store)).toEqual({ supported: false, focusedAgentId: null, hasSignal: false });
    expect(client.sendHeartbeat).toBe(original);
    const dispose = installHostFocusTracker(store);
    expect(client.sendHeartbeat).toBe(original);
    const unsubscribe = subscribeHostFocus("server", () => { throw new Error("must not fire"); }, store);
    dispose();
    unsubscribe();
    expect(client.sendHeartbeat).toBe(original);
  }
  const upgraded = focusStore("0.16.0");
  upgraded.connect("server");
  expect(readHostFocus("server", upgraded).supported).toBe(true);
});

test("verified clients forward heartbeats untouched and deduplicate focus signals", () => {
  const store = focusStore("0.15.3");
  const dispose = installHostFocusTracker(store);
  const { client, calls, original } = store.connect("server");
  const seen: (string | null)[] = [];
  const unsubscribe = subscribeHostFocus("server", () => seen.push(readHostFocus("server", store).focusedAgentId), store);
  expect(readHostFocus("server", store)).toEqual({ supported: true, focusedAgentId: null, hasSignal: false });
  const receiver = { name: "daemon-client" };
  expect(client.sendHeartbeat.call(receiver, { focusedAgentId: "agent-a" }, 42)).toBe("sent");
  const second = { focusedAgentId: "agent-b" };
  client.sendHeartbeat(second);
  client.sendHeartbeat({ focusedAgentId: "agent-b" });
  client.sendHeartbeat({ focusedAgentId: "" });
  client.sendHeartbeat({ focusedAgentId: "" });
  expect(calls).toEqual([
    { self: receiver, payload: { focusedAgentId: "agent-a" }, extra: 42 },
    { self: client, payload: second, extra: undefined },
    { self: client, payload: { focusedAgentId: "agent-b" }, extra: undefined },
    { self: client, payload: { focusedAgentId: "" }, extra: undefined },
    { self: client, payload: { focusedAgentId: "" }, extra: undefined },
  ]);
  expect(seen).toEqual(["agent-a", "agent-b", null]);
  expect(readHostFocus("server", store)).toEqual({ supported: true, focusedAgentId: null, hasSignal: true });
  unsubscribe();
  dispose();
  expect(client.sendHeartbeat).toBe(original);
});

test("tracker scans already-connected hosts and attaches late connections", () => {
  const store = focusStore("0.15.3");
  const ready = store.connect("ready");
  const dispose = installHostFocusTracker(store);
  expect(ready.client.sendHeartbeat).not.toBe(ready.original);
  const seen: (string | null)[] = [];
  const unsubscribe = subscribeHostFocus("late", () => seen.push(readHostFocus("late", store).focusedAgentId), store);
  expect(readHostFocus("late", store).supported).toBe(false);
  const late = store.connect("late");
  expect(late.client.sendHeartbeat).not.toBe(late.original);
  late.client.sendHeartbeat({ focusedAgentId: "agent-late" });
  expect(seen).toEqual(["agent-late"]);
  expect(readHostFocus("late", store)).toEqual({ supported: true, focusedAgentId: "agent-late", hasSignal: true });
  unsubscribe();
  dispose();
  expect(ready.client.sendHeartbeat).toBe(ready.original);
  expect(late.client.sendHeartbeat).toBe(late.original);
});

test("workspace route demand intersects candidates on >=0.15.3 hosts and fails closed on missing shape", () => {
  const store = {
    getClient: () => ({ getLastServerInfoMessage: () => ({ version: "0.16.0" }) }),
    directorySyncByServer: new Map([["server", { routeDemandIds: new Set(["agent-a", "agent-c"]) }]]),
  };
  expect(demandedWorkspaceAgents("server", ["agent-a", "agent-b", "agent-c"], store)).toEqual(["agent-a", "agent-c"]);
  expect(demandedWorkspaceAgents("server", [], store)).toEqual([]);
  const unsupported = { ...store, getClient: () => ({ getLastServerInfoMessage: () => ({ version: "0.15.2" }) }) };
  expect(demandedWorkspaceAgents("server", ["agent-a"], unsupported)).toEqual([]);
  expect(demandedWorkspaceAgents("server", ["agent-a"], { getClient: store.getClient })).toEqual([]);
  expect(demandedWorkspaceAgents("", ["agent-a"], store)).toEqual([]);
});

const workspaceKey = "server:workspace";

function layoutState(tabs: { tabId: string; target: unknown }[], focusedTabId: string | null = "agent-tab") {
  return {
    state: {
      layoutByWorkspace: {
        [workspaceKey]: {
          focusedPaneId: "pane-main",
          root: {
            kind: "group",
            group: {
              children: [
                { kind: "pane", pane: { id: "explorer-sidebar", tabs: [{ tabId: "files", target: { kind: "files" } }], focusedTabId: "files" } },
                { kind: "pane", pane: { id: "pane-main", tabs, focusedTabId } },
              ],
            },
          },
        },
      },
      explorerSidebarPaneIdByWorkspace: { [workspaceKey]: "explorer-sidebar" },
      sheetsByWorkspace: {} as Record<string, unknown>,
    },
  };
}

function layoutStorage(state: unknown) {
  return { getItem: (key: string) => key === "workspace-layout-state" ? JSON.stringify(state) : null };
}

test("web layout resolves the focused main-pane tab beside the Explorer sidebar", () => {
  const state = layoutState([
    { tabId: "files-tab", target: { kind: "files" } },
    { tabId: "agent-tab", target: { kind: "agent", agentId: "agent-a" } },
  ]);
  expect(readWebWorkspaceFocusedTab("server", "workspace", layoutStorage(state), "0.15.3"))
    .toEqual({ kind: "agent", agentId: "agent-a" });
  for (const target of [{ kind: "draft" }, { kind: "terminal" }, { kind: "files" }]) {
    const focused = layoutState([{ tabId: "agent-tab", target }]);
    expect(readWebWorkspaceFocusedTab("server", "workspace", layoutStorage(focused), "0.15.3")).toBeNull();
  }
});

test("web layout prefers the newest workspace sheet's provider subagent", () => {
  const state = layoutState([{ tabId: "agent-tab", target: { kind: "agent", agentId: "agent-a" } }]);
  state.state.sheetsByWorkspace[workspaceKey] = [
    { tab: { target: { kind: "agent", agentId: "agent-b" } } },
    { target: { kind: "provider_subagent", parentAgentId: "parent", subagentId: "child" } },
  ];
  expect(readWebWorkspaceFocusedTab("server", "workspace", layoutStorage(state), "0.15.3"))
    .toEqual({ kind: "provider_subagent", parentAgentId: "parent", subagentId: "child" });
});

test("web layout rejects malformed storage, pre-0.15.3 hosts and missing keys while accepting >=0.16.0", () => {
  const state = layoutState([{ tabId: "agent-tab", target: { kind: "agent", agentId: "agent-a" } }]);
  expect(readWebWorkspaceFocusedTab("server", "workspace", { getItem: () => "{" }, "0.16.0")).toBeNull();
  expect(readWebWorkspaceFocusedTab("server", "workspace", { getItem: () => null }, "0.16.0")).toBeNull();
  expect(readWebWorkspaceFocusedTab("server", "workspace", layoutStorage(state), "0.16.0"))
    .toEqual({ kind: "agent", agentId: "agent-a" });
  expect(readWebWorkspaceFocusedTab("server", "workspace", layoutStorage(state), "0.15.2")).toBeNull();
  expect(readWebWorkspaceFocusedTab("", "workspace", layoutStorage(state), "0.16.0")).toBeNull();
  expect(readWebWorkspaceFocusedTab("server", "other", layoutStorage(state), "0.16.0")).toBeNull();
});

test("duplicate mobile tab switcher rows never hide the focused agent", () => {
  const row = (testId: string) => ({ getAttribute: () => testId });
  const doc = { querySelectorAll: () => [
    row("workspace-tab-agent_agent-a"),
    row("mobile-workspace-tab-switcher-option-workspace-tab-agent_agent-b"),
    row("workspace-tab-agent_agent-a"),
  ] };
  expect(focusedSessionTab(doc)).toEqual({ kind: "agent", agentId: "agent-a" });
});

test("inactive aria-hidden/hidden workspace tabs are ignored and multi-workspace transitions narrow to workspaceAgentIds", () => {
  const row = (testId: string, hiddenAncestor = false) => ({
    getAttribute: () => testId,
    closest: (sel: string) => (hiddenAncestor && sel.includes("aria-hidden") ? {} : null),
  });
  const stackedDoc = {
    querySelectorAll: () => [
      row("workspace-tab-agent_atlas-agent", true),
      row("workspace-tab-agent_dev-projects-agent", false),
    ],
  };
  expect(focusedSessionTab(stackedDoc)).toEqual({ kind: "agent", agentId: "dev-projects-agent" });

  const transitionDoc = {
    querySelectorAll: () => [
      row("workspace-tab-agent_atlas-agent", false),
      row("workspace-tab-agent_dev-projects-agent", false),
    ],
  };
  expect(focusedSessionTab(transitionDoc, "0.16.0", ["dev-projects-agent"])).toEqual({
    kind: "agent",
    agentId: "dev-projects-agent",
  });
  // Brand-new single visible tab in active workspace works immediately even before 15s workspace-agents refresh
  const brandNewDoc = {
    querySelectorAll: () => [row("workspace-tab-agent_brand-new-agent", false)],
  };
  expect(focusedSessionTab(brandNewDoc, "0.16.0", ["older-agent"])).toEqual({
    kind: "agent",
    agentId: "brand-new-agent",
  });
});
