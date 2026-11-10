import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RowSchema, type Row } from "../shared/sessionNav";
import { previewContent } from "./previewContent";

const tool: Row = { item_id: "long-item-id", tool_call_id: "call", tool_name: "read", kind: "tool", status: "visible", version: 1, tokens_display: "20 tok", tool_input: "path", tool_output: "original" };

test("visible tools show input and output; empty output remains empty", () => {
  expect(previewContent(tool).sections).toEqual([{ label: "Input", text: "path" }, { label: "Output", text: "original" }]);
  expect(previewContent({ ...tool, tool_output: "" }).sections[1].text).toBe("");
  expect(previewContent({ ...tool, status: "unhidden", replacement_text: "old summary" }).sections).toEqual(previewContent(tool).sections);
});

test.each(["explicit_user_hide", "rule_summary", "llm_summary", "summarize_pending"])("hidden %s uses exact stored replacement alongside originals", (source) => {
  const row = RowSchema.parse({ ...tool, status: "hidden", source, replacement_text: "stored\nreplacement", summary_pending: source === "summarize_pending" });
  const result = previewContent(row);
  expect(result.sections).toEqual([
    { label: source === "summarize_pending" ? "Sent to model · summary pending" : "Sent to model", text: "stored\nreplacement" },
    { label: "Original input", text: "path" }, { label: "Original output", text: "original" },
  ]);
  expect(result.subtitle).toBe("read");
  expect(result.metadata).toBe(`long-item-id · v1 · ${source} · 20 tok`);
});

test("missing replacement is not invented from summary or original; empty replacement is preserved", () => {
  expect(previewContent({ ...tool, status: "hidden", summary_line: "outline snippet" }).sections[0].text).toBe("Replacement unavailable");
  expect(previewContent({ ...tool, status: "hidden", replacement_text: "" }).sections[0].text).toBe("");
});

test.each(["user", "assistant"] as const)("%s messages show full text and explicit removal when hidden", (kind) => {
  const row: Row = { ...tool, kind, message_text: "full\nmessage", summary_line: "snippet" };
  expect(previewContent(row).sections).toEqual([{ label: "Message", text: "full\nmessage" }]);
  expect(previewContent({ ...row, status: "hidden" }).sections).toEqual([
    { label: "Sent to model", text: "Removed from context" }, { label: "Original message", text: "full\nmessage" },
  ]);
  expect(previewContent({ ...row, message_text: "" }).sections[0].text).toBe("");
});

test("empty selection, legacy unavailable fields, and display-only details stay read-only", () => {
  expect(previewContent(null)).toEqual({ subtitle: "", sections: [], metadata: "" });
  expect(previewContent({ ...tool, tool_input: undefined }).sections[0].text).toBe("Input unavailable");
  expect(previewContent({ ...tool, manageable: false, tool_input: undefined, tool_output: undefined, summary_line: "display info" }).sections).toEqual([
    { label: "Details", text: "display info" }, { label: "Read-only", text: "Display-only item; context controls unavailable." },
  ]);
});

test("drawer preserves narrow-width guards, bounded code scrolling, selectable metadata, and empty state", () => {
  const source = readFileSync(new URL("./PreviewDrawer.tsx", import.meta.url), "utf8");
  expect(source).toContain("minWidth: 0");
  expect(source).toContain("flexShrink: 1");
  expect(source).toContain("maxHeight: 100");
  expect(source).toContain("<Text selectable");
  expect(source).toContain("Select an item to preview");
  expect(source).toContain('numberOfLines={1}');
});
