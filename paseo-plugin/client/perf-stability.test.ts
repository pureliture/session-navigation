import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clearClientPerf, recentClientPerf, recordClientPerf } from "./diagnostics";
import { buildGroupedRows, outlineRowKey, type OutlineRow } from "./outlineGrouping";
import { OutlineScrollDriver } from "./outlineScroll";
import { stabilizeGroupedRows, stabilizeRows, visiblePollInterval } from "./outlineWindow";
import {
  FollowSelectionCoordinator,
  followSnapshotKey,
  isSameConfirmedFollowSession,
  reconcileFollowSelection,
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
    failedIds: [],
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
  expect(resB.failedIds).toEqual([]);
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
  expect(unconfirmed.failedIds).toEqual([]);

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
  expect(confirmed.failedIds).toEqual([]);
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
    failedIds: [],
  });
});

test("resolveSessionTargetProgressive refuses confirmed winner on initial tail failure when unread competitor may outscore", async () => {
  // a1 completes with score 1, while a2 fails on initial tail fetch and actually holds 3 matches.
  const a2Ids = ["m_1", "m_2", "m_3"];
  const tailLoadedIds: string[] = [];
  const completeCachedIds: string[] = [];
  const { loadPage } = makePagedHistoryFixture({
    a1: { ids: ["hit_a1"], tailLimit: 5, beforeLimit: 5 },
    a2: { ids: a2Ids, tailLimit: 5, beforeLimit: 5, failOnPageCall: 1 },
  });

  const res = await resolveSessionTargetProgressive({
    followVisible: true,
    boundAgentId: "a1",
    visibleValues: ["message-hit_a1", "message-m_1", "message-m_2", "message-m_3"],
    candidates: ["a1", "a2"],
    loadPage,
    onTailLoaded: (id) => tailLoadedIds.push(id),
    onCompleteTimelineIds: (id) => completeCachedIds.push(id),
  });

  expect(res.confirmed).toBe(false);
  expect(res.targetId).toBeNull();
  expect(res.incompleteIds).toEqual(["a2"]);
  expect(res.failedIds).toEqual(["a2"]);
  expect(tailLoadedIds).toEqual(["a1"]);
  expect(completeCachedIds).toEqual(["a1"]);
});

test("resolveSessionTargetProgressive refuses confirmed winner when mid-history RPC fails before higher older score, then recovers on retry", async () => {
  // Reproduces exact 784a78f defect:
  // a1 is complete with score 2.
  // a2 gets 1 match in tail (call 1), then RPC fails on older page (call 2), hiding 4 matches in older pages (total 5 > 2).
  let a2ShouldFailMid = true;
  const cachedComplete = new Map<string, { ids: string[]; complete: boolean }>();
  const a1Ids = ["a1_h1", "a1_h2"];
  const a2Ids = ["old_1", "old_2", "old_3", "old_4", "pad_1", "pad_2", "pad_3", "pad_4", "tail_hit", "pad_5"];
  const visibleValues = [
    "message-a1_h1",
    "message-a1_h2",
    "message-tail_hit",
    "message-old_1",
    "message-old_2",
    "message-old_3",
    "message-old_4",
  ];

  let a1Calls = 0;
  let a2CallsThisAttempt = 0;
  const loadPage = async (id: string, cursor?: SessionTimelineCursor): Promise<SessionTimelinePage> => {
    if (id === "a1") {
      a1Calls += 1;
      return { ids: a1Ids, complete: true, startCursor: undefined };
    }
    a2CallsThisAttempt += 1;
    if (!cursor) {
      return {
        ids: a2Ids.slice(5), // tail 5 -> 1 hit ("tail_hit")
        complete: false,
        startCursor: { epoch: "e1", seq: 5 },
      };
    }
    if (a2ShouldFailMid) {
      throw new Error("transient older-page RPC error");
    }
    return {
      ids: a2Ids.slice(0, cursor.seq), // 4 older hits
      complete: true,
      startCursor: undefined,
    };
  };

  // Attempt 1 (mid-page failure): MUST return confirmed=false, NOT pick a1 with confirmed=true!
  const attempt1 = await resolveSessionTargetProgressive({
    followVisible: true,
    boundAgentId: "a1",
    visibleValues,
    candidates: ["a1", "a2"],
    getCachedTimelineIds: (id) => cachedComplete.get(id),
    loadPage,
    onCompleteTimelineIds: (id, ids) => cachedComplete.set(id, { ids, complete: true }),
  });
  expect(attempt1).toEqual({
    targetId: null,
    confirmed: false,
    incompleteIds: ["a2"],
    failedIds: ["a2"],
  });
  expect(cachedComplete.has("a1")).toBe(true);
  expect(cachedComplete.has("a2")).toBe(false);

  // Attempt 2 (recovery): a1 is served from complete cache (0 more calls), a2 retries and wins 5 > 2!
  a2ShouldFailMid = false;
  a2CallsThisAttempt = 0;
  const attempt2 = await resolveSessionTargetProgressive({
    followVisible: true,
    boundAgentId: "a1",
    visibleValues,
    candidates: ["a1", "a2"],
    getCachedTimelineIds: (id) => cachedComplete.get(id),
    loadPage,
    onCompleteTimelineIds: (id, ids) => cachedComplete.set(id, { ids, complete: true }),
  });
  expect(attempt2).toEqual({
    targetId: "a2",
    confirmed: true,
    incompleteIds: [],
    failedIds: [],
  });
  expect(a1Calls).toBe(1);
  expect(a2CallsThisAttempt).toBe(2);
  expect(cachedComplete.has("a2")).toBe(true);
});

