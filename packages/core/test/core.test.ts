import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Engine,
  EngineError,
  Store,
  PythonFloat,
  canonical,
  invocationDigest,
  itemId,
  parseCanonicalJson,
  scopeAliases,
  sha256,
  walSupported,
} from "../src/index.ts";
import { schema } from "../src/schema.ts";
import { makeDriver } from "./runtime.ts";
import { body, fixtures, record } from "./vectors.ts";
function database(fn: (store: Store, path: string) => void | Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "navigation-core-"));
  const path = join(directory, "state.db");
  const store = new Store(makeDriver(path));
  return Promise.resolve()
    .then(() => fn(store, path))
    .finally(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
}
test("child registrations survive reopen and old rows expose null linkage", () => database((store, path) => {
  const registration = { adapter_id: "hermes", adapter_protocol: 1,
    capabilities: { hide: true, summarize: false, unhide: true }, enabled: true, instance_id: "test" };
  const parent = "hermes:default:parent:unknown", child = "hermes:default:child:unknown";
  store.register(parent, registration);
  assert.equal(store.registration(parent)?.parent_scope, null);
  assert.deepEqual(store.childScopes(parent), []);
  store.linkChildren(parent, "delegate", ["sa"]);
  store.register(parent, registration);
  store.register(child, { ...registration, parent_scope: parent, subagent_id: "sa" });
  store.register(child, registration);
  assert.throws(() => store.register(child, { ...registration, parent_scope: child }), /invalid_adapter_registration/);
  assert.throws(() => store.register(child, { ...registration, parent_scope: "invalid" }), /invalid_adapter_registration/);
  const reopened = new Store(makeDriver(path));
  try {
    const rows = reopened.childScopes(parent);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scope_key, child);
    assert.equal(rows[0].tool_call_id, "delegate");
    assert.equal(rows[0].subagent_id, "sa");
    assert.equal(reopened.can(child, "hide"), true);
    assert.equal(reopened.can(child, "summarize"), false);
    assert.deepEqual(reopened.childScopes(child), []);
    reopened.linkChildren(parent, "updated-delegate", ["sa"]);
    assert.equal(reopened.registration(child)?.tool_call_id, "updated-delegate");
  } finally { reopened.close(); }
}));

