import { expect, test } from "bun:test";
import { fallbackToolPreview, previewText } from "./toolPreview";
import { RowSchema } from "../shared/sessionNav";

test("fallback preserves actual args and full output instead of summary", () => {
  const output = "x".repeat(831);
  expect(fallbackToolPreview({ args: { path: "/tmp/input.txt" }, result: output }, {})).toEqual({
    tool_input: JSON.stringify({ path: "/tmp/input.txt" }, null, 2), tool_output: output,
  });
  expect(fallbackToolPreview({}, { command: "pwd", log: "result" })).toEqual({
    tool_input: JSON.stringify({ command: "pwd" }, null, 2), tool_output: "result",
  });
  expect(fallbackToolPreview({}, { filePath: "file.txt", content: "whole file" }).tool_output).toBe("whole file");
});

test("preview supports missing and empty data, structured outputs and serialization errors", () => {
  expect(fallbackToolPreview({}, {})).toEqual({ tool_input: undefined, tool_output: undefined });
  expect(fallbackToolPreview({ args: {}, result: "" }, {}).tool_output).toBe("");
  expect(previewText({ ok: true })).toBe('{\n  "ok": true\n}');
  const circular: any = {};
  circular.self = circular;
  expect(previewText(circular)).toBeUndefined();
  expect(previewText("a".repeat(9000))).toBe("a".repeat(8192) + "\n… [truncated]");
});

test("row schema retains original preview for hidden rows and accepts legacy rows", () => {
  const row = { item_id: "item", tool_call_id: "call", status: "hidden", version: 2, tokens_display: "—" };
  expect(RowSchema.parse({ ...row, tool_input: "input", tool_output: "" }).tool_output).toBe("");
  expect(RowSchema.parse(row).tool_input).toBeUndefined();
  expect(RowSchema.safeParse({ ...row, tool_output: {} }).success).toBe(false);
});
