export type SessionTab =
  | { kind: "agent"; agentId: string }
  | { kind: "provider_subagent"; parentAgentId: string; subagentId: string }
  | { kind: "unresolved_subagent"; parentAgentId?: string };

export type HostFocusSnapshot = {
  supported: boolean;
  focusedAgentId: string | null;
  hasSignal: boolean;
};

const MIN_PASEO_VERSION: readonly [number, number, number] = [0, 15, 3];

function parseSemver(version?: string | null): [number, number, number] | null {
  if (typeof version !== "string") return null;
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) return null;
  return [major, minor, patch];
}

function meetsMinimumHostVersion(version: [number, number, number]): boolean {
  const [minMajor, minMinor, minPatch] = MIN_PASEO_VERSION;
  if (version[0] !== minMajor) return version[0] > minMajor;
  if (version[1] !== minMinor) return version[1] > minMinor;
  return version[2] >= minPatch;
}

export function supportedHostVersion(version?: string | null): boolean {
  if (version == null) return true;
  const parsed = parseSemver(version);
  return parsed !== null && meetsMinimumHostVersion(parsed);
}

export function strictSupportedHostVersion(version?: string | null): boolean {
  const parsed = parseSemver(version);
  return parsed !== null && meetsMinimumHostVersion(parsed);
}

function lengthPrefixed(value: string): [string, string] | null {
  const match = /^(0|[1-9]\d*)_/.exec(value);
  if (!match) return null;
  const length = Number(match[1]);
  const rest = value.slice(match[0].length);
  if (!Number.isSafeInteger(length) || length < 1 || length > 1024 || length > rest.length) return null;
  return [rest.slice(0, length), rest.slice(length)];
}

// Paseo >=0.15.3 DOM contract; newer releases remain enabled as long as runtime structural guards match.
export function parseSessionTab(testId: string): SessionTab | null {
  const agentPrefix = "workspace-tab-agent_";
  if (testId.startsWith(agentPrefix)) {
    const agentId = testId.slice(agentPrefix.length);
    return agentId ? { kind: "agent", agentId } : null;
  }
  const prefix = "workspace-tab-provider_subagent_";
  if (!testId.startsWith(prefix)) return null;
  const parent = lengthPrefixed(testId.slice(prefix.length));
  if (!parent || !parent[1].startsWith("_")) return null;
  const child = lengthPrefixed(parent[1].slice(1));
  return child && !child[1] ? { kind: "provider_subagent", parentAgentId: parent[0], subagentId: child[0] } : null;
}

function visible(node: any): boolean {
  if (!node) return false;
  if (typeof node.getClientRects === "function" && node.getClientRects().length === 0) return false;
  if (typeof node.closest === "function" && node.closest('[aria-hidden="true"], [hidden], [inert]')) return false;
  try {
    const style = node.ownerDocument?.defaultView?.getComputedStyle?.(node);
    if (style && (style.visibility === "hidden" || style.display === "none")) return false;
  } catch {
    // Ignore mock DOM environments without getComputedStyle.
  }
  return true;
}

function hostVersion(doc: any): string | null {
  try {
    const win = doc?.defaultView;
    const server = /^\/h\/([^/]+)\//.exec(win?.location?.pathname ?? "")?.[1];
    const version = server && win?.__paseoHostRuntimeStore?.getClient?.(decodeURIComponent(server))?.getLastServerInfoMessage?.()?.version;
    return typeof version === "string" ? version : null;
  } catch { return null; }
}

export function readHostVersion(serverId?: string | null, doc?: any): string | null {
  if (typeof serverId === "string" && serverId.length > 0) {
    try {
      const version = (globalThis as any).__paseoHostRuntimeStore?.getClient?.(serverId)?.getLastServerInfoMessage?.()?.version;
      if (typeof version === "string") return version;
    } catch { /* Fall back to the document contract. */ }
  }
  return hostVersion(doc);
}

type FocusState = { focusedAgentId: string | null; hasSignal: boolean };
type WrappedClient = { original: (...args: any[]) => any; wrapper: (...args: any[]) => any };

const hostStore = (): any => (globalThis as any).__paseoHostRuntimeStore;
const fallbackStore: object = {};
const focusStates = new WeakMap<object, Map<string, FocusState>>();
const focusListeners = new WeakMap<object, Map<string, Set<() => void>>>();
const wrappedClients = new WeakMap<object, WrappedClient>();
const ownedClients = new WeakMap<object, Set<object>>();
const storeSubscriptions = new WeakMap<object, Set<() => void>>();

