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
