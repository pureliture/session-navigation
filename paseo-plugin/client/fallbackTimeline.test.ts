import { describe, expect, test } from "bun:test";
import type { Row } from "../shared/sessionNav";
import { buildFallbackTimelineRows, mergeHermesTimelineRows, mergeLinkedParentRows } from "./fallbackTimeline";

describe("fallbackTimeline", () => {
  test("buildFallbackTimelineRows converts user, assistant, tool, todo, error, compaction, and plugin entries", () => {
    const entries = [
      {
        seqStart: 1,
        item: { type: "user_message", messageId: "m-user-1", text: "Check pod health" },
      },
      {
        seqStart: 2,
        item: { type: "assistant_message", clientMessageId: "m-ast-1", text: "Running kubectl" },
      },
      {
        seqStart: 3,
        item: {
          type: "tool_call",
          callId: "call-cmd",
          detail: { type: "shell", command: "kubectl get pods -A", output: "pod-a Running" },
        },
      },
      {
        seqStart: 4,
        item: {
          type: "tool_call",
          callId: "call-mc",
          args: { tool_call_ids: ["call-cmd"] },
          detail: { title: "manage_context" },
        },
      },
      {
        seqStart: 5,
        item: {
          type: "tool_call",
          callId: "call-sub",
          detail: { type: "sub_agent", description: "Audit logs", actions: [{}, {}] },
        },
      },
      {
        seqStart: 6,
        item: {
          type: "todo",
          items: [
            { text: "Inspect pods", completed: true },
            { title: "Report status", completed: false },
          ],
        },
      },
      {
        seqStart: 7,
        item: { type: "error", message: "Connection reset" },
      },
      {
        seqStart: 8,
        item: { type: "compaction", summary: "Compacted 12 messages" },
      },
      {
        seqStart: 9,
        item: { type: "plugin", title: "SessionNav", data: { summary: "Synced" } },
      },
      {
        seqStart: 10,
        item: null,
      },
    ];

    const rows = buildFallbackTimelineRows(entries);
    expect(rows).toHaveLength(9);

    expect(rows[0]).toMatchObject({
      item_id: "m-user-1",
      kind: "user",
      tool_name: "user",
      summary_line: "Check pod health",
      message_text: "Check pod health",
    });
    expect(rows[1]).toMatchObject({
      item_id: "m-ast-1",
      kind: "assistant",
      tool_name: "assistant",
      summary_line: "Running kubectl",
    });
    expect(rows[2]).toMatchObject({
      item_id: "call-cmd",
      tool_call_id: "call-cmd",
      kind: "tool",
      tool_name: "run_command",
      summary_line: "$ kubectl get pods -A",
    });
    expect(rows[3]).toMatchObject({
      item_id: "call-mc",
      kind: "tool",
      tool_name: "manage_context",
    });
    expect(rows[4]).toMatchObject({
      item_id: "call-sub",
      kind: "tool",
      summary_line: "Audit logs (2 actions)",
    });
    expect(rows[5]).toMatchObject({
      kind: "agent",
      tool_name: "todo",
      manageable: false,
      summary_line: "[Todo 1/2] [x] Inspect pods",
    });
    expect(rows[6]).toMatchObject({
      kind: "agent",
      tool_name: "error",
      manageable: false,
      summary_line: "[Error] Connection reset",
    });
    expect(rows[7]).toMatchObject({
      kind: "agent",
      tool_name: "compaction",
      manageable: false,
      summary_line: "[Compaction] Compacted 12 messages",
    });
    expect(rows[8]).toMatchObject({
      kind: "agent",
      tool_name: "plugin",
      manageable: false,
      summary_line: "[Plugin · SessionNav] Synced",
    });
  });

  test("mergeHermesTimelineRows preserves chronological order while upgrading matching tool calls to manageable items", () => {
    const parent = "hermes:default:parent:unknown";
    const managed: Row = {
      item_id: "item_1",
      tool_call_id: "call-read",
      kind: "tool",
      tool_name: "read_file",
      status: "visible",
      version: 1,
      tokens_display: "—",
      manageable: true,
    };
    const timeline: Row[] = [
      {
        item_id: "u1",
        tool_call_id: "",
        kind: "user",
        tool_name: "user",
        status: "visible",
        version: 1,
        tokens_display: "—",
        summary_line: "hello",
      },
      { ...managed, item_id: "call-read", manageable: false },
      {
        item_id: "call-del",
        tool_call_id: "call-del",
        kind: "tool",
        tool_name: "delegate_task",
        status: "visible",
        version: 1,
        tokens_display: "—",
        manageable: false,
      },
    ];

    const merged = mergeHermesTimelineRows([managed], timeline, [], parent);
    expect(merged).toEqual([
      { ...timeline[0], item_id: null, manageable: false },
      managed,
      { ...timeline[2], item_id: null, manageable: false },
    ]);
    // Consumer-visible regression: the merged outline keeps the parent
    // delegate_task row with its own tool name; no subagent child rows are
    // fabricated and no "Open tab" affordance exists in the merge output.
    expect(merged.filter((row) => row.tool_name === "delegate_task")).toHaveLength(1);
  });
  test("mergeHermesTimelineRows keeps unmatched older server rows ahead of the merged tail", () => {
    const parent = "hermes:default:parent:unknown";
    const serverRows: Row[] = [
      { item_id: "srv-old", tool_call_id: "call-old", kind: "tool", tool_name: "terminal", status: "visible", version: 1, tokens_display: "—", timeline_index: 5 },
      { item_id: "srv-new", tool_call_id: "call-new", kind: "tool", tool_name: "terminal", status: "visible", version: 1, tokens_display: "—", timeline_index: 700 },
    ];
    const timelineRows: Row[] = [
      { item_id: "fb-user", tool_call_id: "", kind: "user", tool_name: "user", status: "visible", version: 1, tokens_display: "—", timeline_index: 9000, summary_line: "hello" },
      { item_id: "fb-new", tool_call_id: "call-new", kind: "tool", tool_name: "terminal", status: "visible", version: 1, tokens_display: "—", timeline_index: 9001 },
    ];
    const merged = mergeHermesTimelineRows(serverRows, timelineRows, [], parent);
    expect(merged.map((row) => row.item_id)).toEqual(["srv-old", null, "srv-new"]);
    expect(merged[0].timeline_index).toBe(5);
  });

  test("mergeHermesTimelineRows keeps unmatched rows ahead of a full fallback", () => {
    const parent = "hermes:default:parent:unknown";
    const serverRows: Row[] = [
      { item_id: "srv-old", tool_call_id: "call-old", kind: "tool", tool_name: "terminal", status: "visible", version: 1, tokens_display: "—", timeline_index: 5 },
      { item_id: "srv-new", tool_call_id: "call-new", kind: "tool", tool_name: "terminal", status: "visible", version: 1, tokens_display: "—", timeline_index: 700 },
    ];
    const timelineRows: Row[] = [
      { item_id: "fb-user", tool_call_id: "", kind: "user", tool_name: "user", status: "visible", version: 1, tokens_display: "—", timeline_index: 0, summary_line: "hello" },
      { item_id: "fb-new", tool_call_id: "call-new", kind: "tool", tool_name: "terminal", status: "visible", version: 1, tokens_display: "—", timeline_index: 1 },
    ];
    const merged = mergeHermesTimelineRows(serverRows, timelineRows, [], parent, true);
    expect(merged.map((row) => row.item_id)).toEqual(["srv-old", null, "srv-new"]);
    expect(merged[0].timeline_index).toBe(5);
  });

  test("mergeHermesTimelineRows keeps the managed server copy of a duplicated compaction summary", () => {
    const parent = "hermes:default:parent:unknown";
    const text =
      "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below.";
    const serverRows: Row[] = [
      {
        item_id: "srv-summary",
        tool_call_id: "",
        kind: "user",
        tool_name: "user",
        status: "visible",
        version: 3,
        tokens_display: "—",
        timeline_index: 5,
        summary_line: text,
        message_text: text,
      },
    ];
    const timelineRows: Row[] = [
      {
        item_id: "fb-summary",
        tool_call_id: "",
        kind: "user",
        tool_name: "user",
        status: "visible",
        version: 1,
        tokens_display: "—",
        timeline_index: 9000,
        summary_line: text,
        message_text: text,
      },
    ];
    const merged = mergeHermesTimelineRows(serverRows, timelineRows, [], parent);
    expect(merged).toHaveLength(1);
    // The managed server copy wins so hide/unhide metadata survives the merge.
    expect(merged[0]).toMatchObject({ item_id: "srv-summary", version: 3, status: "visible" });
  });

  test("mergeHermesTimelineRows dedupes a compaction summary across agent-vs-user kinds (FN)", () => {
    const parent = "hermes:default:parent:unknown";
    const text = "[Compaction] Earlier turns were compacted into the summary below.";
    const serverRows: Row[] = [
      {
        item_id: "srv-summary",
        tool_call_id: "",
        kind: "user",
        tool_name: "user",
        status: "hidden",
        version: 2,
        tokens_display: "—",
        timeline_index: 5,
        summary_line: text,
        message_text: text,
      },
    ];
    const timelineRows: Row[] = [
      {
        item_id: "compaction-42",
        tool_call_id: "",
        kind: "agent",
        tool_name: "compaction",
        status: "visible",
        version: 1,
        tokens_display: "—",
        timeline_index: 9000,
        summary_line: text,
        message_text: text,
      },
    ];
    const merged = mergeHermesTimelineRows(serverRows, timelineRows, [], parent);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ item_id: "srv-summary", status: "hidden", version: 2 });
  });

  test("mergeHermesTimelineRows preserves distinct rows sharing a long common prefix (FP)", () => {
    const parent = "hermes:default:parent:unknown";
    const prefix = `x${"a".repeat(150)}`;
    const shared = `${prefix} identical suffix`;
    const distinct = `${prefix} different suffix`;
    const serverRows: Row[] = [
      {
        item_id: "srv-same",
        tool_call_id: "",
        kind: "user",
        tool_name: "user",
        status: "visible",
        version: 1,
        tokens_display: "—",
        timeline_index: 5,
        summary_line: shared,
        message_text: shared,
      },
      {
        item_id: "srv-distinct",
        tool_call_id: "",
        kind: "user",
        tool_name: "user",
        status: "visible",
        version: 1,
        tokens_display: "—",
        timeline_index: 6,
        summary_line: distinct,
        message_text: distinct,
      },
    ];
    const timelineRows: Row[] = [
      {
        item_id: "fb-same",
        tool_call_id: "",
        kind: "user",
        tool_name: "user",
        status: "visible",
        version: 1,
        tokens_display: "—",
        timeline_index: 9000,
        summary_line: shared,
        message_text: shared,
      },
    ];
    const merged = mergeHermesTimelineRows(serverRows, timelineRows, [], parent);
    // True duplicate collapses to the managed copy; the prefix-sharing row survives.
    expect(merged.map((row) => row.item_id).sort()).toEqual(["srv-distinct", "srv-same"]);
  });

  test("mergeLinkedParentRows appends linked in-flight parents and ignores everything else", () => {
    const parent = "omp:default:parent:default";
    const scopes = [{ scope_key: "omp:default:child:default", parent_scope: parent, tool_call_id: "call-live", subagent_id: "Bird" }];
    const owned: Row = {
      item_id: "item_1", tool_call_id: "call-done", kind: "tool", tool_name: "delegate_task",
      status: "visible", version: 2, tokens_display: "—", manageable: true,
    };
    const timeline: Row[] = [
      { ...owned, item_id: "call-done", manageable: false, version: 1 },
      {
        item_id: "call-live", tool_call_id: "call-live", kind: "tool", tool_name: "delegate_task",
        status: "visible", version: 1, tokens_display: "—", manageable: false, summary_line: "subagent: Bird",
      },
      {
        item_id: "call-plain", tool_call_id: "call-plain", kind: "tool", tool_name: "run_command",
        status: "visible", version: 1, tokens_display: "—", manageable: false,
      },
      {
        item_id: "u1", tool_call_id: "", kind: "user", tool_name: "user",
        status: "visible", version: 1, tokens_display: "—", summary_line: "hello",
      },
    ];
    const merged = mergeLinkedParentRows([owned], timeline, scopes, parent);
    // Owned rows keep identity; only the linked live delegate_task appends as
    // display-only with its original OMP tool name. Unlinked tools and user
    // rows never merge here. No child rows are fabricated.
    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(owned);
    expect(merged[1]).toMatchObject({
      tool_call_id: "call-live", tool_name: "delegate_task", item_id: null, manageable: false,
    });
  });

  test("mergeLinkedParentRows never resurrects unlinked past tools", () => {
    const parent = "omp:default:parent:default";
    const serverRows: Row[] = Array.from({ length: 150 }, (_, idx) => ({
      item_id: `msg:${idx}`, tool_call_id: "", kind: "user", tool_name: "user",
      status: "visible", version: 1, tokens_display: "—", summary_line: `prompt ${idx}`,
    }));
    const oldTools: Row[] = Array.from({ length: 1000 }, (_, idx) => ({
      item_id: `old-${idx}`, tool_call_id: `old-${idx}`, kind: "tool", tool_name: "run_command",
      status: "visible", version: 1, tokens_display: "—", manageable: false, timeline_index: idx,
    }));
    // No linked children anywhere: 150 user rows in, 150 rows out. A fail-open
    // merge would return 1150 rows here.
    expect(mergeLinkedParentRows(serverRows, oldTools, [], parent)).toEqual(serverRows);
  });

  test("mergeLinkedParentRows appends earlier in-progress calls when a later call persists first", () => {
    const parent = "omp:default:parent:default";
    const scopes = [{ scope_key: "omp:default:child:default", parent_scope: parent, tool_call_id: "call-1", subagent_id: "Bird" }];
    const laterOwned: Row = {
      item_id: "item_2", tool_call_id: "call-2", kind: "tool", tool_name: "run_command",
      status: "visible", version: 1, tokens_display: "—", manageable: true,
    };
    // Concurrent execution: call-2 finished and persisted while call-1 (lower
    // sequence, no result yet) is still running. The linked condition has no
    // recency floor, so the earlier call still appends with its own name.
    const timeline: Row[] = [
      {
        item_id: "call-1", tool_call_id: "call-1", kind: "tool", tool_name: "delegate_task",
        status: "visible", version: 1, tokens_display: "—", manageable: false, timeline_index: 5,
      },
      { ...laterOwned, item_id: "call-2", manageable: false, timeline_index: 9000 },
    ];
    const merged = mergeLinkedParentRows([laterOwned], timeline, scopes, parent);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toBe(laterOwned);
    expect(merged[1]).toMatchObject({ tool_call_id: "call-1", tool_name: "delegate_task", item_id: null, manageable: false });
  });

  test("mergeLinkedParentRows appends linked rows on an empty server, with or without sequences", () => {
    const parent = "omp:default:parent:default";
    const scopes = [{ scope_key: "omp:default:child:default", parent_scope: parent, tool_call_id: "call-live", subagent_id: "Bird" }];
    const live: Row = {
      item_id: "call-live", tool_call_id: "call-live", kind: "tool", tool_name: "task",
      status: "visible", version: 1, tokens_display: "—", manageable: false,
    };
    const plain: Row = {
      item_id: "call-plain", tool_call_id: "call-plain", kind: "tool", tool_name: "run_command",
      status: "visible", version: 1, tokens_display: "—", manageable: false,
    };
    expect(mergeLinkedParentRows([], [live, plain], scopes, parent)).toEqual([
      { ...live, item_id: null, manageable: false },
    ]);
    expect(mergeLinkedParentRows([], [], scopes, parent)).toEqual([]);
  });

  test("linked delegate calls missing from adapter targets are display-only timeline rows, never fabricated targets", () => {
    const parent = "hermes:default:parent:unknown";
    const scopes = [{ scope_key: "hermes:default:child:unknown", parent_scope: parent, tool_call_id: "delegate", subagent_id: "sa-1" }];
    const row: Row = { tool_call_id: "delegate", item_id: "native", kind: "tool", tool_name: "execute", status: "visible", version: 1, tokens_display: "—" };
    expect(mergeLinkedParentRows([], [row], scopes, parent)).toEqual([{ ...row, item_id: null, tool_name: "delegate_task", manageable: false }]);
    expect(mergeLinkedParentRows([row], [row], scopes, parent)).toEqual([row]);
    expect(mergeLinkedParentRows([], [], scopes, parent)).toEqual([]);
    expect(mergeLinkedParentRows([], [row], [], parent)).toEqual([]);
    expect(mergeLinkedParentRows([], [{ ...row, tool_call_id: "unrelated" }], scopes, parent)).toEqual([]);
  });

  test("mergeLinkedParentRows appends rotation-moved in-flight rows on top of a server timeline", () => {
    // server_timeline=true case: the server list is authoritative, but an
    // in-flight delegate_task without a toolResult only exists in the chat
    // timeline. It merges as a display-only row; owned rows are untouched.
    const oldParent = "hermes:default:session-old:unknown";
    const newParent = "hermes:default:session-new:unknown";
    const scopes = [
      {
        scope_key: "hermes:default:child:unknown",
        parent_scope: newParent,
        tool_call_id: "call-del",
        subagent_id: "sa-1",
      },
    ];
    const owned: Row = {
      item_id: "item_1",
      tool_call_id: "call-read",
      kind: "tool",
      tool_name: "read_file",
      status: "visible",
      version: 1,
      tokens_display: "—",
      manageable: true,
    };
    const inFlight: Row = {
      item_id: "call-del",
      tool_call_id: "call-del",
      kind: "tool",
      tool_name: "execute",
      status: "visible",
      version: 1,
      tokens_display: "—",
      manageable: false,
    };
    expect(mergeLinkedParentRows([owned], [inFlight], scopes, oldParent)).toEqual([
      owned,
      { ...inFlight, item_id: null, manageable: false, tool_name: "delegate_task" },
    ]);
    // Once the toolResult lands and the server owns the row, nothing merges.
    expect(mergeLinkedParentRows([owned, { ...inFlight, item_id: "item_2", manageable: true }], [inFlight], scopes, oldParent)).toEqual([
      owned,
      { ...inFlight, item_id: "item_2", manageable: true },
    ]);
  });

  test("mergeLinkedParentRows appends linked unpersisted parents older than any tail window", () => {
    const parent = "omp:default:parent:default";
    const scopes = [{ scope_key: "omp:default:child:default", parent_scope: parent, tool_call_id: "call-long", subagent_id: "Bird" }];
    // A long-running linked call started 1001 timeline entries ago and still
    // has no toolResult; everything newer already persisted. The linked
    // condition has no recency window, so the old call still appends.
    const serverRows: Row[] = Array.from({ length: 1001 }, (_, idx) => ({
      item_id: `item_${idx}`, tool_call_id: `call-new-${idx}`, kind: "tool", tool_name: "run_command",
      status: "visible", version: 1, tokens_display: "—", manageable: true, timeline_index: idx,
    }));
    const newer: Row[] = serverRows.map((row, idx) => ({
      ...row, item_id: row.tool_call_id, manageable: false, timeline_index: 100 + idx,
    }));
    const oldLinked: Row = {
      item_id: "call-long", tool_call_id: "call-long", kind: "tool", tool_name: "delegate_task",
      status: "visible", version: 1, tokens_display: "—", manageable: false, timeline_index: 5,
    };
    const merged = mergeLinkedParentRows(serverRows, [oldLinked, ...newer], scopes, parent);
    expect(merged).toHaveLength(1002);
    expect(merged[1001]).toMatchObject({
      tool_call_id: "call-long", tool_name: "delegate_task", item_id: null, manageable: false,
    });
  });
});