function storeKey(store: any): object {
  return store && typeof store === "object" ? store : fallbackStore;
}

function stateMap(store: any): Map<string, FocusState> {
  const key = storeKey(store);
  let states = focusStates.get(key);
  if (!states) { states = new Map(); focusStates.set(key, states); }
  return states;
}

function listenerMap(store: any): Map<string, Set<() => void>> {
  const key = storeKey(store);
  let listeners = focusListeners.get(key);
  if (!listeners) { listeners = new Map(); focusListeners.set(key, listeners); }
  return listeners;
}

function releaseHandle(handle: any): void {
  try {
    if (typeof handle === "function") handle();
    else if (handle && typeof handle.unsubscribe === "function") handle.unsubscribe();
  } catch { /* Already released. */ }
}

function updateFocusState(store: any, serverId: string, focusedAgentId: string | null): void {
  const states = stateMap(store);
  const previous = states.get(serverId);
  if (previous?.hasSignal && previous.focusedAgentId === focusedAgentId) return;
  states.set(serverId, { focusedAgentId, hasSignal: true });
  const listeners = listenerMap(store).get(serverId);
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try { listener(); } catch { /* Listeners never interfere with the host heartbeat. */ }
  }
}

function ensureClientWrapped(store: any, serverId: string | null | undefined): boolean {
  if (!store || typeof serverId !== "string" || serverId.length === 0) return false;
  try {
    const client = store.getClient?.(serverId);
    if (!client || (typeof client !== "object" && typeof client !== "function")) return false;
    if (!strictSupportedHostVersion(client.getLastServerInfoMessage?.()?.version)) return false;
    if (typeof client.sendHeartbeat !== "function") return false;
    const existing = wrappedClients.get(client);
    if (existing) {
      if (client.sendHeartbeat !== existing.wrapper) client.sendHeartbeat = existing.wrapper;
    } else {
      const original = client.sendHeartbeat;
      const wrapper = function (this: unknown, ...args: any[]) {
        try {
          const payload = args[0];
          if (payload && typeof payload === "object" && "focusedAgentId" in payload) {
            const nextId = typeof payload.focusedAgentId === "string" && payload.focusedAgentId.length > 0
              ? payload.focusedAgentId
              : null;
            updateFocusState(store, serverId, nextId);
          }
        } catch {
          // Never interfere with host heartbeat
        }
        return original.apply(this, args);
      };
      client.sendHeartbeat = wrapper;
      wrappedClients.set(client, { original, wrapper });
    }
    let owned = ownedClients.get(store);
    if (!owned) { owned = new Set(); ownedClients.set(store, owned); }
    owned.add(client);
    return true;
  } catch { return false; }
}

export function installHostFocusTracker(store: any = hostStore()): () => void {
  if (!store || typeof store !== "object") return () => {};
  const sync = () => {
    const serverIds = new Set<string>();
    if (Array.isArray(store.hosts)) {
      for (const host of store.hosts) {
        if (typeof host?.serverId === "string" && host.serverId.length > 0) serverIds.add(host.serverId);
      }
    }
    const listeners = focusListeners.get(store);
    if (listeners) for (const serverId of listeners.keys()) serverIds.add(serverId);
    for (const serverId of serverIds) ensureClientWrapped(store, serverId);
  };
  sync();
  let unsubscribeAll: any = null;
  try { unsubscribeAll = store.subscribeAll?.(sync) ?? null; } catch { unsubscribeAll = null; }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    releaseHandle(unsubscribeAll);
    const subscriptions = storeSubscriptions.get(store);
    if (subscriptions) {
      for (const release of [...subscriptions]) release();
      subscriptions.clear();
    }
    const owned = ownedClients.get(store);
    if (owned) {
      for (const client of owned) {
        const record = wrappedClients.get(client);
        if (record && Reflect.get(client, "sendHeartbeat") === record.wrapper) {
          Reflect.set(client, "sendHeartbeat", record.original);
        }
        wrappedClients.delete(client);
      }
      ownedClients.delete(store);
    }
  };
}

export function readHostFocus(serverId: string, store: any = hostStore()): HostFocusSnapshot {
  const unsupported: HostFocusSnapshot = { supported: false, focusedAgentId: null, hasSignal: false };
  if (!serverId || !store) return unsupported;
  if (!ensureClientWrapped(store, serverId)) return unsupported;
  const current = focusStates.get(storeKey(store))?.get(serverId);
  return { supported: true, focusedAgentId: current?.focusedAgentId ?? null, hasSignal: current?.hasSignal ?? false };
}

