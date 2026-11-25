import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { Store, invocationDigest, itemId, sha256 } from "../../packages/core/src/index.ts";
import { NodeDriver } from "../../packages/core/src/drivers/node.ts";
import { ServiceClient, runtimeSupported } from "./client.ts";

function fixture() {
  const home = mkdtempSync(join(homedir(), "paseo-node-worker-"));
  const client = new ServiceClient(home, join(home, "state.sqlite3"));
  return {
    home,
    client,
    close() {
      client.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function worker(client: ServiceClient): Worker {
  return (client as unknown as { worker: Worker }).worker;
}

test("runtime floor includes 22.13 and rejects older Node releases", () => {
  assert.equal(runtimeSupported("22.12.0"), false);
  assert.equal(runtimeSupported("20.19.0"), false);
  assert.equal(runtimeSupported("22.13.0"), true);
  assert.equal(runtimeSupported("24.0.0"), true);
});

test("embedded Node worker lists missing histories and preserves serialized replies", async () => {
  const state = fixture();
  try {
    const replies = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        state.client.request("list", {
          scope_key: `omp:default:s${index}:default`,
        }),
      ),
    );
    assert.equal(
      replies.every(
        (reply) =>
          reply.ok &&
          reply.items.length === 0 &&
          reply.capabilities.state === "adapter_not_detected",
      ),
      true,
    );
  } finally {
    state.close();
  }
});

test("history and SQLite work do not block the caller event loop", async () => {
  const state = fixture();
  try {
    const directory = join(
      state.home,
      ".omp",
      "agent",
      "sessions",
      "worker-test",
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "date_busy.jsonl"),
      Array.from({ length: 40000 }, (_, index) =>
        JSON.stringify({
          role: "user",
          content: `Message ${index} ` + "x".repeat(100),
        }),
      ).join("\n"),
    );
    let ticks = 0;
    const interval = setInterval(() => ticks++, 1);
    try {
      const reply = await state.client.request("list", {
        scope_key: "omp:default:busy:default",
      });
      assert.equal(reply.ok, true);
      assert.equal(reply.items.length, 40000);
      assert.ok(ticks > 5, `caller ticks during worker operation: ${ticks}`);
    } finally {
      clearInterval(interval);
    }
  } finally {
    state.close();
  }
});

for (const failure of ["exit", "malformed", "error"] as const) {
  test(`worker ${failure} settles in-flight requests explicitly`, async () => {
    const state = fixture();
    try {
      const pending = state.client.request("list", { scope_key: "scope" });
      if (failure === "exit") await worker(state.client).terminate();
      else if (failure === "error")
        worker(state.client).emit(
          "error",
          new Error("injected worker failure"),
        );
      else
        worker(state.client).emit("message", {
          id: 1,
          reply: { ok: "invalid" },
        });
      assert.equal((await pending).error, "engine_error");
    } finally {
      state.close();
    }
  });
}

test("shutdown is synchronous and resolves in-flight and subsequent calls", async () => {
  const state = fixture();
  try {
    const pending = state.client.request("scopes", {});
    assert.equal(state.client.close(), undefined);
    assert.equal((await pending).error, "engine_error");
    assert.equal(
      (await state.client.request("scopes", {})).error,
      "engine_error",
    );
  } finally {
    state.close();
  }
});

test("timeout terminates the worker and resolves pending requests", async (context) => {
  const state = fixture();
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = state.client.request("scopes", {});
    context.mock.timers.tick(30000);
    assert.equal((await pending).error, "engine_error");
  } finally {
    context.mock.timers.reset();
    state.close();
  }
});

test("identical reads coalesce safely without hanging subsequent identical reads", async () => {
  const state = fixture();
  try {
    const [r1, r2] = await Promise.all([
      state.client.request("scopes", {}),
      state.client.request("scopes", {}),
    ]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);

    // Subsequent identical request must NOT hang on stale inflightByCoalesceKey state.
    const r3 = await state.client.request("scopes", {});
    assert.equal(r3.ok, true);
    assert.deepEqual(r3.scopes, r1.scopes);
  } finally {
    state.close();
  }
});

