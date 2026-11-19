import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  Store,
  invocationDigest,
  itemId,
  sha256,
  type Item,
} from "../../packages/core/src/index.ts";
import { BunDriver } from "../../packages/core/src/drivers/bun.ts";
import { hasHermesSession } from "./hermesHistory.ts";
import { loadTimeline } from "./history.ts";
import { PaseoService } from "./service.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

function entry(id: string, role: string, text: string, timestamp: number) {
  return JSON.stringify({
    type: "message",
    id,
    message: { role, content: [{ type: "text", text }], timestamp },
  });
}

function homeWith(lines: string[]) {
  const home = mkdtempSync(join(tmpdir(), "paseo-chunk-"));
  const dir = join(home, ".omp/agent/sessions/project");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026_chunk.jsonl"), lines.join("\n"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

const scope = "omp:default:chunk:default";

test("OMP latest compaction chunk starts at firstKeptEntryId", () => {
  const home = homeWith([
    entry("old", "user", "old question", 1),
    entry("kept", "assistant", "kept answer", 2),
    entry("new", "user", "new question", 3),
    JSON.stringify({ type: "compaction", id: "cmp", firstKeptEntryId: "kept" }),
  ]);
  const timeline = loadTimeline(home, scope);
  const texts = timeline.rows.map((row: any) => row.message_text);
  expect(texts.some((text: string) => text.includes("old question"))).toBe(false);
  expect(texts.some((text: string) => text.includes("kept answer"))).toBe(true);
  expect(texts.some((text: string) => text.includes("new question"))).toBe(true);
  expect(timeline.history.messages).toHaveLength(2);
  expect(timeline.history.chunkStart).toBe(0);
});

test("OMP keeps only the latest compaction boundary", () => {
  const home = homeWith([
    entry("a", "user", "first", 1),
    entry("b", "assistant", "second", 2),
    JSON.stringify({ type: "compaction", id: "cmp1", firstKeptEntryId: "a" }),
    entry("c", "user", "third", 3),
    JSON.stringify({ type: "compaction", id: "cmp2", firstKeptEntryId: "c" }),
    entry("d", "assistant", "fourth", 4),
  ]);
  const timeline = loadTimeline(home, scope);
  const texts = timeline.rows.map((row: any) => row.message_text);
  expect(texts.some((text: string) => text.includes("first"))).toBe(false);
  expect(texts.some((text: string) => text.includes("second"))).toBe(false);
  expect(texts.some((text: string) => text.includes("third"))).toBe(true);
  expect(texts.some((text: string) => text.includes("fourth"))).toBe(true);
});

test("OMP unknown firstKeptEntryId falls back to the full history", () => {
  const home = homeWith([
    entry("a", "user", "kept question", 1),
    JSON.stringify({ type: "compaction", id: "cmp", firstKeptEntryId: "missing" }),
  ]);
  const timeline = loadTimeline(home, scope);
  expect(timeline.rows).toHaveLength(1);
  expect(timeline.history.messages).toHaveLength(1);
});

function tempHome(prefix = "paseo-hermes-chunk-") {
  const home = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function hermesDb(home: string, legacy = false) {
  const dir = join(home, ".hermes");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, "state.db"));
  cleanup.push(() => {
    try {
      db.close();
    } catch {
      // Already closed.
    }
  });
  db.exec(
    legacy
      ? `
        CREATE TABLE sessions (id TEXT PRIMARY KEY, model_config TEXT);
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT,
          tool_call_id TEXT,
          tool_calls TEXT,
          tool_name TEXT,
          codex_message_items TEXT,
          api_content TEXT,
          active INTEGER NOT NULL DEFAULT 1,
          compacted INTEGER NOT NULL DEFAULT 0
        );
      `
      : `
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          model_config TEXT,
          parent_session_id TEXT,
          started_at REAL
        );
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT,
          tool_call_id TEXT,
          tool_calls TEXT,
          tool_name TEXT,
          codex_message_items TEXT,
          api_content TEXT,
          active INTEGER NOT NULL DEFAULT 1,
          compacted INTEGER NOT NULL DEFAULT 0,
          _compressed_summary INTEGER NOT NULL DEFAULT 0
        );
      `,
  );
  return db;
}

