import { releaseExtension } from "../src/registration.ts";
import { beforeEach, test, expect } from "bun:test";
import extension from "../src/extension.ts";

beforeEach(() => releaseExtension());

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

test("registers /session-navigation command", () => {
  const { commands } = makePi();
  expect(commands["session-navigation"]).toBeDefined();
  expect(typeof commands["session-navigation"].handler).toBe("function");
});

test("headless mode aborts without custom UI", async () => {
  const { commands } = makePi();
  let customCalled = false;
  const ctx: any = {
    mode: "print",
    ui: {
      custom: async () => {
        customCalled = true;
      },
      notify: () => {},
      select: async () => "abort_request",
    },
    abort: () => {
      (ctx as any)._aborted = true;
    },
    sessionManager: { getSessionId: () => "s" },
  };
  await commands["session-navigation"].handler("", ctx);
  expect(customCalled).toBe(false);
  expect(ctx._aborted).toBe(true);
});

test("tui mode opens custom overlay", async () => {
  const { commands } = makePi();
  let overlay = false;
  const ctx: any = {
    mode: "tui",
    ui: {
      custom: async (_factory: any, opts: any) => {
        overlay = !!opts?.overlay;
        return undefined;
      },
      notify: () => {},
      select: async () => "abort_request",
    },
    abort: () => {},
    sessionManager: { getSessionId: () => "s" },
  };
  await commands["session-navigation"].handler("", ctx);
  expect(overlay).toBe(true);
});
