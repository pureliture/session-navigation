import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "./session-navigation";

function setup(command = resolve(".venv/bin/session-navigation-daemon")) {
  process.env.SESSION_NAVIGATION_DAEMON = command;
  const events: Record<string, Function> = {};
  const tools: Record<string, any> = {};
  const chainable = () => ({ optional: () => ({}) });
  const pi = { zod: { object: () => ({}), string: chainable, number: () => ({ int: () => ({ min: () => ({ max: chainable }) }) }), array: () => chainable(), enum: () => chainable() },
    on: (name: string, handler: Function) => { events[name] = handler; },
    registerTool: (tool: any) => { tools[tool.name] = tool; } };
  extension(pi as any);
  return { events, tools };
}
const ctx = { sessionManager: { getSessionId: () => "test-session" } };
const longText = Array.from({ length: 100 }, (_, i) => `Output row ${i.toString().padStart(3, "0")} details`).join("\n");
function messages(content: any[] = [{ type: "text", text: longText }], isError = false) {
  return [{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "sample.txt" } }] },
    { role: "toolResult", toolCallId: "call-1", toolName: "read", content, isError, details: { preserved: true }, timestamp: 1 }];
}
async function execute(tool: any, args: any, context = ctx) { return (await tool.execute("test", args, undefined, undefined, context)).details; }

test("실제 데몬으로 확인된 read 결과의 압축과 복원을 수행한다", async () => {
  const { events, tools } = setup(); const input = messages();
  try {
    expect(await events.context({ messages: input }, ctx)).toBeUndefined();
    expect((await execute(tools.hide_context, { tool_call_id: "call-1" })).error).toBe("unconfirmed_snapshot");
    await events.assistant_message({ message: { role: "assistant", stopReason: "toolUse" } }, ctx);
    const compact = await execute(tools.hide_context, { tool_call_id: "call-1" });
    expect(compact.ok).toBe(true);
    const transformed = await events.context({ messages: input }, ctx);
    expect(transformed.messages[1].content[0].text).not.toBe(longText);
    expect(input[1].content[0].text).toBe(longText);
    expect(transformed.messages[1].details).toEqual({ preserved: true });
    const restored = await execute(tools.unhide_context, { item_id: compact.item_id });
    expect(restored.ok).toBe(true);
    expect(await events.context({ messages: input }, ctx)).toBeUndefined();
  } finally { await events.session_shutdown(); }
});

test("실패, 이미지, 중복 ID와 확인되지 않은 세션은 원본을 보존한다", async () => {
  const { events, tools } = setup();
  try {
    for (const input of [messages(undefined, true), messages([{ type: "text", text: longText }, { type: "image", data: "abc" }]), [...messages(), messages()[1]]]) {
      expect(await events.context({ messages: input }, ctx)).toBeUndefined();
      await events.assistant_message({ message: { role: "assistant", stopReason: "toolUse" } }, ctx);
      expect((await execute(tools.hide_context, { tool_call_id: "call-1" })).error).toBe("not_found");
    }
    expect((await execute(tools.hide_context, { tool_call_id: "call-1" }, { sessionManager: { getSessionId: () => "other" } })).error).toBe("unconfirmed_snapshot");
    expect(await events.context({ messages: messages() }, {})).toBeUndefined();
  } finally { await events.session_shutdown(); }
});

test("데몬이 없어도 context는 원본을 유지한다", async () => {
  const { events } = setup("/nonexistent/session-navigation-daemon");
  expect(await events.context({ messages: messages() }, ctx)).toBeUndefined();
  await events.session_shutdown();
});

test("응답이 멈춘 데몬을 폐기하고 이전 snapshot을 승인하지 않는다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "session-nav-hang-"));
  const daemon = join(dir, "daemon");
  writeFileSync(daemon, '#!/bin/sh\nread -r line\necho \'{"id":1,"ok":true,"protocol":2}\'\nexec sleep 10\n');
  chmodSync(daemon, 0o755);
  const oldTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: any, delay?: number, ...args: any[]) => oldTimeout(callback, delay === 2000 ? 100 : delay, ...args)) as typeof setTimeout;
  const { events, tools } = setup(daemon);
  try {
    expect(await events.context({ messages: messages() }, ctx)).toBeUndefined();
    await events.assistant_message({ message: { role: "assistant", stopReason: "toolUse" } }, ctx);
    expect((await execute(tools.hide_context, { tool_call_id: "call-1" })).error).toBe("unconfirmed_snapshot");
    expect(await events.context({ messages: messages() }, ctx)).toBeUndefined();
  } finally {
    await events.session_shutdown(); globalThis.setTimeout = oldTimeout;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("실행 중 취소하면 데몬과 snapshot을 함께 폐기한다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "session-nav-abort-"));
  const daemon = join(dir, "daemon");
  writeFileSync(daemon, '#!/bin/sh\nread -r line\necho \'{"id":1,"ok":true,"protocol":2}\'\nread -r line\necho \'{"id":2,"ok":true,"patches":[]}\'\nexec sleep 10\n');
  chmodSync(daemon, 0o755);
  const { events, tools } = setup(daemon);
  try {
    await events.context({ messages: messages() }, ctx);
    await events.assistant_message({ message: { role: "assistant", stopReason: "toolUse" } }, ctx);
    const controller = new AbortController();
    const pending = tools.hide_context.execute("test", { tool_call_id: "call-1" }, controller.signal, undefined, ctx);
    controller.abort();
    expect((await pending).details.error).toBe("cancelled");
    expect((await execute(tools.hide_context, { tool_call_id: "call-1" })).error).toBe("unconfirmed_snapshot");
  } finally { await events.session_shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("닫힌 데몬 stdin에 큰 요청을 보내도 EPIPE가 세션을 종료하지 않는다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "session-nav-epipe-"));
  const daemon = join(dir, "daemon");
  writeFileSync(daemon, '#!/bin/sh\nread -r line\necho \'{"id":1,"ok":true,"protocol":2}\'\nexec 0<&-\nexec sleep 10\n');
  chmodSync(daemon, 0o755);
  const { events } = setup(daemon);
  try {
    expect(await events.context({ messages: messages([{ type: "text", text: "a".repeat(1_000_000) }]) }, ctx)).toBeUndefined();
  } finally { await events.session_shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
