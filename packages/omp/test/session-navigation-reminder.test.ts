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
      bytes_size: 40_000,
      turn: 1,
    },
  ];
  const note = new BoundaryReminder().note("1", 10, 1000, 1, items)!;
  for (const text of [CLEANUP_GUIDANCE, note]) {
    expect(text).not.toMatch(/[\uac00-\ud7a3]/);
  }
});

test("state machine silences cold-start/mid-turn small reads, prevents boundary oscillation, ignores occupancy %, and suppresses unhide growth", () => {
  const reminder = new BoundaryReminder();
  // Cold start on Turn 1 Request 1 (empty), followed by a 4 KiB read mid-Turn 1 -> stays silent!
  expect(reminder.note("1", 1_000, 128_000, 0, [])).toBeNull();
  const tiny = [{ tool_call_id: "t0", tool_name: "read", hint: "small.ts", bytes_size: 4096, turn: 1 }];
  expect(reminder.note("1", 2_000, 128_000, 1, tiny, 4096)).toBeNull();
  // Turn 2 Request 1 with only 4 KiB (<32 KiB worthwhile floor) stays silent AND eagerly advances turn,
  // so another 4 KiB read inside Turn 2 does NOT leak via stale turn!
  expect(reminder.note("2", 2_500, 128_000, 1, tiny, 4096)).toBeNull();
  const tiny2 = [{ tool_call_id: "t1", tool_name: "read", hint: "small2.ts", bytes_size: 4096, turn: 2 }, ...tiny];
  expect(reminder.note("2", 3_500, 128_000, 2, tiny2, 8192)).toBeNull();

  // Accumulating 50 KiB (<100 KiB) during Turn 2 stays silent mid-turn, then fires ONCE on Turn 3 Request 1 (>=32 KiB).
  const phase = Array.from({ length: 14 }, (_, i) => ({
    tool_call_id: `chatcmpl-tool-${String(i).padStart(16, "0")}`,
    tool_name: "read",
    hint: "phase.txt",
    bytes_size: 4000,
    turn: 2,
  }));
  expect(reminder.note("2", 18_000, 128_000, 14, phase, 56_000)).toBeNull();
  const note = reminder.note("3", 19_000, 128_000, 14, phase, 56_000)!;
  expect(Buffer.byteLength(note)).toBeLessThanOrEqual(16 * 1024);
  expect(note).toContain("eligible=14 (54 KiB)");
  expect(note).not.toContain("via list_context_items");
  expect(note.split("\n")).toHaveLength(15);

  // Keeping that 56 KiB and running ONE 2 KiB read in Turn 3 does NOT nag on Turn 4 (unfiredCredit=2 KiB < 32 KiB).
  const plusSmall = [{ tool_call_id: "tiny-keep", tool_name: "read", hint: "x.ts", bytes_size: 2048, turn: 3 }, ...phase];
  expect(reminder.note("3", 20_000, 128_000, 15, plusSmall, 58_048)).toBeNull();
  expect(reminder.note("4", 21_000, 128_000, 15, plusSmall, 58_048)).toBeNull();

  // Context occupancy % (50%, 75%, 85%, 95%) never triggers a reminder; global window compaction belongs to the host.
  for (const [turnId, tok] of [["5", 64_000], ["6", 96_000], ["7", 110_000], ["8", 122_000]] as const) {
    expect(reminder.note(turnId, tok, 128_000, 15, plusSmall, 58_048)).toBeNull();
  }
  // Boundary oscillation check: 95K -> 105K fire -> hide 10K to 95K -> +6K to 101K MUST stay silent!
  const osc = new BoundaryReminder();
  expect(osc.note("1", 1000, 1_048_576, 0, [])).toBeNull();
  const baseItem = [{ tool_call_id: "o1", tool_name: "bash", hint: "logs", bytes_size: 95 * 1024, turn: 1 }];
  expect(osc.note("1", 25_000, 1_048_576, 1, baseItem, 95 * 1024)).toBeNull();
  expect(osc.note("1", 28_000, 1_048_576, 2, baseItem, 105 * 1024)).toContain("eligible=2");
  expect(osc.note("1", 25_000, 1_048_576, 1, baseItem, 95 * 1024)).toBeNull();
  expect(osc.note("1", 27_000, 1_048_576, 2, baseItem, 101 * 1024)).toBeNull();

  // suppressUnhide absorbs restored byte spikes without firing.
  osc.suppressUnhide();
  expect(osc.note("1", 800_000, 1_048_576, 3, baseItem, 260 * 1024)).toBeNull();

  // Oversized ID is safely excluded from bounded 1000-byte note.
  expect(
    new BoundaryReminder().note("1", 10, 1000, 1, [{ ...phase[0], bytes_size: 40_000, tool_call_id: "a".repeat(2000) }]),
  ).not.toContain("a".repeat(100));
});

