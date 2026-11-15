import { beforeEach } from "bun:test";
import { releaseExtension } from "../src/registration.ts";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import extension, { BoundaryReminder, CLEANUP_GUIDANCE } from "../src/extension.ts";
import { loadTimeline } from "../../../paseo-plugin/server/history.ts";
beforeEach(() => releaseExtension());

test("model-facing guidance and notes stay non-Hangul", () => {
  const items = [
    {
      tool_call_id: "chatcmpl-tool-0000000000000001",
      tool_name: "read",
      hint: "audit-01.jsonl",
      bytes_size: 4000,
      turn: 1,
    },
  ];
  const note = new BoundaryReminder().note("1", 10, 100, 1, items)!;
  for (const text of [CLEANUP_GUIDANCE, note]) {
    expect(text).not.toMatch(/[\uac00-\ud7a3]/);
  }
});

test("reminder notes ignore context-occupancy %, stay silent on chat-only turns, and fire on new candidates", () => {
  const reminder = new BoundaryReminder();
  const items = Array.from({ length: 20 }, (_, i) => ({
    tool_call_id: `chatcmpl-tool-${String(i).padStart(16, "0")}`,
    tool_name: "read",
    hint: "phase.txt",
    bytes_size: 4000,
    turn: 1,
  }));
  expect(reminder.note("", 10, 100, 20, items)).toBeNull();
  expect(reminder.note("1", 10, 100, 0, [])).toBeNull();
  const note = reminder.note("1", 10, 100, 20, items)!;
  expect(Buffer.byteLength(note)).toBeLessThanOrEqual(1000);
  expect(note).toContain("eligible=20");
  expect(note).toContain("+17 via list_context_items(view=candidates)");
  expect(note.split("\n")).toHaveLength(4);
  expect(JSON.parse(note.split("\n")[1])[0]).toBe(items[0].tool_call_id);
  // Context occupancy % (50/75/90%) must NOT re-fire when no new bytes/items arrived.
  for (const tokens of [49, 50, 75, 90, 99]) {
    expect(reminder.note("1", tokens, 100, 20, items)).toBeNull();
  }
  // New chat-only turn with identical candidate IDs stays silent; adding a new candidate ID fires once.
  expect(reminder.note("2", 10, 100, 20, items)).toBeNull();
  const nextItems = [{ tool_call_id: "chatcmpl-tool-new", tool_name: "bash", hint: "ls", bytes_size: 4000, turn: 2 }, ...items];
  expect(reminder.note("2", 10, undefined, 21, nextItems)).toContain("eligible=21");
  expect(
    reminder.note("3", 10, 100, 1, [{ ...items[0], tool_call_id: "a".repeat(2000) }]),
  ).not.toContain("a".repeat(100));
});

test("intra-turn cumulative eligible-byte milestones re-fire on large 1M-window turns and reset after cleanup", () => {
  const reminder = new BoundaryReminder();
  const small = [{ tool_call_id: "c0", tool_name: "read", hint: "a.ts", bytes_size: 4096, turn: 1 }];
  expect(reminder.note("1", 50_000, 1_048_576, 1, small, 4096)).toContain("eligible=1");
  expect(reminder.note("1", 60_000, 1_048_576, 1, small, 4096)).toBeNull();
  const large = [
    { tool_call_id: "c3", tool_name: "grep", hint: "pattern", bytes_size: 120_000, turn: 1 },
    { tool_call_id: "c2", tool_name: "bash", hint: "kubectl get pods", bytes_size: 110_000, turn: 1 },
    { tool_call_id: "c1", tool_name: "read", hint: "spec.md", bytes_size: 90_000, turn: 1 },
  ];
  const fired = reminder.note("1", 140_000, 1_048_576, 8, large, 320_000)!;
  expect(fired).toContain("eligible=8 (312 KiB)");
  expect(Buffer.byteLength(fired, "utf8")).toBeLessThanOrEqual(1000);
  expect(reminder.note("1", 150_000, 1_048_576, 8, large, 330_000)).toBeNull();
  // Cleanup lowers eligibleBytes back under 100 KiB without nagging, then re-arms for the next >=100 KiB wave.
  expect(reminder.note("1", 60_000, 1_048_576, 1, small, 4096)).toBeNull();
  expect(reminder.note("1", 100_000, 1_048_576, 2, large.slice(0, 1), 120_000)).toContain(
    "eligible=2 (117 KiB)",
  );
});

