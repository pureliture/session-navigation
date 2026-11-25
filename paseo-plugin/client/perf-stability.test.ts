import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clearClientPerf, recentClientPerf, recordClientPerf } from "./diagnostics";
import { buildGroupedRows, outlineRowKey, type OutlineRow } from "./outlineGrouping";
import { OutlineScrollDriver } from "./outlineScroll";
import { stabilizeGroupedRows, stabilizeRows, visiblePollInterval } from "./outlineWindow";
import {
  readSessionTimelineIds,
  readSessionTimelinePage,
  resolveSessionTarget,
  resolveSessionTargetProgressive,
  type SessionTimelineCursor,
  type SessionTimelinePage,
} from "./sessionFollowing";
import { readTimelineHistory } from "./timelineHistory";

function makePagedHistoryFixture(
  specs: Record<
    string,
    {
      tailLimit?: number;
      beforeLimit?: number;
      ids: string[];
      failOnPageCall?: number;
    }
  >,
) {
  const pageCalls: Record<string, Array<{ cursor?: SessionTimelineCursor }>> = {};

  const timelineFor = (id: string) => {
    const spec = specs[id];
    pageCalls[id] = [];
    let calls = 0;
    return {
      refetch: async (input: any): Promise<any> => {
        calls += 1;
        if (spec.failOnPageCall === calls) {
          throw new Error(`injected page failure for ${id} at call ${calls}`);
        }
        const total = spec.ids;
        const limit =
          input.direction === "tail"
            ? (spec.tailLimit ?? input.limit ?? 200)
            : (spec.beforeLimit ?? input.limit ?? 1000);
        const end = input.direction === "tail" ? total.length : input.cursor.seq;
        const start = Math.max(0, end - limit);
        const slice = total.slice(start, end);
        return {
          entries: slice.map((entryId, offset) => ({
            item: { id: entryId },
            seqStart: start + offset,
          })),
          hasOlder: start > 0,
          startCursor: start > 0 ? { epoch: "e1", seq: start } : undefined,
        };
      },
    };
  };

  const loadPage = async (id: string, cursor?: SessionTimelineCursor): Promise<SessionTimelinePage> => {
    if (!pageCalls[id]) pageCalls[id] = [];
    pageCalls[id].push({ cursor });
    const spec = specs[id];
    const callNum = pageCalls[id].length;
    if (spec.failOnPageCall === callNum) {
      throw new Error(`injected page failure for ${id} at call ${callNum}`);
    }
    const total = spec.ids;
    const limit = cursor ? (spec.beforeLimit ?? 10) : (spec.tailLimit ?? 5);
    const end = cursor ? cursor.seq : total.length;
    const start = Math.max(0, end - limit);
    return {
      ids: total.slice(start, end),
      complete: start === 0,
      startCursor: start > 0 ? { epoch: "e1", seq: start } : undefined,
    };
  };

  return { pageCalls, loadPage, timelineFor };
}

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

test("readSessionTimelinePage handles tail/before pagination and stuck cursors without looping", async () => {
  const stuck = await readSessionTimelinePage(
    {
      refetch: async (): Promise<any> => ({
        entries: [{ item: { messageId: "x" } }],
        hasOlder: true,
        startCursor: { epoch: "e1", seq: 10 },
      }),
    },
    { epoch: "e1", seq: 10 },
  );
  expect(stuck).toEqual({ ids: [], complete: false, startCursor: undefined });

  const done = await readSessionTimelinePage({
    refetch: async (): Promise<any> => ({
      entries: [{ item: { callId: "c1" } }],
      hasOlder: false,
    }),
  });
  expect(done).toEqual({ ids: ["c1"], complete: true, startCursor: undefined });
});

test("resolveSessionTargetProgressive matches full-history winner even when older candidate outscores tail-200 hit", async () => {
  // a1 has 3 matches in older history and 0 in tail; a2 has 1 match in tail (and is incomplete).
  // Stopping on a2's single tail match would wrongly pick a2 instead of a1!
  const a1Ids = ["old_1", "old_2", "old_3", ...Array.from({ length: 12 }, (_, i) => `a1_pad_${i}`)];
  const a2Ids = [...Array.from({ length: 12 }, (_, i) => `a2_pad_${i}`), "tail_1", "a2_recent"];
  const visibleValues = ["message-old_1", "message-old_2", "message-old_3", "message-tail_1"];

  const { loadPage, timelineFor } = makePagedHistoryFixture({
    a1: { ids: a1Ids, tailLimit: 5, beforeLimit: 5 },
    a2: { ids: a2Ids, tailLimit: 5, beforeLimit: 5 },
  });

  const baseline = await resolveSessionTarget({
    followVisible: true,
    boundAgentId: "a1",
    visibleValues,
    candidates: ["a1", "a2"],
    timelineIds: async (id) => (await readSessionTimelineIds(timelineFor(id))).ids,
  });
  const progressive = await resolveSessionTargetProgressive({
    followVisible: true,
    boundAgentId: "a1",
    visibleValues,
    candidates: ["a1", "a2"],
    loadPage,
  });

  expect(baseline).toBe("a1");
  expect(progressive.confirmed).toBe(true);
  expect(progressive.targetId).toBe("a1");
});

