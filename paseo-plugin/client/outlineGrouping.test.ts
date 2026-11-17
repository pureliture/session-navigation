import { describe, expect, test } from "bun:test";
import type { Row } from "../shared/sessionNav";
import {
  groupBadgeText,
  groupEyeAction,
  buildGroupedRows,
  fmtBytes,
  fmtTokenCount,
  fmtTokens,
  groupMutationItems,
  groupRestoreIconKind,
  groupSubtitleText,
  isSummarizedRow,
  rowMetric,
  truncateString,
  type OutlineRow,
} from "./outlineGrouping";

describe("outlineGrouping", () => {
  describe("fmtBytes", () => {
    test("formats null/undefined as 0 B", () => {
      expect(fmtBytes(undefined)).toBe("0 B");
    });
    test("formats small bytes", () => {
      expect(fmtBytes(500)).toBe("500 B");
    });
    test("formats KiB", () => {
      expect(fmtBytes(2048)).toBe("2.0 KiB");
      expect(fmtBytes(1536)).toBe("1.5 KiB");
    });
  });

  describe("truncateString", () => {
    test("handles empty and short strings", () => {
      expect(truncateString("")).toBe("");
      expect(truncateString("hello")).toBe("hello");
    });
    test("flattens newlines and truncates", () => {
      expect(truncateString("line 1\nline 2", 10)).toBe("line 1 li…");
    });
  });

  describe("isSummarizedRow", () => {
    test("detects summarized source or localMode", () => {
      expect(isSummarizedRow({ item_id: "1", tool_call_id: "1", source: "rule_summary" } as Row)).toBe(true);
      expect(isSummarizedRow({ item_id: "1", tool_call_id: "1", source: "llm" } as Row)).toBe(true);
      expect(isSummarizedRow({ item_id: "1", tool_call_id: "1" } as Row, "summarize")).toBe(true);
      expect(isSummarizedRow({ item_id: "1", tool_call_id: "1" } as Row, "hide")).toBe(false);
    });
  });

  describe("buildGroupedRows", () => {
    const sampleRows: Row[] = [
      {
        item_id: "u1",
        tool_call_id: "",
        kind: "user",
        tool_name: "user",
        status: "visible",
        version: 1,
        bytes_size: 100,
        summary_line: "User prompt 1",
      },
      {
        item_id: "t1",
        tool_call_id: "call_t1",
        kind: "tool",
        tool_name: "bash",
        status: "visible",
        version: 1,
        bytes_size: 200,
        summary_line: "$ echo 1",
      },
      {
        item_id: "t2",
        tool_call_id: "call_t2",
        kind: "tool",
        tool_name: "bash",
        status: "visible",
        version: 1,
        bytes_size: 300,
        summary_line: "$ echo 2",
      },
      {
        item_id: "t3",
        tool_call_id: "call_t3",
        kind: "tool",
        tool_name: "read",
        status: "visible",
        version: 1,
        bytes_size: 400,
        summary_line: "read file.txt",
      },
      {
        item_id: "a1",
        tool_call_id: "",
        kind: "assistant",
        tool_name: "assistant",
        status: "visible",
        version: 1,
        bytes_size: 500,
        summary_line: "Assistant response 1",
      },
      {
        item_id: "t4",
        tool_call_id: "call_t4",
        kind: "tool",
        tool_name: "edit",
        status: "hidden",
        version: 2,
        bytes_size: 600,
        summary_line: "edit file.txt",
        source: "rule_summary",
      },
    ];

    test("groups contiguous tool calls between user and assistant messages when collapsed", () => {
      const grouped = buildGroupedRows(sampleRows, {}, {});
      expect(grouped.length).toBe(4);

      expect(grouped[0].type).toBe("user");
      expect((grouped[0] as any).row.item_id).toBe("u1");

      expect(grouped[1].type).toBe("group");
      const group1 = grouped[1] as Extract<OutlineRow, { type: "group" }>;
      expect(group1.groupId).toBe("group:t1");
      expect(group1.title).toBe("3 tool calls");
      expect(group1.subTitle).toContain("bash × 2");
      expect(group1.subTitle).toContain("read");
      expect(group1.totalBytes).toBe(900);
      expect(group1.allHidden).toBe(false);
      expect(group1.children.length).toBe(3);

      expect(grouped[2].type).toBe("assistant");
      expect((grouped[2] as any).row.item_id).toBe("a1");

      expect(grouped[3].type).toBe("group");
      const group2 = grouped[3] as Extract<OutlineRow, { type: "group" }>;
      expect(group2.groupId).toBe("group:t4");
      expect(group2.title).toBe("1 tool call");
      expect(group2.totalBytes).toBe(600);
      expect(group2.allHidden).toBe(true);
      expect(group2.allSummarized).toBe(true);
    });

    test("expands child rows when expandedGroups has groupId", () => {
      const grouped = buildGroupedRows(sampleRows, { "group:t1": true }, {});
      // user (1) + group1 (1) + children (3) + assistant (1) + group2 (1) = 7
      expect(grouped.length).toBe(7);

      expect(grouped[0].type).toBe("user");
      expect(grouped[1].type).toBe("group");
      expect(grouped[2].type).toBe("child");
      expect((grouped[2] as any).row.item_id).toBe("t1");
      expect(grouped[3].type).toBe("child");
      expect((grouped[3] as any).row.item_id).toBe("t2");
      expect(grouped[4].type).toBe("child");
      expect((grouped[4] as any).row.item_id).toBe("t3");
      expect(grouped[5].type).toBe("assistant");
      expect(grouped[6].type).toBe("group");
    });

    test("detects mixed hidden status correctly", () => {
      const partiallyHiddenRows: Row[] = [
        {
          item_id: "t1",
          tool_call_id: "call_t1",
          kind: "tool",
          tool_name: "bash",
          status: "hidden",
          version: 2,
          bytes_size: 200,
        },
        {
          item_id: "t2",
          tool_call_id: "call_t2",
          kind: "tool",
          tool_name: "bash",
          status: "visible",
          version: 1,
          bytes_size: 300,
        },
      ];

      const grouped = buildGroupedRows(partiallyHiddenRows, {}, {});
      expect(grouped.length).toBe(1);
      const group = grouped[0] as Extract<OutlineRow, { type: "group" }>;
      expect(group.allHidden).toBe(false);
      expect(group.mixed).toBe(true);
      expect(group.hiddenCount).toBe(1);
    });
  });
});

