import { test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import extension, { CLEANUP_GUIDANCE } from "./session-navigation";

let calls: string[] = [];
let active = 0;
let peak = 0;
let unavailable = false;
mock.module("@oh-my-pi/pi-ai", () => ({ completeSimple: async (_model: any, request: any) => {
  const text = request.messages[0].content[0].text.split("\n\n")[1];
  calls.push(text.split("\n")[0]);
  peak = Math.max(peak, ++active);
  await new Promise((resolve) => setTimeout(resolve, 5));
  --active;
  if (unavailable) throw new Error("model unavailable");
  return { content: [{ type: "text", text: text.split("\n")[0] }] };
} }));

test("cleanup discovers IDs, requires explicit choices, limits model concurrency and repeats across turns without an ID cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sn-cleanup-"));
  process.env.SESSION_NAVIGATION_STATE_PATH = join(dir, "state.sqlite3");
  process.env.SESSION_NAVIGATION_DAEMON = resolve(".venv/bin/session-navigation-daemon");
  const events: Record<string, Function> = {};
  const tools: Record<string, any> = {};
  const optional = () => ({ optional: () => ({}) });
  extension({ zod: { object: () => ({}), string: optional, array: () => ({}), enum: optional,
    number: () => ({ int: () => ({ min: () => ({ max: optional }) }) }) },
    on: (name: string, fn: Function) => { events[name] = fn; },
    registerTool: (tool: any) => { tools[tool.name] = tool; } } as any);
  const ctx = { sessionManager: { getSessionId: () => "cleanup" }, model: { id: "test" }, modelRegistry: { resolver: () => "local-test" } };
  const execute = async (name: string, params: any) => (await tools[name].execute("test", params, undefined, undefined, ctx)).details;
  const pair = (id: string, content = Array.from({ length: 100 }, (_, i) => `Tool ${id} row ${i.toString().padStart(3, "0")} contains useful details`).join("\n"), name = "read", args = { path: "sample.txt" }) => [
    { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
    { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: content }], isError: false }];
  const input = Array.from({ length: 90 }, (_, i) => pair(`c${i}`)).flat();
  input.push(...pair("short", "tiny"), ...pair("danger", undefined, "bash", { command: "rm -rf sample" } as any));
  const prepare = async () => {
    await events.context({ messages: input }, ctx);
    await events.assistant_message({ message: { role: "assistant", stopReason: "toolUse" } }, ctx);
  };
  try {
    expect((await events.before_agent_start({ systemPrompt: ["base"] })).systemPrompt).toEqual(["base", CLEANUP_GUIDANCE]);
    expect((await execute("manage_context", {})).error).toBe("tool_call_ids_required");
    expect((await execute("manage_context", { tool_call_ids: [] })).error).toBe("tool_call_ids_required");
    expect((await execute("manage_context", { tool_call_ids: "all" })).error).toBe("invalid_tool_call_ids");
    expect(calls.length).toBe(0);
    await prepare();
    const listed = await execute("list_context_items", { view: "candidates" });
    expect(listed.items.length).toBe(30);
    expect(listed.items[0]).toEqual({ tool_call_id: "c89", tool_name: "read", hint: "sample.txt", bytes_size: Buffer.byteLength(input[179].content[0].text), tokens_display: "—" });
    expect((await execute("list_context_items", { view: "candidates", limit: 2 })).items.map((i: any) => i.tool_call_id)).toEqual(["c89", "c88"]);
    const chosen = Array.from({ length: 70 }, (_, i) => `c${i}`);
    const first = await execute("manage_context", { tool_call_ids: chosen, action: "summarize" });
    expect(first.applied).toBe(70);
    expect(calls.length).toBe(70);
    expect(new Set(calls.map((line) => line.split(" ")[1]))).toEqual(new Set(chosen));
    expect(peak).toBe(4);
    await execute("manage_context", { tool_call_ids: ["c0", "short", "danger", "missing"], action: "summarize" });
    expect(calls.length).toBe(70);
    input.push(...pair("next-turn"));
    await prepare();
    const next = await execute("manage_context", { tool_call_ids: ["next-turn"], action: "hide" });
    expect(next.applied).toBe(1);
    expect(calls.length).toBe(70);
    unavailable = true;
    const failure = await execute("manage_context", { tool_call_ids: ["c89"], action: "summarize" });
    expect(failure.items[0].error).toBe("summarizer_unavailable");
    expect(calls.length).toBe(71);
    const patched = await events.context({ messages: input }, ctx);
    const outputs = patched.messages.filter((m: any) => m.role === "toolResult");
    expect(outputs[0].content[0].text).not.toBe(input[1].content[0].text);
    expect(outputs[89].content[0].text).toBe(input[179].content[0].text);
  } finally { unavailable = false; await events.session_shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