test("resolveSessionTargetProgressive preserves exact tie-break priority when earlier candidate matches only in older history", async () => {
  // ordered = ["a1", "a2"]. a2 matches 1 in tail; a1 matches 0 in tail and 1 in older history -> tie 1:1 MUST go to a1.
  const a1Ids = ["old_hit", ...Array.from({ length: 12 }, (_, i) => `a1_pad_${i}`)];
  const a2Ids = [...Array.from({ length: 12 }, (_, i) => `a2_pad_${i}`), "tail_hit"];
  const visibleValues = ["message-old_hit", "message-tail_hit"];

  const { loadPage, timelineFor } = makePagedHistoryFixture({
    a1: { ids: a1Ids, tailLimit: 5, beforeLimit: 5 },
    a2: { ids: a2Ids, tailLimit: 5, beforeLimit: 5 },
  });

  const baseline = await resolveSessionTarget({
    followVisible: true,
    boundAgentId: "a1",
    visibleValues,
    candidates: ["a1", "a2"],
    timelineIds: async (id) => (await readSessionTimelineIds(timelineFor(id))).ids,
  });
  const progressive = await resolveSessionTargetProgressive({
    followVisible: true,
    boundAgentId: "a1",
    visibleValues,
    candidates: ["a1", "a2"],
    loadPage,
  });

  expect(baseline).toBe("a1");
  expect(progressive.confirmed).toBe(true);
  expect(progressive.targetId).toBe("a1");
});

test("resolveSessionTargetProgressive checks older history of trailing candidate when both match in tail and proves huge leader early", async () => {
  // Case A: a1 (small, complete in tail) scores 1; a2 (trailing, larger) scores 1 in tail + 2 in older -> a2 wins!
  // On page 2, a2 reaches score 2 (> complete a1's score 1) and proves winner without needing page 3.
  const caseA = makePagedHistoryFixture({
    a1: { ids: ["hit_1", "pad_1"], tailLimit: 5, beforeLimit: 5 },
    a2: { ids: ["old_2", "old_3", ...Array.from({ length: 8 }, (_, i) => `p_${i}`), "hit_2"], tailLimit: 5, beforeLimit: 5 },
  });
  const resA = await resolveSessionTargetProgressive({
    followVisible: true,
    boundAgentId: "a1",
    visibleValues: ["message-hit_1", "message-hit_2", "message-old_2", "message-old_3"],
    candidates: ["a1", "a2"],
    loadPage: caseA.loadPage,
  });
  expect(resA).toEqual({
    targetId: "a2",
    confirmed: true,
    incompleteIds: ["a2"],
  });
  expect(caseA.pageCalls.a2.length).toBe(2);

  // Case B: huge candidate a2_huge scores 2 in tail while a1_small completes in 2 pages with score 1.
  // Non-leader-first paging finishes a1_small and proves a2_huge without paging a2_huge past its tail!
  const completedCached: string[] = [];
  const caseB = makePagedHistoryFixture({
    a1_small: { ids: ["a1_old", ...Array.from({ length: 6 }, (_, i) => `s_${i}`)], tailLimit: 4, beforeLimit: 10 },
    a2_huge: { ids: [...Array.from({ length: 50 }, (_, i) => `h_${i}`), "huge_1", "huge_2"], tailLimit: 4, beforeLimit: 4 },
  });
  const resB = await resolveSessionTargetProgressive({
    followVisible: true,
    boundAgentId: "a1_small",
    visibleValues: ["message-a1_old", "message-huge_1", "message-huge_2"],
    candidates: ["a1_small", "a2_huge"],
    loadPage: caseB.loadPage,
    onCompleteTimelineIds: (id) => completedCached.push(id),
  });
  expect(resB.confirmed).toBe(true);
  expect(resB.targetId).toBe("a2_huge");
  expect(resB.incompleteIds).toEqual(["a2_huge"]);
  expect(caseB.pageCalls.a2_huge.length).toBe(1);
  expect(completedCached).toEqual(["a1_small"]);
});

