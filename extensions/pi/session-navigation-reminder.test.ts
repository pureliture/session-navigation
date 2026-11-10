import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import extension, { BoundaryReminder } from "./session-navigation";
import { CLEANUP_GUIDANCE } from "./session-navigation";

test("model-facing guidance and notes are English and batch-cleanup oriented", () => {
  const items = [{ tool_call_id: "chatcmpl-tool-0000000000000001", tool_name: "read", hint: "audit-01.jsonl", bytes_size: 4000, turn: 1 }];
  const note = new BoundaryReminder().note("1", 10, 100, 1, items)!;
  for (const text of [CLEANUP_GUIDANCE, note]) {
    expect(text).not.toMatch(/[\uac00-\ud7a3]/);
    expect(text).toContain("batch cleanup in one call");
    expect(text).toContain("avoid re-verifying unchanged files");
    expect(text).toContain("final message must restate the complete answer with all requested facts/values");
    expect(text).toContain("never say 'reported above' or 'see above'");
  }
});

test("boundary/threshold notes are bounded, optional and preserve literal IDs", () => {
  const reminder = new BoundaryReminder();
  const items = Array.from({ length: 20 }, (_, i) => ({ tool_call_id: `chatcmpl-tool-${String(i).padStart(16, "0")}`, tool_name: "read", hint: "phase.txt", bytes_size: 4000, turn: 1 }));
  expect(reminder.note("", 10, 100, 20, items)).toBeNull();
  expect(reminder.note("1", 10, 100, 0, [])).toBeNull();
  const note = reminder.note("1", 10, 100, 20, items)!;
  expect(Buffer.byteLength(note)).toBeLessThanOrEqual(1000);
  expect(note).toContain("eligible=20");
  expect(note.split("\n")).toHaveLength(4);
  expect(JSON.parse(note.split("\n")[1])[0]).toBe(items[0].tool_call_id);
  expect(reminder.note("1", 49, 100, 20, items)).toBeNull();
  for (const tokens of [50, 75, 90]) {
    expect(reminder.note("1", tokens, 100, 20, items)).toContain(`${tokens}%`);
    expect(reminder.note("1", tokens, 100, 20, items)).toBeNull();
  }
  expect(reminder.note("1", 50, 100, 20, items)).toBeNull();
  expect(reminder.note("2", 10, undefined, 20, items)).toContain("? tokens");
  expect(reminder.note("3", 10, 100, 1, [{ ...items[0], tool_call_id: "a".repeat(2000) }])).not.toContain("a".repeat(100));
});

test("OMP tail note uses daemon eligibility, never persists, and unlisted IDs support keep_lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sn-reminder-"));
  process.env.SESSION_NAVIGATION_DAEMON = resolve(".venv/bin/session-navigation-daemon");
  process.env.SESSION_NAVIGATION_STATE_PATH = join(dir, "state.sqlite3");
  const events: Record<string, Function> = {}, tools: Record<string, any> = {};
  const optional = () => ({ optional: () => ({}) });
  extension({ zod: { object: () => ({}), string: optional, array: optional, enum: optional,
    number: () => ({ int: () => ({ min: () => ({ max: optional }) }) }) },
    on: (name: string, fn: Function) => { events[name] = fn; }, registerTool: (tool: any) => { tools[tool.name] = tool; } } as any);
  let tokens = 20000;
  const ctx = { sessionManager: { getSessionId: () => "reminders" }, getContextUsage: () => ({ tokens, contextWindow: 128000 }) };
  const body = Array.from({ length: 150 }, (_, i) => i === 50 ? "Agent selected middle sentence." : `fixture row ${i}: detail`).join("\n");
  const messages: any[] = [{ role: "user", content: [{ type: "text", text: "Inspect files" }], timestamp: 1 }];
  for (let i = 0; i < 5; i++) messages.push(
    { role: "assistant", content: [{ type: "toolCall", id: `r${i}`, name: "read", arguments: { path: `phase-${i}.txt` } }] },
    { role: "toolResult", toolCallId: `r${i}`, toolName: "read", isError: false, content: [{ type: "text", text: body }] });
  const original = structuredClone(messages);
  try {
    let out = await events.context({ messages }, ctx);
    expect(messages).toEqual(original);
    expect(out.messages.slice(0, -1)).toEqual(original);
    const note = out.messages.at(-1).content[0].text;
    expect(note).toContain("eligible=5");
    expect(JSON.parse(note.split("\n")[1])).toEqual(["r4", "read", "phase-4.txt", Buffer.byteLength(body), 1]);
    expect(note).not.toContain('"r0"');
    expect(await events.context({ messages }, ctx)).toBeUndefined();
    await events.assistant_message({ message: { role: "assistant", stopReason: "toolUse" } }, ctx);
    let result = (await tools.manage_context.execute("hide", { tool_call_ids: ["r0"], action: "hide", keep_lines: ["selected middle sentence"] }, undefined, undefined, ctx)).details;
    expect(result.applied).toBe(1);
    out = await events.context({ messages }, ctx);
    expect(out.messages[2].content[0].text).toContain("selected middle sentence");
    expect(out.messages).toHaveLength(messages.length);
    expect(messages).toEqual(original);
    tokens = 100000;
    out = await events.context({ messages }, ctx);
    expect(out.messages.at(-1).content[0].text).toContain("eligible=4");
    expect(Number(out.messages.at(-1).content[0].text.match(/\((\d+)%\)/)[1])).toBeGreaterThanOrEqual(75);
    await events.assistant_message({ message: { role: "assistant", stopReason: "toolUse" } }, ctx);
    result = (await tools.manage_context.execute("hide", { tool_call_ids: ["r1", "r2"], action: "hide", keep_lines: [" 20:selected middle sentence ", "invented"] }, undefined, undefined, ctx)).details;
    expect(result.applied).toBe(2);
    for (const item of result.items) {
      expect(item.keep_lines_ignored[0].entry).toBe("invented");
      expect(item.keep_lines_ignored[0].reason).toContain("not found verbatim");
      expect(item.keep_lines_normalized[0].accepted).toBe("selected middle sentence");
    }
    result = (await tools.manage_context.execute("hide", { tool_call_ids: ["r1"], keep_lines: [] }, undefined, undefined, ctx)).details;
    expect(result.error).toBe("invalid_keep_lines_action");
    messages.push({ role: "user", content: [{ type: "text", text: "Next unit" }], timestamp: 2 });
    out = await events.context({ messages }, ctx);
    expect(out.messages.at(-1).content[0].text).toContain("eligible=2");
  } finally {
    await events.session_shutdown?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
