import { releaseExtension } from "../src/registration.ts";
import { beforeEach, test, expect, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import extension, { CLEANUP_GUIDANCE } from "../src/extension.ts";
import { Store } from "../../core/src/index.ts";
import { BunDriver } from "../../core/src/drivers/bun.ts";
import { PaseoService } from "../../../paseo-plugin/server/service.ts";

beforeEach(() => releaseExtension());

let calls: string[] = [];
let active = 0;
let peak = 0;
let unavailable = false;
let invalid = false;
let hanging = false;
let inputs: string[] = [];
mock.module("@oh-my-pi/pi-ai", () => ({
  completeSimple: async (_model: any, request: any, options: any) => {
    inputs.push(request.messages[0].content[0].text);
    const text = request.messages[0].content[0].text.split("\n\n")[1];
    calls.push(text.split("\n")[0]);
    peak = Math.max(peak, ++active);
    if (hanging)
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => {
            --active;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    await new Promise((resolve) => setTimeout(resolve, 5));
    --active;
    if (unavailable) throw new Error("model unavailable");
    if (invalid) return { content: [{ type: "text", text: "Invented 999999 observations." }] };
    return { content: [{ type: "text", text: text.split("\n")[0] }] };
  },
}));

for (const mode of ["success", "invalid", "unavailable", "timeout", "oversize"] as const) {
  test(`the actual context hook sends the ${mode === "success" ? "LLM summary" : "rule fallback"} on its first pending turn (${mode})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "sn-pending-"));
    const state = join(dir, "state.sqlite3");
    process.env.SESSION_NAVIGATION_STATE_PATH = state;
    const events: Record<string, Function> = {};
    const optional = () => ({ optional: () => ({}) });
    extension({
      zod: {
        object: () => ({}),
        string: optional,
        array: optional,
        enum: optional,
        number: () => ({ int: () => ({ min: () => ({ max: optional }) }) }),
      },
      on: (name: string, fn: Function) => {
        events[name] = fn;
      },
      registerTool: () => {},
    } as any);
    events.session_start({}, { agent: { kind: "main" } });
    const content = Array.from(
      { length: mode === "oversize" ? 2000 : 100 },
      (_, i) => `Output row ${i.toString().padStart(3, "0")} details`,
    ).join("\n");
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "pending-read", name: "read", arguments: { path: "sample.txt" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "pending-read",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: content }],
      },
    ];
    const sessions = join(dir, ".omp/agent/sessions/project");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(
      join(sessions, "2026_pending-check.jsonl"),
      messages.map((message) => JSON.stringify({ type: "message", message })).join("\n"),
    );
    const store = new Store(new BunDriver(state));
    const scope = "omp:default:pending-check:default";
    store.register(scope, { adapter_id: "omp", adapter_protocol: 1, capabilities: { hide: true, summarize: true, unhide: true }, enabled: true, instance_id: "test" });
    const seeded = await new PaseoService(store, dir).handle("hide", { scope_key: scope, item_id: "pending-read", mode: "summarize" });
    expect(seeded.ok).toBe(true);
    store.close();
    const ctx = {
      sessionManager: { getSessionId: () => "pending-check" },
      model: { id: "test" },
      modelRegistry: { resolver: () => "local-test" },
    };
    const originalTimeout = globalThis.setTimeout;
    if (mode === "timeout")
      globalThis.setTimeout = ((callback: any, delay?: number, ...args: any[]) =>
        originalTimeout(
          callback,
          delay && delay > 20_000 ? 10 : delay,
          ...args,
        )) as typeof setTimeout;
    calls = [];
    active = 0;
    peak = 0;
    invalid = mode === "invalid";
    unavailable = mode === "unavailable";
    hanging = mode === "timeout";
    try {
      const first = await events.context({ messages }, ctx);
      const sent = first.messages.find((message: any) => message.role === "toolResult").content[0]
        .text;
      expect(calls).toHaveLength(mode === "oversize" ? 0 : 1);
      expect(active).toBe(0);
      expect(sent).not.toBe(content);
      if (mode === "success") expect(sent).toBe(content.split("\n")[0]);
      else expect(sent).toContain("[hidden:");
      expect(messages[1].content[0]).toEqual({ type: "text", text: content });
      const second = await events.context({ messages }, ctx);
      expect(
        second.messages.find((message: any) => message.role === "toolResult").content[0].text,
      ).toBe(sent);
      expect(calls).toHaveLength(mode === "oversize" ? 0 : 1);
    } finally {
      globalThis.setTimeout = originalTimeout;
      unavailable = false;
      invalid = false;
      hanging = false;
      calls = [];
      active = 0;
      peak = 0;
      await events.session_shutdown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("actual OMP summary requests retain the tail and refuse byte/window overflow without calling the model", async () => {
  for (const mode of ["tail", "oversize", "small-window"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "sn-summary-input-"));
    process.env.SESSION_NAVIGATION_STATE_PATH = join(dir, "state.sqlite3");
    const events: Record<string, Function> = {}, tools: Record<string, any> = {};
    const optional = () => ({ optional: () => ({}) });
    extension({
      zod: { object: () => ({}), string: optional, array: optional, enum: optional,
        number: () => ({ int: () => ({ min: () => ({ max: optional }) }) }) },
      on: (name: string, handler: Function) => { events[name] = handler; },
      registerTool: (tool: any) => { tools[tool.name] = tool; },
    } as any);
    events.session_start({}, { agent: { kind: "main" } });
    const ctx = { sessionManager: { getSessionId: () => "summary-input" },
      model: { id: "test", contextWindow: mode === "small-window" ? 8192 : 65536 },
      modelRegistry: { resolver: () => "local-test" } };
    const source = Array.from({ length: mode === "oversize" ? 2000 : 700 }, (_, i) => `Result row ${i} telemetry details`).join("\n") + "\nlatency_budget_ms=151";
    expect(source.indexOf("latency_budget_ms")).toBeGreaterThan(12000);
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "input-read", name: "read", arguments: { path: "audit-01.jsonl" } }] },
      { role: "toolResult", toolCallId: "input-read", toolName: "read", isError: false, content: [{ type: "text", text: source }] },
    ];
    inputs = []; calls = []; active = 0; invalid = unavailable = hanging = false;
    try {
      await events.context({ messages }, ctx);
      await events.assistant_message({ message: { role: "assistant", stopReason: "stop" } }, ctx);
      const result = (await tools.summarize_context.execute("test", { tool_call_id: "input-read" }, undefined, undefined, ctx)).details;
      if (mode === "tail") {
        expect(result.ok).toBe(true);
        expect(inputs).toEqual(["Summarize this tool result in one paragraph. State only facts present in the result.\n\n" + source]);
      } else {
        expect(result.error).toBe("input_too_large");
        expect(inputs).toEqual([]);
      }
      expect(messages[1].content[0].text).toBe(source);
    } finally { await events.session_shutdown(); rmSync(dir, { recursive: true, force: true }); }
  }
});

test("cleanup discovers IDs, requires explicit choices, limits model concurrency and repeats across turns without an ID cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sn-cleanup-"));
  process.env.SESSION_NAVIGATION_STATE_PATH = join(dir, "state.sqlite3");
  const events: Record<string, Function> = {};
  const tools: Record<string, any> = {};
  const optional = () => ({ optional: () => ({}) });
  extension({
    zod: {
      object: () => ({}),
      string: optional,
      array: optional,
      enum: optional,
      number: () => ({ int: () => ({ min: () => ({ max: optional }) }) }),
    },
    on: (name: string, fn: Function) => {
      events[name] = fn;
    },
    registerTool: (tool: any) => {
      tools[tool.name] = tool;
    },
  } as any);
  events.session_start({}, { agent: { kind: "main" } });
  const ctx = {
    sessionManager: { getSessionId: () => "cleanup" },
    model: { id: "test" },
    modelRegistry: { resolver: () => "local-test" },
  };
  const execute = async (name: string, params: any) =>
    (await tools[name].execute("test", params, undefined, undefined, ctx)).details;
  const pair = (
    id: string,
    content = Array.from(
      { length: 100 },
      (_, i) => `Tool ${id} row ${i.toString().padStart(3, "0")} contains useful details`,
    ).join("\n"),
    name = "read",
    args = { path: "sample.txt" },
  ) => [
    { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
    {
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text: content }],
      isError: false,
    },
  ];
  const input = Array.from({ length: 90 }, (_, i) => pair(`c${i}`)).flat();
  input.push(
    ...pair("short", "tiny"),
    ...pair("danger", undefined, "bash", { command: "rm -rf sample" } as any),
  );
  const prepare = async () => {
    await events.context({ messages: input }, ctx);
    await events.assistant_message({ message: { role: "assistant", stopReason: "toolUse" } }, ctx);
  };
  try {
    expect((await events.before_agent_start({ systemPrompt: ["base"] })).systemPrompt).toEqual([
      "base",
      CLEANUP_GUIDANCE,
    ]);
    expect((await execute("manage_context", {})).error).toBe("tool_call_ids_required");
    expect((await execute("manage_context", { tool_call_ids: [] })).error).toBe(
      "tool_call_ids_required",
    );
    expect((await execute("manage_context", { tool_call_ids: "all" })).error).toBe(
      "invalid_tool_call_ids",
    );
    expect(calls.length).toBe(0);
    await prepare();
    const listed = await execute("list_context_items", { view: "candidates" });
    expect(listed.items.length).toBe(30);
    expect(listed.items[0]).toEqual({
      tool_call_id: "c89",
      tool_name: "read",
      hint: "sample.txt",
      bytes_size: Buffer.byteLength(input[179].content[0].text),
      tokens_display: "—",
    });
    expect(
      (await execute("list_context_items", { view: "candidates", limit: 2 })).items.map(
        (i: any) => i.tool_call_id,
      ),
    ).toEqual(["c89", "c88"]);
    const chosen = Array.from({ length: 70 }, (_, i) => `c${i}`);
    const first = await execute("manage_context", { tool_call_ids: chosen, action: "summarize" });
    expect(first.applied).toBe(70);
    expect(calls.length).toBe(70);
    expect(new Set(calls.map((line) => line.split(" ")[1]))).toEqual(new Set(chosen));
    expect(peak).toBe(4);
    await execute("manage_context", {
      tool_call_ids: ["c0", "short", "danger", "missing"],
      action: "summarize",
    });
    expect(calls.length).toBe(70);
    input.push(...pair("next-turn"));
    await prepare();
    const next = await execute("manage_context", { tool_call_ids: ["next-turn"], action: "hide" });
    expect(next.applied).toBe(1);
    expect(calls.length).toBe(70);
    unavailable = true;
    const failure = await execute("manage_context", {
      tool_call_ids: ["c89"],
      action: "summarize",
    });
    expect(failure.items[0].error).toBe("summarizer_unavailable");
    expect(calls.length).toBe(71);
    const patched = await events.context({ messages: input }, ctx);
    const outputs = patched.messages.filter((m: any) => m.role === "toolResult");
    expect(outputs[0].content[0].text).not.toBe(input[1].content[0].text);
    expect(outputs[89].content[0].text).toBe(input[179].content[0].text);
  } finally {
    unavailable = false;
    await events.session_shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
