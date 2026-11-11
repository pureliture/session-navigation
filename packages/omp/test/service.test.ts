import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../core/src/index.ts";
import { BunDriver } from "../../core/src/drivers/bun.ts";
import { OmpService, MAX_CHUNK_BYTES, sessionScope } from "../src/service.ts";

const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function service(path = ":memory:"): OmpService {
  const store = new Store(new BunDriver(path));
  stores.push(store);
  return new OmpService(store);
}

function record(
  callId = "call-1",
  content = Array.from(
    { length: 100 },
    (_, index) => `Output row ${String(index).padStart(3, "0")} details`,
  ).join("\n"),
) {
  return {
    call_id: callId,
    tool_name: "read",
    arguments: { path: "sample.txt" },
    status: "ok",
    content,
  };
}

const call = (adapter: OmpService, method: string, params: Record<string, unknown> = {}) =>
  adapter.handle(method, { session_id: "a", ...params });

test("query-excluded stored items are never relabeled unrecorded or unhidden", async () => {
  const adapter = service();
  await call(adapter, "prepare", { snapshot_id: "filtered", records: [record()] });
  const compacted = await call(adapter, "compact", { snapshot_id: "filtered", tool_call_id: "call-1" });
  expect(compacted.ok).toBe(true);
  expect((await call(adapter, "list_items", { snapshot_id: "filtered", query: "audit-01.jsonl" })).items).toEqual([]);
  const all = (await call(adapter, "list_items", { snapshot_id: "filtered" })).items as any[];
  expect(all).toHaveLength(1);
  expect(all[0].item_id).toBe(compacted.item_id);
  expect(all[0].visibility).toBe("hidden");
  expect((await call(adapter, "list_items", { snapshot_id: "filtered", query: compacted.item_id })).items).toHaveLength(1);
  expect((await call(adapter, "list_items", { session_id: "empty", query: "missing" })).items).toEqual([]);
});

test("explicit IDs, invalid requests, chunk append tokens and invalidation", async () => {
  const adapter = service();
  expect((await call(adapter, "manage")).error).toBe("tool_call_ids_required");
  expect((await call(adapter, "manage", { tool_call_ids: [] })).error).toBe("tool_call_ids_required");
  expect((await call(adapter, "manage", { tool_call_ids: "all" })).error).toBe(
    "invalid_tool_call_ids",
  );
  expect(
    (await call(adapter, "prepare", { snapshot_id: "one", append: true, records: [] })).error,
  ).toBe("unconfirmed_snapshot");
  expect((await call(adapter, "prepare", { snapshot_id: "one", records: [record()] })).ok).toBe(
    true,
  );
  expect(
    (await call(adapter, "compact", { snapshot_id: "wrong", tool_call_id: "call-1" })).error,
  ).toBe("unconfirmed_snapshot");
  expect(
    (await call(adapter, "prepare", { snapshot_id: "wrong", append: true, records: [] })).error,
  ).toBe("unconfirmed_snapshot");
  expect(adapter.snapshots.has("a")).toBe(true);
  expect(
    (await call(adapter, "prepare", { snapshot_id: "one", append: true, records: [record()] }))
      .error,
  ).toBe("invalid_record");
  expect(adapter.snapshots.has("a")).toBe(false);
  expect(await call(adapter, "prepare", { snapshot_id: "empty", records: [] })).toEqual({
    ok: true,
    patches: [],
    hidden_messages: [],
    pending_summaries: [],
  });
  expect(
    (
      await call(adapter, "prepare", {
        snapshot_id: "many",
        records: Array.from({ length: 65 }, (_, index) => record(String(index))),
      })
    ).error,
  ).toBe("invalid_snapshot");
  for (const invalid of [
    { ...record(), status: "error" },
    { ...record(), tool_name: "bash" },
    { ...record(), result_position: true },
  ]) {
    expect(
      (await call(adapter, "prepare", { snapshot_id: "invalid", records: [invalid] })).error,
    ).toBe("invalid_record");
  }
});

test("64-record and 4 MiB limits apply per chunk, not combined snapshot", async () => {
  const adapter = service();
  const content = "x".repeat(MAX_CHUNK_BYTES / 2 + 1);
  expect(
    (await call(adapter, "prepare", { snapshot_id: "one", records: [record("a", content)] })).ok,
  ).toBe(true);
  expect(
    (
      await call(adapter, "prepare", {
        snapshot_id: "one",
        append: true,
        records: [record("b", content)],
      })
    ).ok,
  ).toBe(true);
  expect(adapter.snapshots.get("a")!.records.size).toBe(2);
  expect(
    (
      await call(adapter, "prepare", {
        snapshot_id: "large",
        records: [record("a", content), record("b", content)],
      })
    ).error,
  ).toBe("snapshot_too_large");
  expect(adapter.snapshots.has("a")).toBe(false);
  expect(
    (
      await call(adapter, "prepare", {
        snapshot_id: "utf8",
        records: [record("a", "😀".repeat(MAX_CHUNK_BYTES / 4 + 1))],
      })
    ).error,
  ).toBe("snapshot_too_large");
});

