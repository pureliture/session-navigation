import { summaryDedupeKey } from "../shared/sessionNav.ts";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
import { fileChangeToken, hasHermesSession } from "./hermesHistory.ts";
import { loadTimeline } from "./history.ts";
import { HistoryTooLargeError, MAX_HISTORY_ROWS } from "./historyLimits.ts";
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

  // Items stored under the child rotation session must still apply when the
  // list request uses the parent session's scope.
  const childScope = "hermes:default:h-new:unknown";
  store.register(childScope, {
    adapter_id: "hermes",
    adapter_protocol: 1,
    capabilities: { hide: true, summarize: true, unhide: true },
    enabled: true,
    instance_id: "test",
  });
  const curInv = { tool_name: "read_file", arguments: { path: "cur.txt" } };
  store.publishTargets(childScope, [
    {
      record: {
        call_id: "call_cur",
        content: curContent,
        content_sha256: sha256(curContent),
        invocation: curInv,
        invocation_digest: invocationDigest(curInv),
        result_position: 0,
        status: "ok",
      },
    },
  ]);
  expect((await service.handle("hide", { scope_key: childScope, item_id: "call_cur" })).ok).toBe(
    true,
  );
  const afterChildHide = await service.handle("list", { scope_key: hScope });
  expect(
    afterChildHide.items.find((row: any) => row.tool_call_id === "call_cur")?.status,
  ).toBe("hidden");
  expect(afterChildHide.totals.hidden_count).toBe(1);
  expect(afterChildHide.totals.saved_bytes).toBeGreaterThan(0);
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

test("Hermes msg: unit IDs count pre-summary slots so pN matches the full active payload", () => {
  const home = tempHome();
  const db = hermesDb(home);
  db.prepare("INSERT INTO sessions (id, model_config) VALUES (?, ?)").run("p0-sess", "{}");
  const insMsg = db.prepare(
    "INSERT INTO messages (session_id, role, content, _compressed_summary) VALUES (?, ?, ?, ?)",
  );
  const preUser = "pre-summary question";
  const preAssistant = "pre-summary answer";
  insMsg.run("p0-sess", "user", preUser, 0);
  insMsg.run("p0-sess", "assistant", preAssistant, 0);
  const summaryText = "[CONTEXT COMPACTION] compacted context";
  insMsg.run("p0-sess", "user", summaryText, 1);
  const latestText = "latest question after summary";
  insMsg.run("p0-sess", "user", latestText, 0);

  const tl = loadTimeline(home, "hermes:default:p0-sess:unknown");
  expect(tl.rows.map((r) => r.summary_line)).toEqual([summaryText, latestText]);
  // The pre-summary user (p0) and assistant (p1) keep their payload slots, so
  // the latest chunk resumes at p2 instead of colliding with pre-summary p0.
  expect(tl.rows[0].item_id).toBe(`msg:user:p2:${sha256(summaryText).slice(0, 12)}`);
  expect(tl.rows[1].item_id).toBe(`msg:user:p3:${sha256(latestText).slice(0, 12)}`);
});

test("Hermes multi-compaction chunk starts at the latest summary, not the first", () => {
  const home = tempHome();
  const db = hermesDb(home);
  db.prepare("INSERT INTO sessions (id, model_config) VALUES (?, ?)").run("multi-sess", "{}");
  const insMsg = db.prepare(
    "INSERT INTO messages (session_id, role, content, _compressed_summary) VALUES (?, ?, ?, ?)",
  );
  insMsg.run("multi-sess", "user", "first chunk prompt", 0);
  insMsg.run("multi-sess", "user", "[CONTEXT COMPACTION] first summary", 1);
  insMsg.run("multi-sess", "user", "second chunk prompt", 0);
  insMsg.run("multi-sess", "user", "[CONTEXT COMPACTION] second summary", 1);
  insMsg.run("multi-sess", "assistant", "latest reply", 0);

  const tl = loadTimeline(home, "hermes:default:multi-sess:unknown");
  expect(tl.rows.map((r) => r.summary_line)).toEqual([
    "[CONTEXT COMPACTION] second summary",
    "latest reply",
  ]);
});

