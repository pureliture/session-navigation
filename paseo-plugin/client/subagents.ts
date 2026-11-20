import type { SessionTab } from "./hostCompat";

export { mergeHermesTimelineRows, mergeLinkedParentRows } from "./fallbackTimeline";

export type ChildScope = {
  scope_key: string;
  parent_scope?: string | null;
  tool_call_id?: string | null;
  subagent_id?: string | null;
  agent_id?: string;
};

export function scopeForAgent(scopes: readonly ChildScope[], agentId: string): string | null {
  const matches = scopes.filter((scope) => scope.agent_id === agentId);
  if (matches.length) return matches.length === 1 ? matches[0].scope_key : null;
  return scopes.find((scope) => [`pi:default:${agentId}:default`, `paseo:default:${agentId}:default`].includes(scope.scope_key))?.scope_key ?? null;
}

export function resolveChildScope(tab: SessionTab | null, parentScope: string | null, scopes: readonly ChildScope[]): ChildScope | null {
  if (tab?.kind !== "provider_subagent" || !parentScope?.startsWith("omp:")) return null;
  const children = scopes.filter((scope) => scope.parent_scope === parentScope && scope.subagent_id === tab.subagentId && scope.scope_key.startsWith("omp:"));
  return children.length === 1 ? children[0] : null;
}


export function childrenForCall(scopes: readonly ChildScope[], parentScope: string, callId: string): ChildScope[] {
  const exact = scopes.filter((scope) => scope.parent_scope === parentScope && scope.tool_call_id === callId && !!scope.subagent_id &&
    ["omp", "hermes"].includes(scope.scope_key.split(":")[0]) && scope.scope_key !== parentScope);
  // Legacy behavior wins: an exact parent_scope match never falls through.
  if (exact.length > 0) return exact;
  // After a Hermes rotation the panel still addresses the pre-rotation parent
  // (h-old) while new subagents register under the rotation child (h-new).
  // Fall back to same-profile Hermes parents so inline links keep working.
  // Matching still requires the exact tool_call_id + subagent_id, and every
  // merged row stays display-only (manageable=false), so a newer
  // non-rotation child can never hijack mutations — only add an inline link.
  if (!parentScope.startsWith("hermes:")) return exact;
  const profile = parentScope.split(":")[1] ?? "";
  if (!profile) return exact;
  const prefix = `hermes:${profile}:`;
  return scopes.filter((scope) =>
    scope.tool_call_id === callId && !!scope.subagent_id &&
    ["omp", "hermes"].includes(scope.scope_key.split(":")[0]) && scope.scope_key !== parentScope &&
    typeof scope.parent_scope === "string" &&
    scope.parent_scope.startsWith(prefix));
}

/**
 * True when a linked subagent child owns a tool row the server list does not
 * contain — including rotation-moved children (parent_scope h-new) while the
 * panel addresses h-old. Independent of `server_timeline`, so in-flight
 * task/delegate_task rows stay visible even when the server owns a timeline.
 */
export function hasMissingLinkedChildren(
  items: readonly { tool_call_id?: string | null }[],
  scopes: readonly ChildScope[],
  parentScope: string,
): boolean {
  return scopes.some((scope) => {
    const callId = scope.tool_call_id;
    if (typeof callId !== "string" || callId.length === 0) return false;
    if (items.some((row) => row.tool_call_id === callId)) return false;
    return childrenForCall(scopes, parentScope, callId).length > 0;
  });
}

export async function subagentMainTarget(tab: SessionTab | null, parentId: (id: string) => Promise<string | null>): Promise<{
  agentId: string | null; subagent: boolean;
}> {
  if (!tab) return { agentId: null, subagent: false };
  if (tab.kind === "unresolved_subagent") return { agentId: tab.parentAgentId ?? null, subagent: true };
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