test("32 snapshots use append-refreshed retention and replacement", async () => {
  const adapter = service();
  for (let index = 0; index < 32; index++)
    await call(adapter, "prepare", { session_id: String(index), snapshot_id: "one", records: [] });
  await call(adapter, "prepare", {
    session_id: "0",
    snapshot_id: "one",
    append: true,
    records: [record()],
  });
  expect(
    (await call(adapter, "prepare", { session_id: "new", snapshot_id: "two", records: [] }))
      .evicted_snapshots,
  ).toEqual(["1"]);
  expect(adapter.snapshots.size).toBe(32);
  await call(adapter, "prepare", { session_id: "0", snapshot_id: "replace", records: [] });
  expect(adapter.snapshots.get("0")!.records.size).toBe(0);
});

test("2000 records retain early/late hides and all snapshot targets", async () => {
  const adapter = service();
  const records = Array.from({ length: 2000 }, (_, index) => record(`call-${index + 1}`));
  await call(adapter, "prepare", { snapshot_id: "seed", records: [records[0], records[1499]] });
  for (const id of ["call-1", "call-1500"])
    expect((await call(adapter, "compact", { snapshot_id: "seed", tool_call_id: id })).ok).toBe(
      true,
    );
  const patches: unknown[] = [];
  for (let offset = 0; offset < records.length; offset += 64) {
    const response = await call(adapter, "prepare", {
      snapshot_id: "whole",
      append: offset > 0,
      records: records.slice(offset, offset + 64),
    });
    expect(response.ok).toBe(true);
    patches.push(...(response.patches as unknown[]));
  }
  expect(patches.map((patch: any) => patch.call_id)).toEqual(["call-1", "call-1500"]);
  expect((await call(adapter, "list_items", { snapshot_id: "whole" })).items).toHaveLength(2000);
  expect(
    (await call(adapter, "compact", { snapshot_id: "whole", tool_call_id: "call-2000" })).ok,
  ).toBe(true);
});

test("candidates are newest eligible first and display limits do not limit management", async () => {
  const adapter = service();
  const records = Array.from({ length: 80 }, (_, index) => record(`r${index}`));
  records.push(record("short", "tiny"), {
    ...record("danger"),
    tool_name: "bash",
    arguments: { command: "rm -rf path" },
  } as any);
  await call(adapter, "prepare", { snapshot_id: "one", records: records.slice(0, 64) });
  await call(adapter, "prepare", { snapshot_id: "one", append: true, records: records.slice(64) });
  const response = await call(adapter, "list_candidates", { snapshot_id: "one", limit: 2 });
  expect((response.items as any[]).map((item) => item.tool_call_id)).toEqual(["r79", "r78"]);
  expect((response.items as any[])[0]).toEqual({ tool_call_id: "r79", tool_name: "read", hint: "sample.txt",
    bytes_size: Buffer.byteLength(records[0].content), tokens_display: "—" });
  expect((await call(adapter, "list_candidates", { snapshot_id: "one" })).items).toHaveLength(30);
  expect(response.total).toBe(80);
  expect((await call(adapter, "list_candidates", { snapshot_id: "one", limit: 0 })).error).toBe(
    "invalid_limit",
  );
  const result = await call(adapter, "manage", {
    snapshot_id: "one",
    tool_call_ids: records.map((item) => item.call_id),
    action: "hide",
  });
  expect(result.applied).toBe(80);
  expect((result.items as any[]).slice(-2).map((item) => item.error)).toEqual([
    "not_long",
    "destructive_command",
  ]);
  expect((await call(adapter, "list_candidates", { snapshot_id: "one" })).items).toEqual([]);
  const skipped = await call(adapter, "manage", { snapshot_id: "one", tool_call_ids: ["r79", "short", "danger"], action: "summarize" });
  expect((skipped.items as any[]).map((item) => item.error)).toEqual(["summarizer_unavailable", "not_long", "destructive_command"]);
  expect(
    (
      await call(adapter, "manage", {
        snapshot_id: "one",
        tool_call_ids: ["missing"],
        action: "hide",
      })
    ).items,
  ).toEqual([{ tool_call_id: "missing", ok: false, error: "not_found" }]);
});

