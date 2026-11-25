import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../packages/core/src/index.ts";
import { NodeDriver } from "../../packages/core/src/drivers/node.ts";
import { PaseoService } from "./service.ts";
import {
  clearServerPerf,
  recentServerPerf,
  recordServerPerf,
} from "./diagnostics.ts";

function setupFixture(prefix = "paseo-perf-"): {
  home: string;
  store: Store;
  service: PaseoService;
  cleanup: () => void;
} {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const store = new Store(new NodeDriver(join(home, "state.sqlite3")));
  const service = new PaseoService(store, home);
  return {
    home,
    store,
    service,
    cleanup() {
      store.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("OMP lazy paged list hydrates only requested slice, preserves group boundaries and search, and mutates single records", async () => {
  const fx = setupFixture("paseo-omp-lazy-");
  try {
    const scope = "omp:default:lazy-session:default";
    const sessDir = join(fx.home, ".omp", "agent", "sessions", "proj");
    mkdirSync(sessDir, { recursive: true });
    const lines: string[] = [];
    // Build 180 turns: 1 user + consecutive read tools + assistant text, with unique search needles.
    let ts = 1000;
    for (let i = 0; i < 120; i++) {
      lines.push(
        JSON.stringify({
          type: "message",
          id: `u_${i}`,
          message: { role: "user", timestamp: ++ts, content: `User prompt ${i}` },
        }),
      );
      lines.push(
        JSON.stringify({
          type: "message",
          id: `a_${i}`,
          message: {
            role: "assistant",
            timestamp: ++ts,
            content: [
              { type: "toolCall", id: `call_${i}_1`, name: "read", arguments: { path: `/tmp/file_${i}_one.txt` } },
              { type: "toolCall", id: `call_${i}_2`, name: "read", arguments: { path: `/tmp/file_${i}_two.txt` } },
            ],
          },
        }),
      );
      lines.push(
        JSON.stringify({
          type: "message",
          id: `t_${i}_1`,
          message: {
            role: "toolResult",
            toolCallId: `call_${i}_1`,
            toolName: "read",
            isError: false,
            content: [{ type: "text", text: `output ${i}-1 ` + "A".repeat(300) }],
          },
        }),
      );
      lines.push(
        JSON.stringify({
          type: "message",
          id: `t_${i}_2`,
          message: {
            role: "toolResult",
            toolCallId: `call_${i}_2`,
            toolName: "read",
            isError: false,
            content: [{ type: "text", text: `output ${i}-2 ` + "B".repeat(300) }],
          },
        }),
      );
    }
    writeFileSync(join(sessDir, "2026_lazy-session.jsonl"), lines.join("\n"));
    fx.store.register(scope, {
      adapter_id: "omp",
      adapter_protocol: 1,
      capabilities: { hide: true, summarize: true, unhide: true },
      enabled: true,
      instance_id: "test",
    });

    clearServerPerf();
    // 120 * 3 rows = 360 total rows; request limit 3 starting mid tool-group so boundary expands cleanly.
    const paged = await fx.service.handle("list", {
      scope_key: scope,
      limit: 1,
      before_index: 3, // lands on tool 2 (index 2 of [u0, t0_1, t0_2]), must pull in t0_1 as well!
    });
    expect(paged.ok).toBe(true);
    expect(paged.totals.total_rows).toBe(360);
    expect(paged.items.map((r: any) => r.timeline_index)).toEqual([1, 2]);
    expect(paged.has_older).toBe(true);
    expect(paged.next_before_index).toBe(1);
    expect(typeof paged.items[0].tool_input).toBe("string");
    expect(typeof paged.items[0].tool_output).toBe("string");

    const diag = recentServerPerf(10).find((e) => e.op === "list");
    expect(diag?.row_count).toBe(360);
    expect(diag?.hydrated_count).toBe(2);

    // Query search must still find arguments (tool_input) across lazy-indexed rows!
    const searched = await fx.service.handle("list", {
      scope_key: scope,
      query: "/tmp/file_5_two.txt",
    });
    expect(searched.ok).toBe(true);
    expect(searched.items.length).toBe(1);
    expect(searched.items[0].tool_call_id).toBe("call_5_2");

    // Hide + unhide single record via lazy lookup
    const targetId = searched.items[0].item_id;
    const hidden = await fx.service.handle("hide", { scope_key: scope, item_id: targetId });
    expect(hidden.ok).toBe(true);
    expect(hidden.visibility).toBe("hidden");

    const listedAfterHide = await fx.service.handle("list", {
      scope_key: scope,
      limit: 5,
    });
    expect(listedAfterHide.totals.hidden_count).toBe(1);
    expect(listedAfterHide.totals.saved_bytes).toBeGreaterThan(0);

    const restored = await fx.service.handle("unhide", {
      scope_key: scope,
      item_id: targetId,
      expected_version: hidden.version,
    });
    expect(restored.ok).toBe(true);
    expect(restored.visibility).toBe("visible");
  } finally {
    fx.cleanup();
  }
});

test("Hermes keyset index survives hide/unhide overlay updates and supports paged/search/mutate", async () => {
  const fx = setupFixture("paseo-hermes-lazy-");
  try {
    const sessionId = "h-session-1";
    const scope = `hermes:default:${sessionId}:unknown`;
    const hermesDir = join(fx.home, ".hermes");
    mkdirSync(hermesDir, { recursive: true });
    const dbPath = join(hermesDir, "state.db");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, started_at INTEGER, model_config TEXT);
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
          compacted INTEGER DEFAULT 0,
          _compressed_summary INTEGER DEFAULT 0,
          active INTEGER DEFAULT 1
        );
      `);
      db.prepare("INSERT INTO sessions (id, started_at, model_config) VALUES (?, ?, ?)").run(
        sessionId,
        100,
        JSON.stringify({ _usage_anchor: { prompt_tokens: 1500, completion_tokens: 200 } }),
      );
      const insertMsg = db.prepare(
        `INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, _compressed_summary, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      );
      // Pre-summary rows to verify pre-chunk slot counting
      insertMsg.run(sessionId, "user", "Pre-compaction prompt", null, null, null, 0);
      insertMsg.run(sessionId, "assistant", "Pre-compaction reply", null, null, null, 0);
      // Flagged compaction summary row
      insertMsg.run(sessionId, "assistant", "Compacted summary row", null, null, null, 1);
      // 310 pairs (>256 keyset batch size) of user/assistant+tool
      for (let i = 0; i < 160; i++) {
        insertMsg.run(sessionId, "user", `Turn user ${i}`, null, null, null, 0);
        const callId = `hc_${i}`;
        insertMsg.run(
          sessionId,
          "assistant",
          null,
          null,
          JSON.stringify([
            {
              id: callId,
              function: { name: "read_file", arguments: JSON.stringify({ path: `/repo/h_${i}.py` }) },
            },
          ]),
          null,
          0,
        );
        insertMsg.run(
          sessionId,
          "tool",
          `result body ${i} ` + "Z".repeat(400),
          callId,
          null,
          "read_file",
          0,
        );
      }

      fx.store.register(scope, {
        adapter_id: "hermes",
        adapter_protocol: 1,
        capabilities: { hide: true, summarize: true, unhide: true },
        enabled: true,
        instance_id: "test",
      });

      const page = await fx.service.handle("list", {
        scope_key: scope,
        limit: 20,
      });
      expect(page.ok).toBe(true);
      // 1 summary + 160 user + 160 tool = 321 rows
      expect(page.totals.total_rows).toBe(321);
      expect(page.items.length).toBe(20);
      expect(page.context?.used_tokens).toBe(1700);
      expect(page.has_older).toBe(true);

      // Search matches tool_input from batch without loading full content
      const search = await fx.service.handle("list", {
        scope_key: scope,
        query: "/repo/h_12.py",
      });
      expect(search.ok).toBe(true);
      expect(search.items.length).toBe(1);
      expect(search.items[0].tool_call_id).toBe("hc_12");

      // Hide item + hide message and verify totals & overlay survive cache hits
      const hiddenTool = await fx.service.handle("manage", {
        scope_key: scope,
        action: "hide",
        tool_call_ids: ["hc_12"],
      });
      expect(hiddenTool.ok).toBe(true);

      const hiddenMsg = await fx.service.handle("hide", {
        scope_key: scope,
        item_id: page.items[0].item_id,
      });
      expect(hiddenMsg.ok).toBe(true);

      const afterMutate = await fx.service.handle("list", {
        scope_key: scope,
        limit: 25,
      });
      expect(afterMutate.ok).toBe(true);
      expect(afterMutate.totals.hidden_count).toBe(2);
      expect(afterMutate.totals.saved_bytes).toBeGreaterThan(0);
      const reloadedHiddenMsg = afterMutate.items.find(
        (r: any) => r.item_id === page.items[0].item_id,
      );
      expect(reloadedHiddenMsg?.visibility).toBe("hidden");
    } finally {
      db.close();
    }
  } finally {
    fx.cleanup();
  }
});

