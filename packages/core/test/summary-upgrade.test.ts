import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine, Store, summaryFeedback } from "../src/index.ts";
import { makeDriver } from "./runtime.ts";
import { record, upgradeVectors } from "./vectors.ts";

test("summary upgrades, retry success/failure, cached idempotence and CAS race", async () => {
  const rows = await upgradeVectors();
  assert.deepEqual(rows.map(r => [r.name,r.ok,r.source,r.version,r.calls,r.cached_calls]), [
    ["upgrade",true,"llm",2,1,0], ["retry-success",true,"llm",2,2,0],
    ["retry-failure",false,"rule",1,2,0], ["fresh-retry",true,"llm",1,2,0],
    ["cas-race",false,"rule",2,1,0],
  ]);
  assert.equal(rows[2].error,"verification_failed");
  assert.equal(rows[4].error,"version_conflict");
  assert.ok(rows.every(r => r.original && r.restored));
  assert.ok(rows[1].feedback?.includes('"100"'));
});

test("both invalid and corrected responses are accounted, no third attempt", async () => {
  const store = new Store(makeDriver(":memory:")), engine = new Engine(store);
  const input = record("Routine annotation details.\n".repeat(100) + "Count 42.");
  const before = await engine.hide("usage",input);
  let calls=0;
  const result = await engine.summarize("usage",input,async () => {
    calls++;
    store.recordCall("usage",String(calls),10,5,15,.01);
    return {summary:"Count 100."};
  });
  assert.equal(calls,2);
  assert.equal(result.error,"verification_failed");
  assert.equal(store.items("usage")[0].compacted,before.item!.compacted);
  assert.deepEqual(store.driver.get("SELECT COUNT(*) AS n, SUM(total_tokens) AS tokens, SUM(cost_usd) AS cost FROM calls"),{n:2,tokens:30,cost:.02});
  store.close();
});

test("English feedback identifies changed numbers, identifiers, paths and missing critical facts", () => {
  const feedback=summaryFeedback("cedar-app package; 42 checks passed. id: alpha\n/known/source.txt",{summary:"100 checks failed. id: beta /unknown/source.txt"},[]);
  for(const fact of ["100","id: beta","/unknown/source.txt","cedar-app package","42 checks passed"]) assert.ok(feedback.includes(fact));
});

test("manual hide then summarize upgrade preserves visibility, version chain and original", async () => {
  const store = new Store(makeDriver(":memory:")), engine = new Engine(store);
  const source = "Routine annotation details.\n".repeat(100) + "Count 42.";
  const input = record(source);
  const hidden = await engine.hide("usage", input);
  assert.equal(hidden.ok, true);
  assert.equal(hidden.item?.visibility, "hidden");
  const before = store.items("usage")[0];
  const upgraded = await engine.summarize("usage", input, async () => ({ summary: "Count 42." }));
  assert.equal(upgraded.ok, true);
  const after = store.get("usage", before.item_id);
  assert.equal(after?.visibility, "hidden");
  assert.equal(after?.version, before.version + 1);
  assert.equal(after?.original, source);
  assert.equal(after?.compacted, upgraded.item?.compacted);
  assert.equal(after?.compaction_source, "llm");
  assert.equal(after?.content_sha256, before.content_sha256);
  assert.equal(after?.invocation_digest, before.invocation_digest);
  assert.equal(after?.tool_name, before.tool_name);
  const restored = engine.unhide("usage", before.item_id, after?.version);
  assert.equal(restored.ok, true);
  assert.equal(restored.item?.visibility, "visible");
  assert.equal(restored.item?.original, source);
  store.close();
});

test("message unhide is not blocked by a history size cap", () => {
  const store = new Store(makeDriver(":memory:"));
  // Larger than the 256 MiB history cap enforced elsewhere: the core restore
  // path must still unhide without a size gate.
  const big = "z".repeat(257 * 1024 * 1024);
  const put = store.put("usage", {
    item_id: "big", tool_call_id: "big", result_position: 0,
    content_sha256: "sha", invocation_digest: "digest", original: big,
    compacted: "c", excerpt_lines: [], visibility: "hidden", version: 1,
    tool_name: "read", compaction_source: "rule", invocation_snapshot: null,
    context_hint: null, invocation_options_omitted: false, created_at: 0, updated_at: 0,
  }, undefined, true);
  assert.equal(put.ok, true);
  const restored = store.restore("usage", "big", 1);
  assert.equal(restored.ok, true);
  assert.equal(restored.item?.visibility, "visible");
  assert.equal(restored.item?.original.length, big.length);
  assert.ok(restored.item?.original.startsWith("z".repeat(1024)));
  store.close();
});
