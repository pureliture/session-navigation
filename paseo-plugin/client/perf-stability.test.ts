import { expect, test } from "bun:test";
import { clearClientPerf, recentClientPerf, recordClientPerf } from "./diagnostics";
import type { OutlineRow } from "./outlineGrouping";
import {
  OUTLINE_INITIAL_TAIL_WINDOW,
  OUTLINE_VIRTUALIZE_THRESHOLD,
  OUTLINE_WINDOW_OVERSCAN,
  computeOutlineWindow,
  stabilizeGroupedRows,
  stabilizeRows,
} from "./outlineWindow";
import { resolveSessionTargetProgressive } from "./sessionFollowing";
import { readTimelineHistory } from "./timelineHistory";

test("readTimelineHistory accumulates pages in O(N) chronological order and honors shouldStop/maxPages", async () => {
  const total = Array.from({ length: 12 }, (_, i) => ({ item: { id: `m_${i}` }, seqStart: i }));
  const makeTimeline = () => ({
    refetch: async (input: any): Promise<any> => {
      const end = input.direction === "tail" ? total.length : input.cursor.seq;
      const start = Math.max(0, end - 4);
      return {
        entries: total.slice(start, end),
        hasOlder: start > 0,
        startCursor: { epoch: "e", seq: start },
      };
    },
  });

  const full = await readTimelineHistory(makeTimeline());
  expect(full.complete).toBe(true);
  expect(full.entries.map((e) => e.item?.id)).toEqual(total.map((t) => t.item.id));

  let batchesSeen = 0;
  const stoppedEarly = await readTimelineHistory(makeTimeline(), {
    shouldStop: (batch) => {
      batchesSeen += 1;
      return batch.some((e) => e.item?.id === "m_6");
    },
  });
  expect(batchesSeen).toBe(2);
  expect(stoppedEarly.complete).toBe(false);
  expect(stoppedEarly.entries.map((e) => e.item?.id)).toEqual(
    total.slice(4).map((t) => t.item.id),
  );

  const bounded = await readTimelineHistory(makeTimeline(), { maxPages: 1 });
  expect(bounded.complete).toBe(false);
  expect(bounded.entries.map((e) => e.item?.id)).toEqual(["m_8", "m_9", "m_10", "m_11"]);
});

test("resolveSessionTargetProgressive short-circuits on tail match and falls back to progressive scan on miss", async () => {
  let progressiveCalls = 0;
  const tailWin = await resolveSessionTargetProgressive({
    followVisible: true,
    boundAgentId: "a1",
    visibleValues: ["message-m_tail"],
    candidates: ["a1", "a2"],
    loadTailIds: async (id) => ({
      ids: id === "a2" ? ["m_tail"] : ["other"],
      complete: false,
    }),
    loadProgressiveIds: async () => {
      progressiveCalls += 1;
      return { ids: [], complete: true };
    },
  });
  expect(tailWin).toBe("a2");
  expect(progressiveCalls).toBe(0);

  const progWin = await resolveSessionTargetProgressive({
    followVisible: true,
    boundAgentId: "a1",
    visibleValues: ["message-ancient"],
    candidates: ["a1", "a2"],
    loadTailIds: async () => ({ ids: ["recent"], complete: false }),
    loadProgressiveIds: async (id) => {
      progressiveCalls += 1;
      return { ids: id === "a1" ? ["ancient"] : ["other"], complete: false };
    },
  });
  expect(progWin).toBe("a1");
  expect(progressiveCalls).toBe(2);
});

