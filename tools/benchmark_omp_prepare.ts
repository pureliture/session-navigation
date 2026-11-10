/** Run after building packages/omp: bun tools/benchmark_omp_prepare.ts */
import { mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WorkerClient } from "../packages/omp/src/client.ts";
import { prepareSnapshot } from "../packages/omp/src/context.ts";

const directory = mkdtempSync(join(homedir(), "session-navigation-prepare-bench-"));
console.log(`Benchmark databases: ${directory}`);
for (const [count, size] of [[2000, 1024], [5000, 1024], [2048, 10 * 1024]]) {
  const client = new WorkerClient(join(directory, `${count}-${size}.sqlite3`));
  let chunks = 0;
  let largestRequest = 0;
  const send = (method: string, params: object, timeout = 5000) => {
    if (method === "prepare") { chunks++; largestRequest = Math.max(largestRequest, Buffer.byteLength(JSON.stringify(params))); }
    return client.request(method, params, timeout);
  };
  try {
    const content = Array.from({ length: 40 }, (_, index) => `Output row ${index}: ` + "x".repeat(70)).join("\n").slice(0, size).padEnd(size, "x");
    const records = Array.from({ length: count }, (_, index) => ({ call_id: `call-${index+1}`, tool_name: "read", arguments: { path: `file-${index+1}` }, status: "ok", content }));
    await prepareSnapshot([records[0], records[1499]], "benchmark", "seed", send);
    for (const id of ["call-1", "call-1500"]) {
      const reply = await send("compact", { session_id: "benchmark", snapshot_id: "seed", tool_call_id: id });
      if (!reply.ok) throw new Error(JSON.stringify(reply));
    }
    const samples: number[] = [];
    for (let run = 0; run < 3; run++) {
      chunks = 0;
      largestRequest = 0;
      const start = performance.now();
      const reply = await prepareSnapshot(records, "benchmark", `run-${run}`, send);
      samples.push(Math.round((performance.now() - start) * 100) / 100);
      if (!reply.ok || JSON.stringify(reply.patches?.map(patch => patch.call_id)) !== '["call-1","call-1500"]') throw new Error(JSON.stringify(reply));
    }
    console.log(JSON.stringify({ records: count, content_bytes: count * size, chunks, largest_request_bytes: largestRequest, samples_ms: samples }));
  } finally { client.close(); }
}
