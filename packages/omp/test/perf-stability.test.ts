import { expect, test } from "bun:test";
import { Store } from "../../core/src/index.ts";
import { BunDriver } from "../../core/src/drivers/bun.ts";
import { OmpService } from "../src/service.ts";
import { WorkerClient, type WorkerTransport } from "../src/client.ts";
import { ADAPTER_RPC_TIMEOUT_MS, prepareSnapshot, type RecordItem } from "../src/context.ts";
import { clearOmpPerf, recentOmpPerf, recordOmpPerf } from "../src/diagnostics.ts";

test("prepareSnapshot sends include_candidates=false only on intermediate append chunks and computes final candidates", async () => {
  const store = new Store(new BunDriver(":memory:"));
  const svc = new OmpService(store);
  const records: RecordItem[] = Array.from({ length: 150 }, (_, i) => ({
    call_id: `call-${i}`,
    tool_name: "read",
    arguments: { path: `/tmp/file_${i}.txt` },
    status: "ok",
    content: Array.from({ length: 80 }, (_, k) => `line ${k} of call ${i} with enough detail to qualify`).join("\n"),
  }));
  const sentParams: any[] = [];
  const replies: any[] = [];

  const reply = await prepareSnapshot(
    records,
    "omp-multi-chunk",
    "tok-1",
    async (method, params) => {
      sentParams.push(params);
      const r = await svc.handle(method, params);
      replies.push(r);
      return r;
    },
  );

  expect(reply.ok).toBe(true);
  expect(sentParams.length).toBe(3); // 64 + 64 + 22
  expect("include_candidates" in sentParams[0]).toBe(false);
  expect(replies[0].eligible_count).toBe(64);
  expect(sentParams[1].append).toBe(true);
  expect(sentParams[1].include_candidates).toBe(false);
  expect(replies[1].eligible_count).toBeUndefined();
  expect(sentParams[2].append).toBe(true);
  expect("include_candidates" in sentParams[2]).toBe(false);
  expect(reply.eligible_count).toBe(150);

  const unitRows = store.listUnits("omp:default:omp-multi-chunk:default");
  expect(unitRows.length).toBe(150);
  store.close();
});

test("OMP WorkerClient records safe diagnostics and respects ADAPTER_RPC_TIMEOUT_MS >= SQLite busy_timeout", async () => {
  expect(ADAPTER_RPC_TIMEOUT_MS).toBeGreaterThanOrEqual(8000);
  clearOmpPerf();
  let terminated = false;
  const fakeWorker: WorkerTransport = {
    onmessage: null,
    onerror: null,
    postMessage() {
      // Simulate slow worker without reply to test soft timeout diagnostics.
    },
    terminate() {
      terminated = true;
    },
  };
  const client = new WorkerClient(":memory:", () => {}, () => fakeWorker);
  const reply = await client.request(
    "record_summary_call",
    { session_id: "s1", call_key: "k1" },
    15,
    undefined,
    { invalidateOnTimeout: false },
  );
  expect(reply).toEqual({ ok: false, error: "timeout" });
  expect(terminated).toBe(false);
  const last = recentOmpPerf(1)[0];
  expect(last?.op).toBe("worker.record_summary_call");
  expect(last?.timed_out).toBe(true);
  expect(last?.invalidated).toBe(false);
  client.close();
});

test("OMP diagnostics strip content/secrets and never write to stdout", () => {
  clearOmpPerf();
  const prev = process.env.SESSION_NAVIGATION_PERF_DIAG;
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  let out = "";
  let err = "";
  process.stdout.write = ((chunk: any) => {
    out += String(chunk);
    return true;
  }) as any;
  process.stderr.write = ((chunk: any) => {
    err += String(chunk);
    return true;
  }) as any;
  try {
    process.env.SESSION_NAVIGATION_PERF_DIAG = "verbose";
    const entry = recordOmpPerf({
      op: "prepare",
      duration_ms: 9.1,
      ok: true,
      unit_count: 64,
      ...({
        original: "secret tool output",
        command: "curl -H 'Authorization: secret'",
        api_key: "secret-key",
      } as any),
    });
    expect((entry as any).original).toBeUndefined();
    expect((entry as any).command).toBeUndefined();
    expect((entry as any).api_key).toBeUndefined();
    expect(out).toBe("");
    expect(err).not.toContain("secret-key");
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    if (prev === undefined) delete process.env.SESSION_NAVIGATION_PERF_DIAG;
    else process.env.SESSION_NAVIGATION_PERF_DIAG = prev;
    clearOmpPerf();
  }
});