test("Hermes duplicate compaction summaries collapse across kinds with metadata preserved", () => {
  const home = tempHome();
  const db = hermesDb(home);
  db.prepare("INSERT INTO sessions (id, model_config) VALUES (?, ?)").run("dup-sum-sess", "{}");
  const insMsg = db.prepare(
    "INSERT INTO messages (session_id, role, content, compacted, _compressed_summary) VALUES (?, ?, ?, ?, ?)",
  );
  const summaryText = "[CONTEXT COMPACTION] carried summary";
  insMsg.run("dup-sum-sess", "user", "old prompt", 0, 0);
  // Flagged summary stored compacted (hist_ ID, unmanageable) ...
  insMsg.run("dup-sum-sess", "user", summaryText, 1, 1);
  // ... and carried a second time as a plain assistant message.
  insMsg.run("dup-sum-sess", "assistant", summaryText, 0, 0);

  const tl = loadTimeline(home, "hermes:default:dup-sum-sess:unknown");
  const summaryRows = tl.rows.filter((r) => r.summary_line === summaryText);
  expect(summaryRows).toHaveLength(1);
  // Metadata preserved: the manageable msg: ID wins over the hist_ fallback.
  expect(summaryRows[0].manageable).toBe(true);
  expect(summaryRows[0].item_id).toStartWith("msg:assistant:");
});

test("Hermes distinct long messages sharing a prefix never dedupe", () => {
  const home = tempHome();
  const db = hermesDb(home);
  db.prepare("INSERT INTO sessions (id, model_config) VALUES (?, ?)").run("prefix-sess", "{}");
  const insMsg = db.prepare(
    "INSERT INTO messages (session_id, role, content, _compressed_summary) VALUES (?, ?, ?, ?)",
  );
  const sharedPrefix = "x".repeat(130);
  insMsg.run("prefix-sess", "user", `${sharedPrefix} alpha tail`, 0);
  insMsg.run("prefix-sess", "user", `${sharedPrefix} beta tail`, 0);

  const tl = loadTimeline(home, "hermes:default:prefix-sess:unknown");
  expect(tl.rows).toHaveLength(2);
  expect(new Set(tl.rows.map((r) => r.item_id)).size).toBe(2);
});

test("summaryDedupeKey ignores kind and matches full text, not prefixes", () => {
  const a = "x".repeat(200) + " one";
  const b = "x".repeat(200) + " two";
  expect(summaryDedupeKey(a)).toBe(summaryDedupeKey(a));
  expect(summaryDedupeKey(a)).not.toBe(summaryDedupeKey(b));
});

test("Hermes oversized chunk fails fast with history_too_large via pre-count guard", () => {
  const home = tempHome();
  const db = hermesDb(home);
  db.prepare("INSERT INTO sessions (id, model_config) VALUES (?, ?)").run("big-sess", "{}");
  db.exec("BEGIN");
  try {
    const insMsg = db.prepare("INSERT INTO messages (session_id, role, content, active) VALUES (?, ?, ?, ?)");
    for (let i = 0; i < MAX_HISTORY_ROWS + 1; i++) insMsg.run("big-sess", "user", "x", 1);
  } finally {
    db.exec("COMMIT");
  }
  let code: string | undefined;
  try {
    loadTimeline(home, "hermes:default:big-sess:unknown");
  } catch (err) {
    code = err instanceof HistoryTooLargeError ? err.code : `unexpected:${String(err)}`;
  }
  expect(code).toBe("history_too_large");
});

test("empty valid Hermes chunk is authoritative and never resurrects stale targets", async () => {
  const home = tempHome();
  const db = hermesDb(home);
  db.prepare("INSERT INTO sessions (id, model_config) VALUES (?, ?)").run("empty-sess", "{}");
  // Only an inactive row: the latest chunk is valid but empty.
  db.prepare("INSERT INTO messages (session_id, role, content, active) VALUES (?, ?, ?, ?)").run(
    "empty-sess",
    "user",
    "inactive old prompt",
    0,
  );

  const hScope = "hermes:default:empty-sess:unknown";
  const direct = loadTimeline(home, hScope);
  expect(direct.rows).toEqual([]);
  expect(direct.history.chunkAuthoritative).toBe(true);

  const store = new Store(new BunDriver(join(home, "state.sqlite3")));
  cleanup.push(() => store.close());
  store.register(hScope, {
    adapter_id: "hermes",
    adapter_protocol: 1,
    capabilities: { hide: true, summarize: true, unhide: true },
    enabled: true,
    instance_id: "test",
  });
  const staleContent = "stale pre-chunk output ".repeat(40);
  const staleInv = { tool_name: "read_file", arguments: { path: "stale.txt" } };
  store.publishTargets(hScope, [
    {
      record: {
        call_id: "call_stale",
        content: staleContent,
        content_sha256: sha256(staleContent),
        invocation: staleInv,
        invocation_digest: invocationDigest(staleInv),
        result_position: 0,
        status: "ok",
      },
    },
  ]);

  const service = new PaseoService(store, home);
  const listed = await service.handle("list", { scope_key: hScope });
  expect(listed.ok).toBe(true);
  expect(listed.items).toEqual([]);
  expect(listed.totals).toEqual({
    total_rows: 0,
    manageable_count: 0,
    hidden_count: 0,
    saved_bytes: 0,
  });
});