test("fences reject changed invocation and missing identities", async () => {
  const adapter = service();
  await call(adapter, "prepare", { snapshot_id: "one", records: [record()] });
  expect((await call(adapter, "compact", { snapshot_id: "one", tool_call_id: "call-1" })).ok).toBe(
    true,
  );
  expect(
    (
      await call(adapter, "prepare", {
        snapshot_id: "two",
        records: [{ ...record(), arguments: { path: "different.txt" } }],
      })
    ).patches,
  ).toEqual([]);
  expect(
    (await call(adapter, "compact", { snapshot_id: "two", tool_call_id: "call-1" })).error,
  ).toBe("invocation_conflict");
  adapter.store.driver.run("DELETE FROM identities");
  await call(adapter, "prepare", { snapshot_id: "three", records: [record()] });
  expect(
    (await call(adapter, "compact", { snapshot_id: "three", tool_call_id: "call-1" })).error,
  ).toBe("identity_expired");
});

test("restart, fork, scope isolation and restore CAS preserve originals", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-store-"));
  directories.push(directory);
  const path = join(directory, "state.sqlite3");
  const adapter = service(path);
  await call(adapter, "prepare", { snapshot_id: "one", records: [record()] });
  const hidden = await call(adapter, "compact", { snapshot_id: "one", tool_call_id: "call-1" });
  expect(
    (await call(adapter, "restore", { item_id: hidden.item_id, expected_version: 999 })).error,
  ).toBe("version_conflict");
  expect((await call(adapter, "restore", { session_id: "b", item_id: hidden.item_id })).ok).toBe(
    false,
  );
  expect(
    (await adapter.handle("fork_scope", { src_session_id: "a", dst_session_id: "b" })).ok,
  ).toBe(true);
  const reopened = service(path);
  expect(
    (await call(reopened, "prepare", { session_id: "b", snapshot_id: "fork", records: [record()] }))
      .patches,
  ).toHaveLength(1);
  expect(
    (await call(reopened, "restore", { item_id: hidden.item_id, expected_version: hidden.version }))
      .ok,
  ).toBe(true);
  expect(
    (await call(reopened, "prepare", { snapshot_id: "restored", records: [record()] })).patches,
  ).toEqual([]);
  expect(reopened.store.items(sessionScope("a"))[0].original).toBe(record().content);
});

test("pending summaries settle with fallback and version fences without append replay", async () => {
  for (const text of [undefined, "Invented 99999 facts.", "Output row 000 details"]) {
    const adapter = service();
    await call(adapter, "prepare", { snapshot_id: "one", records: [record()] });
    const hidden = await call(adapter, "compact", { snapshot_id: "one", tool_call_id: "call-1" });
    const item = adapter.store.get(sessionScope("a"), String(hidden.item_id))!;
    adapter.store.put(
      sessionScope("a"),
      { ...item, compaction_source: "summarize_pending", version: 2 },
      1,
    );
    const prepared = await call(adapter, "prepare", { snapshot_id: "two", records: [record()] });
    expect(prepared.pending_summaries).toHaveLength(1);
    expect(
      (
        await call(adapter, "prepare", {
          snapshot_id: "two",
          append: true,
          records: [record("next")],
        })
      ).pending_summaries,
    ).toEqual([]);
    expect(
      (
        await call(adapter, "apply_summary", {
          item_id: item.item_id,
          expected_version: 1,
          summary_text: text,
        })
      ).error,
    ).toBe("version_conflict");
    const settled = await call(adapter, text ? "apply_summary" : "summary_failed", {
      item_id: item.item_id,
      expected_version: 2,
      summary_text: text,
    });
    expect(settled.ok).toBe(text !== "Invented 99999 facts.");
    expect(adapter.store.get(sessionScope("a"), item.item_id)!.compaction_source).toBe(
      text === "Output row 000 details" ? "llm_summary" : "explicit_user_hide",
    );
    expect((await call(adapter, "summary_failed", { item_id: item.item_id })).error).toBe(
      "not_found",
    );
  }
});