test("scopes computes batch counts cleanly across 100 registered scopes", async () => {
  const fx = setupFixture("paseo-100-scopes-");
  try {
    for (let i = 0; i < 100; i++) {
      const scope = `omp:default:s_${String(i).padStart(3, "0")}:default`;
      fx.store.register(scope, {
        adapter_id: "omp",
        adapter_protocol: 1,
        capabilities: { hide: true, summarize: true, unhide: true },
        enabled: true,
        instance_id: "test",
      });
      if (i % 2 === 0) {
        fx.store.upsertUnits(scope, [
          {
            unit_id: `msg:user:${1000 + i}:abc`,
            kind: "user",
            tool_call_id: null,
            content_sha256: "abc",
            char_count: 100,
            visibility: i % 4 === 0 ? "hidden" : "visible",
          },
        ]);
      }
    }
    const res = await fx.service.handle("scopes", {});
    expect(res.ok).toBe(true);
    expect(res.scopes.length).toBe(100);
    const s0 = res.scopes.find((s: any) => s.scope_key === "omp:default:s_000:default");
    const s2 = res.scopes.find((s: any) => s.scope_key === "omp:default:s_002:default");
    expect(s0.capabilities.unhide).toBe(true);
    expect(s2.capabilities.unhide).toBe(false);
  } finally {
    fx.cleanup();
  }
});

