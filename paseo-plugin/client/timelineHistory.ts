import type { usePaseo } from "@getpaseo/plugin/client";

type PaseoAgentTimelineHandle = ReturnType<ReturnType<typeof usePaseo>["agents"]["ref"]>["timeline"];

export type TimelineHistory = {
  entries: Array<{ item?: Record<string, unknown>; seqStart?: number }>;
  complete: boolean;
};

function historyEntries(entries: Awaited<ReturnType<PaseoAgentTimelineHandle["refetch"]>>["entries"]): TimelineHistory["entries"] {
  return entries.map(({ item, seqStart }) => ({ item: { ...item }, seqStart }));
}

export async function readTimelineHistory(
  timeline: Pick<PaseoAgentTimelineHandle, "refetch">,
  {
    allowPartial = false,
    maxPages,
    shouldStop,
  }: {
    allowPartial?: boolean;
    maxPages?: number;
    shouldStop?: (pageEntries: TimelineHistory["entries"]) => boolean;
  } = {},
): Promise<TimelineHistory> {
  let page = await timeline.refetch({ direction: "tail", limit: 1000, projection: "canonical" });
  if (page.error) throw new Error(page.error);

  const pages: TimelineHistory["entries"][] = [];
  const firstPage = historyEntries(page.entries);
  pages.push(firstPage);

  let stoppedEarly = false;
  if (shouldStop?.(firstPage)) {
    stoppedEarly = Boolean(page.hasOlder);
  } else {
    while (page.hasOlder && page.startCursor) {
      if (typeof maxPages === "number" && maxPages > 0 && pages.length >= maxPages) {
        stoppedEarly = true;
        break;
      }
      const cursor = page.startCursor;
      try {
        page = await timeline.refetch({ direction: "before", cursor, limit: 1000, projection: "canonical" });
        if (page.error) throw new Error(page.error);
        if (
          !page.entries.length ||
          (page.startCursor &&
            page.startCursor.epoch === cursor.epoch &&
            page.startCursor.seq >= cursor.seq)
        ) {
          break;
        }
        const batch = historyEntries(page.entries);
        pages.push(batch);
        if (shouldStop?.(batch)) {
          stoppedEarly = Boolean(page.hasOlder);
          break;
        }
      } catch (error) {
        if (!allowPartial) throw error;
        const entries: TimelineHistory["entries"] = [];
        for (let i = pages.length - 1; i >= 0; i--) {
          entries.push(...pages[i]);
        }
        return { entries, complete: false };
      }
    }
  }

  const entries: TimelineHistory["entries"] = [];
  for (let i = pages.length - 1; i >= 0; i--) {
    entries.push(...pages[i]);
  }
  return { entries, complete: !stoppedEarly && page.hasOlder === false };
}