test("active timeout fails only the timed-out read and preserves queued requests", async (context) => {
  const state = fixture();
  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const first = state.client.request("scopes", {});
    const queued = state.client.request("list", {
      scope_key: "omp:default:queued-after-timeout:default",
    });
    // Only `first` is active (id:1); ticking 30s times out `first` and respawns for `queued`.
    context.mock.timers.tick(30000);
    const firstReply = await first;
    assert.equal(firstReply.error, "engine_error");

    // Disable mock timers so the respawned worker finishes `queued` normally.
    context.mock.timers.reset();
    const queuedReply = await queued;
    assert.equal(queuedReply.ok, true);
    assert.equal(queuedReply.scope_key, "omp:default:queued-after-timeout:default");
  } finally {
    context.mock.timers.reset();
    state.close();
  }
});

test("write lane and read lane operate independently and write timeout never auto-retries", async (context) => {
  const state = fixture();
  const scope = "omp:default:lane-test:default";
  const dbPath = join(state.home, "state.sqlite3");
  const makeRecord = (callId: string) => {
    const content = Array.from({ length: 80 }, (_, i) => `row ${i} for ${callId} payload`).join("\n");
    const invocation = { tool_name: "read", arguments: { path: `/tmp/${callId}.txt` } };
    return {
      call_id: callId,
      content,
      content_sha256: sha256(content),
      invocation,
      invocation_digest: invocationDigest(invocation),
      result_position: 0,
      status: "ok" as const,
    };
  };
  const r1 = makeRecord("c1");
  const r2 = makeRecord("c2");
  const id1 = itemId(scope, r1.call_id, r1.content_sha256, r1.invocation_digest, 0);
  const id2 = itemId(scope, r2.call_id, r2.content_sha256, r2.invocation_digest, 0);
  const seedStore = new Store(new NodeDriver(dbPath));
  try {
    seedStore.register(scope, {
      adapter_id: "omp",
      adapter_protocol: 1,
      capabilities: { hide: true, summarize: true, unhide: true },
      enabled: true,
      instance_id: "test",
    });
    seedStore.publishTargets(scope, [{ record: r1 }, { record: r2 }]);
  } finally {
    seedStore.close();
  }

  context.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const timedOutWrite = state.client.request("hide", {
      scope_key: scope,
      item_id: id1,
    });
    const queuedWrite = state.client.request("hide", {
      scope_key: scope,
      item_id: id2,
    });

    // Tick 30s synchronously while timedOutWrite is active on writeWorker:
    // fails timedOutWrite without auto-retrying it, respawns writeWorker for queuedWrite,
    // and leaves readLane independent.
    context.mock.timers.tick(30000);
    context.mock.timers.reset();

    const readDuringWrite = state.client.request("scopes", {});

    const w1Res = await timedOutWrite;
    const w2Res = await queuedWrite;
    const readRes = await readDuringWrite;

    assert.equal(w1Res.ok, false);
    assert.equal(w1Res.error, "engine_error");
    assert.equal(w2Res.ok, true);
    assert.equal(w2Res.visibility, "hidden");
    assert.equal(readRes.ok, true);

    const verifyStore = new Store(new NodeDriver(dbPath));
    try {
      assert.equal(verifyStore.get(scope, id1), undefined);
      assert.equal(verifyStore.get(scope, id2)?.visibility, "hidden");
    } finally {
      verifyStore.close();
    }
  } finally {
    context.mock.timers.reset();
    state.close();
  }
});

