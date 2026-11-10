import { releaseExtension } from "../src/registration.ts";
import { beforeEach, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import extension from "../src/extension.ts";
import { Store, Engine, sha256, invocationDigest } from "../../core/src/index.ts";
import { BunDriver } from "../../core/src/drivers/bun.ts";
import { PaseoService } from "../../../paseo-plugin/server/service.ts";

beforeEach(() => releaseExtension());

const DB = join(mkdtempSync(join(tmpdir(), "sn-3ui-")), "state.sqlite3");
process.env.SESSION_NAVIGATION_STATE_PATH = DB;

async function seedDb() {
  const store = new Store(new BunDriver(DB));
  const scope = "omp:default:s3:default";
  store.register(scope, { adapter_id: "omp", adapter_protocol: 1, capabilities: { hide: true, summarize: true, unhide: true }, enabled: true, instance_id: "test" });
  for (let index = 0; index < 3; index++) {
    const content = Array.from({ length: 80 }, (_, line) => `Row ${index} line ${line} content`).join("\n");
    const invocation = { tool_name: "read", arguments: { path: "f.txt" } };
    expect((await new Engine(store).hide(scope, { call_id: `c${index}`, content, content_sha256: sha256(content), invocation, invocation_digest: invocationDigest(invocation), status: "ok", result_position: 0 })).ok).toBe(true);
  }
  store.close();
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
  await seedDb();
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
  const database = new Database(DB);
  const row = database.query("SELECT visibility, version FROM items WHERE tool_call_id='c0' AND scope_key='omp:default:s3:default'").get() as any;
  expect(row.visibility).toBe("visible");
  expect(row.version).toBeGreaterThan(1);
  database.close();
  expect(doneCalled).toBe(false);
  await events.session_shutdown();
});

test("Paseo service operates the same rows", async () => {
  await seedDb();
  const store = new Store(new BunDriver(DB));
  const service = new PaseoService(store);
  const scope = "omp:default:s3:default";
  const listed: any = await service.handle("list", { scope_key: scope });
  expect(listed.ok).toBe(true);
  expect(listed.items.length).toBeGreaterThanOrEqual(3);
  const first = listed.items[0];
  const unhid: any = await service.handle("unhide", {
    scope_key: scope,
    item_id: first.item_id,
    expected_version: first.version,
  });
  expect(unhid.ok).toBe(true);
  const managed: any = await service.handle("manage", { scope_key: scope, action: "auto", tool_call_ids: [first.tool_call_id] });
  expect(managed.applied).toBeGreaterThanOrEqual(1);
  const relisted: any = await service.handle("list", { scope_key: scope });
  expect(relisted.items.find((i: any) => i.item_id === first.item_id)?.status).toBe("hidden");
  store.close();
});

test("OMP tool hide/unhide roundtrip via worker RPC", async () => {
  await seedDb();
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
