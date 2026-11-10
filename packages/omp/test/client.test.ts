import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../core/src/index.ts";
import { BunDriver } from "../../core/src/drivers/bun.ts";
import { WorkerClient, type WorkerTransport } from "../src/client.ts";

class FakeWorker implements WorkerTransport {
  onmessage: WorkerTransport["onmessage"] = null;
  onerror: WorkerTransport["onerror"] = null;
  requests: any[] = [];
  terminated = false;
  postMessage(value: unknown): void {
    this.requests.push(value);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(index: number, reply = { ok: true }): void {
    this.onmessage?.({ data: { id: this.requests[index].id, reply } } as MessageEvent);
  }
}

test("worker requests serialize and correlate replies", async () => {
  const worker = new FakeWorker();
  const client = new WorkerClient(":memory:", undefined, () => worker);
  const first = client.request("prepare", {}, 1000);
  const second = client.request("compact", {}, 1000);
  await Promise.resolve();
  expect(worker.requests).toHaveLength(1);
  worker.reply(0);
  expect((await first).ok).toBe(true);
  await Promise.resolve();
  expect(worker.requests).toHaveLength(2);
  worker.reply(1);
  expect((await second).ok).toBe(true);
  client.close();
  expect(worker.terminated).toBe(true);
});

test("timeout terminates worker, clears snapshots and ignores late responses", async () => {
  const worker = new FakeWorker();
  let invalidated = 0;
  const client = new WorkerClient(
    ":memory:",
    () => invalidated++,
    () => worker,
  );
  const response = await client.request("prepare", {}, 10);
  expect(response.error).toBe("timeout");
  expect(worker.terminated).toBe(true);
  expect(invalidated).toBe(1);
  worker.reply(0);
  expect((await client.request("compact", {}, 1000)).error).toBe("cooldown");
  client.close();
});

test("in-flight and queued cancellation invalidate the snapshot and do not write", async () => {
  const worker = new FakeWorker();
  let invalidated = 0;
  const client = new WorkerClient(
    ":memory:",
    () => invalidated++,
    () => worker,
  );
  const controller = new AbortController();
  const response = client.request("compact", {}, 1000, controller.signal);
  await Promise.resolve();
  controller.abort();
  expect((await response).error).toBe("cancelled");
  expect(worker.terminated).toBe(true);
  expect(invalidated).toBe(1);
  const cancelled = new AbortController();
  cancelled.abort();
  expect((await client.request("compact", {}, 1000, cancelled.signal)).error).toBe("cancelled");
  expect(worker.requests).toHaveLength(1);
  client.close();
});

test("worker crash, postMessage failure, malformed reply and shutdown settle pending calls", async () => {
  for (const mode of ["crash", "post", "malformed", "shutdown"] as const) {
    const worker = new FakeWorker();
    if (mode === "post")
      worker.postMessage = () => {
        throw new Error("cannot send");
      };
    const client = new WorkerClient(":memory:", undefined, () => worker);
    const response = client.request("prepare", {}, 1000);
    await Promise.resolve();
    if (mode === "crash") worker.onerror?.({} as ErrorEvent);
    if (mode === "malformed") worker.onmessage?.({ data: {} } as MessageEvent);
    if (mode === "shutdown") client.close();
    expect((await response).error).toBe(
      mode === "malformed" ? "invalid_response" : mode === "shutdown" ? "shutdown" : "worker_error",
    );
    expect(worker.terminated).toBe(true);
    client.close();
  }
});

test("SQLite lock waits in the actual worker leave the main loop responsive", async () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-lock-"));
  const path = join(directory, "state.sqlite3");
  const store = new Store(new BunDriver(path));
  const client = new WorkerClient(path);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try {
    expect((await client.request("ping", {}, 5000)).ok).toBe(true);
    store.driver.exec("BEGIN IMMEDIATE");
    ticks = 0;
    const response = client.request(
      "prepare",
      { session_id: "responsive", snapshot_id: "one", records: [] },
      5000,
    );
    await Bun.sleep(100);
    expect(ticks).toBeGreaterThan(5);
    store.driver.exec("ROLLBACK");
    expect((await response).ok).toBe(true);
  } finally {
    clearInterval(timer);
    client.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
