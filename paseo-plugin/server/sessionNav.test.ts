import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbChoice, hideBatch, unhideBatch, hideItem, listItems, manageItems, findAgentMappings } from "./sessionNav";
import { readFileSync } from "node:fs";

test("imported OMP bare native handles resolve recursively like CLI session filenames", () => {
  const home = mkdtempSync(join(tmpdir(), "sn-omp-import-"));
  try {
    const agents = join(home, ".paseo", "agents", "workspace");
    const sessions = join(home, ".omp", "agent", "sessions", "workspace", "nested");
    mkdirSync(agents, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    const file = join(sessions, "2026-11-09_session-import.jsonl");
    writeFileSync(file, "");
    for (const [id, handle] of [
      ["import", "session-import"], ["path", file], ["missing", "missing-session"],
      ["wrong-suffix", "session-imp"], ["bad-path", join(home, "missing.jsonl")],
    ]) {
      writeFileSync(join(agents, `${id}.json`), JSON.stringify({
        id, persistence: { provider: "omp", sessionId: `session-${id}`, nativeHandle: handle },
      }));
    }
    expect(findAgentMappings(home).ompScopes.sort((a, b) => a.agent_id.localeCompare(b.agent_id))).toEqual([
      { scope_key: "pi:default:session-import:default", agent_id: "import" },
      { scope_key: "pi:default:session-path:default", agent_id: "path" },
    ]);
    rmSync(join(home, ".omp"), { recursive: true });
    expect(findAgentMappings(home).ompScopes).toEqual([]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("list carries original preview fields including empty output through asRow", async () => {
  const dir = fakeCli(`echo '{"ok":true,"items":[{"item_id":"preview","tool_call_id":"call","status":"hidden","version":2,"tool_input":"original path","tool_output":""}]}'`);
  try {
    const result: any = await listItems({ scope_key: "preview-fields" });
    expect(result.ok).toBe(true);
    expect(result.items[0].tool_input).toBe("original path");
    expect(result.items[0].tool_output).toBe("");
  } finally { restorePath(dir); }
});
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

test("hideItem passes --mode hide or summarize to CLI", async () => {
  const dir = fakeCli(`echo "$*" > "$0.args"\necho '{"ok":true,"item_id":"item_x","visibility":"hidden","version":2}'`);
  try {
    const scope = `paseo:default:mode-${Date.now()}:default`;
    const res: any = await hideItem({ scope_key: scope, item_id: "item_x", expected_version: 1, mode: "summarize" });
    expect(res.ok).toBe(true);
    const { readFileSync } = await import("node:fs");
    const args = readFileSync(join(dir, "session-navigation.args"), "utf8").trim();
    expect(args).toContain("--mode summarize");
  } finally { restorePath(dir); }
});

for (const command of ["hide", "unhide"] as const) {
  test(`batch ${command} invokes the CLI once with items and versions`, async () => {
    const dir = fakeCli(`echo "$*" >> "$0.args"
echo '{"ok":false,"applied":1,"failed":1,"items":[{"item_id":"a","ok":true,"status":"hidden","visibility":"hidden","version":2},{"item_id":"b","ok":false,"status":"visible","visibility":"visible","version":4,"error":"version_conflict"}]}'
exit 2`);
    try {
      const input = { scope_key: `batch-${command}`, mode: "summarize" as const,
        items: [{ item_id: "a", expected_version: 1 }, { item_id: "b", expected_version: 3 }] };
      const result = await (command === "hide" ? hideBatch(input) : unhideBatch(input));
      expect(result.ok).toBe(false);
      expect(result.applied).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.items[1].error).toBe("version_conflict");
      const lines = readFileSync(join(dir, "session-navigation.args"), "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(`${command} --scope batch-${command} --items-json ${JSON.stringify(input.items)}`);
      if (command === "hide") expect(lines[0]).toContain("--mode summarize");
      else expect(lines[0]).not.toContain("--mode");
    } finally { restorePath(dir); }
  });

  test(`batch ${command} observes the D9 gate and recovers after a probe`, async () => {
    const dir = fakeCli(`echo '{"ok":true,"applied":0,"failed":0,"items":[]}'`);
    try {
      const scope = `batch-gate-${command}`;
      await dbChoice({ scope_key: scope, choice: "abort_request" });
      const mutate = command === "hide" ? hideBatch : unhideBatch;
      expect((await mutate({ scope_key: scope, items: [] })).error).toBe("db_error");
      await listItems({ scope_key: scope });
      expect((await mutate({ scope_key: scope, items: [] })).ok).toBe(true);
    } finally { restorePath(dir); }
  });
}

for (const error of ["db_error", "db_full", "summarizer_unavailable"]) {
  test(`batch errors preserve ${error}`, async () => {
    const dir = fakeCli(`echo '{"ok":false,"error":"${error}"}'; exit 3`);
    try {
      const result = await hideBatch({ scope_key: "batch-errors", items: [{ item_id: "a" }] });
      expect(result.error).toBe(error);
      expect(result.items).toEqual([]);
      if (error !== "summarizer_unavailable") expect(result.choices).toEqual(["abort_request", "send_original"]);
    } finally { restorePath(dir); }
  });
}

test("list carries measured row tokens and the session context", async () => {
  const dir = fakeCli(`echo '{"ok":true,"context":{"used_tokens":9069,"max_tokens":32768,"source":"omp_session_usage"},"items":[{"item_id":"t","tool_call_id":"call","status":"visible","version":1,"tokens":44,"tokens_display":"44 tok"}]}'`);
  try {
    const result: any = await listItems({ scope_key: "token-fields" });
    expect(result.context).toEqual({ used_tokens: 9069, max_tokens: 32768, source: "omp_session_usage" });
    expect(result.items[0].tokens).toBe(44);
    expect(result.items[0].tokens_display).toBe("44 tok");
  } finally { restorePath(dir); }
});
