import { describe, expect, test } from "bun:test";
import type { Row } from "../shared/sessionNav";
import {
  buildGroupedRows,
  fmtBytes,
  isSummarizedRow,
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