test("canonical JSON preserves Unicode sorting, integer precision and float kinds", () => {
  assert.equal(
    canonical(parseCanonicalJson('{"𐀀":3,"":4,"n":9007199254740993,"float":1.0}')),
    '{"float":1.0,"n":9007199254740993,"":4,"𐀀":3}',
  );
  const protoObj = parseCanonicalJson('{"__proto__":{"a":1},"constructor":2,"toString":3}') as {
    [key: string]: any;
  };
  assert.equal(canonical(protoObj), '{"__proto__":{"a":1},"constructor":2,"toString":3}');
  assert.notEqual(
    invocationDigest({ tool_name: "mcp_read_status", arguments: protoObj }),
    invocationDigest({ tool_name: "mcp_read_status", arguments: { constructor: 2, toString: 3 } }),
  );
  assert.equal(canonical(new PythonFloat(-0)), "-0.0");
  assert.equal(canonical(new PythonFloat(1e-7)), "1e-07");
  assert.equal(canonical(0.00001), "1e-05");
  assert.throws(() => canonical(9007199254740992), /unsafe_json_number/);
  assert.equal(canonical(String.fromCharCode(0xd800)), `"${String.fromCharCode(0xfffd)}"`);
  assert.equal(canonical(String.fromCharCode(0xdc00)), `"${String.fromCharCode(0xfffd)}"`);
  const lonePair = `a${String.fromCharCode(0xd800)}b${String.fromCharCode(0xdc00)}c`;
  assert.equal(canonical(lonePair), `"a${String.fromCharCode(0xfffd)}b${String.fromCharCode(0xfffd)}c"`);
  assert.equal(canonical(`a${String.fromCharCode(0xd83d, 0xde00)}b`), '"a😀b"');
  assert.equal(canonical({ q: String.fromCharCode(0xd800) }), `{"q":"${String.fromCharCode(0xfffd)}"}`);
  assert.throws(() => parseCanonicalJson("[1,]"), SyntaxError);
  assert.throws(() => parseCanonicalJson('{"x":NaN}'), SyntaxError);
  assert.equal(canonical(parseCanonicalJson("[]")), "[]");
});
test("identity includes all tuple components and omitted options", () => {
  const toolRecord = record("original");
  assert.notEqual(
    invocationDigest(toolRecord.invocation, { timeout: 1 }),
    toolRecord.invocation_digest,
  );
  assert.notEqual(
    itemId(
      fixtures.scope,
      toolRecord.call_id,
      toolRecord.content_sha256,
      toolRecord.invocation_digest,
      0,
    ),
    itemId(
      fixtures.scope,
      toolRecord.call_id,
      toolRecord.content_sha256,
      toolRecord.invocation_digest,
      1,
    ),
  );
  assert.deepEqual(scopeAliases(fixtures.scope), [
    fixtures.scope,
    fixtures.scope.replace(/unknown$/, "default"),
  ]);
  assert.deepEqual(scopeAliases("pi:default:s:default"), ["pi:default:s:default"]);
});
test("schema 1 is adopted in place and protocol refusal preserves rows", () =>
  database((store, path) => {
    store.driver.run("DELETE FROM meta WHERE key='engine_protocol_version'");
    store.driver.run("UPDATE meta SET value='1' WHERE key='schema_version'");
    store.driver.exec("DROP TABLE adapter_targets");
    store.driver.exec("DROP TABLE adapter_sessions");
    store.driver.run(
      "INSERT INTO calls(scope_key,call_key,total_tokens) VALUES ('legacy','call',42)",
    );
    const adopted = new Store(makeDriver(path));
    assert.equal(
      adopted.driver.get("SELECT value FROM meta WHERE key='schema_version'")!.value,
      "2",
    );
    assert.equal(adopted.driver.get("SELECT total_tokens FROM calls")!.total_tokens, 42);
    adopted.close();
    store.driver.run("UPDATE meta SET value='2' WHERE key='engine_protocol_version'");
    assert.throws(
      () => new Store(makeDriver(path)),
      (error: unknown) =>
        error instanceof EngineError && error.code === "engine_protocol_incompatible",
    );
    assert.throws(
      () =>
        store.register(fixtures.scope, {
          adapter_id: "hermes",
          adapter_protocol: 1,
          instance_id: "one",
          capabilities: { hide: true, summarize: false, unhide: true },
          enabled: true,
        }),
      (error: unknown) =>
        error instanceof EngineError && error.code === "engine_protocol_incompatible",
    );
  }));
