import type { PaseoAgentTimelineHandle } from "@getpaseo/client";

export type TimelineHistory = {
  entries: Array<{ item?: Record<string, unknown>; seqStart?: number }>;
  complete: boolean;
};

function historyEntries(entries: Awaited<ReturnType<PaseoAgentTimelineHandle["refetch"]>>["entries"]): TimelineHistory["entries"] {
  return entries.map(({ item, seqStart }) => ({ item: { ...item }, seqStart }));
}

export async function readTimelineHistory(
  timeline: Pick<PaseoAgentTimelineHandle, "refetch">,
  { allowPartial = false }: { allowPartial?: boolean } = {},
): Promise<TimelineHistory> {
  let page = await timeline.refetch({ direction: "tail", limit: 1000, projection: "canonical" });
  if (page.error) throw new Error(page.error);
  let entries = historyEntries(page.entries);
  while (page.hasOlder && page.startCursor) {
    const cursor = page.startCursor;
    try {
      page = await timeline.refetch({ direction: "before", cursor, limit: 1000, projection: "canonical" });
      if (page.error) throw new Error(page.error);
      if (!page.entries.length || (page.startCursor && page.startCursor.epoch === cursor.epoch &&
        page.startCursor.seq >= cursor.seq)) return { entries, complete: page.hasOlder === false };
      entries = [...historyEntries(page.entries), ...entries];
    } catch (error) {
      if (!allowPartial) throw error;
      return { entries, complete: false };
    }
  }
  return { entries, complete: page.hasOlder === false };
}