test("Hermes fork children without compaction summaries never hijack the parent outline", () => {
  const home = tempHome();
  const db = hermesDb(home);
  const insSess = db.prepare(
    "INSERT INTO sessions (id, model_config, parent_session_id, started_at) VALUES (?, ?, ?, ?)",
  );
  const insMsg = db.prepare(
    "INSERT INTO messages (session_id, role, content, _compressed_summary) VALUES (?, ?, ?, ?)",
  );
  // Rotation child carries a summary; a newer ACP fork/subagent child does not.
  insSess.run("fork-parent", "{}", null, 100);
  insSess.run("rotation-old", "{}", "fork-parent", 150);
  insSess.run("fork-new", "{}", "fork-parent", 200);
  insMsg.run("fork-parent", "user", "parent prompt", 0);
  insMsg.run("rotation-old", "user", "[CONTEXT COMPACTION] rotation summary", 1);
  insMsg.run("rotation-old", "assistant", "rotation reply", 0);
  insMsg.run("fork-new", "user", "fork subagent prompt", 0);
  insMsg.run("fork-new", "assistant", "fork subagent reply", 0);

  const tl = loadTimeline(home, "hermes:default:fork-parent:unknown");
  expect(tl.rows.map((r) => r.summary_line)).toEqual([
    "[CONTEXT COMPACTION] rotation summary",
    "rotation reply",
  ]);
  expect(tl.history.effectiveScope).toBe("hermes:default:rotation-old:unknown");
});

test("Hermes fork with no summary child and empty child shell both stay on the parent", () => {
  const home = tempHome();
  const db = hermesDb(home);
  const insSess = db.prepare(
    "INSERT INTO sessions (id, model_config, parent_session_id, started_at) VALUES (?, ?, ?, ?)",
  );
  const insMsg = db.prepare(
    "INSERT INTO messages (session_id, role, content, _compressed_summary) VALUES (?, ?, ?, ?)",
  );
  // Two live fork children, neither a rotation: the parent keeps its outline.
  insSess.run("ambiguous", "{}", null, 100);
  insSess.run("fork-a", "{}", "ambiguous", 150);
  insSess.run("fork-b", "{}", "ambiguous", 200);
  insMsg.run("ambiguous", "user", "parent prompt", 0);
  insMsg.run("fork-a", "user", "fork a prompt", 0);
  insMsg.run("fork-b", "user", "fork b prompt", 0);
  const ambiguous = loadTimeline(home, "hermes:default:ambiguous:unknown");
  expect(ambiguous.rows.map((r) => r.summary_line)).toEqual(["parent prompt"]);
  expect(ambiguous.history.effectiveScope ?? "hermes:default:ambiguous:unknown").toBe(
    "hermes:default:ambiguous:unknown",
  );

  // A single empty child shell never hijacks a parent that owns content.
  insSess.run("shell-parent", "{}", null, 100);
  insSess.run("empty-shell", "{}", "shell-parent", 200);
  insMsg.run("shell-parent", "user", "shell parent prompt", 0);
  const shelled = loadTimeline(home, "hermes:default:shell-parent:unknown");
  expect(shelled.rows.map((r) => r.summary_line)).toEqual(["shell parent prompt"]);
});