test("fresh bootstrap is atomic on DDL failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "navigation-schema-"));
  const path = join(directory, "s.db");
  schema.push("INVALID SQL");
  try {
    assert.throws(() => new Store(makeDriver(path)), EngineError);
    const driver = makeDriver(path);
    assert.deepEqual(driver.all("SELECT name FROM sqlite_master WHERE type='table'"), []);
    driver.close();
  } finally {
    schema.pop();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("DELETE is default and WAL gate honors only safe versions", () =>
  database((store) => {
    assert.equal(store.driver.get("PRAGMA journal_mode")!.journal_mode, "delete");
    assert.equal(walSupported("3.51.0"), false);
    assert.equal(walSupported("3.51.3"), true);
    assert.equal(walSupported("3.44.6"), true);
    assert.equal(walSupported("3.50.7"), true);
    assert.equal(walSupported("3.50.8"), false);
  }));
test("WAL converts safely or is refused when busy on unsafe runtime", () =>
  database((store, path) => {
    const reader = makeDriver(path);
    reader.get("PRAGMA journal_mode=WAL");
    reader.exec("BEGIN");
    reader.all("SELECT * FROM meta");
    if (walSupported(store.sqliteVersion)) {
      const writer = new Store(makeDriver(path));
      assert.equal(writer.driver.get("PRAGMA journal_mode")!.journal_mode, "wal");
      writer.close();
    } else {
      assert.throws(
        () => new Store(makeDriver(path)),
        (error: unknown) => error instanceof EngineError && error.code === "unsafe_journal_mode",
      );
    }
    reader.exec("ROLLBACK");
    reader.close();
    const converted = new Store(makeDriver(path));
    assert.equal(converted.driver.get("PRAGMA journal_mode")!.journal_mode, "delete");
    converted.close();
  }));
test("driver never rounds large integers and normalizes rollback and busy errors", () =>
  database((store, path) => {
    const row = store.driver.get("SELECT 9007199254740993 AS integer");
    assert.equal(row!.integer, 9007199254740993n);
    assert.throws(
      () =>
        store.transaction(() => {
          store.driver.run("INSERT INTO calls(scope_key,call_key) VALUES ('x','y')");
          throw Error("abort");
        }),
      /abort/,
    );
    assert.equal(store.driver.get("SELECT count(*) AS count FROM calls")!.count, 0);
    const other = makeDriver(path);
    other.exec("BEGIN IMMEDIATE");
    store.driver.exec("PRAGMA busy_timeout=1");
    assert.throws(
      () => store.transaction(() => {}),
      (error: unknown) => error instanceof EngineError && error.code === "db_error",
    );
    other.exec("ROLLBACK");
    other.close();
  }));
test("hide, CAS, unhide, rehide, fork and per-target batches", () =>
  database(async (store) => {
    const engine = new Engine(store);
    const toolRecord = record(body(fixtures.engine[0]));
    const scope = fixtures.scope;
    const hide = await engine.hide(scope, toolRecord);
    assert.equal(hide.ok, true);
    assert.equal(hide.item!.version, 1);
    assert.equal(engine.unhide(scope, hide.item!.item_id, 9).error, "version_conflict");
    assert.equal(engine.unhide(scope, hide.item!.item_id, 1).item!.version, 2);
    assert.equal((await engine.hide(scope, toolRecord)).item!.version, 3);
    assert.equal(engine.project(scope, [toolRecord]).length, 1);
    const fork = store.fork(scope, "hermes:default:child:unknown");
    assert.deepEqual(fork, { items: 1, identities: 1, units: 0, calls: 0 });
    assert.equal(engine.project("hermes:default:child:unknown", [toolRecord]).length, 1);
    const batch = store.batch(["missing", hide.item!.item_id, hide.item!.item_id], (id) =>
      engine.unhide(scope, id),
    );
    assert.equal(batch.length, 2);
    assert.equal(batch[0].result.ok, false);
    assert.equal(batch[1].result.ok, true);
  }));
test("registration rate limits, capabilities, exact aliases and bounded targets", () =>
  database((store) => {
    const owner = {
      adapter_id: "hermes",
      adapter_protocol: 1,
      instance_id: "one",
      capabilities: { hide: true, summarize: false, unhide: true },
      enabled: true,
    };
    assert.equal(store.register(fixtures.scope, owner, 100), true);
    assert.equal(store.register(fixtures.scope, owner, 101), false);
    assert.equal(store.register(fixtures.scope, owner, 400), true);
    assert.equal(store.can(fixtures.scope.replace(/unknown$/, "default"), "hide"), true);
    assert.equal(store.can(fixtures.scope, "summarize"), false);
    store.publishTargets(
      fixtures.scope,
      Array.from({ length: 258 }, (_, index) => ({
        record: record("original " + index, String(index)),
      })),
    );
    assert.equal(store.targets(fixtures.scope).length, 256);
    assert.equal(store.targets(fixtures.scope)[0].tool_call_id, "2");
    assert.equal(store.items(fixtures.scope).length, 0);
    assert.throws(
      () =>
        store.publishTargets(fixtures.scope, [
          { record: { ...record("valid"), content_sha256: "bad" } },
        ]),
      (error: unknown) => error instanceof EngineError && error.code === "invalid_target_identity",
    );
    store.publishTargets(fixtures.scope, []);
    assert.equal(store.targets(fixtures.scope).length, 256);
    store.register(fixtures.scope, { ...owner, enabled: false }, 401);
    assert.equal(store.can(fixtures.scope, "hide"), false);
    store.register(
      fixtures.scope.replace(/unknown$/, "default"),
      { ...owner, enabled: false },
      401,
    );
    assert.equal(store.registration(fixtures.scope.replace(/unknown$/, "default"))!.enabled, false);
  }));
test("messages preserve existing visibility and reject stale CAS", () =>
  database((store) => {
    store.ensureMessages(fixtures.scope, [
      { unit_id: "msg", kind: "user", content_sha256: sha256("hi"), char_count: 2 },
    ]);
    assert.equal(
      store.setMessageVisibility(fixtures.scope, "msg", "user", sha256("hi"), 2, "hidden", 1)
        .version,
      2,
    );
    store.ensureMessages(fixtures.scope, [
      { unit_id: "msg", kind: "user", content_sha256: sha256("hi"), char_count: 2 },
    ]);
    assert.deepEqual(store.hiddenMessages(fixtures.scope), ["msg"]);
    assert.equal(
      store.setMessageVisibility(fixtures.scope, "msg", "user", "", 2, "visible", 1).error,
      "version_conflict",
    );
  }));
test("target byte bounds use UTF-8 and skip oversized originals without seeding items", () =>
  database((store) => {
    const owner = {
      adapter_id: "hermes",
      adapter_protocol: 1,
      instance_id: "one",
      capabilities: { hide: true, summarize: false, unhide: true },
      enabled: true,
    };
    store.register(fixtures.scope, owner);
    const content = "😀".repeat(600000);
    store.publishTargets(fixtures.scope, [
      { record: record(content, "first") },
      { record: record(content, "second") },
    ]);
    assert.equal(store.targets(fixtures.scope).length, 1);
    assert.equal(store.targets(fixtures.scope)[0].tool_call_id, "second");
    store.publishTargets(fixtures.scope, [
      { record: record("x".repeat(4 * 1024 * 1024 + 1), "oversized") },
    ]);
    assert.equal(store.targets(fixtures.scope).length, 1);
    assert.equal(store.items(fixtures.scope).length, 0);
  }));
test("unsafe long-lived writers refuse a journal switched to WAL", () =>
  database(async (store) => {
    if (walSupported(store.sqliteVersion)) {
      return;
    }
    store.driver.get("PRAGMA journal_mode=WAL");
    const result = await new Engine(store).hide(fixtures.scope, record(body(fixtures.engine[0])));
    assert.equal(result.error, "unsafe_journal_mode");
    assert.equal(store.items(fixtures.scope).length, 0);
  }));
test("pending settlement validates text and never overwrites a concurrent unhide", () =>
  database(async (store, path) => {
    const engine = new Engine(store);
    const toolRecord = record(body(fixtures.engine[0]));
    const hidden = await engine.hide(fixtures.scope, toolRecord);
    const item = hidden.item!;
    store.put(fixtures.scope, { ...item, compaction_source: "summarize_pending", version: 2 }, 1);
    assert.equal(
      engine.settlePending(fixtures.scope, item.item_id, 2, "Invented 9999 facts").error,
      "verification_failed",
    );
    assert.equal(store.get(fixtures.scope, item.item_id)!.compacted, item.compacted);
    store.put(
      fixtures.scope,
      {
        ...store.get(fixtures.scope, item.item_id)!,
        compaction_source: "summarize_pending",
        version: 4,
      },
      3,
    );
    const other = new Store(makeDriver(path));
    other.restore(fixtures.scope, item.item_id, 4);
    other.close();
    assert.equal(
      engine.settlePending(fixtures.scope, item.item_id, 4, "Routine catalog annotation.").error,
      "version_conflict",
    );
  }));
test("summarize failure does not fall back unless explicitly allowed", () =>
  database(async (store) => {
    const engine = new Engine(store);
    const toolRecord = record(body(fixtures.engine[0]));
    const result = await engine.summarize(fixtures.scope, toolRecord, async () => {
      throw new Error("model failed");
    });
    assert.equal(result.ok, false);
    assert.equal(store.items(fixtures.scope).length, 0);
    assert.equal(
      (await engine.summarize(fixtures.scope, toolRecord, async () => null)).error,
      "verification_failed",
    );
    assert.equal(
      (
        await engine.hide(fixtures.scope, toolRecord, {
          summarizer: async () => ({ summary: "Invented 9999 facts" }),
        })
      ).ok,
      true,
    );
  }));
test("persisted invocation JSON retains Python floats and arbitrary integer tokens", () =>
  database(async (store) => {
    const engine = new Engine(store);
    const toolRecord = record(body(fixtures.engine[0]));
    const result = await engine.hide(fixtures.scope, toolRecord);
    const item = result.item!;
    const invocation = parseCanonicalJson('{"integer":9007199254740993,"float":1.0,"small":1e-7}');
    assert.equal(
      store.put(fixtures.scope, { ...item, invocation_snapshot: invocation, version: 2 }, 1).ok,
      true,
    );
    const saved = store.get(fixtures.scope, item.item_id)!;
    assert.equal(
      canonical(saved.invocation_snapshot),
      '{"float":1.0,"integer":9007199254740993,"small":1e-07}',
    );
    assert.equal(store.put(fixtures.scope, { ...saved, version: 3 }, 2).ok, true);
    assert.equal(
      store.driver.get("SELECT invocation_snapshot FROM items")!.invocation_snapshot,
      canonical(invocation),
    );
  }));
test("in-progress reservations and create-only commits protect the first writer", () =>
  database(async (store, path) => {
    const engine = new Engine(store);
    const toolRecord = record(body(fixtures.engine[0]));
    let release!: (value: unknown) => void;
    const summary = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    const first = engine.summarize(fixtures.scope, toolRecord, async () => summary);
    assert.equal((await engine.hide(fixtures.scope, toolRecord)).error, "in_progress");
    const remoteStore = new Store(makeDriver(path));
    const remote = new Engine(remoteStore);
    const hidden = await remote.hide(fixtures.scope, toolRecord);
    assert.equal(hidden.ok, true);
    release({ summary: "Routine catalog annotation with no special facts." });
    assert.equal((await first).error, "version_conflict");
    assert.equal(
      store.put(
        fixtures.scope,
        { ...hidden.item!, compacted: "unsafe replacement" },
        undefined,
        true,
      ).error,
      "version_conflict",
    );
    assert.equal(
      store.get(fixtures.scope, hidden.item!.item_id)!.compacted,
      hidden.item!.compacted,
    );
    remoteStore.close();
  }));
test("manage handles empty, duplicate, unsupported and destructive targets", () =>
  database(async (store) => {
    const engine = new Engine(store);
    assert.deepEqual(await engine.manage(fixtures.scope, [], [], "hide"), []);
    const toolRecord = record(body(fixtures.engine[0]));
    const results = await engine.manage(
      fixtures.scope,
      [toolRecord],
      ["missing", "call", "call"],
      "hide",
    );
    assert.equal(results.length, 2);
    assert.equal(results[0].result.error, "not_found");
    assert.equal(results[1].result.ok, true);
    const destructive = {
      ...toolRecord,
      call_id: "other",
      invocation: { tool_name: "bash", arguments: { command: "rm -rf path" } },
    };
    destructive.invocation_digest = invocationDigest(destructive.invocation);
    assert.equal(
      (await engine.manage(fixtures.scope, [destructive], ["other"], "hide"))[0].result.error,
      "destructive_command",
    );
  }));

test("independent SQLite writers reject stale CAS and observe subsequent interleaved writes", () =>
  database(async (store, path) => {
    const others = [new Store(makeDriver(path)), new Store(makeDriver(path))];
    try {
      const stores = [store, ...others];
      const engines = stores.map((writer) => new Engine(writer));
      const toolRecord = record(body(fixtures.engine[0]));
      const hidden = await engines[0].hide(fixtures.scope, toolRecord);
      assert.equal(hidden.ok, true);
      const item = hidden.item!;
      const attempts = engines.map((engine) => engine.unhide(fixtures.scope, item.item_id, item.version));
      assert.deepEqual(attempts.map((reply) => reply.ok), [true, false, false]);
      assert.deepEqual(attempts.slice(1).map((reply) => reply.error), ["version_conflict", "version_conflict"]);
      const rehidden = await engines[2].hide(fixtures.scope, toolRecord);
      assert.equal(rehidden.item!.version, item.version + 2);
      assert.equal(engines[1].unhide(fixtures.scope, item.item_id, item.version).error, "version_conflict");
      for (const writer of stores) {
        const rows = writer.items(fixtures.scope);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].visibility, "hidden");
        assert.equal(rows[0].version, item.version + 2);
        assert.equal(rows[0].original, toolRecord.content);
      }
    } finally { for (const writer of others) writer.close(); }
  }));