test("resolveSessionTargetProgressive refuses to misclassify bounded incomplete scan as confirmed selection", async () => {
  const visibleValues = ["message-tail_a1"];
  const { loadPage } = makePagedHistoryFixture({
    a1: { ids: [...Array.from({ length: 20 }, (_, i) => `p1_${i}`), "tail_a1"], tailLimit: 5, beforeLimit: 5 },
    a2: { ids: Array.from({ length: 20 }, (_, i) => `p2_${i}`), tailLimit: 5, beforeLimit: 5 },
  });

  // With maxPagesPerCandidate=1, neither a1 nor a2 is complete after tail, so a2 could have older hits!
  const unconfirmed = await resolveSessionTargetProgressive({
    followVisible: true,
    boundAgentId: "a1",
    visibleValues,
    candidates: ["a1", "a2"],
    loadPage,
    maxPagesPerCandidate: 1,
  });
  expect(unconfirmed.confirmed).toBe(false);
  expect(unconfirmed.targetId).toBeNull();
  expect(unconfirmed.incompleteIds).toEqual(["a1", "a2"]);

  // If competitor a2 IS complete with score 0 on page 1, a1 is provably the winner even with maxPagesPerCandidate=1.
  const provable = makePagedHistoryFixture({
    a1: { ids: [...Array.from({ length: 20 }, (_, i) => `p1_${i}`), "tail_a1"], tailLimit: 5, beforeLimit: 5 },
    a2: { ids: ["only_recent"], tailLimit: 5, beforeLimit: 5 },
  });
  const confirmed = await resolveSessionTargetProgressive({
    followVisible: true,
    boundAgentId: "a1",
    visibleValues,
    candidates: ["a1", "a2"],
    loadPage: provable.loadPage,
    maxPagesPerCandidate: 1,
  });
  expect(confirmed.confirmed).toBe(true);
  expect(confirmed.targetId).toBe("a1");
  expect(confirmed.incompleteIds).toEqual(["a1"]);
});

test("resolveSessionTargetProgressive uses complete cache and tail cache cleanly when provable", async () => {
  let loadCalls = 0;
  const cachedResult = await resolveSessionTargetProgressive({
    followVisible: true,
    boundAgentId: "a1",
    visibleValues: ["message-m1"],
    candidates: ["a1", "a2"],
    getCachedTimelineIds: (id) =>
      id === "a1" ? { ids: ["other"], complete: true } : undefined,
    getCachedTailPage: (id) =>
      id === "a2" ? { ids: ["m1"], complete: true } : undefined,
    loadPage: async () => {
      loadCalls += 1;
      return { ids: [], complete: true };
    },
  });
  expect(loadCalls).toBe(0);
  expect(cachedResult).toEqual({
    targetId: "a2",
    confirmed: true,
    incompleteIds: [],
  });
});

test("stabilizeRows avoids fallback item_id/tool_call_id collisions and detects cost_usd changes", () => {
  const f1: any = {
    item_id: null,
    tool_call_id: "",
    tool_name: "user",
    kind: "user",
    status: "visible",
    version: 1,
    tokens_display: "—",
    summary_line: "first message",
    timeline_index: 0,
  };
  const f2: any = {
    item_id: null,
    tool_call_id: "",
    tool_name: "assistant",
    kind: "assistant",
    status: "visible",
    version: 1,
    tokens_display: "—",
    summary_line: "second message",
    timeline_index: 1,
  };
  const next = [{ ...f1 }, { ...f2 }];
  const stabilized = stabilizeRows([f1, f2], next);
  expect(stabilized[0]).toBe(f1);
  expect(stabilized[1]).toBe(f2);

  const costUpdated = stabilizeRows([f1], [{ ...f1, cost_usd: 0.02 }]);
  expect(costUpdated[0]).not.toBe(f1);
  expect(costUpdated[0].cost_usd).toBe(0.02);

  const g1: OutlineRow = { key: outlineRowKey(f1, 0), type: "user", row: f1 };
  const stabGroup = stabilizeGroupedRows([g1], [{ ...g1, row: { ...f1 } }]);
  expect(stabGroup[0]).toBe(g1);
  expect(typeof visiblePollInterval(10_000)).toBe("number");
});