test("dbChoice flows remain coherent on write lane across read and write calls", async () => {
  const state = fixture();
  try {
    const choice = await state.client.request("dbChoice", {
      scope_key: "omp:default:dbchoice-lane:default",
      choice: "abort_request",
    });
    assert.equal(choice.ok, true);
    const blocked = await state.client.request("hide", {
      scope_key: "omp:default:dbchoice-lane:default",
      item_id: "i1",
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error, "db_error");
    const clearedList = await state.client.request("list", {
      scope_key: "omp:default:dbchoice-lane:default",
    });
    assert.equal(clearedList.ok, true);
    const afterClear = await state.client.request("hide", {
      scope_key: "omp:default:dbchoice-lane:default",
      item_id: "i1",
    });
    assert.equal(afterClear.error, "adapter_not_detected");
  } finally {
    state.close();
  }
});

function writeWorker(client: ServiceClient): Worker | undefined {
  return (client as unknown as { writeWorker?: Worker }).writeWorker;
}

function seedOmpScope(
  home: string,
  dbPath: string,
  scope: string,
  callIds: string[],
): string[] {
  const sessionId = scope.split(":")[2] ?? "s1";
  const sessionsDir = join(home, ".omp", "agent", "sessions", sessionId);
  mkdirSync(sessionsDir, { recursive: true });
  const lines: string[] = [];
  const records = callIds.map((callId, idx) => {
    const content = Array.from(
      { length: 80 },
      (_, i) => `row ${i} for ${callId} payload line ${idx}`,
    ).join("\n");
    const invocation = { tool_name: "read", arguments: { path: `/tmp/${callId}.txt` } };
    const ts = 1_700_000_000_000 + idx * 10;
    lines.push(
      JSON.stringify({
        type: "message",
        id: `ast_${callId}`,
        timestamp: ts,
        message: {
          role: "assistant",
          timestamp: ts,
          content: [{ type: "toolCall", id: callId, name: "read", arguments: invocation.arguments }],
        },
      }),
    );
    lines.push(
      JSON.stringify({
        type: "message",
        id: `tr_${callId}`,
        timestamp: ts + 1,
        message: {
          role: "toolResult",
          toolCallId: callId,
          toolName: "read",
          isError: false,
          timestamp: ts + 1,
          content: [{ type: "text", text: content }],
        },
      }),
    );
    const rec = {
      call_id: callId,
      content,
      content_sha256: sha256(content),
      invocation,
      invocation_digest: invocationDigest(invocation),
      result_position: 0,
      status: "ok" as const,
    };
    return {
      record: rec,
      id: itemId(scope, rec.call_id, rec.content_sha256, rec.invocation_digest, 0),
    };
  });
  writeFileSync(join(sessionsDir, `2026-01-01_${sessionId}.jsonl`), `${lines.join("\n")}\n`, "utf8");
  const store = new Store(new NodeDriver(dbPath));
  try {
    store.register(scope, {
      adapter_id: "omp",
      adapter_protocol: 1,
      capabilities: { hide: true, summarize: true, unhide: true },
      enabled: true,
      instance_id: "seed-test",
    });
    store.publishTargets(
      scope,
      records.map((entry) => ({ record: entry.record })),
    );
  } finally {
    store.close();
  }
  return records.map((entry) => entry.id);
}

test("read-after-write barrier forces list and scopes to observe immediately preceding unawaited hide and unhide", async () => {
  const state = fixture();
  const scope = "omp:default:raw-barrier:default";
  const dbPath = join(state.home, "state.sqlite3");
  const [id1] = seedOmpScope(state.home, dbPath, scope, ["c1", "c2"]);
  try {
    // Warm readWorker BEFORE write so a naive readWorker without write barrier would race ahead of hide.
    const initialList = await state.client.request("list", { scope_key: scope });
    assert.equal(initialList.ok, true);
    assert.equal(initialList.totals.hidden_count, 0);

    // Fire unawaited hide followed immediately in the same turn by list & scopes.
    const hidePromise = state.client.request("hide", { scope_key: scope, item_id: id1 });
    const listAfterHidePromise = state.client.request("list", { scope_key: scope });
    const scopesAfterHidePromise = state.client.request("scopes", {});

    const [hideRes, listAfterHide, scopesAfterHide] = await Promise.all([
      hidePromise,
      listAfterHidePromise,
      scopesAfterHidePromise,
    ]);
    assert.equal(hideRes.ok, true);
    assert.equal(hideRes.visibility, "hidden");
    assert.equal(listAfterHide.ok, true);
    assert.equal(listAfterHide.totals.hidden_count, 1);
    assert.equal(listAfterHide.items.find((r: any) => r.item_id === id1)?.visibility, "hidden");
    assert.equal(scopesAfterHide.ok, true);
    assert.equal(
      scopesAfterHide.scopes.find((s: any) => s.scope_key === scope)?.capabilities?.unhide,
      true,
    );

    // Repeat with unawaited unhide immediately followed by list.
    const unhidePromise = state.client.request("unhide", { scope_key: scope, item_id: id1 });
    const listAfterUnhidePromise = state.client.request("list", { scope_key: scope });
    const [unhideRes, listAfterUnhide] = await Promise.all([
      unhidePromise,
      listAfterUnhidePromise,
    ]);
    assert.equal(unhideRes.ok, true);
    assert.equal(unhideRes.visibility, "visible");
    assert.equal(listAfterUnhide.ok, true);
    assert.equal(listAfterUnhide.totals.hidden_count, 0);
    assert.equal(listAfterUnhide.items.find((r: any) => r.item_id === id1)?.visibility, "visible");
  } finally {
    state.close();
  }
});

test("slow prior read never blocks independent write, while post-write read waits for write completion and skips pre-write coalescing", async () => {
  const state = fixture();
  const busyScope = "omp:default:slow-busy:default";
  const targetScope = "omp:default:fast-target:default";
  const dbPath = join(state.home, "state.sqlite3");

  const busyDir = join(state.home, ".omp", "agent", "sessions", "slow-busy");
  mkdirSync(busyDir, { recursive: true });
  writeFileSync(
    join(busyDir, "2026-01-01_slow-busy.jsonl"),
    Array.from({ length: 65000 }, (_, index) =>
      JSON.stringify({
        role: "user",
        content: `Busy message ${index} ` + "y".repeat(120),
      }),
    ).join("\n"),
    "utf8",
  );
  const [id1, warmId] = seedOmpScope(state.home, dbPath, targetScope, ["c1", "warm"]);

  try {
    // Pre-warm both workers (read + write) so write speed is pure SQLite execution vs 65k-line read.
    await state.client.request("scopes", {});
    const warmHide = await state.client.request("hide", { scope_key: targetScope, item_id: warmId });
    assert.equal(warmHide.ok, true);
    await state.client.request("unhide", { scope_key: targetScope, item_id: warmId });

    const doneOrder: string[] = [];
    const slowRead = state.client
      .request("list", { scope_key: busyScope })
      .then((res) => {
        doneOrder.push("slowRead");
        return res;
      });
    const coalescedPreRead = state.client
      .request("list", { scope_key: busyScope })
      .then((res) => {
        doneOrder.push("coalescedPreRead");
        return res;
      });

    // Independent write fires while slowRead is busy on readWorker.
    const writePromise = state.client
      .request("hide", { scope_key: targetScope, item_id: id1 })
      .then((res) => {
        doneOrder.push("write");
        return res;
      });

    // Post-write reads arrive AFTER writePromise (must wait for write completion and NOT coalesce onto slowRead).
    const postWriteTargetRead = state.client
      .request("list", { scope_key: targetScope })
      .then((res) => {
        doneOrder.push("postWriteTargetRead");
        return res;
      });
    const postWriteBusyRead = state.client
      .request("list", { scope_key: busyScope })
      .then((res) => {
        doneOrder.push("postWriteBusyRead");
        return res;
      });

    const [slowRes, coalescedRes, writeRes, postTargetRes, postBusyRes] = await Promise.all([
      slowRead,
      coalescedPreRead,
      writePromise,
      postWriteTargetRead,
      postWriteBusyRead,
    ]);

    assert.equal(slowRes.ok, true);
    assert.equal(coalescedRes.ok, true);
    assert.equal(writeRes.ok, true);
    assert.equal(postTargetRes.ok, true);
    assert.equal(postBusyRes.ok, true);
    assert.equal(postTargetRes.totals.hidden_count, 1);
    assert.equal(postTargetRes.items.find((r: any) => r.item_id === id1)?.visibility, "hidden");
    assert.ok(
      doneOrder.indexOf("write") < doneOrder.indexOf("slowRead"),
      `expected write to finish before slowRead, order=${doneOrder.join(",")}`,
    );
    assert.ok(
      doneOrder.indexOf("postWriteTargetRead") > doneOrder.indexOf("write"),
      `expected postWriteTargetRead after write, order=${doneOrder.join(",")}`,
    );
    assert.ok(
      doneOrder.indexOf("postWriteBusyRead") > doneOrder.indexOf("slowRead"),
      `expected postWriteBusyRead after slowRead without stale coalescing, order=${doneOrder.join(",")}`,
    );
  } finally {
    state.close();
  }
});

test("ambiguous write crash awaits termination before subsequent reads and never deadlocks queued reads on lane failure", async () => {
  const state = fixture();
  const scope = "omp:default:crash-barrier:default";
  const dbPath = join(state.home, "state.sqlite3");
  const [id1, id2, id3] = seedOmpScope(state.home, dbPath, scope, ["c1", "c2", "c3"]);
  try {
    // 2 consecutive active crashes on writeWorker trigger MAX_CONSECUTIVE_LANE_FAILURES drain.
    const w1 = state.client.request("hide", { scope_key: scope, item_id: id1 });
    const w2 = state.client.request("hide", { scope_key: scope, item_id: id2 });
    const w3 = state.client.request("hide", { scope_key: scope, item_id: id3 });
    const postWriteRead = state.client.request("list", { scope_key: scope });

    writeWorker(state.client)!.emit("error", new Error("first injected crash"));
    assert.equal((await w1).error, "engine_error");

    // Once w1 finishes terminating + failing, w2 spawns a fresh writeWorker and dispatches.
    const deadline = Date.now() + 2000;
    while (!writeWorker(state.client) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    writeWorker(state.client)!.emit("error", new Error("second injected crash"));

    const [r2, r3, readAfterDrain] = await Promise.all([w2, w3, postWriteRead]);
    assert.equal(r2.error, "engine_error");
    assert.equal(r3.error, "engine_error");
    // readAfterDrain MUST wake up cleanly after writeLane drains and observe truth on SQLite.
    assert.equal(readAfterDrain.ok, true);
    assert.equal(readAfterDrain.totals.hidden_count, 0);
  } finally {
    state.close();
  }
});

test("dbChoice survives writeWorker crash/respawn across Hermes unknown/default aliases and clears cleanly on list", async () => {
  const state = fixture();
  const dbPath = join(state.home, "state.sqlite3");
  const storedScope = "hermes:default:alias-crash:unknown";
  const aliasScope = "hermes:default:alias-crash:default";

  const seedStore = new Store(new NodeDriver(dbPath));
  try {
    seedStore.register(storedScope, {
      adapter_id: "hermes",
      adapter_protocol: 1,
      capabilities: { hide: true, summarize: false, unhide: true },
      enabled: true,
      instance_id: "hermes-seed",
    });
  } finally {
    seedStore.close();
  }

  try {
    const choiceRes = await state.client.request("dbChoice", {
      scope_key: storedScope,
      choice: "abort_request",
    });
    assert.equal(choiceRes.ok, true);

    // Crash idle writeWorker intentionally and wait for its removal.
    await writeWorker(state.client)!.terminate();

    // Hide on alias scope ("...:default") must respawn writeWorker with synced decisions and block with db_error.
    const blockedHide = await state.client.request("hide", {
      scope_key: aliasScope,
      item_id: "missing_item",
    });
    assert.equal(blockedHide.ok, false);
    assert.equal(blockedHide.error, "db_error");

    // List on alias scope must route to writeLane via alias detection and clear the decision.
    const clearList = await state.client.request("list", { scope_key: aliasScope });
    assert.equal(clearList.ok, true);

    // Subsequent hide bypasses db_error gate (proceeding to normal not_found).
    const afterClearHide = await state.client.request("hide", {
      scope_key: aliasScope,
      item_id: "missing_item",
    });
    assert.equal(afterClearHide.error, "not_found");

    // Verify send_original queued unawaited with 1st list, hide, 2nd list, hide maintains exact single-worker semantics.
    const pChoice = state.client.request("dbChoice", {
      scope_key: storedScope,
      choice: "send_original",
    });
    const pList1 = state.client.request("list", { scope_key: aliasScope });
    const pBlockedHide2 = state.client.request("hide", {
      scope_key: aliasScope,
      item_id: "missing_item",
    });
    const pList2 = state.client.request("list", { scope_key: aliasScope });
    const pClearHide2 = state.client.request("hide", {
      scope_key: aliasScope,
      item_id: "missing_item",
    });
    const [c2, l1, hBlocked2, l2, hClear2] = await Promise.all([
      pChoice,
      pList1,
      pBlockedHide2,
      pList2,
      pClearHide2,
    ]);
    assert.equal(c2.ok, true);
    assert.equal(l1.ok, true);
    assert.equal(hBlocked2.error, "db_error");
    assert.equal(l2.ok, true);
    assert.equal(hClear2.error, "not_found");
  } finally {
    state.close();
  }
});

test("setAdapterToggle unawaited barrier and external SQLite writer / same-ms control revision updates are observed immediately", async () => {
  const state = fixture();
  const dbPath = join(state.home, "state.sqlite3");
  const ompScope = "omp:default:toggle-causal:default";
  const [id1] = seedOmpScope(state.home, dbPath, ompScope, ["c1"]);

  try {
    // Warm readWorker first so host/adapter caches exist if any.
    const initialScopes = await state.client.request("scopes", {});
    assert.equal(initialScopes.ok, true);

    // Pause OMP via writeLane and immediately query on readLane without awaiting.
    const toggleOff = state.client.request("setAdapterToggle", {
      adapter: "omp",
      enabled: false,
    });
    const togglesRead = state.client.request("getAdapterToggles", {});
    const scopesRead = state.client.request("scopes", {});
    const listRead = state.client.request("list", { scope_key: ompScope });

    const [tRes, gRes, sRes, lRes] = await Promise.all([
      toggleOff,
      togglesRead,
      scopesRead,
      listRead,
    ]);
    assert.equal(tRes.ok, true);
    assert.equal(gRes.omp.enabled, false);
    assert.equal(
      sRes.scopes.find((s: any) => s.scope_key === ompScope)?.capabilities?.state,
      "adapter_disabled",
    );
    assert.equal(lRes.paused, true);
    assert.equal(lRes.capabilities.state, "adapter_disabled");

    // External writer modifies adapter_control (same timestamp -> revision bumps) and hides item directly in SQLite.
    let fixedNow = 1700000123.5;
    const extStore = new Store(new NodeDriver(dbPath), () => fixedNow);
    try {
      extStore.setAdapterControl("omp", true);
      const item = extStore.get(ompScope, id1);
      if (!item) {
        const res = extStore.put(
          ompScope,
          {
            item_id: id1,
            tool_call_id: "c1",
            result_position: 0,
            content_sha256: sha256("ext"),
            invocation_digest: invocationDigest({ tool_name: "read", arguments: { path: "/tmp/c1.txt" } }),
            original: "ext",
            compacted: "[hidden]",
            excerpt_lines: [],
            visibility: "hidden",
            version: 1,
            tool_name: "read",
            compaction_source: "explicit_user_hide",
            invocation_snapshot: { tool_name: "read", arguments: { path: "/tmp/c1.txt" } },
            context_hint: null,
            invocation_options_omitted: false,
            created_at: 0,
            updated_at: 0,
          },
          undefined,
          true,
        );
        assert.equal(res.ok, true);
      }
      // Also verify same-timestamp revision toggle: disable then immediately enable at exact same fixedNow.
      extStore.setAdapterControl("omp", false);
      extStore.setAdapterControl("omp", true);
    } finally {
      extStore.close();
    }

    const extScopes = await state.client.request("scopes", {});
    const extList = await state.client.request("list", { scope_key: ompScope });
    assert.equal(
      extScopes.scopes.find((s: any) => s.scope_key === ompScope)?.capabilities?.state,
      "ready",
    );
    assert.equal(extList.capabilities.state, "ready");
    assert.equal(extList.paused, undefined);
    assert.equal(extList.totals.hidden_count, 1);
  } finally {
    state.close();
  }
});