test("adapter_control stores toggle revisions and synchronizes adapter_sessions.enabled", () =>
  database((store, path) => {
    assert.equal(store.getAdapterControl("omp"), null);
    assert.equal(store.get_adapter_control("hermes"), null);
    store.register("omp:default:s1:default", {
      adapter_id: "omp",
      adapter_protocol: 1,
      capabilities: { hide: true, summarize: true, unhide: true },
      enabled: true,
      instance_id: "inst-1",
    });
    const first = store.setAdapterControl("omp", false, 100);
    assert.deepEqual(first, { adapter_id: "omp", enabled: false, revision: 1, updated_at: 100 });
    assert.equal(store.registration("omp:default:s1:default")?.enabled, false);
    assert.equal(store.can("omp:default:s1:default", "hide"), false);

    const second = store.set_adapter_control("omp", true, 200);
    assert.deepEqual(second, { adapter_id: "omp", enabled: true, revision: 2, updated_at: 200 });
    assert.equal(store.registration("omp:default:s1:default")?.enabled, true);

    const reopened = new Store(makeDriver(path));
    try {
      assert.deepEqual(reopened.getAdapterControl("omp"), second);
    } finally {
      reopened.close();
    }

    // Failure during adapter_sessions update must roll back adapter_control in the same transaction
    const driver = (store as any).driver;
    const origRun = driver.run.bind(driver);
    driver.run = (sql: string, params?: unknown[]) => {
      if (sql.includes("UPDATE adapter_sessions")) {
        throw new Error("injected_session_update_failure");
      }
      return origRun(sql, params);
    };
    try {
      assert.throws(() => store.setAdapterControl("omp", false, 300), /injected_session_update_failure/);
      assert.deepEqual(store.getAdapterControl("omp"), second);
      assert.equal(store.registration("omp:default:s1:default")?.enabled, true);
    } finally {
      driver.run = origRun;
    }
  }));

