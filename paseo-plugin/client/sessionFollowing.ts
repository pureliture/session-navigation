import type { usePaseo } from "@getpaseo/plugin/client";
import { identityMatches } from "./chatNavigation";
import type { SessionTab } from "./hostCompat";
import { readTimelineHistory } from "./timelineHistory";

type PaseoAgentTimelineHandle = ReturnType<ReturnType<typeof usePaseo>["agents"]["ref"]>["timeline"];

export async function readSessionTimelineIds(timeline: Pick<PaseoAgentTimelineHandle, "refetch">) {
  const { entries, complete } = await readTimelineHistory(timeline, { allowPartial: true });
  const ids = entries.flatMap((entry) => ["messageId", "callId", "id"].map((key) => entry.item?.[key]))
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return { ids, complete };
}

export function sessionFollowCandidates(workspaceAgentIds: readonly string[] | undefined, scopeAgentIds: readonly string[]): readonly string[] {
  return workspaceAgentIds ?? scopeAgentIds;
}

export async function resolveSessionTarget({
  followVisible, boundAgentId, visibleValues, candidates, timelineIds,
}: {
  followVisible: boolean;
  boundAgentId: string;
  visibleValues: string[] | null;
  candidates: readonly string[];
  timelineIds: (id: string) => Promise<string[]>;
}): Promise<string | null> {
  if (!followVisible) return boundAgentId || null;
  if (visibleValues === null) return null;
  if (visibleValues.length === 0) return null;
  let best = { id: "", score: 0 };
  for (const id of new Set([boundAgentId, ...candidates].filter(Boolean))) {
    const ids = await timelineIds(id).catch(() => []);
    const score = ids.filter((identity) => visibleValues.some((value) => identityMatches(value, identity))).length;
    if (score > best.score) best = { id, score };
  }
  return best.id || null;
}

export function hasDomDocument(doc: any = (globalThis as any).document): boolean {
  return typeof doc?.querySelectorAll === "function";
}

export type BoundSession = { agentId: string; scopeKey: string; items: number; adapter: string };

function adapterRank(scopeKey: string): number {
  if (scopeKey.startsWith("omp:") || scopeKey.startsWith("hermes:")) return 0;
  if (scopeKey.startsWith("pi:")) return 2;
  return 1;
}

export function boundRootSessions(
  scopes: readonly { scope_key: string; parent_scope?: string | null; agent_id?: string; items?: number }[],
  workspaceAgentIds?: readonly string[],
): BoundSession[] {
  const best = new Map<string, BoundSession>();
  for (const scope of scopes) {
    if (scope.parent_scope || typeof scope.agent_id !== "string" || scope.agent_id.length === 0) continue;
    if (workspaceAgentIds !== undefined && !workspaceAgentIds.includes(scope.agent_id)) continue;
    const candidate: BoundSession = {
      agentId: scope.agent_id,
      scopeKey: scope.scope_key,
      items: scope.items ?? 0,
      adapter: scope.scope_key.split(":")[0] ?? "",
    };
    const existing = best.get(candidate.agentId);
    if (!existing) {
      best.set(candidate.agentId, candidate);
      continue;
    }
    const rankDelta = adapterRank(candidate.scopeKey) - adapterRank(existing.scopeKey);
    if (rankDelta < 0 || (rankDelta === 0 && (candidate.items > existing.items ||
      (candidate.items === existing.items && candidate.scopeKey < existing.scopeKey)))) {
      best.set(candidate.agentId, candidate);
    }
  }
  const result = [...best.values()];
  if (workspaceAgentIds !== undefined) {
    result.sort((a, b) => workspaceAgentIds.indexOf(a.agentId) - workspaceAgentIds.indexOf(b.agentId));
  } else {
    result.sort((a, b) => (a.scopeKey < b.scopeKey ? -1 : a.scopeKey > b.scopeKey ? 1 : 0));
  }
  return result;
}

export function resolveWorkspaceSessionState({ pinnedAgentId, trackedAgentId, hasTrackerSignal, trackerSupported, hasDocument, demandedAgentIds, boundSessions, workspaceAgentIds }: {
  pinnedAgentId: string | null;
  trackedAgentId: string | null;
  hasTrackerSignal: boolean;
  trackerSupported: boolean;
  hasDocument: boolean;
  demandedAgentIds: readonly string[];
  boundSessions: readonly BoundSession[];
  workspaceAgentIds?: readonly string[];
}): { mode: "pinned" | "follow" | "single-auto" | "chooser"; effectiveAgentId: string | null; unavailablePin: boolean } {
  if (pinnedAgentId) {
    if (workspaceAgentIds !== undefined && !workspaceAgentIds.includes(pinnedAgentId) &&
      !boundSessions.some((session) => session.agentId === pinnedAgentId)) {
      return { mode: "chooser", effectiveAgentId: null, unavailablePin: true };
    }
    return { mode: "pinned", effectiveAgentId: pinnedAgentId, unavailablePin: false };
  }
  if (hasDocument) {
    return { mode: "follow", effectiveAgentId: trackedAgentId, unavailablePin: false };
  }
  if (hasTrackerSignal) {
    if (trackedAgentId !== null) return { mode: "follow", effectiveAgentId: trackedAgentId, unavailablePin: false };
    return { mode: "chooser", effectiveAgentId: null, unavailablePin: false };
  }
  if (demandedAgentIds.length === 1) return { mode: "follow", effectiveAgentId: demandedAgentIds[0], unavailablePin: false };
  if (!trackerSupported && boundSessions.length === 1) return { mode: "single-auto", effectiveAgentId: boundSessions[0].agentId, unavailablePin: false };
  if (boundSessions.length === 1 && workspaceAgentIds !== undefined) return { mode: "single-auto", effectiveAgentId: boundSessions[0].agentId, unavailablePin: false };
  return { mode: "chooser", effectiveAgentId: null, unavailablePin: false };
}

export function acceptWorkspaceAgentId({ agentId, workspaceCandidateIds, agentWorkspaceId, panelWorkspaceId }: {
  agentId: string | null;
  workspaceCandidateIds?: readonly string[];
  agentWorkspaceId?: string | null;
  panelWorkspaceId?: string;
}): "accept" | "reject" | "unknown" {
  if (!agentId) return "reject";
  if (panelWorkspaceId && agentWorkspaceId) return agentWorkspaceId === panelWorkspaceId ? "accept" : "reject";
  if (workspaceCandidateIds !== undefined) return workspaceCandidateIds.includes(agentId) ? "accept" : "reject";
  if (!panelWorkspaceId) return "accept";
  return "unknown";
}

export function selectMainOrFallbackAgent({ tab, managed, fallback, followVisible, resolvedTarget, lastMainAgentId }: {
  tab: SessionTab | null;
  managed: boolean;
  fallback: { agentId: string | null; subagent: boolean };
  followVisible: boolean;
  resolvedTarget: string | null;
  lastMainAgentId: string | null;
}): { agentId: string | null; subagentFallback: boolean; inView: boolean } {
  const useFallback = fallback.subagent && !managed;
  const agentId = tab?.kind === "provider_subagent" ? tab.parentAgentId : useFallback ? (fallback.agentId ?? lastMainAgentId) : tab?.kind === "agent" && followVisible ? tab.agentId : resolvedTarget;
  return { agentId, subagentFallback: useFallback, inView: !!agentId || useFallback };
}
