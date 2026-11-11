import type { SessionTab } from "./hostCompat";
import type { Row } from "../shared/sessionNav";

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
  return scopes.filter((scope) => scope.parent_scope === parentScope && scope.tool_call_id === callId && !!scope.subagent_id &&
    ["omp", "hermes"].includes(scope.scope_key.split(":")[0]) && scope.scope_key !== parentScope);
}

export function mergeLinkedParentRows(rows: Row[], timeline: Row[], scopes: readonly ChildScope[], parentScope: string): Row[] {
  const missing = timeline.filter((row) => row.kind === "tool" &&
    !rows.some((managed) => managed.tool_call_id === row.tool_call_id) && childrenForCall(scopes, parentScope, row.tool_call_id).length > 0);
  return [...rows, ...missing.map((row) => ({ ...row, item_id: null, manageable: false,
    tool_name: parentScope.startsWith("hermes:") ? "delegate_task" : row.tool_name }))];
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