test("register preserves optional protection_only and bundle_fingerprint capability markers", () =>
  database((store) => {
    store.register("hermes:default:plain:unknown", {
      adapter_id: "hermes",
      adapter_protocol: 1,
      capabilities: { hide: true, summarize: false, unhide: true },
      enabled: true,
      instance_id: "inst-plain",
    });
    store.register("hermes:default:marked:unknown", {
      adapter_id: "hermes",
      adapter_protocol: 1,
      capabilities: {
        hide: true,
        summarize: false,
        unhide: true,
        protection_only: true,
        bundle_fingerprint: "fp-ts-1234",
      },
      enabled: false,
      instance_id: "inst-marked",
    });
    assert.deepEqual(store.registration("hermes:default:plain:unknown")?.capabilities, {
      hide: true,
      summarize: false,
      unhide: true,
    });
    assert.deepEqual(store.registration("hermes:default:marked:unknown")?.capabilities, {
      hide: true,
      summarize: false,
      unhide: true,
      protection_only: true,
      bundle_fingerprint: "fp-ts-1234",
    });
  }));

test("adapter_control rejects adapter ids containing ':'", () =>
  database((store) => {
    assert.throws(() => store.setAdapterControl("hermes:default", false), /invalid_adapter_registration/);
    assert.throws(() => store.setAdapterControl(":", true), /invalid_adapter_registration/);
    assert.equal(store.getAdapterControl("hermes:default"), null);
    assert.throws(
      () =>
        store.register("hermes:default:s:default", {
          adapter_id: "hermes:default",
          adapter_protocol: 1,
          capabilities: { hide: true, summarize: false, unhide: true },
          enabled: true,
          instance_id: "bad",
        }),
      /invalid_adapter_registration/,
    );
    store.register("hermes:default:s:default", {
      adapter_id: "hermes",
      adapter_protocol: 1,
      capabilities: { hide: true, summarize: false, unhide: true },
      enabled: true,
      instance_id: "good",
    });
    assert.equal(store.registration("hermes:default:s:default")?.adapter_id, "hermes");
  }));

