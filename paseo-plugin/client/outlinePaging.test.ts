import { describe, expect, test } from "bun:test";
import type { Row } from "../shared/sessionNav";
import { appendOlderServerPage, shouldInvalidateOlderServerPage } from "./outlinePaging";

function row(id: string, timeline_index: number): Row {
  return {
    item_id: id,
    tool_call_id: "",
    kind: "user",
    status: "visible",
    version: 1,
    tokens_display: "—",
    timeline_index,
  };
}

describe("outlinePaging", () => {
  test("search invalidates previously paged older rows", () => {
    const state = {
      sessionKey: "s",
      rows: [row("old", 1)],
      hasOlder: true,
      nextBeforeIndex: 1,
      totalRows: 100,
    };
    expect(
      shouldInvalidateOlderServerPage({
        state,
        sessionKey: "s",
        tailHasOlder: true,
        tailTotalRows: 100,
        searchActive: true,
      }),
    ).toBe(true);
    expect(
      shouldInvalidateOlderServerPage({
        state,
        sessionKey: "s",
        tailHasOlder: true,
        tailTotalRows: 100,
        searchActive: false,
      }),
    ).toBe(false);
  });

  test("live compaction shrinking totals invalidates stale older rows", () => {
    const state = {
      sessionKey: "s",
      rows: [row("old", 1)],
      hasOlder: true,
      nextBeforeIndex: 1,
      totalRows: 755,
    };
    // Pre-compaction tail: same totals keep the older pages.
    expect(
      shouldInvalidateOlderServerPage({
        state,
        sessionKey: "s",
        tailHasOlder: true,
        tailTotalRows: 755,
        searchActive: false,
      }),
    ).toBe(false);
    // Post-compaction tail: totals shrank, older rows came from the old chunk.
    expect(
      shouldInvalidateOlderServerPage({
        state,
        sessionKey: "s",
        tailHasOlder: true,
        tailTotalRows: 600,
        searchActive: false,
      }),
    ).toBe(true);
    // A tail that no longer pages older resets the window entirely.
    expect(
      shouldInvalidateOlderServerPage({
        state,
        sessionKey: "s",
        tailHasOlder: false,
        tailTotalRows: 600,
        searchActive: false,
      }),
    ).toBe(true);
  });

  test("mismatched session keys never invalidate", () => {
    const state = {
      sessionKey: "other",
      rows: [row("old", 1)],
      hasOlder: true,
      nextBeforeIndex: 1,
      totalRows: 755,
    };
    expect(
      shouldInvalidateOlderServerPage({
        state,
        sessionKey: "s",
        tailHasOlder: false,
        tailTotalRows: 1,
        searchActive: true,
      }),
    ).toBe(false);
    expect(
      shouldInvalidateOlderServerPage({
        state: null,
        sessionKey: "s",
        tailHasOlder: false,
        tailTotalRows: 1,
        searchActive: true,
      }),
    ).toBe(false);
  });

  test("appending an older page adopts fresh totals and resets stale snapshots", () => {
    const prev = {
      sessionKey: "s",
      rows: [row("r1", 1)],
      hasOlder: true,
      nextBeforeIndex: 1,
      totalRows: 755,
    };
    // Fresh totals replace the pre-compaction snapshot instead of mixing chunks.
    const next = appendOlderServerPage({
      prev,
      sessionKey: "s",
      items: [row("r0", 0)],
      hasOlder: false,
      nextBeforeIndex: null,
      totalRows: 600,
    });
    expect(next.totalRows).toBe(600);
    expect(next.rows.map((r) => r.item_id)).toEqual(["r0", "r1"]);
    // A page fetch without totals resets the snapshot instead of carrying the
    // stale pre-compaction count forward.
    const reset = appendOlderServerPage({
      prev,
      sessionKey: "s",
      items: [row("r0", 0)],
      hasOlder: false,
      nextBeforeIndex: null,
      totalRows: undefined,
    });
    expect(reset.totalRows).toBeUndefined();
    // A different session starts from an empty base.
    const switched = appendOlderServerPage({
      prev,
      sessionKey: "other",
      items: [row("r0", 0)],
      hasOlder: true,
      nextBeforeIndex: 0,
      totalRows: 10,
    });
    expect(switched.rows.map((r) => r.item_id)).toEqual(["r0"]);
  });
});