test("Hermes rotation child with null/empty model_config does not inherit the parent usage anchor", () => {
  for (const childConfig of [null, ""]) {
    const home = tempHome();
    const db = hermesDb(home);
    const insSess = db.prepare(
      "INSERT INTO sessions (id, model_config, parent_session_id, started_at) VALUES (?, ?, ?, ?)",
    );
    insSess.run(
      "anchor-parent",
      JSON.stringify({ _usage_anchor: { prompt_tokens: 9000, completion_tokens: 100 } }),
      null,
      100,
    );
    if (childConfig === null) {
      db.prepare("INSERT INTO sessions (id, model_config, parent_session_id, started_at) VALUES (?, NULL, ?, ?)").run(
        "anchor-child",
        "anchor-parent",
        200,
      );
    } else {
      insSess.run("anchor-child", "", "anchor-parent", 200);
    }
    db.prepare(
      "INSERT INTO messages (session_id, role, content, _compressed_summary) VALUES (?, ?, ?, ?)",
    ).run("anchor-child", "user", "post-rotation prompt", 0);
    const tl = loadTimeline(home, "hermes:default:anchor-parent:unknown");
    expect(tl.history.effectiveScope).toBe("hermes:default:anchor-child:unknown");
    expect(tl.history.externalContext).toBeUndefined();
  }
  // A child with its own anchor still reports its own gauge.
  const home = tempHome();
  const db = hermesDb(home);
  db.prepare(
    "INSERT INTO sessions (id, model_config, parent_session_id, started_at) VALUES (?, ?, ?, ?)",
  ).run(
    "anchor-parent",
    JSON.stringify({ _usage_anchor: { prompt_tokens: 9000, completion_tokens: 100 } }),
    null,
    100,
  );
  db.prepare(
    "INSERT INTO sessions (id, model_config, parent_session_id, started_at) VALUES (?, ?, ?, ?)",
  ).run(
    "anchor-child",
    JSON.stringify({ _usage_anchor: { prompt_tokens: 120, completion_tokens: 30 } }),
    "anchor-parent",
    200,
  );
  db.prepare(
    "INSERT INTO messages (session_id, role, content, _compressed_summary) VALUES (?, ?, ?, ?)",
  ).run("anchor-child", "user", "post-rotation prompt", 0);
  const tl = loadTimeline(home, "hermes:default:anchor-parent:unknown");
  expect(tl.history.externalContext?.used_tokens).toBe(150);
});

test("OMP later compaction with missing firstKeptEntryId keeps the last valid boundary", () => {
  const home = homeWith([
    entry("pre", "user", "pre-compaction question", 1),
    entry("a", "user", "kept question", 2),
    entry("b", "assistant", "kept answer", 3),
    JSON.stringify({ type: "compaction", id: "cmp1", firstKeptEntryId: "a" }),
    entry("c", "user", "third question", 4),
    JSON.stringify({ type: "compaction", id: "cmp2", firstKeptEntryId: "missing" }),
    JSON.stringify({ type: "compaction", id: "cmp3" }),
    entry("d", "assistant", "fourth answer", 5),
  ]);
  const timeline = loadTimeline(home, scope);
  const texts = timeline.rows.map((row: any) => row.message_text);
  expect(texts.some((text: string) => text.includes("pre-compaction question"))).toBe(false);
  expect(texts.some((text: string) => text.includes("kept question"))).toBe(true);
  expect(texts.some((text: string) => text.includes("fourth answer"))).toBe(true);
});

test("OMP empty latest chunk stays authoritative without resurrecting rows", async () => {
  const home = homeWith([
    entry("a", "user", "old question", 1),
    entry("b", "assistant", "old answer", 2),
    // Self-referencing boundary at the end: nothing is kept.
    JSON.stringify({ type: "compaction", id: "cmp", firstKeptEntryId: "cmp" }),
  ]);
  const direct = loadTimeline(home, scope);
  expect(direct.rows).toEqual([]);
  expect(direct.history.chunkAuthoritative).toBe(true);

  const store = new Store(new BunDriver(join(home, "state.sqlite3")));
  cleanup.push(() => store.close());
  store.register(scope, {
    adapter_id: "omp",
    adapter_protocol: 1,
    capabilities: { hide: true, summarize: true, unhide: true },
    enabled: true,
    instance_id: "test",
  });
  const service = new PaseoService(store, home);
  const listed = await service.handle("list", { scope_key: scope });
  expect(listed.ok).toBe(true);
  expect(listed.items).toEqual([]);
  expect(listed.server_timeline).toBe(false);
});