test("resolveSessionTargetProgressive blocks tie award when earlier candidate fails mid-history and recovers tie priority", async () => {
  // ordered = ["a1", "a2"]. a2 completes with score 1.
  // a1 gets 0 in tail (pad), fails on older page that contains 1 match -> tie 1:1 MUST wait for recovery!
  let failA1Mid = true;
  const a1Ids = ["old_tie_hit", "p1", "p2", "p3", "p4", "p5", "p6", "p7"];
  const a2Ids = ["a2_tail_hit"];
  const visibleValues = ["message-old_tie_hit", "message-a2_tail_hit"];

  const loadPage = async (id: string, cursor?: SessionTimelineCursor): Promise<SessionTimelinePage> => {
    if (id === "a2") {
      return { ids: a2Ids, complete: true };
    }
    if (!cursor) {
      return { ids: a1Ids.slice(4), complete: false, startCursor: { epoch: "e1", seq: 4 } };
    }
    if (failA1Mid) throw new Error("a1 older page RPC error");
    return { ids: a1Ids.slice(0, 4), complete: true };
  };

  const duringFail = await resolveSessionTargetProgressive({
    followVisible: true,
    boundAgentId: "a1",
    visibleValues,
    candidates: ["a1", "a2"],
    loadPage,
  });
  expect(duringFail).toEqual({
    targetId: null,
    confirmed: false,
    incompleteIds: ["a1"],
    failedIds: ["a1"],
  });

  failA1Mid = false;
  const recovered = await resolveSessionTargetProgressive({
    followVisible: true,
    boundAgentId: "a1",
    visibleValues,
    candidates: ["a1", "a2"],
    loadPage,
  });
  expect(recovered).toEqual({
    targetId: "a1",
    confirmed: true,
    incompleteIds: [],
    failedIds: [],
  });
});

test("resolveSessionTargetProgressive allows confirmed winner only if ALL competitors are strictly complete and surpassed", async () => {
  // a1 gets 2 hits in tail while competitor a2 is strictly complete with 1 hit.
  // Proof finishes after tail without ever needing to touch a1's unavailable older page.
  const cachedComplete: string[] = [];
  let a1OlderCalls = 0;
  const res = await resolveSessionTargetProgressive({
    followVisible: true,
    boundAgentId: "a1",
    visibleValues: ["message-h1", "message-h2", "message-a2h"],
    candidates: ["a1", "a2"],
    loadPage: async (id, cursor) => {
      if (id === "a2") return { ids: ["a2h"], complete: true };
      if (!cursor) {
        return {
          ids: ["h1", "h2"],
          complete: false,
          startCursor: { epoch: "e1", seq: 5 },
        };
      }
      a1OlderCalls += 1;
      throw new Error("a1 older page unavailable");
    },
    onCompleteTimelineIds: (id) => cachedComplete.push(id),
  });
  expect(res).toEqual({
    targetId: "a1",
    confirmed: true,
    incompleteIds: ["a1"],
    failedIds: [],
  });
  expect(a1OlderCalls).toBe(0);
  expect(cachedComplete).toEqual(["a2"]);
});