describe("groupMutationItems", () => {
  const rows = [
    { item_id: "a", tool_call_id: "a", status: "visible", version: 2 },
    { item_id: "b", tool_call_id: "b", status: "hidden", version: 5 },
  ] as Row[];
  test("hide/summarize target visible members, unhide targets hidden ones, with CAS versions", async () => {
    const { groupMutationItems } = await import("./outlineGrouping");
    expect(groupMutationItems({ children: rows }, "hide")).toEqual([{ item_id: "a", expected_version: 2 }]);
    expect(groupMutationItems({ children: rows }, "summarize")).toEqual([{ item_id: "a", expected_version: 2 }]);
    expect(groupMutationItems({ children: rows }, "unhide")).toEqual([{ item_id: "b", expected_version: 5 }]);
  });
});

test("group eye restores hidden members of partial groups and preserves visible/hidden behavior", () => {
  const visible: Row = { item_id: "visible", tool_call_id: "visible", kind: "tool",
    status: "visible", version: 2, tokens_display: "—" };
  const hidden: Row = { ...visible, item_id: "hidden", tool_call_id: "hidden", status: "hidden", version: 5 };
  for (const children of [[visible], [visible, hidden], [hidden]]) {
    const group = buildGroupedRows(children, {}, {})[0];
    if (group.type !== "group") throw new Error("expected group");
    const action = groupEyeAction(group);
    expect(action).toBe(children.includes(hidden) ? "unhide" : "hide");
    expect(groupMutationItems(group, action)).toEqual(children.includes(hidden)
      ? [{ item_id: "hidden", expected_version: 5 }]
      : [{ item_id: "visible", expected_version: 2 }]);
  }
});

describe("token display", () => {
  const tool = (id: string, tokens?: number): Row => ({
    item_id: id, tool_call_id: id, kind: "tool", tool_name: "bash", status: "visible", version: 1,
    tokens_display: tokens === undefined ? "—" : `${tokens} tok`, bytes_size: 100, tokens,
  });
  const group = (rows: Row[]) => buildGroupedRows(rows, {}, {}).find((r) => r.type === "group") as any;

  test("formats counts like Paseo's K figure", () => {
    expect(fmtTokens(44)).toBe("44 tok");
    expect(fmtTokenCount(9069)).toBe("9.1K");
  });

  test("group shows summed tokens only when every member is measured", () => {
    expect(group([tool("a", 30), tool("b", 12)]).totalTokens).toBe(42);
    expect(group([tool("a", 30), tool("b")]).totalTokens).toBeNull();
  });
});