test("Hermes rotation list hits the cache on repeat and propagates history_too_large", async () => {
  const home = tempHome();
  const db = hermesDb(home);
  db.prepare(
    "INSERT INTO sessions (id, model_config, parent_session_id, started_at) VALUES (?, ?, ?, ?)",
  ).run("cache-parent", "{}", null, 100);
  db.prepare(
    "INSERT INTO sessions (id, model_config, parent_session_id, started_at) VALUES (?, ?, ?, ?)",
  ).run("cache-child", "{}", "cache-parent", 200);
  db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(
    "cache-child",
    "user",
    "cached prompt",
  );
  const hScope = "hermes:default:cache-parent:unknown";
  const store = new Store(new BunDriver(join(home, "state.sqlite3")));
  cleanup.push(() => store.close());
  store.register(hScope, {
    adapter_id: "hermes",
    adapter_protocol: 1,
    capabilities: { hide: true, summarize: true, unhide: true },
    enabled: true,
    instance_id: "test",
  });
  const service = new PaseoService(store, home);
  const first = await service.handle("list", { scope_key: hScope });
  const second = await service.handle("list", { scope_key: hScope });
  expect(first.ok).toBe(true);
  expect(second).toEqual(first);

  // Oversized rotated chunk surfaces a bounded error instead of throwing.
  const big = tempHome();
  const bigDb = hermesDb(big);
  bigDb.prepare(
    "INSERT INTO sessions (id, model_config, parent_session_id, started_at) VALUES (?, ?, ?, ?)",
  ).run("big-parent", "{}", null, 100);
  bigDb.prepare(
    "INSERT INTO sessions (id, model_config, parent_session_id, started_at) VALUES (?, ?, ?, ?)",
  ).run("big-child", "{}", "big-parent", 200);
  const insBig = bigDb.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)");
  bigDb.exec("BEGIN");
  for (let i = 0; i <= MAX_HISTORY_ROWS; i++) insBig.run("big-child", "user", `filler prompt ${i}`);
  bigDb.exec("COMMIT");
  const bigStore = new Store(new BunDriver(join(big, "state.sqlite3")));
  cleanup.push(() => bigStore.close());
  const bigScope = "hermes:default:big-parent:unknown";
  bigStore.register(bigScope, {
    adapter_id: "hermes",
    adapter_protocol: 1,
    capabilities: { hide: true, summarize: true, unhide: true },
    enabled: true,
    instance_id: "test",
  });
  const bigService = new PaseoService(bigStore, big);
  const oversized = await bigService.handle("list", { scope_key: bigScope });
  expect(oversized.ok).toBe(false);
  expect(oversized.error).toBe("history_too_large");
});

test("Hermes WAL growth invalidates the cache and middle-byte rewrites change the token", () => {
  const home = tempHome("paseo-hermes-wal-");
  const dir = join(home, ".hermes");
  mkdirSync(dir, { recursive: true });
  const writer = new DatabaseSync(join(dir, "state.db"));
  cleanup.push(() => {
    try {
      writer.close();
    } catch {
      // Already closed.
    }
  });
  writer.exec("PRAGMA journal_mode=WAL");
  writer.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, model_config TEXT, parent_session_id TEXT, started_at REAL);
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
  `);
  writer.prepare("INSERT INTO sessions (id, model_config) VALUES (?, ?)").run("wal-sess", "{}");
  writer.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(
    "wal-sess",
    "user",
    `wal-only prompt ${"x".repeat(4000)}`,
  );
  const hScope = "hermes:default:wal-sess:unknown";
  const before = loadTimeline(home, hScope);
  expect(before?.rows).toHaveLength(1);

  // WAL growth from a second write invalidates the cache end to end.
  writer.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(
    "wal-sess",
    "assistant",
    "second wal reply",
  );
  const grown = loadTimeline(home, hScope);
  expect(grown?.rows).toHaveLength(2);

  // A same-size middle-byte rewrite (what a non-truncating RESTART
  // checkpoint can leave behind) changes the token even when size and
  // mtime are pinned back: only WAL content sensitivity distinguishes
  // the states, so the stale snapshot is never reused.
  const walPath = join(dir, "state.db-wal");
  const wal = readFileSync(walPath);
  expect(wal.length).toBeGreaterThan(512);
  const tokenBefore = fileChangeToken(walPath, false);
  expect(tokenBefore).toMatch(/:walhash:[0-9a-f]{64}/);
  const overlay = Buffer.from(wal);
  overlay.fill(0x61, 200, 400);
  // Keep first-32B header and last-24B tail identical: a header+tail
  // sample cannot see this rewrite.
  overlay.subarray(0, 32).set(wal.subarray(0, 32));
  overlay.subarray(overlay.length - 24).set(wal.subarray(wal.length - 24));
  writeFileSync(walPath, overlay);
  const pinned = new Date(946684800000);
  utimesSync(walPath, pinned, pinned);
  expect(statSync(walPath).size).toBe(wal.length);
  const tokenAfter = fileChangeToken(walPath, false);
  expect(tokenAfter).not.toBe(tokenBefore);
});

test("OMP custom reminder lines account injected length without crashing", () => {
  const home = homeWith([
    entry("a", "user", "first", 1),
    JSON.stringify({ type: "custom", id: "rem-1", data: { reminder: "0123456789abc" } }),
    entry("b", "assistant", "second", 2),
  ]);
  const timeline = loadTimeline(home, scope);
  expect(timeline.history.injected).toEqual([[1, 13]]);
  expect(timeline.history.messages).toHaveLength(2);
});
