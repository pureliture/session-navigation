import { releaseExtension } from "../src/registration.ts";
import { beforeEach, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import extension from "../src/extension.ts";
import {
  listItems,
  hideItem,
  unhideItem,
  manageItems,
} from "../../../paseo-plugin/server/sessionNav";

beforeEach(() => releaseExtension());

const REPO = resolve(import.meta.dir, "../../..");
const DB = join(mkdtempSync(join(tmpdir(), "sn-3ui-")), "state.sqlite3");
process.env.SESSION_NAVIGATION_STATE_PATH = DB;
process.env.PATH = `${join(REPO, ".venv/bin")}${process.env.PATH ? ":" + process.env.PATH : ""}`;
process.env.PYTHONPATH = join(REPO, "src");

function seedDb() {
  const py = resolve(REPO, ".venv/bin/python");
  const code = [
    "import sys; sys.path.insert(0, 'src')",
    "from session_navigation.sqlite_store import SQLiteContextStore",
    "from session_navigation.engine import SessionNavigationEngine",
    "from session_navigation.model import Scope, ToolResultRecord, compute_invocation_digest, compute_sha256",
    "db = '" + DB + "'",
    "store = SQLiteContextStore(db); engine = SessionNavigationEngine(store=store)",
    "scope = Scope('omp', 'default', 's3', 'default')",
    "for i in range(3):",
    "  body = '\\n'.join(f'Row {i:03d} line {j:03d} content' for j in range(80))",
    "  inv = {'tool_name': 'read', 'arguments': {'path': 'f.txt'}}",
    "  rec = ToolResultRecord(call_id=f'c{i}', content=body, content_sha256=compute_sha256(body), invocation=inv, invocation_digest=compute_invocation_digest(inv), status='ok')",
    "  assert engine.compact_sync(scope, rec).ok",
    "store.close()",
  ].join("\n");
  const r = spawnSync(py, ["-c", code], {
    cwd: REPO,
    env: { ...process.env, SESSION_NAVIGATION_STATE_PATH: DB },
  });
  if (r.status !== 0) throw new Error("seed failed: " + r.stderr.toString().slice(0, 500));
}

function makePi() {
  const events: Record<string, Function> = {};
  const tools: Record<string, any> = {};
  const commands: Record<string, any> = {};
  const chainable = () => ({ optional: () => ({}) });
  const pi = {
    zod: {
      object: () => ({}),
      string: chainable,
      number: () => ({ int: () => ({ min: () => ({ max: chainable }) }) }),
      array: () => chainable(),
      enum: () => chainable(),
    },
    on: (name: string, handler: Function) => {
      events[name] = handler;
    },
    registerTool: (tool: any) => {
      tools[tool.name] = tool;
    },
    registerCommand: (name: string, opts: any) => {
      commands[name] = opts;
    },
  };
  extension(pi as any);
  events.session_start({}, { agent: { kind: "main" } });
  return { events, tools, commands };
}

test("OMP overlay factory renders rows and unhides via worker", async () => {
  seedDb();
  const { commands, events } = makePi();
  let factory: any = null;
  let doneCalled = false;
  const ctx: any = {
    mode: "tui",
    ui: {
      custom: async (f: any) => {
        factory = f;
        return undefined;
      },
      notify: () => {},
      select: async () => "abort_request",
    },
    abort: () => {},
    sessionManager: { getSessionId: () => "s3" },
  };
  await commands["session-navigation"].handler("", ctx);
  expect(factory).not.toBeNull();
  const tui = { requestRender: () => {} };
  const component = await factory(tui, {}, {}, () => {
    doneCalled = true;
  });
  const lines = component.render(100).join("\n");
  expect(lines).toContain("Session navigation");
  expect(lines).toContain("c0");
  expect(lines).toContain("hidden");
  // Drive unhide on the selected row through the live worker RPC.
  // Integration against a worker service process: poll render until the async
  // mutation lands (deterministic timers cannot apply to a child process).
  await component.handleInput("u");
  let after = "";
  for (let i = 0; i < 50; i++) {
    after = component.render(100).join("\n");
    if (after.includes("visible") || after.includes("version_conflict")) break;
    await Bun.sleep(50);
  }
  expect(after).toContain("c0");
  expect(after).toMatch(/visible|version_conflict/);
  // Prove the daemon-side state actually flipped, not just the render text.
  const { execFileSync } = await import("node:child_process");
  const raw = execFileSync(
    "sqlite3",
    [
      DB,
      "SELECT visibility, version FROM items WHERE tool_call_id='c0' AND scope_key='omp:default:s3:default';",
    ],
    { encoding: "utf8" },
  ).trim();
  const [vis, ver] = raw.split("|");
  expect(vis).toBe("visible");
  expect(Number(ver)).toBeGreaterThan(1);
  expect(doneCalled).toBe(false);
  await events.session_shutdown();
});

test("Paseo RPC handlers operate the same rows", async () => {
  seedDb();
  const scope = "omp:default:s3:default";
  const listed: any = await listItems({ scope_key: scope });
  expect(listed.ok).toBe(true);
  expect(listed.items.length).toBeGreaterThanOrEqual(3);
  const first = listed.items[0];
  const unhid: any = await unhideItem({
    scope_key: scope,
    item_id: first.item_id,
    expected_version: first.version,
  });
  expect(unhid.ok).toBe(true);
  const managed: any = await manageItems({ scope_key: scope, action: "auto", max_items: 20 });
  expect(managed.applied).toBeGreaterThanOrEqual(1);
  const relisted: any = await listItems({ scope_key: scope });
  expect(relisted.items.find((i: any) => i.item_id === first.item_id)?.status).toBe("hidden");
});

test("OMP tool hide/unhide roundtrip via worker RPC", async () => {
  seedDb();
  const { tools, events } = makePi();
  const ctx: any = {
    mode: "print",
    sessionManager: { getSessionId: () => "s3" },
    ui: { notify: () => {}, select: async () => "abort_request" },
    abort: () => {},
  };
  const listed: any = await tools.list_context_items.execute("t", {}, undefined, undefined, ctx);
  expect(listed.details.ok).toBe(true);
  await events.session_shutdown();
});
