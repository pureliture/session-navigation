export type SessionTab = { kind: "agent"; agentId: string } |
  { kind: "provider_subagent"; parentAgentId: string; subagentId: string } |
  { kind: "unresolved_subagent"; parentAgentId?: string };

export function supportedHostVersion(version?: string | null): boolean {
  return version == null || version === "0.15.3";
}

function lengthPrefixed(value: string): [string, string] | null {
  const match = /^(0|[1-9]\d*)_/.exec(value);
  if (!match) return null;
  const length = Number(match[1]);
  const rest = value.slice(match[0].length);
  if (!Number.isSafeInteger(length) || length < 1 || length > 1024 || length > rest.length) return null;
  return [rest.slice(0, length), rest.slice(length)];
}

// Private Paseo 0.15.3 DOM contract. Unknown versions require the same structural guards.
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
  return typeof node.getClientRects !== "function" || node.getClientRects().length > 0;
}

function hostVersion(doc: any): string | null {
  try {
    const win = doc?.defaultView;
    const server = /^\/h\/([^/]+)\//.exec(win?.location?.pathname ?? "")?.[1];
    const version = server && win?.__paseoHostRuntimeStore?.getClient?.(decodeURIComponent(server))?.getLastServerInfoMessage?.()?.version;
    return typeof version === "string" ? version : null;
  } catch { return null; }
}

export function focusedSessionTab(doc: any, version: string | null | undefined = hostVersion(doc)): SessionTab | null {
  const tabs = (Array.from(doc?.querySelectorAll?.('[data-testid][aria-selected="true"]') ?? []) as any[])
    .filter(visible)
    .map((node): SessionTab | null => {
      const id = node.getAttribute("data-testid") ?? "";
      return parseSessionTab(id) ?? (id.startsWith("workspace-tab-provider_subagent_") ? { kind: "unresolved_subagent" } : null);
    }).filter((tab): tab is SessionTab => tab !== null);
  if (tabs.length > 1 && tabs.some((tab) => tab.kind !== "agent")) return { kind: "unresolved_subagent" };
  const tab = tabs.length === 1 ? tabs[0] : null;
  return tab?.kind === "provider_subagent" && !supportedHostVersion(version) ? { kind: "unresolved_subagent", parentAgentId: tab.parentAgentId } : tab;
}

function uniqueTestId(doc: any, id: string): any {
  const nodes = (Array.from(doc?.querySelectorAll?.("[data-testid]") ?? []) as any[])
    .filter((node) => visible(node) && node.getAttribute("data-testid") === id);
  return nodes.length === 1 ? nodes[0] : null;
}

export async function openProviderSubagent(doc: any, parentAgentId: string, subagentId: string, options: {
  version?: string | null; openParent: () => void; wait?: () => Promise<void>;
}): Promise<boolean> {
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