test("Hermes rotation chain follows parent_session_id to latest child and starts at _compressed_summary=1", () => {
  const home = tempHome();
  const db = hermesDb(home);
  const insSess = db.prepare(
    "INSERT INTO sessions (id, model_config, parent_session_id, started_at) VALUES (?, ?, ?, ?)",
  );
  insSess.run("root-sess", JSON.stringify({ _usage_anchor: { prompt_tokens: 100, completion_tokens: 10 } }), null, 100);
  insSess.run("child-old", JSON.stringify({ _usage_anchor: { prompt_tokens: 200, completion_tokens: 10 } }), "root-sess", 150);
  insSess.run("child-1", JSON.stringify({ _usage_anchor: { prompt_tokens: 300, completion_tokens: 10 } }), "root-sess", 200);
  insSess.run("child-2", JSON.stringify({ _usage_anchor: { prompt_tokens: 450, completion_tokens: 50 } }), "child-1", 300);

  const insMsg = db.prepare(
    "INSERT INTO messages (session_id, role, content, _compressed_summary) VALUES (?, ?, ?, ?)",
  );
  insMsg.run("root-sess", "user", "root old prompt", 0);
  insMsg.run("child-old", "user", "stale sibling branch", 1);
  insMsg.run("child-1", "user", "intermediate rotation prompt", 1);
  insMsg.run("child-2", "user", "pre-summary active row in child-2", 0);
  insMsg.run("child-2", "user", "[CONTEXT COMPACTION] child-2 summary", 1);
  insMsg.run("child-2", "assistant", "latest chunk reply", 0);

  const tl = loadTimeline(home, "hermes:default:root-sess:unknown");
  expect(tl.rows.map((r) => r.summary_line)).toEqual([
    "[CONTEXT COMPACTION] child-2 summary",
    "latest chunk reply",
  ]);
  expect(tl.history.externalContext?.used_tokens).toBe(500);
  expect(hasHermesSession(home, "default", "root-sess")).toBe(true);
});