test("server diagnostics enforce strict allowlist and never write to stdout", () => {
  clearServerPerf();
  const prevDiag = process.env.SESSION_NAVIGATION_PERF_DIAG;
  const origStdout = process.stdout.write;
  const origStderr = process.stderr.write;
  let stdoutSeen = "";
  let stderrSeen = "";
  process.stdout.write = ((chunk: any) => {
    stdoutSeen += String(chunk);
    return true;
  }) as any;
  process.stderr.write = ((chunk: any) => {
    stderrSeen += String(chunk);
    return true;
  }) as any;
  try {
    process.env.SESSION_NAVIGATION_PERF_DIAG = "verbose";
    const recorded = recordServerPerf({
      op: "list",
      duration_ms: 12.345,
      ok: false,
      error_code: "secret user message should not pass verbatim",
      adapter: "omp",
      row_count: 500,
      hydrated_count: 20,
      ...({
        query: "secret query text",
        message_text: "private user text",
        api_key: "sk-live-secret",
        compacted: "hidden text",
        path: "/Users/secret/file",
      } as any),
    });
    expect(recorded.error_code).toBe("error");
    expect((recorded as any).query).toBeUndefined();
    expect((recorded as any).message_text).toBeUndefined();
    expect((recorded as any).api_key).toBeUndefined();
    expect((recorded as any).compacted).toBeUndefined();
    expect((recorded as any).path).toBeUndefined();
    expect(stdoutSeen).toBe("");
    expect(stderrSeen).toContain("[session-nav:perf]");
    expect(stderrSeen).not.toContain("secret query text");
    expect(stderrSeen).not.toContain("sk-live-secret");
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
    if (prevDiag === undefined) delete process.env.SESSION_NAVIGATION_PERF_DIAG;
    else process.env.SESSION_NAVIGATION_PERF_DIAG = prevDiag;
    clearServerPerf();
  }
});
