import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbChoice, hideItem, listItems, manageItems } from "./sessionNav";
function fakeCli(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sn-paseo-"));
  const cmd = join(dir, "session-navigation");
  writeFileSync(cmd, `#!/bin/sh\n${script}\n`);
  chmodSync(cmd, 0o755);
  const prev = process.env.PATH ?? "";
  process.env.PATH = `${dir}:${prev}`;
  return dir;
}

function restorePath(dir: string) {
  process.env.PATH = (process.env.PATH ?? "").replace(`${dir}:`, "");
  rmSync(dir, { recursive: true, force: true });
}

test("abort_request locks mutations; a healthy list probe recovers", async () => {
  const dir = fakeCli(`echo '{"ok":true,"items":[]}'`);
  try {
    const scope = `paseo:default:abort-${Date.now()}:default`;
    expect((await dbChoice({ scope_key: scope, choice: "abort_request" })).ok).toBe(true);
    const blocked = await hideItem({ scope_key: scope, item_id: "item_x" });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe("db_error");
    const probe: any = await listItems({ scope_key: scope });
    expect(probe.ok).toBe(true);
    const after = await hideItem({ scope_key: scope, item_id: "item_x", expected_version: 1 });
    expect((after as any).ok).toBe(true);
  } finally { restorePath(dir); }
});

test("abort probe failure keeps the lock", async () => {
  const dir = fakeCli(`echo '{"ok":false,"error":"db_error"}'`);
  try {
    const scope = `paseo:default:abortfail-${Date.now()}:default`;
    expect((await dbChoice({ scope_key: scope, choice: "abort_request" })).ok).toBe(true);
    const probe: any = await listItems({ scope_key: scope });
    expect(probe.ok).toBe(false);
    const blocked = await hideItem({ scope_key: scope, item_id: "item_x" });
    expect(blocked.ok).toBe(false);
  } finally { restorePath(dir); }
});

test("send_original permits one list then locks mutations", async () => {
  const dir = fakeCli(`echo '{"ok":true,"items":[]}'`);
  try {
    const scope = `paseo:default:send-${Date.now()}:default`;
    expect((await dbChoice({ scope_key: scope, choice: "send_original" })).ok).toBe(true);
    const first: any = await listItems({ scope_key: scope });
    expect(first.ok).toBe(true);
    const blocked = await hideItem({ scope_key: scope, item_id: "item_x" });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toBe("db_error");
    const second: any = await listItems({ scope_key: scope });
    expect(second.ok).toBe(true);
    const third = await hideItem({ scope_key: scope, item_id: "item_x" });
    expect(third.ok).toBe(true);
  } finally { restorePath(dir); }
});

test("manage passes action and parses per-item results", async () => {
  const dir = fakeCli(`echo '{"ok":true,"applied":2,"failed":1,"items":[{"tool_call_id":"a","ok":true,"item_id":"item_a"},{"tool_call_id":"b","ok":false,"error":"destructive_command"}]}'`);
  try {
    const res: any = await manageItems({ scope_key: "paseo:default:m:default", action: "auto", max_items: 20 });
    expect(res.ok).toBe(true);
    expect(res.applied).toBe(2);
    expect(res.failed).toBe(1);
    expect(res.items.length).toBe(2);
  } finally { restorePath(dir); }
});
