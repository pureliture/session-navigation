import { describe, expect, test } from "bun:test";
import type { Row } from "../shared/sessionNav";
import {
  buildFallbackTimelineRows,
  mergeHermesTimelineRows,
  mergeLinkedParentRows,
  mergePagedRows,
} from "./fallbackTimeline";

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

  test("mergeLinkedParentRows and mergeHermesTimelineRows handle linked children and chronological merging", () => {
    const parent = "hermes:default:parent:unknown";
    const scopes = [
      {
        scope_key: "hermes:default:child:unknown",
        parent_scope: parent,
        tool_call_id: "call-del",
        subagent_id: "sa-1",
      },
    ];
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
        tool_name: "execute",
        status: "visible",
        version: 1,
        tokens_display: "—",
        manageable: false,
      },
    ];

    expect(mergeLinkedParentRows([managed], timeline, scopes, parent)).toEqual([
      managed,
      { ...timeline[2], item_id: null, manageable: false, tool_name: "delegate_task" },
    ]);

    const merged = mergeHermesTimelineRows([managed], timeline, scopes, parent);
    expect(merged).toEqual([
      { ...timeline[0], item_id: null, manageable: false },
      managed,
      { ...timeline[2], item_id: null, manageable: false, tool_name: "delegate_task" },
    ]);
  });
  test("mergeHermesTimelineRows keeps unmatched older server rows ahead of the merged tail", () => {
    const parent = "hermes:atlas:session:unknown";
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


  test("mergePagedRows deduplicates overlapping timeline_index boundaries and preserves newer row freshness", () => {
    const older: Row[] = [
      { item_id: "r0", tool_call_id: "", kind: "user", status: "visible", version: 1, tokens_display: "—", timeline_index: 0 },
      { item_id: "r1", tool_call_id: "c1", kind: "tool", status: "visible", version: 1, tokens_display: "—", timeline_index: 1 },
      { item_id: "r2", tool_call_id: "c2", kind: "tool", status: "visible", version: 1, tokens_display: "—", timeline_index: 2 },
    ];
    const newer: Row[] = [
      { item_id: "r1", tool_call_id: "c1", kind: "tool", status: "hidden", version: 2, tokens_display: "—", timeline_index: 1 },
      { item_id: "r2", tool_call_id: "c2", kind: "tool", status: "visible", version: 1, tokens_display: "—", timeline_index: 2 },
      { item_id: "r3", tool_call_id: "", kind: "assistant", status: "visible", version: 1, tokens_display: "—", timeline_index: 3 },
    ];
    const merged = mergePagedRows(older, newer);
    expect(merged.map((r) => [r.timeline_index, r.status])).toEqual([
      [0, "visible"],
      [1, "hidden"],
      [2, "visible"],
      [3, "visible"],
    ]);
  });
});