test("OMP context pipeline re-arms after full cleanup (total=0), suppresses unhide spikes, and supports unlisted keep_lines", async () => {
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
  const body = Array.from({ length: 320 }, (_, i) =>
    i === 50 ? "Agent selected middle sentence." : `fixture row ${i}: detail payload padding`,
  ).join("\n");
  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: "Inspect files" }], timestamp: 1 },
  ];
  try {
    // Turn 1 Request 1 (empty) + single ~10 KiB read stays silent inside Turn 1 (no cold-start noise).
    expect(await events.context({ messages }, ctx)).toBeUndefined();
    messages.push(
      { role: "assistant", content: [{ type: "toolCall", id: "r0", name: "read", arguments: { path: "phase-0.txt" } }] },
      { role: "toolResult", toolCallId: "r0", toolName: "read", isError: false, content: [{ type: "text", text: body }] },
    );
    expect(await events.context({ messages }, ctx)).toBeUndefined();

    // Push r1..r10 so Turn 1 crosses 100 KiB intra-turn -> fires!
    for (let i = 1; i <= 10; i++) {
      messages.push(
        { role: "assistant", content: [{ type: "toolCall", id: `r${i}`, name: "read", arguments: { path: `phase-${i}.txt` } }] },
        { role: "toolResult", toolCallId: `r${i}`, toolName: "read", isError: false, content: [{ type: "text", text: body }] },
      );
    }
    const original = structuredClone(messages);
    let out = await events.context({ messages }, ctx);
    expect(messages).toEqual(original);
    expect(out.messages.slice(0, -1)).toEqual(original);
    const note = out.messages.at(-1).content[0].text;
    expect(note).toContain("eligible=11");
    expect(JSON.parse(note.split("\n")[1])).toEqual([
      "r10",
      "read",
      "phase-10.txt",
      Buffer.byteLength(body),
      1,
    ]);
    expect(note).toContain('"r0"');
    expect(note.split("\n")).toHaveLength(12);
    expect(await events.context({ messages }, ctx)).toBeUndefined();

    // Hide r0 with keep_lines, r1..r2 with normalized/ignored diagnostics, and r3..r10 to empty ALL candidates (total=0)!
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
    const r0ItemId = result.items[0].item_id;

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

    // Clean ALL remaining items (r3..r10 -> eligible_count = 0), verify real context hook resets watermark to 0,
    // and then another >=100 KiB wave in the SAME turn fires again!
    const restIds = Array.from({ length: 8 }, (_, i) => `r${i + 3}`);
    const restRes = (
      await tools.manage_context.execute("hide", { tool_call_ids: restIds, action: "hide" }, undefined, undefined, ctx)
    ).details;
    expect(restRes.applied).toBe(8);
    out = await events.context({ messages }, ctx);
    expect(out.messages[2].content[0].text).toContain("selected middle sentence");
    expect(out.messages).toHaveLength(messages.length);

    // Unhiding r0 must NOT trigger a reminder spike even at high occupancy!
    tokens = 105000;
    const unhid = (
      await tools.unhide_context.execute("unhide", { item_id: r0ItemId }, undefined, undefined, ctx)
    ).details;
    expect(unhid.ok).toBe(true);
    out = await events.context({ messages }, ctx);
    expect(out.messages).toHaveLength(messages.length);
    tokens = 20000;

    // Second >=100 KiB wave in the SAME Turn 1 re-fires cleanly through the real prepare+context pipeline!
    for (let i = 11; i <= 21; i++) {
      messages.push(
        { role: "assistant", content: [{ type: "toolCall", id: `r${i}`, name: "read", arguments: { path: `phase-${i}.txt` } }] },
        { role: "toolResult", toolCallId: `r${i}`, toolName: "read", isError: false, content: [{ type: "text", text: body }] },
      );
    }
    out = await events.context({ messages }, ctx);
    expect(out.messages.at(-1).content[0].text).toContain("eligible=12");
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