test("Hermes in-place compaction slices at first _compressed_summary=1 and marks cross-boundary tool results display_only", () => {
  const home = tempHome();
  const db = hermesDb(home);
  db.prepare(
    "INSERT INTO sessions (id, model_config, parent_session_id, started_at) VALUES (?, ?, ?, ?)",
  ).run("inplace-sess", "{}", null, 100);

  const insMsg = db.prepare(
    `INSERT INTO messages
       (session_id, role, content, tool_call_id, tool_calls, tool_name, active, _compressed_summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insMsg.run("inplace-sess", "user", "archived prompt", null, null, null, 0, 0);
  insMsg.run(
    "inplace-sess",
    "assistant",
    "",
    null,
    JSON.stringify([{ id: "call_before", type: "function", function: { name: "read_file", arguments: '{"path":"old.txt"}' } }]),
    null,
    1,
    0,
  );
  insMsg.run("inplace-sess", "assistant", "[CONTEXT COMPACTION] in-place summary", null, null, null, 1, 1);
  insMsg.run("inplace-sess", "tool", "result from pre-boundary call", "call_before", null, "read_file", 1, 0);
  insMsg.run(
    "inplace-sess",
    "assistant",
    "",
    null,
    JSON.stringify([{ id: "call_after", type: "function", function: { name: "read_file", arguments: '{"path":"new.txt"}' } }]),
    null,
    1,
    0,
  );
  insMsg.run("inplace-sess", "tool", "result from post-boundary call", "call_after", null, "read_file", 1, 0);

  const tl = loadTimeline(home, "hermes:default:inplace-sess:unknown");
  expect(tl.rows).toHaveLength(3);
  expect(tl.rows[0].summary_line).toBe("[CONTEXT COMPACTION] in-place summary");
  expect(tl.rows[1]).toMatchObject({
    tool_call_id: "call_before",
    manageable: false,
    source: "display_only",
  });
  expect(tl.rows[2]).toMatchObject({
    tool_call_id: "call_after",
    manageable: true,
    source: "unrecorded",
  });
});

test("Hermes legacy DB without _compressed_summary or parent_session_id returns full active history", () => {
  const home = tempHome();
  const db = hermesDb(home, true);
  db.prepare("INSERT INTO sessions (id, model_config) VALUES (?, ?)").run("legacy-sess", "{}");
  const insMsg = db.prepare(
    "INSERT INTO messages (session_id, role, content, active) VALUES (?, ?, ?, ?)",
  );
  insMsg.run("legacy-sess", "user", "inactive row", 0);
  insMsg.run("legacy-sess", "user", "legacy prompt 1", 1);
  insMsg.run("legacy-sess", "assistant", "legacy reply 1", 1);

  const tl = loadTimeline(home, "hermes:default:legacy-sess:unknown");
  expect(tl.rows.map((r) => r.summary_line)).toEqual(["legacy prompt 1", "legacy reply 1"]);
});

test("Hermes rotation chain guards against cycles, honors 32-hop bound, and falls back to requested session when childless", () => {
  const home = tempHome();
  const db = hermesDb(home);
  const insSess = db.prepare(
    "INSERT INTO sessions (id, model_config, parent_session_id, started_at) VALUES (?, ?, ?, ?)",
  );
  const insMsg = db.prepare(
    "INSERT INTO messages (session_id, role, content, _compressed_summary) VALUES (?, ?, ?, ?)",
  );

  // Cycle a <-> b
  insSess.run("cyc-a", "{}", "cyc-b", 10);
  insSess.run("cyc-b", "{}", "cyc-a", 20);
  insMsg.run("cyc-b", "user", "cycle leaf prompt", 0);

  const cycleTl = loadTimeline(home, "hermes:default:cyc-a:unknown");
  expect(cycleTl.rows.map((r) => r.summary_line)).toEqual(["cycle leaf prompt"]);

  // Childless session
  insSess.run("solo-sess", "{}", null, 30);
  insMsg.run("solo-sess", "user", "solo prompt", 0);
  const soloTl = loadTimeline(home, "hermes:default:solo-sess:unknown");
  expect(soloTl.rows.map((r) => r.summary_line)).toEqual(["solo prompt"]);

  // 32-hop cap stops at hop 32 when chain exceeds 32 links
  for (let i = 0; i <= 34; i++) {
    insSess.run(`hop-${i}`, "{}", i === 0 ? null : `hop-${i - 1}`, 100 + i);
  }
  insMsg.run("hop-32", "user", "hop 32 boundary prompt", 0);
  insMsg.run("hop-34", "user", "beyond 32 hops", 0);
  const deepTl = loadTimeline(home, "hermes:default:hop-0:unknown");
  expect(deepTl.rows.map((r) => r.summary_line)).toEqual(["hop 32 boundary prompt"]);
});

test("PaseoService.list excludes pre-compaction Hermes targets/items and scopes totals to the latest chunk", async () => {
  const home = tempHome();
  const db = hermesDb(home);
  db.prepare(
    "INSERT INTO sessions (id, model_config, parent_session_id, started_at) VALUES (?, ?, ?, ?)",
  ).run("h-old", "{}", null, 100);
  db.prepare(
    "INSERT INTO sessions (id, model_config, parent_session_id, started_at) VALUES (?, ?, ?, ?)",
  ).run("h-new", "{}", "h-old", 200);
  const insMsg = db.prepare(
    `INSERT INTO messages
       (session_id, role, content, tool_call_id, tool_calls, tool_name, active, _compressed_summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insMsg.run("h-old", "user", "old hermes prompt", null, null, null, 1, 0);
  insMsg.run("h-new", "user", "[CONTEXT COMPACTION] hermes summary", null, null, null, 1, 1);
  insMsg.run(
    "h-new",
    "assistant",
    "",
    null,
    JSON.stringify([{ id: "call_cur", type: "function", function: { name: "read_file", arguments: '{"path":"cur.txt"}' } }]),
    null,
    1,
    0,
  );
  const curContent = "current chunk output ".repeat(30);
  insMsg.run("h-new", "tool", curContent, "call_cur", null, "read_file", 1, 0);

  const hScope = "hermes:default:h-old:unknown";
  const store = new Store(new BunDriver(join(home, "state.sqlite3")));
  cleanup.push(() => store.close());
  store.register(hScope, {
    adapter_id: "hermes",
    adapter_protocol: 1,
    capabilities: { hide: true, summarize: true, unhide: true },
    enabled: true,
    instance_id: "test",
  });
  const oldInv = { tool_name: "read_file", arguments: { path: "pre.txt" } };
  const oldContent = "pre-compaction hermes target ".repeat(40);
  store.publishTargets(hScope, [
    {
      record: {
        call_id: "call_pre_target",
        content: oldContent,
        content_sha256: sha256(oldContent),
        invocation: oldInv,
        invocation_digest: invocationDigest(oldInv),
        result_position: 0,
        status: "ok",
      },
    },
  ]);

  const service = new PaseoService(store, home);
  const beforeHide = await service.handle("list", { scope_key: hScope });
  expect(beforeHide.ok).toBe(true);
  expect(beforeHide.items.map((r: any) => r.timeline_index)).toEqual([0, 1]);
  expect(beforeHide.items.map((r: any) => r.tool_call_id)).toEqual(["", "call_cur"]);
  expect(beforeHide.totals).toEqual({
    total_rows: 2,
    manageable_count: 2,
    hidden_count: 0,
    saved_bytes: 0,
  });
  expect((await service.handle("list", { scope_key: hScope, query: "pre-compaction" })).items).toEqual([]);
});

test("PaseoService.list excludes pre-compaction store items/targets from rows, totals, search, and before_index pagination", async () => {
  const home = homeWith([
    entry("old_u", "user", "old prompt before compaction", 1),
    JSON.stringify({
      type: "message",
      id: "old_call_msg",
      message: {
        role: "assistant",
        timestamp: 2,
        content: [{ type: "toolCall", id: "call_old", name: "read", arguments: { path: "old.txt" } }],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "old_res_msg",
      message: {
        role: "toolResult",
        timestamp: 3,
        toolCallId: "call_old",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "old secret output ".repeat(50) }],
      },
    }),
    entry("kept_u", "user", "kept chunk start prompt", 4),
    JSON.stringify({
      type: "message",
      id: "kept_call_msg",
      message: {
        role: "assistant",
        timestamp: 5,
        content: [{ type: "toolCall", id: "call_new", name: "read", arguments: { path: "new.txt" } }],
      },
    }),
    JSON.stringify({
      type: "message",
      id: "kept_res_msg",
      message: {
        role: "toolResult",
        timestamp: 6,
        toolCallId: "call_new",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "new chunk output ".repeat(40) }],
      },
    }),
    JSON.stringify({ type: "compaction", id: "cmp_1", firstKeptEntryId: "kept_u" }),
  ]);

  const store = new Store(new BunDriver(join(home, "state.sqlite3")));
  cleanup.push(() => store.close());
  store.register(scope, {
    adapter_id: "omp",
    adapter_protocol: 1,
    capabilities: { hide: true, summarize: true, unhide: true },
    enabled: true,
    instance_id: "test",
  });
  const oldInv = { tool_name: "read", arguments: { path: "old.txt" } };
  const oldDigest = invocationDigest(oldInv);
  const oldOriginal = "old secret output ".repeat(50);
  const oldItem: Item = {
    item_id: itemId(scope, "call_old", sha256(oldOriginal), oldDigest, 0),
    tool_call_id: "call_old",
    result_position: 0,
    content_sha256: sha256(oldOriginal),
    invocation_digest: oldDigest,
    original: oldOriginal,
    compacted: "[hidden: read call_old]",
    excerpt_lines: [],
    visibility: "hidden",
    version: 2,
    tool_name: "read",
    compaction_source: "explicit_user_hide",
    invocation_snapshot: null,
    context_hint: null,
    invocation_options_omitted: false,
    created_at: 0,
    updated_at: 0,
  };
  expect(store.put(scope, oldItem).ok).toBe(true);

  const service = new PaseoService(store, home);
  const full = await service.handle("list", { scope_key: scope });
  expect(full.ok).toBe(true);
  expect(full.items.map((r: any) => r.timeline_index)).toEqual([0, 1]);
  expect(full.items.map((r: any) => r.tool_call_id)).toEqual(["", "call_new"]);
  expect(full.totals).toEqual({
    total_rows: 2,
    manageable_count: 2,
    hidden_count: 0,
    saved_bytes: 0,
  });

  // Search must not surface pre-compaction prompt or hidden item
  const oldSearch = await service.handle("list", { scope_key: scope, query: "old" });
  expect(oldSearch.items).toEqual([]);

  // Pagination stays chunk-local
  const page = await service.handle("list", { scope_key: scope, limit: 1, before_index: 1 });
  expect(page.items.map((r: any) => r.timeline_index)).toEqual([0]);
  expect(page.has_older).toBe(false);
  expect(page.next_before_index).toBeNull();
});