test("OMP tail note uses engine eligibility, never persists, and unlisted IDs support keep_lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sn-reminder-"));
  process.env.SESSION_NAVIGATION_STATE_PATH = join(dir, "state.sqlite3");
  const events: Record<string, Function> = {},
    tools: Record<string, any> = {};
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
  let tokens = 20000;
  const ctx = {
    sessionManager: { getSessionId: () => "reminders" },
    getContextUsage: () => ({ tokens, contextWindow: 128000 }),
  };
  const body = Array.from({ length: 150 }, (_, i) =>
    i === 50 ? "Agent selected middle sentence." : `fixture row ${i}: detail`,
  ).join("\n");
  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "Inspect files" }], timestamp: 1 },
  ];
  for (let i = 0; i < 5; i++)
    messages.push(
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: `r${i}`, name: "read", arguments: { path: `phase-${i}.txt` } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: `r${i}`,
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: body }],
      },
    );
  const original = structuredClone(messages);
  try {
    let out = await events.context({ messages }, ctx);
    expect(messages).toEqual(original);
    expect(out.messages.slice(0, -1)).toEqual(original);
    const note = out.messages.at(-1).content[0].text;
    expect(note).toContain("eligible=5");
    expect(JSON.parse(note.split("\n")[1])).toEqual([
      "r4",
      "read",
      "phase-4.txt",
      Buffer.byteLength(body),
      1,
    ]);
    expect(note).not.toContain('"r0"');
    expect(await events.context({ messages }, ctx)).toBeUndefined();
    await events.assistant_message({ message: { role: "assistant", stopReason: "toolUse" } }, ctx);
    let result = (
      await tools.manage_context.execute(
        "hide",
        { tool_call_ids: ["r0"], action: "hide", keep_lines: ["selected middle sentence"] },
        undefined,
        undefined,
        ctx,
      )
    ).details;
    expect(result.applied).toBe(1);
    out = await events.context({ messages }, ctx);
    expect(out.messages[2].content[0].text).toContain("selected middle sentence");
    expect(out.messages).toHaveLength(messages.length);
    expect(messages).toEqual(original);
    // Raising context occupancy % alone must NOT re-fire a reminder when no new outputs arrived.
    tokens = 100000;
    out = await events.context({ messages }, ctx);
    expect(out.messages).toHaveLength(messages.length);
    await events.assistant_message({ message: { role: "assistant", stopReason: "toolUse" } }, ctx);
    result = (
      await tools.manage_context.execute(
        "hide",
        {
          tool_call_ids: ["r1", "r2"],
          action: "hide",
          keep_lines: [" 20:selected middle sentence ", "invented"],
        },
        undefined,
        undefined,
        ctx,
      )
    ).details;
    expect(result.applied).toBe(2);
    for (const item of result.items) {
      expect(item.keep_lines_ignored[0].entry).toBe("invented");
      expect(item.keep_lines_ignored[0].reason).toContain("not found verbatim");
      expect(item.keep_lines_normalized[0].accepted).toBe("selected middle sentence");
    }
    result = (
      await tools.manage_context.execute(
        "hide",
        { tool_call_ids: ["r1"], keep_lines: [] },
        undefined,
        undefined,
        ctx,
      )
    ).details;
    expect(result.error).toBe("invalid_keep_lines_action");
    // Chat-only user turn with no new eligible output stays silent; adding a new eligible output fires.
    messages.push({ role: "user", content: [{ type: "text", text: "Next unit" }], timestamp: 2 });
    out = await events.context({ messages }, ctx);
    expect(out.messages).toHaveLength(messages.length);
    messages.push(
      { role: "assistant", content: [{ type: "toolCall", id: "r5", name: "read", arguments: { path: "phase-5.txt" } }] },
      { role: "toolResult", toolCallId: "r5", toolName: "read", content: [{ type: "text", text: body }], isError: false },
    );
    out = await events.context({ messages }, ctx);
    expect(out.messages.at(-1).content[0].text).toContain("eligible=3");
  } finally {
    await events.session_shutdown?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OMP registers essential top-level tools and shares item identity with Paseo for read-only query tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sn-parity-"));
  process.env.SESSION_NAVIGATION_STATE_PATH = join(dir, "state.sqlite3");
  const events: Record<string, Function> = {};
  const tools: Record<string, { loadMode?: string; execute: Function }> = {};
  const optional = () => ({ optional: () => ({}) });
  // Minimal ExtensionAPI test double matching the registration surface.
  const mockPi = {
    zod: {
      object: () => ({}),
      string: optional,
      array: optional,
      enum: optional,
      number: () => ({ int: () => ({ min: () => ({ max: optional }) }) }),
    },
    on: (name: string, fn: Function) => (events[name] = fn),
    registerTool: (tool: { name: string; loadMode?: string; execute: Function }) =>
      (tools[tool.name] = tool),
    registerCommand: () => {},
  } as unknown as Parameters<typeof extension>[0];
  extension(mockPi);
  await events.session_start({}, { agent: { kind: "main" } });
  for (const name of [
    "list_context_items",
    "manage_context",
    "hide_context",
    "summarize_context",
    "unhide_context",
  ]) {
    expect(tools[name]?.loadMode).toBe("essential");
  }
  const longBody = [
    "export const PINNED_FACT = 42;",
    ...Array.from(
      { length: 40 },
      (_, i) => `src/module-${i}.ts:10: export interface State { status: 'idle' | 'running'; window: number; reason?: string }`,
    ),
  ].join("\n");
  const messages = [
    { role: "user", content: [{ type: "text", text: "Search codebase" }], timestamp: 1 },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "g1", name: "grep", arguments: { i: "Searching", pattern: "State", path: "src" } },
        { type: "toolCall", id: "a1", name: "get_agent_activity", arguments: { i: "Checking child", agentId: "agent-1" } },
        { type: "toolCall", id: "x1", name: "read", arguments: { i: "Device docs", path: "xd://manage_context" } },
        { type: "toolCall", id: "e1", name: "edit", arguments: { i: "Editing", input: "[a.ts#1234]" } },
      ],
    },
    { role: "toolResult", toolCallId: "g1", toolName: "grep", isError: false, content: [{ type: "text", text: longBody }] },
    { role: "toolResult", toolCallId: "a1", toolName: "get_agent_activity", isError: false, content: [{ type: "text", text: longBody }] },
    { role: "toolResult", toolCallId: "x1", toolName: "read", isError: false, content: [{ type: "text", text: longBody }] },
    { role: "toolResult", toolCallId: "e1", toolName: "edit", isError: false, content: [{ type: "text", text: longBody }] },
  ];
  const ctx = {
    sessionManager: { getSessionId: () => "parity-sess" },
    getContextUsage: () => ({ tokens: 10_000, contextWindow: 1_048_576 }),
  };
  const sessDir = join(dir, ".omp", "agent", "sessions", "proj");
  mkdirSync(sessDir, { recursive: true });
  writeFileSync(
    join(sessDir, "2026-11-15_parity-sess.jsonl"),
    messages.map((message) => JSON.stringify({ type: "message", message })).join("\n"),
  );
  try {
    await events.context({ messages }, ctx);
    await events.assistant_message({ message: { role: "assistant", stopReason: "toolUse" } }, ctx);
    const candidates = (
      await tools.list_context_items.execute("list", { view: "candidates" }, undefined, undefined, ctx)
    ).details;
    expect(candidates.items.map((item: { tool_call_id: string }) => item.tool_call_id)).toEqual(["a1", "g1"]);
    const managed = (
      await tools.manage_context.execute(
        "manage",
        { tool_call_ids: ["g1", "a1"], action: "hide", keep_lines: ["PINNED_FACT = 42"] },
        undefined,
        undefined,
        ctx,
      )
    ).details;
    expect(managed.applied).toBe(2);
    const projected = await events.context({ messages }, ctx);
    expect(projected.messages[2].content[0].text).toContain("PINNED_FACT = 42");
    const timeline = loadTimeline(dir, "omp:default:parity-sess:default");
    const toolRows = timeline.rows.filter((row) => row.kind === "tool");
    expect(toolRows.map((row) => [row.tool_call_id, row.manageable])).toEqual([
      ["g1", true],
      ["a1", true],
      ["x1", false],
      ["e1", false],
    ]);
    expect(toolRows.slice(0, 2).map((row) => row.item_id)).toEqual(
      managed.items.map((item: { item_id: string }) => item.item_id),
    );
  } finally {
    await events.session_shutdown?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