test("variable-height >160 row outline keeps full scroll anchoring across width resize, wrap growth, expand, prepend, and search", () => {
  const rows: any[] = [];
  for (let i = 0; i < 240; i++) {
    if (i % 5 === 0) {
      rows.push({
        item_id: `u_${i}`,
        tool_call_id: "",
        kind: "user",
        tool_name: "user",
        status: "visible",
        version: 1,
        tokens_display: "—",
        summary_line: "Wrapped long prompt line\nsecond wrapped line\nthird wrapped line",
        timeline_index: i,
      });
    } else {
      rows.push({
        item_id: `t_${i}`,
        tool_call_id: `call_${i}`,
        kind: "tool",
        tool_name: "bash",
        status: "visible",
        version: 1,
        tokens_display: "—",
        summary_line: `command output line ${i}`,
        timeline_index: i,
      });
    }
  }
  const grouped = buildGroupedRows(rows, {}, {});
  expect(grouped.length).toBeGreaterThan(80);
  // Expand all tool groups so rendered variable-height item count exceeds 160.
  const expandedMap: Record<string, boolean> = {};
  for (const item of grouped) {
    if (item.type === "group") expandedMap[item.groupId] = true;
  }
  const expanded = buildGroupedRows(rows, expandedMap, {});
  expect(expanded.length).toBeGreaterThan(160);

  const driver = new OutlineScrollDriver(1500);
  const offsets: number[] = [];
  let clientHeight = 620;
  let scrollHeight = 18_400; // variable wrapped heights above initial estimate
  let scrollTop = 0;
  const list = {
    getScrollableNode: () => ({ scrollTop, scrollHeight, clientHeight }),
    scrollToEnd: () => {
      scrollTop = Math.max(0, scrollHeight - clientHeight);
    },
    scrollToOffset: ({ offset }: { offset: number }) => {
      scrollTop = offset;
      offsets.push(offset);
    },
  };
  const state = {
    sessionKey: "var-height-s1",
    mounted: true,
    rowCount: expanded.length,
    isLoading: false,
    hasSearchQuery: false,
  };

  driver.handleLayout(list, { nativeEvent: { layout: { height: clientHeight } } }, state, 1000);
  driver.handleContentSizeChange(list, scrollHeight, state, 1020);
  expect(scrollTop).toBe(18_400 - 620);

  // User fast-scrolls upward to inspect mid-history.
  driver.handleWheel({ deltaY: -120 });
  scrollTop = 4200;
  driver.handleScrollEvent(
    { nativeEvent: { contentOffset: { y: scrollTop }, contentSize: { height: scrollHeight }, layoutMeasurement: { height: clientHeight } } },
    2000,
  );
  expect(driver.scroller.isStuckToBottom()).toBe(false);

  // Narrower sidebar/viewport width causes existing wrapped text rows to double in height (18,400 -> 22,900)
  // without jumping back to bottom.
  scrollHeight = 22_900;
  driver.handleContentSizeChange(list, scrollHeight, state, 2500);
  expect(scrollTop).toBe(4200);

  // Prepending older variable-height rows shifts scrollTop by exact measured delta.
  offsets.length = 0;
  driver.preparePrepend(list);
  scrollHeight = 26_150;
  driver.handleContentSizeChange(list, scrollHeight, { ...state, rowCount: expanded.length + 30 }, 3000);
  expect(offsets).toEqual([4200 + 3250]);
  expect(scrollTop).toBe(7450);
  driver.handleScrollEvent(
    { nativeEvent: { contentOffset: { y: scrollTop }, contentSize: { height: scrollHeight }, layoutMeasurement: { height: clientHeight } } },
    3050,
  );

  // Search filter narrows list then clears back to saved scrollTop.
  driver.maybeSync(list, { ...state, hasSearchQuery: true, rowCount: 12 }, { contentHeight: 720, now: 3500, scheduleFrame: () => {} });
  scrollHeight = 26_150;
  driver.maybeSync(list, { ...state, hasSearchQuery: false, rowCount: expanded.length + 30 }, { contentHeight: scrollHeight, now: 4000, scheduleFrame: () => {} });
  expect(scrollTop).toBe(7450);
  driver.dispose();

  // Regression guard: SessionNavPanel renders groupedRows directly in ScrollView without synthetic spacer slicing.
  const panelSource = readFileSync(join(import.meta.dir, "sessionNavPanel.tsx"), "utf8");
  expect(panelSource).toContain("{groupedRows.map((item) => {");
  expect(panelSource).not.toContain("computeOutlineWindow");
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
      op: "sessionFollow.resolve",
      duration_ms: 4.5,
      ok: true,
      candidate_count: 3,
      page_count: 2,
      ...({
        query: "sensitive search",
        message_text: "sensitive text",
      } as any),
    });
    expect((entry as any).query).toBeUndefined();
    expect((entry as any).message_text).toBeUndefined();
    expect(recentClientPerf(1)[0]?.candidate_count).toBe(3);
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