export function subscribeHostFocus(serverId: string, listener: () => void, store: any = hostStore()): () => void {
  if (!serverId || typeof listener !== "function") return () => {};
  const listeners = listenerMap(store);
  let set = listeners.get(serverId);
  if (!set) { set = new Set(); listeners.set(serverId, set); }
  const ownedListeners = set;
  ownedListeners.add(listener);
  ensureClientWrapped(store, serverId);
  let handle: unknown = null;
  try {
    handle = store?.subscribe?.(serverId, () => { ensureClientWrapped(store, serverId); }) ?? null;
  } catch { handle = null; }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseHandle(handle);
  };
  let subscriptions: Set<() => void> | undefined;
  if (handle) {
    subscriptions = storeSubscriptions.get(storeKey(store));
    if (!subscriptions) {
      subscriptions = new Set();
      storeSubscriptions.set(storeKey(store), subscriptions);
    }
    subscriptions.add(release);
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    ownedListeners.delete(listener);
    if (ownedListeners.size === 0) listeners.delete(serverId);
    subscriptions?.delete(release);
    release();
  };
}

export function focusedSessionTab(
  doc: any,
  version: string | null | undefined = hostVersion(doc),
  workspaceAgentIds?: readonly string[],
): SessionTab | null {
  const seen = new Set<string>();
  let tabs = (Array.from(doc?.querySelectorAll?.('[data-testid][aria-selected="true"]') ?? []) as any[])
    .filter(visible)
    .map((node): SessionTab | null => {
      const id = node.getAttribute("data-testid") ?? "";
      return parseSessionTab(id) ?? (id.startsWith("workspace-tab-provider_subagent_") ? { kind: "unresolved_subagent" } : null);
    })
    // MobileWorkspaceTabSwitcher repeats the active tab as a combobox row. Identical rows are one session.
    .filter((tab): tab is SessionTab => {
      if (tab === null) return false;
      const key = tab.kind === "agent" ? `agent:${tab.agentId}`
        : tab.kind === "provider_subagent" ? `provider:${tab.parentAgentId}:${tab.subagentId}` : "unresolved";
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (tabs.length > 1 && Array.isArray(workspaceAgentIds)) {
    const allowed = new Set(workspaceAgentIds);
    const narrowed = tabs.filter((tab) =>
      tab.kind === "agent"
        ? allowed.has(tab.agentId)
        : tab.kind === "provider_subagent"
          ? allowed.has(tab.parentAgentId)
          : true,
    );
    if (narrowed.length > 0) tabs = narrowed;
  }
  if (tabs.length > 1 && tabs.some((tab) => tab.kind !== "agent")) return { kind: "unresolved_subagent" };
  const tab = tabs.length === 1 ? tabs[0] : null;
  return tab?.kind === "provider_subagent" && !supportedHostVersion(version)
    ? { kind: "unresolved_subagent", parentAgentId: tab.parentAgentId }
    : tab;
}

function uniqueTestId(doc: any, id: string): any {
  const nodes = (Array.from(doc?.querySelectorAll?.("[data-testid]") ?? []) as any[])
    .filter((node) => visible(node) && node.getAttribute("data-testid") === id);
  return nodes.length === 1 ? nodes[0] : null;
}

export async function openProviderSubagent(doc: any, parentAgentId: string, subagentId: string, options: {
  version?: string | null; openParent: () => void; wait?: () => Promise<void>;
}): Promise<boolean> {
  if (!doc || typeof doc.querySelectorAll !== "function") return false;
  options = { ...options, version: options.version === undefined ? hostVersion(doc) : options.version };
  if (!parentAgentId || !subagentId || !supportedHostVersion(options.version)) return false;
  const matches = () => {
    const tab = focusedSessionTab(doc, options.version);
    return tab?.kind === "provider_subagent" && tab.parentAgentId === parentAgentId && tab.subagentId === subagentId;
  };
  if (matches()) return true;
  const wait = options.wait ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
  try {
    const tabId = `workspace-tab-provider_subagent_${parentAgentId.length}_${parentAgentId}_${subagentId.length}_${subagentId}`;
    const existing = uniqueTestId(doc, tabId);
    if (existing) existing.click();
    else {
      const focused = focusedSessionTab(doc, options.version);
      if (focused?.kind !== "agent" || focused.agentId !== parentAgentId) options.openParent();
      await wait();
    }
    let openedTrack = false, clickedRow = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (matches()) return true;
      const focused = focusedSessionTab(doc, options.version);
      if (focused?.kind === "unresolved_subagent") return false;
      if (!existing && focused?.kind === "agent" && focused.agentId === parentAgentId) {
        const row = uniqueTestId(doc, `subagents-track-row-${subagentId}`);
        if (row && !clickedRow) { row.click(); clickedRow = true; }
        else if (!row && !openedTrack) {
          const header = uniqueTestId(doc, "subagents-track-header");
          if (header && header.getAttribute("aria-expanded") !== "true") { header.click(); openedTrack = true; }
        }
      }
      await wait();
    }
  } catch { return false; }
  return false;
}

export function demandedWorkspaceAgents(
  serverId: string,
  candidateIds: readonly string[],
  store: any = hostStore(),
): string[] {
  try {
    if (!serverId || !Array.isArray(candidateIds) || candidateIds.length === 0) return [];
    const version = store?.getClient?.(serverId)?.getLastServerInfoMessage?.()?.version;
    if (!strictSupportedHostVersion(version)) return [];
    const demanded = store?.directorySyncByServer?.get?.(serverId)?.routeDemandIds;
    if (!demanded) return [];
    const demandedSet = new Set<string>(demanded as Iterable<string>);
    return candidateIds.filter((id) => typeof id === "string" && demandedSet.has(id));
  } catch { return []; }
}

function sessionTabOf(target: any): SessionTab | null {
  if (!target || typeof target !== "object") return null;
  if (target.kind === "agent" && typeof target.agentId === "string" && target.agentId.length > 0) {
    return { kind: "agent", agentId: target.agentId };
  }
  if (target.kind === "provider_subagent" &&
    typeof target.parentAgentId === "string" && target.parentAgentId.length > 0 &&
    typeof target.subagentId === "string" && target.subagentId.length > 0) {
    return { kind: "provider_subagent", parentAgentId: target.parentAgentId, subagentId: target.subagentId };
  }
  return null;
}

export function readWebWorkspaceFocusedTab(
  serverId: string,
  workspaceId: string,
  storage: { getItem(key: string): string | null } | null = (globalThis as any).localStorage,
  version?: string | null,
): SessionTab | null {
  try {
    if (!serverId || !workspaceId || !storage || typeof storage.getItem !== "function") return null;
    const resolvedVersion = version === undefined ? readHostVersion(serverId, (globalThis as any).document) : version;
    if (!supportedHostVersion(resolvedVersion)) return null;
    const raw = storage.getItem("workspace-layout-state");
    if (!raw) return null;
    const state = JSON.parse(raw)?.state;
    if (!state || typeof state !== "object") return null;
    const workspaceKey = `${serverId}:${workspaceId}`;
    const sheets = state.sheetsByWorkspace?.[workspaceKey];
    if (Array.isArray(sheets) && sheets.length > 0) {
      const entry = sheets[sheets.length - 1];
      const sheetTab = sessionTabOf(entry?.tab?.target ?? entry?.target);
      if (sheetTab) return sheetTab;
    }
    const layout = state.layoutByWorkspace?.[workspaceKey];
    if (!layout?.root) return null;
    const collect = (node: any): any[] => node?.kind === "pane" ? [node.pane]
      : node?.kind === "group" && Array.isArray(node.group?.children) ? node.group.children.flatMap(collect) : [];
    const explorerPaneId = state.explorerSidebarPaneIdByWorkspace?.[workspaceKey] ??
      state.explorerPaneIdByWorkspace?.[workspaceKey] ?? "explorer-sidebar";
    const mainPanes = collect(layout.root).filter((pane) => pane && pane.id !== explorerPaneId && pane.hidden !== true);
    const mainPane = mainPanes.find((pane) => pane.id === layout.focusedPaneId) ??
      (mainPanes.length === 1 ? mainPanes[0] : null);
    if (!mainPane || !Array.isArray(mainPane.tabs)) return null;
    const activeTab = mainPane.focusedTabId
      ? mainPane.tabs.find((tab: any) => tab?.tabId === mainPane.focusedTabId)
      : (mainPane.tabs.length === 1 ? mainPane.tabs[0] : null);
    return sessionTabOf(activeTab?.target);
  } catch { return null; }
}