test("adapter_control toggle matching is case-sensitive and prefix-exact", () =>
  database((store) => {
    const capabilities = { hide: true, summarize: false, unhide: true };
    store.register("omp:default:lower:default", {
      adapter_id: "omp", adapter_protocol: 1, capabilities, enabled: true, instance_id: "a",
    });
    store.register("OMP:default:upper:default", {
      adapter_id: "OMP", adapter_protocol: 1, capabilities, enabled: true, instance_id: "b",
    });
    store.register("om:default:short:default", {
      adapter_id: "om", adapter_protocol: 1, capabilities, enabled: true, instance_id: "c",
    });
    // LIKE is ASCII case-insensitive: under the old matching "omp" off would
    // also disable "OMP:*" rows. instr() keeps them isolated.
    store.setAdapterControl("omp", false);
    assert.equal(store.registration("omp:default:lower:default")?.enabled, false);
    assert.equal(store.registration("OMP:default:upper:default")?.enabled, true);
    assert.equal(store.registration("om:default:short:default")?.enabled, true);
    store.setAdapterControl("OMP", false);
    assert.equal(store.registration("OMP:default:upper:default")?.enabled, false);
    assert.equal(store.registration("omp:default:lower:default")?.enabled, false);
    store.setAdapterControl("omp", true);
    assert.equal(store.registration("omp:default:lower:default")?.enabled, true);
    assert.equal(store.registration("OMP:default:upper:default")?.enabled, false);
  }));

