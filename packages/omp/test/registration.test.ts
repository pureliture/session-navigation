import { afterEach, expect, test } from "bun:test";
import packageExtension from "../index.ts";
import legacyExtension from "../../../extensions/pi/session-navigation.ts";
import { releaseExtension } from "../src/registration.ts";

afterEach(() => releaseExtension());

test("package and legacy shim share a registration guard, in either load order", async () => {
  for (const extensions of [
    [packageExtension, legacyExtension],
    [legacyExtension, packageExtension],
  ]) {
    releaseExtension();
    const events = new Map<string, Function[]>();
    const tools: string[] = [];
    const optional = () => ({ optional: () => ({}) });
    const api = {
      zod: {
        object: () => ({}),
        string: optional,
        array: optional,
        enum: optional,
        number: () => ({ int: () => ({ min: () => ({ max: optional }) }) }),
      },
      on: (event: string, handler: Function) => {
        if (event !== "session_start") expect(events.has(event)).toBe(false);
        events.set(event, [...(events.get(event) ?? []), handler]);
      },
      registerTool: (tool: { name: string }) => tools.push(tool.name),
    };
    extensions[0](api as any);
    extensions[1](api as any);
    for (const start of events.get("session_start")!) start({}, { agent: { kind: "main" } });
    expect(tools).toEqual([
      "list_context_items", "manage_context", "hide_context", "summarize_context", "unhide_context",
    ]);
    await events.get("session_shutdown")![0]();
  }
});
