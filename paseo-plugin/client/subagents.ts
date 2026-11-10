export type SessionTab = { kind: "agent"; agentId: string } |
  { kind: "provider_subagent"; parentAgentId: string; subagentId: string } |
  { kind: "unresolved_subagent" };

function lengthPrefixed(value: string): [string, string] | null {
  const match = /^(0|[1-9]\d*)_/.exec(value);
  if (!match) return null;
  const length = Number(match[1]);
  const rest = value.slice(match[0].length);
  if (!Number.isSafeInteger(length) || length < 1 || length > rest.length) return null;
  return [rest.slice(0, length), rest.slice(length)];
}

// Paseo 0.15.3 renders target keys on tabs; provider children are not SDK agents.
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

export function focusedSessionTab(doc: any): SessionTab | null {
  const tabs = (Array.from(doc?.querySelectorAll?.('[data-testid][aria-selected="true"]') ?? []) as any[])
    .filter((node) => typeof node.getClientRects !== "function" || node.getClientRects().length > 0)
    .map((node): SessionTab | null => {
      const id = node.getAttribute("data-testid") ?? "";
      return parseSessionTab(id) ?? (id.startsWith("workspace-tab-provider_subagent_") ? { kind: "unresolved_subagent" } : null);
    })
    .filter((tab): tab is SessionTab => tab !== null);
  if (tabs.length > 1 && tabs.some((tab) => tab.kind !== "agent")) return { kind: "unresolved_subagent" };
  return tabs.length === 1 ? tabs[0] : null;
}

export async function subagentMainTarget(tab: SessionTab | null, parentId: (id: string) => Promise<string | null>): Promise<{
  agentId: string | null; subagent: boolean;
}> {
  if (!tab) return { agentId: null, subagent: false };
  if (tab.kind === "unresolved_subagent") return { agentId: null, subagent: true };
  let id = tab.kind === "provider_subagent" ? tab.parentAgentId : tab.agentId;
  let subagent = tab.kind === "provider_subagent";
  const seen = new Set<string>();
  try {
    while (!seen.has(id)) {
      seen.add(id);
      const parent = await parentId(id);
      if (!parent) return { agentId: subagent ? id : null, subagent };
      subagent = true;
      id = parent;
    }
  } catch {
    return { agentId: null, subagent };
  }
  return { agentId: null, subagent: true };
}
