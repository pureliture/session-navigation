import { identityMatches } from "./chatNavigation";

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
  if (visibleValues.length === 0) return boundAgentId || null;
  let best = { id: "", score: 0 };
  for (const id of new Set([boundAgentId, ...candidates].filter(Boolean))) {
    const ids = await timelineIds(id).catch(() => []);
    const score = ids.filter((identity) => visibleValues.some((value) => identityMatches(value, identity))).length;
    if (score > best.score) best = { id, score };
  }
  return best.id || null;
}