test("outlineWindow virtualizes large lists with spacer heights and stabilizes unchanged row references", () => {
  const small: OutlineRow[] = Array.from({ length: 20 }, (_, i) => ({
    key: `u_${i}`,
    type: "user" as const,
    row: { item_id: `u_${i}`, tool_call_id: "", kind: "user", tool_name: "user" } as any,
  }));
  const smallWin = computeOutlineWindow(small, {
    scrollTop: 0,
    clientHeight: 400,
    compact: false,
    expandedGroups: {},
    pinToTail: true,
  });
  expect(smallWin.virtualized).toBe(false);
  expect(smallWin.visibleItems.length).toBe(20);
  expect(smallWin.topSpacerHeight).toBe(0);
  expect(smallWin.bottomSpacerHeight).toBe(0);

  const large: OutlineRow[] = Array.from({ length: 5000 }, (_, i) => ({
    key: `u_${i}`,
    type: "user" as const,
    row: { item_id: `u_${i}`, tool_call_id: "", kind: "user", tool_name: "user" } as any,
  }));
  const tailWin = computeOutlineWindow(large, {
    scrollTop: 0,
    clientHeight: 600,
    compact: false,
    expandedGroups: {},
    pinToTail: true,
  });
  expect(tailWin.virtualized).toBe(true);
  expect(tailWin.endIndex).toBe(5000);
  expect(tailWin.startIndex).toBe(5000 - OUTLINE_INITIAL_TAIL_WINDOW - OUTLINE_WINDOW_OVERSCAN);
  expect(tailWin.topSpacerHeight).toBeGreaterThan(0);
  expect(tailWin.bottomSpacerHeight).toBe(0);
  expect(OUTLINE_VIRTUALIZE_THRESHOLD).toBe(160);

  const midWin = computeOutlineWindow(large, {
    scrollTop: 60_000,
    clientHeight: 600,
    compact: false,
    expandedGroups: {},
    pinToTail: false,
  });
  expect(midWin.startIndex).toBeGreaterThan(500);
  expect(midWin.endIndex).toBeLessThan(1500);
  expect(midWin.topSpacerHeight).toBeGreaterThan(0);
  expect(midWin.bottomSpacerHeight).toBeGreaterThan(0);

  const rA: any = {
    item_id: "i1",
    tool_call_id: "c1",
    tool_name: "read",
    kind: "tool",
    visibility: "visible",
    status: "visible",
    version: 1,
    summary_line: "ok",
    bytes_size: 100,
    tokens_display: "—",
    manageable: true,
    source: "unrecorded",
    timeline_index: 0,
  };
  const rA2 = { ...rA };
  const stabilized = stabilizeRows([rA], [rA2]);
  expect(stabilized[0]).toBe(rA);

  const g1: OutlineRow = { key: "k1", type: "user", row: rA };
  const g1Clone: OutlineRow = { key: "k1", type: "user", row: rA2 };
  const stabGroup = stabilizeGroupedRows([g1], [g1Clone]);
  expect(stabGroup[0]).toBe(g1);
});

test("client diagnostics keep bounded ring buffer and reject user content or stdout writes", () => {
  clearClientPerf();
  const prev = process.env.SESSION_NAVIGATION_PERF_DIAG;
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  let out = "";
  let err = "";
  process.stdout.write = ((chunk: any) => {
    out += String(chunk);
    return true;
  }) as any;
  process.stderr.write = ((chunk: any) => {
    err += String(chunk);
    return true;
  }) as any;
  try {
    process.env.SESSION_NAVIGATION_PERF_DIAG = "verbose";
    const entry = recordClientPerf({
      op: "outline.window",
      duration_ms: 4.5,
      ok: true,
      row_count: 5000,
      rendered_count: 104,
      virtualized: true,
      ...({
        query: "sensitive search",
        message_text: "sensitive text",
      } as any),
    });
    expect((entry as any).query).toBeUndefined();
    expect((entry as any).message_text).toBeUndefined();
    expect(recentClientPerf(1)[0]?.rendered_count).toBe(104);
    expect((globalThis as any).__sessionNavPerfDiag.size()).toBe(1);
    expect(out).toBe("");
    expect(err).not.toContain("sensitive");
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    if (prev === undefined) delete process.env.SESSION_NAVIGATION_PERF_DIAG;
    else process.env.SESSION_NAVIGATION_PERF_DIAG = prev;
    clearClientPerf();
  }
});
