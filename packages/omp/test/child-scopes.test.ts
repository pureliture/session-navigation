import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../core/src/index.ts";
import { BunDriver } from "../../core/src/drivers/bun.ts";
import extension from "../src/extension.ts";
import { OmpService, sessionScope } from "../src/service.ts";
import { releaseExtension } from "../src/registration.ts";

afterEach(() => releaseExtension());

test("parent and passive child own separate sessions; child projection and revival preserve state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-child-"));
  const store = new Store(new BunDriver(join(directory, "state.db")));
  const service = new OmpService(store);
  const parentFile = join(directory, "parent.jsonl");
  writeFileSync(parentFile, JSON.stringify({ type: "title", title: "parent" }) + "\n" +
    JSON.stringify({ type: "session", id: "parent" }) + "\n");
  const childContext: any = {
    agent: { kind: "sub", id: "ChildBird", parentId: "Main", depth: 1 },
    sessionManager: { getSessionId: () => "child", getHeader: () => ({ parentSession: parentFile }),
      getSessionFile: () => join(directory, "ChildBird.jsonl") },
  };
  const optional = () => ({ optional: () => ({}) });
  const build = () => {
    const events = new Map<string, Function>(), tools: string[] = [];
    let token: string;
    const client = { request: async (method: string, params: any) => {
      if (method === "prepare") token = params.snapshot_id;
      return service.handle(method, params);
    }, close() {} };
    extension({ on: (name: string, handler: Function) => events.set(name, handler),
      zod: { object: () => ({}), string: optional, array: optional, enum: optional,
        number: () => ({ int: () => ({ min: () => ({ max: optional }) }) }) },
      registerTool: (tool: { name: string }) => tools.push(tool.name),
    } as any, { client: () => client as any });
    return { events, tools, token: () => token };
  };
  try {
    const parent = build(), child = build();
    await parent.events.get("session_start")!({}, { agent: { kind: "main" }, sessionManager: { getSessionId: () => "parent" } });
    await parent.events.get("context")!({ messages: [] }, { sessionManager: { getSessionId: () => "parent" } });
    await child.events.get("session_start")!({}, childContext);
    expect(parent.tools).toHaveLength(5);
    expect(child.tools).toEqual([]);
    expect(child.events.has("before_agent_start")).toBe(false);
    const owned = store.childScopes(sessionScope("parent"));
    expect(owned.map((row) => row.subagent_id)).toEqual(["ChildBird"]);
    await parent.events.get("tool_result")!({ toolName: "task", toolCallId: "task-call", details: { progress: [{ id: "ChildBird" }] } },
      { sessionManager: { getSessionId: () => "parent" } });
    const body = Array.from({ length: 100 }, (_, i) => `Routine catalog annotation ${i}`).join("\n");
    const messages = [{ role: "assistant", content: [{ type: "toolCall", id: "read-child", name: "read", arguments: { path: "sample.txt" } }] },
      { role: "toolResult", toolCallId: "read-child", toolName: "read", isError: false, content: [{ type: "text", text: body }] }];
    expect(await child.events.get("context")!({ messages }, childContext)).toBeUndefined();
    expect((await service.handle("compact", { session_id: "child", snapshot_id: child.token(), tool_call_id: "read-child" })).ok).toBe(true);
    const projected = await child.events.get("context")!({ messages }, childContext);
    expect(projected.messages[1].content[0].text).toContain("[hidden:");
    expect(messages[1].content[0].text).toBe(body);
    expect(store.items(sessionScope("parent"))).toEqual([]);
    await child.events.get("session_start")!({}, childContext);
    expect(store.items(sessionScope("child"))).toHaveLength(1);
    expect(store.registration(sessionScope("child"))?.tool_call_id).toBe("task-call");
    await child.events.get("session_shutdown")!();
    const revived = build();
    await revived.events.get("session_start")!({}, childContext);
    expect((await revived.events.get("context")!({ messages }, childContext)).messages[1].content[0].text).toContain("[hidden:");
    expect(store.registration(sessionScope("child"))?.tool_call_id).toBe("task-call");
    const item = store.items(sessionScope("child"))[0];
    await service.handle("restore", { session_id: "child", item_id: item.item_id, expected_version: item.version });
    expect(await revived.events.get("context")!({ messages }, childContext)).toBeUndefined();
    await revived.events.get("session_shutdown")!();
    await parent.events.get("session_shutdown")!();
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
