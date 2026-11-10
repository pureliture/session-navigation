import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../src/extension.ts";
import { releaseExtension } from "../src/registration.ts";

afterEach(() => releaseExtension());

test("unlinked subagents and depth-zero clones stay inert and never open state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-subagent-"));
  const oldPath = process.env.SESSION_NAVIGATION_STATE_PATH;
  const state = join(directory, "must-not-exist.sqlite3");
  process.env.SESSION_NAVIGATION_STATE_PATH = state;
  try {
    for (const agent of [
      { kind: "sub", id: "0-Explore", name: "explore", parentId: "Main", depth: 1 },
      { kind: "sub", id: "clone", name: "sub", parentId: "Main", depth: 0 },
      { kind: "sub", id: "advisor", name: "advisor", parentId: "Main", depth: 0 },
    ]) {
      releaseExtension();
      const events = new Map<string, Function>();
      const tools: unknown[] = [];
      const commands: unknown[] = [];
      let clients = 0;
      extension(
        {
          on: (name: string, handler: Function) => events.set(name, handler),
          registerTool: (tool: unknown) => tools.push(tool),
          registerCommand: (command: unknown) => commands.push(command),
        } as any,
        {
          client: () => {
            clients++;
            throw new Error("subagent must not create a client");
          },
        },
      );
      await events.get("session_start")!(
        {},
        { agent, sessionManager: { getSessionId: () => "parent-session" } },
      );
      expect(tools).toEqual([]);
      expect(commands).toEqual([]);
      expect([...events.keys()]).toEqual(["session_start"]);
      expect(clients).toBe(0);
      expect(existsSync(state)).toBe(false);
    }
  } finally {
    if (oldPath === undefined) delete process.env.SESSION_NAVIGATION_STATE_PATH;
    else process.env.SESSION_NAVIGATION_STATE_PATH = oldPath;
    rmSync(directory, { recursive: true, force: true });
  }
});
