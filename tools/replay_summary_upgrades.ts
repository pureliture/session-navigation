import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Engine, Store, invocationDigest, sha256 } from "../packages/core/src/index.ts";
import { BunDriver } from "../packages/core/src/drivers/bun.ts";

const rows=JSON.parse(readFileSync(process.argv[2],"utf8")).slice(0,4);
const corrected=rows.find((row:any)=>row.accepted);
for(const row of rows) {
  const store=new Store(new BunDriver(":memory:")),engine=new Engine(store);
  const invocation={tool_name:"read",arguments:{path:"audit-01.jsonl"}};
  const record={call_id:"read",content:row.source,content_sha256:sha256(row.source),invocation,invocation_digest:invocationDigest(invocation),status:"ok",result_position:0};
  assert.ok((await engine.hide("replay",record)).ok);
  const calls:(string|undefined)[]=[];
  const result=await engine.summarize("replay",record,async (_source,_required,_invocation,feedback)=>{
    calls.push(feedback);
    return {summary:calls.length===1?row.summary:corrected.summary};
  });
  assert.ok(result.ok,result.error);
  assert.equal(result.item!.compaction_source,"llm");
  assert.equal(result.item!.version,2);
  assert.equal(result.item!.original,row.source);
  assert.equal(calls.length,row.accepted?1:2);
  if(!row.accepted) assert.ok(calls[1]!.includes(row.trace.token));
  assert.equal(engine.unhide("replay",result.item!.item_id,2).item!.original,row.source);
  console.log("PASS TS captured",row.id,"Hide -> LLM upgrade; calls",calls.length,"; restore exact");
  store.close();
}
