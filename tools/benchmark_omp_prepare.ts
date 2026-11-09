/** Run from the repo root with: bun tools/benchmark_omp_prepare.ts */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { prepareSnapshot } from "../extensions/pi/session-navigation";

const directory = mkdtempSync(join(homedir(), "session-navigation-prepare-bench-"));
console.log(`Benchmark databases: ${directory}`);

for (const [count, size] of [[2000, 1024], [5000, 1024], [2048, 10 * 1024]]) {
  const child = spawn(resolve(".venv/bin/python"), ["-m", "session_navigation_omp.daemon"], {
    env: { ...process.env, PYTHONPATH: resolve("src"),
      SESSION_NAVIGATION_STATE_PATH: join(directory, `${count}-${size}.sqlite3`) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  let nextId = 0, wireBytes = 0, chunks = 0, stderr = "";
  let pending: { resolve: (reply: any) => void; reject: (error: Error) => void } | undefined;
  child.stderr.on("data", (data) => { stderr += data; });
  child.on("error", (error) => pending?.reject(error));
  child.on("exit", () => pending?.reject(new Error(`daemon exited: ${stderr}`)));
  lines.on("line", (line) => {
    try { pending?.resolve(JSON.parse(line)); } catch (error) { pending?.reject(error as Error); }
  });
  const send = (method: string, params: object, timeout = 5000): Promise<any> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("daemon timeout")); }, timeout);
    pending = { resolve: (reply) => { clearTimeout(timer); pending = undefined; resolve(reply); },
      reject: (error) => { clearTimeout(timer); pending = undefined; reject(error); } };
    const request = JSON.stringify({ id: ++nextId, method, params }) + "\n";
    if (method === "prepare") { wireBytes = Math.max(wireBytes, Buffer.byteLength(request)); chunks++; }
    child.stdin.write(request, (error) => { if (error) pending?.reject(error); });
  });
  try {
    const hello = await send("ping", {});
    if (!hello.ok) throw new Error(JSON.stringify(hello));
    const text = Array.from({ length: 40 }, (_, i) => `Output row ${i}: ` + "x".repeat(70)).join("\n");
    const content = text.slice(0, size).padEnd(size, "x");
    const records = Array.from({ length: count }, (_, i) => ({ call_id: `call-${i + 1}`,
      tool_name: "read", arguments: { path: `file-${i + 1}` }, status: "ok", content }));
    const seed = await prepareSnapshot([records[0], records[1499]], "benchmark", "seed", send);
    if (!seed.ok) throw new Error(JSON.stringify(seed));
    for (const id of ["call-1", "call-1500"]) {
      const hidden = await send("compact", { session_id: "benchmark", snapshot_id: "seed", tool_call_id: id });
      if (!hidden.ok) throw new Error(JSON.stringify(hidden));
    }
    const samples: number[] = [];
    for (let run = 0; run < 3; run++) {
      wireBytes = 0; chunks = 0;
      const start = performance.now();
      const response = await prepareSnapshot(records, "benchmark", `run-${run}`, send);
      samples.push(Number((performance.now() - start).toFixed(2)));
      if (!response.ok || JSON.stringify(response.patches?.map((p) => p.call_id)) !== '["call-1","call-1500"]') {
        throw new Error(JSON.stringify(response));
      }
    }
    console.log(JSON.stringify({ records: count, content_bytes: count * size, chunks,
      largest_request_bytes: wireBytes, samples_ms: samples,
      median_ms: [...samples].sort((a, b) => a - b)[1], patched: ["call-1", "call-1500"] }));
  } finally {
    child.stdin.end();
    await new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.once("exit", () => resolve()); });
    lines.close();
  }
}
