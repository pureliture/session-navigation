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