test("control-on never resurrects sessions disabled for their own reasons", () =>
  database((store) => {
    const owner = {
      adapter_id: "hermes", adapter_protocol: 1,
      capabilities: { hide: true, summarize: false, unhide: true },
      enabled: true, instance_id: "i",
    };
    store.register("hermes:default:normal:unknown", owner);
    // Unsupported api_mode equivalent: capabilities off, enabled false.
    store.register("hermes:default:legacy:unknown", {
      ...owner,
      capabilities: { hide: false, summarize: false, unhide: false },
      enabled: false,
    });
    store.setAdapterControl("hermes", false);
    assert.equal(store.registration("hermes:default:normal:unknown")?.enabled, false);
    assert.equal(store.registration("hermes:default:legacy:unknown")?.enabled, false);
    store.setAdapterControl("hermes", true);
    assert.equal(store.registration("hermes:default:normal:unknown")?.enabled, true);
    assert.equal(store.registration("hermes:default:legacy:unknown")?.enabled, false);
    assert.equal(store.can("hermes:default:legacy:unknown", "hide"), false);
    // The marker is bookkeeping: never surfaced as a capability.
    assert.deepEqual(store.registration("hermes:default:normal:unknown")?.capabilities, {
      hide: true, summarize: false, unhide: true,
    });
    // A self-disable landing while control is on survives later toggles too.
    store.register("hermes:default:normal:unknown", { ...owner, enabled: false });
    store.setAdapterControl("hermes", false, 300);
    store.setAdapterControl("hermes", true, 400);
    assert.equal(store.registration("hermes:default:normal:unknown")?.enabled, false);
    // A mirrored disable written while control is off still round-trips.
    store.register("hermes:default:mirror:unknown", owner);
    store.setAdapterControl("hermes", false, 500);
    store.register("hermes:default:mirror:unknown", { ...owner, enabled: false });
    store.setAdapterControl("hermes", true, 600);
    assert.equal(store.registration("hermes:default:mirror:unknown")?.enabled, true);
  }));