test("user/assistant/tool rows share one metric: measured tokens, else bytes", () => {
  const base = { item_id: "u", tool_call_id: "", kind: "user" as const, status: "visible" as const, version: 1, bytes_size: 190 };
  expect(rowMetric({ ...base, tokens_display: "42 tok", tokens: 42 })).toBe("42 tok");
  expect(rowMetric({ ...base, tokens_display: "—" })).toBe("190 B");
});

test("group actions skip display-only tool rows", () => {
  const row = (id: string, manageable?: boolean): Row => ({ item_id: id, tool_call_id: id, kind: "tool", status: "visible", version: 1, tokens_display: "—", manageable });
  expect(groupMutationItems({ children: [row("a"), row("b", false)] }, "hide")).toEqual([{ item_id: "a", expected_version: 1 }]);
});

describe("mixed summarize and hide group states (Issue #16)", () => {
  const makeTool = (
    id: string,
    overrides: Partial<Row> = {},
  ): Row => ({
    item_id: id,
    tool_call_id: `call_${id}`,
    kind: "tool",
    tool_name: "bash",
    status: "visible",
    version: 1,
    tokens_display: "100 tok",
    tokens: 100,
    bytes_size: 200,
    ...overrides,
  });

  test("Scenario A: 2 llm_summary + 8 explicit_user_hide + 5 unmanageable visible rows", () => {
    const rows: Row[] = [
      ...Array.from({ length: 2 }, (_, i) =>
        makeTool(`s${i}`, { status: "hidden", source: "llm_summary", version: 2 }),
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        makeTool(`h${i}`, { status: "hidden", source: "explicit_user_hide", version: 2 }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        makeTool(`u${i}`, { status: "visible", manageable: false, version: 1 }),
      ),
    ];

    const grouped = buildGroupedRows(rows, {}, {});
    expect(grouped.length).toBe(1);
    const group = grouped[0] as Extract<OutlineRow, { type: "group" }>;

    expect(group.hiddenCount).toBe(10);
    expect(group.summarizedCount).toBe(2);
    expect(group.visibleManageableCount).toBe(0);
    expect(group.allHidden).toBe(false);
    expect(group.allManageableHidden).toBe(true);
    expect(group.allSummarized).toBe(false);
    expect(group.mixed).toBe(true);

    expect(groupRestoreIconKind(group)).toBe("summarize");
    expect(groupBadgeText(group)).toBe("2 summarized, 8 hidden / 15");
    expect(groupSubtitleText(group)).toBe(
      `[2 summarized, 8 hidden] tap slashed icon to restore (${group.subTitle})`,
    );
    expect(groupMutationItems(group, "summarize")).toEqual([]);
    expect(groupMutationItems(group, "unhide")).toHaveLength(10);
  });

  test("Scenario B: all 10 manageable rows hidden with 2 summarized and 8 plain hidden", () => {
    const rows: Row[] = [
      ...Array.from({ length: 2 }, (_, i) =>
        makeTool(`s${i}`, { status: "hidden", source: "llm_summary", version: 2 }),
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        makeTool(`h${i}`, { status: "hidden", source: "explicit_user_hide", version: 2 }),
      ),
    ];

    const grouped = buildGroupedRows(rows, {}, {});
    const group = grouped[0] as Extract<OutlineRow, { type: "group" }>;

    expect(group.allHidden).toBe(true);
    expect(group.allManageableHidden).toBe(true);
    expect(group.allSummarized).toBe(false);
    expect(group.summarizedCount).toBe(2);
    expect(group.mixed).toBe(true);

    expect(groupRestoreIconKind(group)).toBe("summarize");
    expect(groupBadgeText(group)).toBe("2 summarized, 8 hidden");
    expect(groupSubtitleText(group)).toBe(
      `[2 summarized, 8 hidden] tap slashed icon to restore (${group.subTitle})`,
    );
  });

  test("Scenario C: partial summarized group with remaining visible manageable rows", () => {
    const rows: Row[] = [
      makeTool("s0", { status: "hidden", source: "llm_summary", version: 2 }),
      makeTool("s1", { status: "hidden", source: "rule_summary", version: 2 }),
      makeTool("v0", { status: "visible", manageable: true }),
      makeTool("v1", { status: "visible", manageable: true }),
      makeTool("v2", { status: "visible", manageable: true }),
    ];

    const grouped = buildGroupedRows(rows, {}, {});
    const group = grouped[0] as Extract<OutlineRow, { type: "group" }>;

    expect(group.allHidden).toBe(false);
    expect(group.allManageableHidden).toBe(false);
    expect(group.summarizedCount).toBe(2);
    expect(group.visibleManageableCount).toBe(3);

    expect(groupRestoreIconKind(group)).toBe("summarize");
    expect(groupBadgeText(group)).toBe("2/5 summarized");
    expect(groupSubtitleText(group)).toBe(group.subTitle);
  });

  test("Scenario D: plain hidden rows only keep hide restore icon and standard badge/subtitle", () => {
    const partialRows: Row[] = [
      makeTool("h0", { status: "hidden", source: "explicit_user_hide", version: 2 }),
      makeTool("v0", { status: "visible", manageable: true }),
    ];
    const partialGroup = buildGroupedRows(partialRows, {}, {})[0] as Extract<OutlineRow, { type: "group" }>;
    expect(groupRestoreIconKind(partialGroup)).toBe("hide");
    expect(groupBadgeText(partialGroup)).toBe("1/2 hidden");

    const allPlainHiddenRows: Row[] = [
      makeTool("h0", { status: "hidden", source: "explicit_user_hide", version: 2 }),
      makeTool("h1", { status: "hidden", source: "explicit_user_hide", version: 2 }),
    ];
    const allPlainGroup = buildGroupedRows(allPlainHiddenRows, {}, {})[0] as Extract<OutlineRow, { type: "group" }>;
    expect(groupRestoreIconKind(allPlainGroup)).toBe("hide");
    expect(groupBadgeText(allPlainGroup)).toBeNull();
    expect(groupSubtitleText(allPlainGroup)).toBe(
      `[all hidden] tap slashed icon to restore (${allPlainGroup.subTitle})`,
    );
  });

  test("Scenario E: all summarized and unmanageable-included summarized groups", () => {
    const allSumRows: Row[] = [
      makeTool("s0", { status: "hidden", source: "llm_summary", version: 2 }),
      makeTool("s1", { status: "hidden", source: "summarize_pending", version: 2 }),
    ];
    const allSumGroup = buildGroupedRows(allSumRows, {}, {})[0] as Extract<OutlineRow, { type: "group" }>;
    expect(allSumGroup.allSummarized).toBe(true);
    expect(groupRestoreIconKind(allSumGroup)).toBe("summarize");
    expect(groupBadgeText(allSumGroup)).toBeNull();
    expect(groupSubtitleText(allSumGroup)).toBe(
      `[all summarized] tap slashed icon to restore (${allSumGroup.subTitle})`,
    );

    const mixedUnmanageableSumRows: Row[] = [
      makeTool("s0", { status: "hidden", source: "llm_summary", version: 2 }),
      makeTool("s1", { status: "hidden", source: "llm_summary", version: 2 }),
      makeTool("u0", { status: "visible", manageable: false }),
    ];
    const mixedSumGroup = buildGroupedRows(mixedUnmanageableSumRows, {}, {})[0] as Extract<OutlineRow, { type: "group" }>;
    expect(mixedSumGroup.allHidden).toBe(false);
    expect(mixedSumGroup.allManageableHidden).toBe(true);
    expect(mixedSumGroup.allSummarized).toBe(true);
    expect(groupRestoreIconKind(mixedSumGroup)).toBe("summarize");
    expect(groupBadgeText(mixedSumGroup)).toBe("2/3 summarized");
    expect(groupSubtitleText(mixedSumGroup)).toBe(
      `[2/3 summarized] tap slashed icon to restore (${mixedSumGroup.subTitle})`,
    );
  });

  test("server summary source wins over explicit_user_hide fallback rules and preserves large outline counts", () => {
    expect(
      isSummarizedRow(
        makeTool("s0", { status: "hidden", source: "llm_summary" }),
        "hide",
      ),
    ).toBe(true);
    expect(
      isSummarizedRow(
        makeTool("h0", { status: "hidden", source: "explicit_user_hide" }),
        "summarize",
      ),
    ).toBe(true);

    // Build a long session (> 200 items) to verify grouping produces all rows without truncation.
    const longRows: Row[] = [];
    for (let i = 0; i < 120; i++) {
      longRows.push(
        {
          item_id: `u${i}`,
          tool_call_id: "",
          kind: "user",
          tool_name: "user",
          status: "visible",
          version: 1,
          tokens_display: "10 tok",
          bytes_size: 50,
        },
        makeTool(`t${i}`),
      );
    }
    const grouped = buildGroupedRows(longRows, {}, {});
    expect(grouped.length).toBe(240);
  });

  test("messageSummarySnippet strips leading blank lines and Reasoning fences so Assistant rows never collapse to ellipsis", () => {
    const { messageSummarySnippet, utf8ByteLength } = require("./outlineGrouping");
    expect(
      messageSummarySnippet("\n\n**Gemini 오케스트레이터 검토가 끝났습니다.**\n\n**권고 (Gemini)**\n| 단계 | 내용 |"),
    ).toBe("**Gemini 오케스트레이터 검토가 끝났습니다.**\n**권고 (Gemini)**");
    expect(
      messageSummarySnippet(
        "💭 **Reasoning:**\n```\nCreated. Set thinking high.\n```\n\n**Gemini 오케스트레이터 에이전트를 ACP로 새로 띄웠습니다.**\n\n- 에이전트: `626cf856`",
      ),
    ).toBe("**Gemini 오케스트레이터 에이전트를 ACP로 새로 띄웠습니다.**\n- 에이전트: `626cf856`");
    expect(
      messageSummarySnippet(
        "💭 **Reasoning:**\n```\nThe Gemini orchestrator finished with a recommendation.\n```",
      ),
    ).toBe("💭 **Reasoning:**\nThe Gemini orchestrator finished with a recommendation.");
    expect(messageSummarySnippet("\n  \n\t\n")).toBe("");
    expect(utf8ByteLength("아니 모든 방안을")).toBeGreaterThan("아니 모든 방안을".length);
  });

  test("effectiveRowBytes, rowMetric, groupMetric, and buildGroupedRows display post / pre sizes after Hide/Summarize", () => {
    const { effectiveRowBytes, rowMetric, groupMetric, buildGroupedRows } = require("./outlineGrouping");
    const visibleTool = {
      item_id: "item_1",
      tool_call_id: "c1",
      kind: "tool",
      tool_name: "read",
      status: "visible",
      version: 1,
      tokens: 5000,
      tokens_display: "5.0K tok",
      bytes_size: 20480,
    };
    const hiddenTool = {
      ...visibleTool,
      item_id: "item_2",
      tool_call_id: "c2",
      status: "hidden",
      compacted_bytes_size: 512,
    };
    const hiddenMsg = {
      item_id: "msg:user:1:abc",
      tool_call_id: "",
      kind: "user",
      tool_name: "user",
      status: "hidden",
      version: 2,
      tokens_display: "—",
      bytes_size: 4096,
      compacted_bytes_size: 0,
    };
    expect(effectiveRowBytes(visibleTool)).toBe(20480);
    expect(effectiveRowBytes(hiddenTool)).toBe(512);
    expect(effectiveRowBytes(hiddenMsg)).toBe(0);
    expect(rowMetric(visibleTool)).toBe("5.0K tok");
    expect(rowMetric(hiddenTool)).toBe("0.5/20.0 KiB");
    expect(rowMetric(hiddenMsg)).toBe("0/4.0 KiB");

    const grouped = buildGroupedRows([visibleTool, hiddenTool], {}, {});
    const group = grouped[0];
    expect(group.type).toBe("group");
    expect(group.totalBytes).toBe(20480 + 512);
    expect(group.originalTotalBytes).toBe(40960);
    expect(group.totalTokens).toBeNull();
    expect(groupMetric(group)).toBe("20.5/40.0 KiB");
    const visibleOnlyGroup = buildGroupedRows([visibleTool], {}, {})[0];
    expect(groupMetric(visibleOnlyGroup)).toBe("5.0K tok");
  });

  test("buildGroupedRows pins manage_context in collapsed group subtitle even past 3 tool types", () => {
    const make = (id: string, name: string): Row => ({
      item_id: id,
      tool_call_id: id,
      kind: "tool",
      tool_name: name,
      status: "visible",
      version: 1,
      tokens_display: "—",
      bytes_size: 100,
    });
    const rows = [
      make("1", "todo"),
      make("2", "eval"),
      make("3", "read"),
      make("4", "grep"),
      make("5", "manage_context"),
    ];
    const group = buildGroupedRows(rows, {}, {})[0] as Extract<OutlineRow, { type: "group" }>;
    expect(group.subTitle).toBe("todo, eval, read, manage_context, +1");
  });
});
