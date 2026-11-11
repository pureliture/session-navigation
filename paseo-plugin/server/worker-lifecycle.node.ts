import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
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