test("registration occurs on valid processing; legacy state is copied once and preserved", async () => {
  const adapter = service();
  expect(adapter.store.registration(sessionScope("a"))).toBeUndefined();
  await call(adapter, "prepare", { snapshot_id: "one", records: [record()] });
  const hidden = await call(adapter, "compact", { snapshot_id: "one", tool_call_id: "call-1" });
  adapter.store.fork(sessionScope("a"), "pi:default:legacy:default");
  expect(
    (
      await call(adapter, "prepare", {
        session_id: "legacy",
        snapshot_id: "copy",
        records: [record()],
      })
    ).patches,
  ).toHaveLength(1);
  expect(adapter.store.items("pi:default:legacy:default")).toHaveLength(1);
  const imported = adapter.store.items(sessionScope("legacy"))[0];
  adapter.engine.unhide(sessionScope("legacy"), imported.item_id, imported.version);
  const restarted = new OmpService(adapter.store);
  expect(
    (
      await call(restarted, "prepare", {
        session_id: "legacy",
        snapshot_id: "again",
        records: [record()],
      })
    ).patches,
  ).toEqual([]);
  expect(adapter.store.items("pi:default:legacy:default")[0].visibility).toBe("hidden");
  expect(adapter.store.registration(sessionScope("a"))!.adapter_id).toBe("omp");
  expect(adapter.store.can(sessionScope("a"), "summarize")).toBe(true);
  expect(
    (await call(adapter, "summarize", { snapshot_id: "one", tool_call_id: "call-1" })).error,
  ).toBe("summarizer_unavailable");
  expect(hidden.ok).toBe(true);
});

test("duplicate complete snapshots invalidate tokens while hidden messages survive reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-messages-"));
  directories.push(directory);
  const path = join(directory, "state.sqlite3");
  const adapter = service(path);
  const scope = sessionScope("a");
  adapter.store.ensureMessages(scope, [{ unit_id: "msg:user:1", kind: "user", content_sha256: "sha", char_count: 4 }]);
  expect(adapter.store.setMessageVisibility(scope, "msg:user:1", "user", "sha", 4, "hidden", 1).ok).toBe(true);
  adapter.store.close();
  const reopened = service(path);
  const prepared = await call(reopened, "prepare", { snapshot_id: "one", records: [] });
  expect(prepared).toEqual({ ok: true, patches: [], hidden_messages: ["msg:user:1"], pending_summaries: [] });
  expect((await call(reopened, "prepare", { snapshot_id: "two", records: [record(), record()] })).error).toBe("invalid_record");
  expect((await call(reopened, "compact", { snapshot_id: "one", tool_call_id: "call-1" })).error).toBe("unconfirmed_snapshot");
  expect(reopened.store.hiddenMessages(scope)).toEqual(["msg:user:1"]);
  expect(reopened.store.hiddenMessages(sessionScope("b"))).toEqual([]);
});

test("SQLite pending jobs survive reopen and settle to model text or plain hide", async () => {
  for (const text of [undefined, "Invented 99999 facts.", record().content.repeat(2), "Output row 000 details"]) {
    const directory = mkdtempSync(join(tmpdir(), "omp-pending-"));
    directories.push(directory);
    const path = join(directory, "state.sqlite3");
    const adapter = service(path);
    const scope = sessionScope("a");
    await call(adapter, "prepare", { snapshot_id: "one", records: [record()] });
    const hidden = await call(adapter, "compact", { snapshot_id: "one", tool_call_id: "call-1" });
    const item = adapter.store.get(scope, String(hidden.item_id))!;
    expect(adapter.store.put(scope, { ...item, compaction_source: "summarize_pending", version: 2 }, 1).ok).toBe(true);
    adapter.store.close();
    const reopened = service(path);
    const reply = await call(reopened, "prepare", { snapshot_id: "two", records: [record()] });
    expect((reply.pending_summaries as any[]).map((job) => job.content)).toEqual([record().content]);
    const settled = await call(reopened, text ? "apply_summary" : "summary_failed", {
      item_id: item.item_id, expected_version: 2, summary_text: text,
    });
    const valid = text === "Output row 000 details";
    expect(settled.ok).toBe(valid || text === undefined);
    if (text && !valid) expect(settled.error).toBe("verification_failed");
    const stored = reopened.store.get(scope, item.item_id)!;
    expect(stored.compaction_source).toBe(valid ? "llm_summary" : "explicit_user_hide");
    expect(stored.original).toBe(record().content);
    if (valid) expect(stored.compacted).toBe(text!);
    expect((await call(reopened, "prepare", { snapshot_id: "three", records: [record()] })).pending_summaries).toEqual([]);
  }
});

test("SQLite write refusal during prepare returns explicit request failure choices", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-readonly-"));
  directories.push(directory);
  const adapter = service(join(directory, "state.sqlite3"));
  adapter.store.driver.exec("PRAGMA query_only=ON");
  try {
    const reply = await call(adapter, "prepare", { snapshot_id: "one", records: [record()] });
    expect(reply).toEqual({ ok: false, error: "db_error", choices: ["abort_request", "send_original"] });
    expect(adapter.store.items(sessionScope("a"))).toEqual([]);
  } finally { adapter.store.driver.exec("PRAGMA query_only=OFF"); }
});