test("reconcileFollowSelection clears stale previous session on uncertain failure and SessionNavPanel gates mutations", () => {
  // 1. Confirmed Session A ("a1")
  const sessionA = reconcileFollowSelection({
    tab: { kind: "chat" } as any,
    followVisible: true,
    followResult: { targetId: "a1", confirmed: true, incompleteIds: [], failedIds: [] },
    boundAgentId: "a1",
  });
  expect(sessionA).toEqual({
    agentId: "a1",
    inView: true,
    followResolved: true,
    followUncertain: false,
    retryable: false,
  });

  // 2. Follow failure happens (even though panel was bound to "a1"): MUST clear agentId & inView, set followUncertain=true
  const uncertain = reconcileFollowSelection({
    tab: { kind: "chat" } as any,
    followVisible: true,
    followResult: { targetId: null, confirmed: false, incompleteIds: ["a2"], failedIds: ["a2"] },
    boundAgentId: "a1",
  });
  expect(uncertain).toEqual({
    agentId: null,
    inView: false,
    followResolved: true,
    followUncertain: true,
    retryable: true,
  });

  // 3. Recovery resolves Session B ("a2") cleanly and clears uncertain/retryable flags
  const recovered = reconcileFollowSelection({
    tab: { kind: "chat" } as any,
    followVisible: true,
    followResult: { targetId: "a2", confirmed: true, incompleteIds: [], failedIds: [] },
    boundAgentId: "a1",
  });
  expect(recovered).toEqual({
    agentId: "a2",
    inView: true,
    followResolved: true,
    followUncertain: false,
    retryable: false,
  });

  // 4. Direct agent tab clears uncertain state immediately
  const directTab = reconcileFollowSelection({
    tab: { kind: "agent", agentId: "a2" },
    followVisible: true,
    followResult: null,
    boundAgentId: "a1",
  });
  expect(directTab).toEqual({
    agentId: "a2",
    inView: true,
    followResolved: true,
    followUncertain: false,
    retryable: false,
  });

  // 5. Structural guard: SessionNavPanel clears agentId when !inView || followUncertain and gates mutations
  const panelSource = readFileSync(join(import.meta.dir, "sessionNavPanel.tsx"), "utf8");
  expect(panelSource).toContain("inView && !followUncertain");
  expect(panelSource).toContain("canMutateSession");
  expect(panelSource).toContain("Retry session match");
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

test("FollowSelectionCoordinator blocks actions immediately on A->B switch and discards stale slow scans (both completion orders)", async () => {
  // Helper deferred gate for deterministic async interleaving.
  const deferred = <T,>() => {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  // Initial mount in follow mode bound to "a1" MUST block actions before first match confirms.
  const coord = new FollowSelectionCoordinator(true, "a1");
  expect(coord.getState()).toMatchObject({
    agentId: null,
    inView: false,
    followResolved: false,
    actionBlocked: true,
  });

  // Initial slow scan for A ("msg-a1") starts; mid-scan focus switches to B ("msg-b1").
  const obsA = { tab: null, visibleValues: ["msg-a1"] };
  const obsB = { tab: null, visibleValues: ["msg-b1"] };
  const attemptA = coord.beginAttempt(obsA, true);
  expect(attemptA.kind).toBe("run");
  if (attemptA.kind !== "run") throw new Error("expected run attempt for A");

  const gateA = deferred<SessionTimelinePage>();
  let aPageCalls = 0;
  const slowScanA = resolveSessionTargetProgressive({
    followVisible: true,
    boundAgentId: "a1",
    visibleValues: [...obsA.visibleValues],
    candidates: ["a1", "b1"],
    loadPage: async (id) => {
      aPageCalls += 1;
      if (id === "a1") return gateA.promise;
      return { ids: ["msg-b1"], complete: true };
    },
    isStale: () => !coord.isCurrent(attemptA.generation),
  });

  // Switch focus to B while slowScanA is still suspended on gateA.
  const liveToB = coord.observeLiveChange(obsB, true);
  expect(liveToB.invalidatedInFlight).toBe(true);
  expect(coord.isCurrent(attemptA.generation)).toBe(false);

  // Start fast scan for B immediately (without waiting for slowScanA).
  const attemptB = coord.beginAttempt(obsB, true);
  expect(attemptB.kind).toBe("run");
  if (attemptB.kind !== "run") throw new Error("expected run attempt for B");
  const fastResultB = await resolveSessionTargetProgressive({
    followVisible: true,
    boundAgentId: "a1",
    visibleValues: [...obsB.visibleValues],
    candidates: ["a1", "b1"],
    loadPage: async (id) =>
      id === "b1"
        ? { ids: ["msg-b1"], complete: true }
        : { ids: ["msg-a1"], complete: true },
    isStale: () => !coord.isCurrent(attemptB.generation),
  });
  const outcomeB = coord.commitAttempt({
    generation: attemptB.generation,
    startObservation: obsB,
    startSnapshotKey: attemptB.snapshotKey,
    liveObservation: obsB,
    followVisible: true,
    followResult: fastResultB,
    boundAgentId: "a1",
  });
  expect(outcomeB.committed).toBe(true);
  expect(outcomeB.state).toMatchObject({
    agentId: "b1",
    inView: true,
    followResolved: true,
    followSwitching: false,
    actionBlocked: false,
  });

  // Late resolution of slowScanA MUST stop early via isStale and be discarded (never overwrite B).
  gateA.resolve({ ids: ["msg-a1"], complete: false, startCursor: { epoch: "e1", seq: 1 } });
  const staleResultA = await slowScanA;
  expect(staleResultA.confirmed).toBe(false);
  expect(aPageCalls).toBe(2); // did not proceed to "before" pagination once marked stale
  const staleOutcomeA = coord.commitAttempt({
    generation: attemptA.generation,
    startObservation: obsA,
    startSnapshotKey: attemptA.snapshotKey,
    liveObservation: obsB,
    followVisible: true,
    followResult: staleResultA,
    boundAgentId: "a1",
  });
  expect(staleOutcomeA).toMatchObject({
    committed: false,
    staleReason: "superseded",
    needsFollowUp: false,
  });
  expect(coord.getState().agentId).toBe("b1");

  // Second switch B -> C: verify stale previous-session B actions are blocked at T=0ms before C settles.
  const obsC = { tab: null, visibleValues: ["msg-c1"] };
  const switchBtoC = coord.observeLiveChange(obsC, true, (id) =>
    id === "b1" ? ["msg-b1"] : undefined,
  );
  expect(switchBtoC.enteredSwitching).toBe(true);
  expect(switchBtoC.state).toMatchObject({
    agentId: null,
    followSwitching: true,
    actionBlocked: true,
  });

  // Also test stale slow B resolving AFTER superseding attempt C starts (reverse completion order).
  const attemptCSlow = coord.beginAttempt(obsC, true);
  if (attemptCSlow.kind !== "run") throw new Error("expected run attempt for C");
  const obsD = { tab: null, visibleValues: ["msg-d1"] };
  coord.observeLiveChange(obsD, true);
  const outcomeCSupersededBeforeD = coord.commitAttempt({
    generation: attemptCSlow.generation,
    startObservation: obsC,
    startSnapshotKey: attemptCSlow.snapshotKey,
    liveObservation: obsD,
    followVisible: true,
    followResult: { targetId: "c1", confirmed: true, incompleteIds: [], failedIds: [] },
    boundAgentId: "a1",
  });
  expect(outcomeCSupersededBeforeD.committed).toBe(false);
  expect(coord.getState().actionBlocked).toBe(true);
  expect(coord.getState().agentId).toBeNull();
});

test("FollowSelectionCoordinator catches silent mid-scan DOM changes and keeps same-session refreshes flicker-free", () => {
  const coord = new FollowSelectionCoordinator(true, "a1");
  const knownTimelines: Record<string, string[]> = {
    a1: ["msg-a1", "msg-a2"],
    b1: ["msg-b1"],
  };
  const getKnown = (id: string) => knownTimelines[id];

  // Confirm session A ("a1").
  const obsA1 = { tab: null, visibleValues: ["msg-a1"] };
  const a1 = coord.beginAttempt(obsA1, true, getKnown);
  if (a1.kind !== "run") throw new Error("expected run");
  const cA1 = coord.commitAttempt({
    generation: a1.generation,
    startObservation: obsA1,
    startSnapshotKey: a1.snapshotKey,
    liveObservation: obsA1,
    followVisible: true,
    followResult: { targetId: "a1", confirmed: true, incompleteIds: [], failedIds: [] },
    boundAgentId: "a1",
    getKnownAgentTimelineIds: getKnown,
  });
  expect(cA1.state).toMatchObject({
    agentId: "a1",
    inView: true,
    followSwitching: false,
    actionBlocked: false,
  });

  // 1. Periodic 3s refresh on identical snapshot: NO switching banner, NO action blocking, deduplicates same snapshot in-flight.
  const refreshSame = coord.beginAttempt(obsA1, true, getKnown);
  expect(refreshSame.kind).toBe("run");
  if (refreshSame.kind !== "run") throw new Error("expected run");
  expect(refreshSame.enteredSwitching).toBe(false);
  expect(coord.getState()).toMatchObject({
    agentId: "a1",
    followSwitching: false,
    actionBlocked: false,
  });
  const dupRefresh = coord.beginAttempt(obsA1, true, getKnown);
  expect(dupRefresh.kind).toBe("dedup");

  // 2. While identical periodic refresh is in-flight, DOM silently mutates to session B without a prior event
  // (including a shared generic DOM chrome id "chat-root" that must NOT mask an A -> B session change).
  const obsBWithSharedChrome = { tab: null, visibleValues: ["chat-root", "msg-b1"] };
  expect(
    isSameConfirmedFollowSession({
      confirmed: coord.getConfirmed(),
      observation: obsBWithSharedChrome,
      getKnownAgentTimelineIds: getKnown,
    }),
  ).toBe(false);

  const staleCommit = coord.commitAttempt({
    generation: refreshSame.generation,
    startObservation: obsA1,
    startSnapshotKey: refreshSame.snapshotKey,
    liveObservation: obsBWithSharedChrome,
    followVisible: true,
    followResult: { targetId: "a1", confirmed: true, incompleteIds: [], failedIds: [] },
    boundAgentId: "a1",
    getKnownAgentTimelineIds: getKnown,
  });
  expect(staleCommit).toMatchObject({
    committed: false,
    staleReason: "snapshot_changed",
    needsFollowUp: true,
    enteredSwitching: true,
  });
  expect(staleCommit.state).toMatchObject({
    agentId: null,
    followSwitching: true,
    actionBlocked: true,
  });

  // 3. Follow-up scan resolves B cleanly.
  const b1 = coord.beginAttempt(obsBWithSharedChrome, true, getKnown);
  if (b1.kind !== "run") throw new Error("expected run");
  const cB1 = coord.commitAttempt({
    generation: b1.generation,
    startObservation: obsBWithSharedChrome,
    startSnapshotKey: b1.snapshotKey,
    liveObservation: obsBWithSharedChrome,
    followVisible: true,
    followResult: { targetId: "b1", confirmed: true, incompleteIds: [], failedIds: [] },
    boundAgentId: "a1",
    getKnownAgentTimelineIds: getKnown,
  });
  expect(cB1).toMatchObject({
    committed: true,
    state: {
      agentId: "b1",
      inView: true,
      followSwitching: false,
      actionBlocked: false,
    },
  });

  // 4. Same-session scroll / streaming new message matching cached B timeline: NO switching flicker and NO blocking.
  knownTimelines.b1 = ["msg-b1", "msg-b2"];
  const obsBScrolled = { tab: null, visibleValues: ["msg-b1", "msg-b2"] };
  const liveScroll = coord.observeLiveChange(obsBScrolled, true, getKnown);
  expect(liveScroll.enteredSwitching).toBe(false);
  expect(liveScroll.state).toMatchObject({
    agentId: "b1",
    followSwitching: false,
    actionBlocked: false,
  });
});

test("FollowSelectionCoordinator handles direct tab supersede, uncertain failure retry without flicker, recovery, and panel wiring", () => {
  const coord = new FollowSelectionCoordinator(true, "a1");
  const obsA = { tab: null, visibleValues: ["msg-a1"] };
  const aAttempt = coord.beginAttempt(obsA, true);
  if (aAttempt.kind !== "run") throw new Error("expected run");

  // Direct agent tab B supersedes slow scan A immediately.
  const tabB = { tab: { kind: "agent" as const, agentId: "b1" }, visibleValues: null };
  const bAttempt = coord.beginAttempt(tabB, true);
  if (bAttempt.kind !== "run") throw new Error("expected run");
  const bCommitted = coord.commitAttempt({
    generation: bAttempt.generation,
    startObservation: tabB,
    startSnapshotKey: followSnapshotKey(tabB),
    liveObservation: tabB,
    followVisible: true,
    followResult: null,
    boundAgentId: "a1",
  });
  expect(bCommitted.state).toMatchObject({
    agentId: "b1",
    inView: true,
    followSwitching: false,
    actionBlocked: false,
  });

  // Stale slow scan A resolves late -> rejected, B remains active.
  const lateA = coord.commitAttempt({
    generation: aAttempt.generation,
    startObservation: obsA,
    startSnapshotKey: aAttempt.snapshotKey,
    liveObservation: tabB,
    followVisible: true,
    followResult: { targetId: "a1", confirmed: true, incompleteIds: [], failedIds: [] },
    boundAgentId: "a1",
  });
  expect(lateA.committed).toBe(false);
  expect(coord.getState().agentId).toBe("b1");

  // Switch B -> failing C: blocks B immediately, enters followUncertain, retries cleanly without flicker, recovers to C.
  const obsC = { tab: null, visibleValues: ["msg-c1"] };
  const cAttempt1 = coord.beginAttempt(obsC, true);
  if (cAttempt1.kind !== "run") throw new Error("expected run");
  expect(cAttempt1.enteredSwitching).toBe(true);
  expect(cAttempt1.state.actionBlocked).toBe(true);

  const cFailed = coord.commitAttempt({
    generation: cAttempt1.generation,
    startObservation: obsC,
    startSnapshotKey: cAttempt1.snapshotKey,
    liveObservation: obsC,
    followVisible: true,
    followResult: { targetId: null, confirmed: false, incompleteIds: ["c1"], failedIds: ["c1"] },
    boundAgentId: "a1",
  });
  expect(cFailed.state).toMatchObject({
    agentId: null,
    inView: false,
    followUncertain: true,
    followSwitching: false,
    actionBlocked: true,
    retryable: true,
    failedIds: ["c1"],
  });

  // Retry while uncertain stays on error screen (does not flip followSwitching=true).
  const cRetry = coord.beginAttempt(obsC, true);
  if (cRetry.kind !== "run") throw new Error("expected run");
  expect(cRetry.enteredSwitching).toBe(false);
  expect(cRetry.state.actionBlocked).toBe(true);

  // Recovery confirms C and re-enables actions.
  const cRecovered = coord.commitAttempt({
    generation: cRetry.generation,
    startObservation: obsC,
    startSnapshotKey: cRetry.snapshotKey,
    liveObservation: obsC,
    followVisible: true,
    followResult: { targetId: "c1", confirmed: true, incompleteIds: [], failedIds: [] },
    boundAgentId: "a1",
  });
  expect(cRecovered.state).toMatchObject({
    agentId: "c1",
    inView: true,
    followUncertain: false,
    followSwitching: false,
    actionBlocked: false,
    retryable: false,
  });

  // Structural guard verifying SessionNavPanel wires FollowSelectionCoordinator, sync ref guard, and live probe.
  const panelSource = readFileSync(join(import.meta.dir, "sessionNavPanel.tsx"), "utf8");
  expect(panelSource).toContain("FollowSelectionCoordinator");
  expect(panelSource).toContain("followActionBlockedRef");
  expect(panelSource).toContain("isMutationAllowedNow");
  expect(panelSource).toContain("isStale: () => cancelled || !coordinator.isCurrent(attempt.generation)");
  expect(panelSource).toContain("coordinator.commitAttempt");
  expect(panelSource).toContain("Switching session…");
});