test("register clamps stale enabled and mutations couple the control check", () =>
  database((store) => {
    const owner = {
      adapter_id: "omp", adapter_protocol: 1,
      capabilities: { hide: true, summarize: false, unhide: true },
      enabled: true, instance_id: "i",
    };
    store.register("omp:default:s:default", owner);
    store.setAdapterControl("omp", false);
    // A stale isAdapterEnabled()=true read must not commit enabled=true.
    store.register("omp:default:s:default", { ...owner, enabled: true });
    assert.equal(store.registration("omp:default:s:default")?.enabled, false);
    assert.equal(store.can("omp:default:s:default", "hide"), false);
    // Simulate a cross-connection race: enabled=true committed before control-off.
    store.driver.run(
      "INSERT INTO adapter_sessions VALUES (?,?,?,?,?,?,?) ON CONFLICT(scope_key) DO UPDATE SET enabled=excluded.enabled",
      ["omp:default:s:default", "omp", 1, canonical({ hide: true, summarize: false, unhide: true }), 1, "i", 100],
    );
    assert.equal(store.registration("omp:default:s:default")?.enabled, true);
    assert.equal(store.can("omp:default:s:default", "hide"), false);
    assert.throws(
      () => store.publishTargets("omp:default:s:default", [{ record: record("fresh", "race") }]),
      (error: unknown) => error instanceof EngineError && error.code === "adapter_disabled",
    );
    assert.equal(store.targets("omp:default:s:default").length, 0);
    store.setAdapterControl("omp", true);
    assert.equal(store.can("omp:default:s:default", "hide"), true);
    store.publishTargets("omp:default:s:default", [{ record: record("fresh", "race") }]);
    assert.equal(store.targets("omp:default:s:default").length, 1);
  }));

test("adapter_control enforces 0/1 and bundle fingerprints count UTF-16 units", () =>
  database((store) => {
    const sql = store.driver.get(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='adapter_control'",
    );
    assert.match(String(sql?.sql), /CHECK \(enabled IN \(0, 1\)\)/);
    assert.throws(() =>
      store.driver.run("INSERT INTO adapter_control VALUES (?,?,?,?)", ["x", 2, 1, 0]),
    );
    // Bound is UTF-16 code units (String.length), matching Python _utf16_len.
    const astral64 = "😀".repeat(64); // 64 code points, 128 UTF-16 units: accepted.
    assert.equal(astral64.length, 128);
    store.register("omp:default:fp:default", {
      adapter_id: "omp", adapter_protocol: 1,
      capabilities: { hide: true, summarize: false, unhide: true, bundle_fingerprint: astral64 },
      enabled: true, instance_id: "i",
    });
    assert.equal(
      store.registration("omp:default:fp:default")?.capabilities.bundle_fingerprint,
      astral64,
    );
    // 65 emoji are 65 code points but 130 UTF-16 units: rejected.
    store.register("omp:default:fp2:default", {
      adapter_id: "omp", adapter_protocol: 1,
      capabilities: { hide: true, summarize: false, unhide: true, bundle_fingerprint: "😀".repeat(65) },
      enabled: true, instance_id: "i",
    });
    assert.equal(
      store.registration("omp:default:fp2:default")?.capabilities.bundle_fingerprint,
      undefined,
    );
    store.register("omp:default:fp3:default", {
      adapter_id: "omp", adapter_protocol: 1,
      capabilities: { hide: true, summarize: false, unhide: true, bundle_fingerprint: "x".repeat(129) },
      enabled: true, instance_id: "i",
    });
    assert.equal(
      store.registration("omp:default:fp3:default")?.capabilities.bundle_fingerprint,
      undefined,
    );
  }));
