import type { usePaseo } from "@getpaseo/plugin/client";

type PaseoApi = ReturnType<typeof usePaseo>;

export type WorkspaceAgent = { id: string; title: string };

export async function listWorkspaceAgents(paseo: PaseoApi, workspaceId: string, signal?: AbortSignal): Promise<WorkspaceAgent[]> {
  const agents = new Map<string, WorkspaceAgent>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await paseo.agents.list({
      filter: { includeArchived: true },
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: 200, cursor },
      signal,
    });
    for (const { agent } of page.entries) {
      if (agent.workspaceId === workspaceId) agents.set(agent.id, { id: agent.id, title: agent.title || agent.id });
    }
    if (!page.pageInfo.hasMore) break;
    cursor = page.pageInfo.nextCursor ?? undefined;
    if (!cursor || cursors.has(cursor)) throw new Error("Agent list pagination did not advance");
    cursors.add(cursor);
  } while (cursor);
  return [...agents.values()];
}
