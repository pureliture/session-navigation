import { afterEach, expect, test } from "bun:test";
import extension from "../src/extension.ts";
import { releaseExtension } from "../src/registration.ts";
import { supportedSqliteVersion } from "../src/sqlite-runtime.ts";

afterEach(() => releaseExtension());

test("requires upstream SQLite 3.51.3 or newer", () => {
  for (const version of ["3.51.0", "3.51.2", "3.50.7", "3.44.6", "unknown", "3.51.3junk", ""]) {
    expect(supportedSqliteVersion(version)).toBe(false);
  }
  for (const version of ["3.51.3", "3.53.2", "4.0.0"]) {
    expect(supportedSqliteVersion(version)).toBe(true);
  }
});

test("unsupported SQLite blocks context rather than sending hidden originals", async () => {
  const events = new Map<string, Function>();
  const warnings: string[] = [];
  const tools: unknown[] = [];
  let clients = 0;
  const api = {
    on: (name: string, handler: Function) => events.set(name, handler),
    registerTool: (tool: unknown) => tools.push(tool),
  };
  extension(api as any, {
    sqliteVersion: () => "3.51.0",
    client: () => { clients++; throw new Error("must not create a client"); },
  });
  await events.get("session_start")!({}, {
    agent: { kind: "main" },
    ui: { notify: (message: string) => warnings.push(message) },
  });
  expect(tools).toEqual([]);
  expect(clients).toBe(0);
  expect(warnings[0]).toContain("SQLite 3.51.0은 지원되지 않습니다");
  let aborted = false;
  await expect(events.get("context")!({ messages: [] }, { abort: () => { aborted = true; } }))
    .rejects.toThrow("SQLite 3.51.3 이상이 필요합니다");
  expect(aborted).toBe(true);
});
