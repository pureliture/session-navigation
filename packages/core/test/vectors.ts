import { readFileSync } from 'node:fs';
import { Engine, Store, canonical, invocationDigest, itemId, normalizeKeepLines, parseCanonicalJson, refusalReason, requiredEvidence, scopeAliases, selectRule, selectableText, sha256, splitLines, validateSummary, verifiedFacts, isDestructive, type Json, type RecordInput } from '../src/index.ts';
import { makeDriver } from './runtime.ts';
export interface TextVector {name:string;line:string;repeat:number;suffix:string;envelope?:boolean;numbered?:boolean;keep?:Json[];summary?:string}
export const fixtures = JSON.parse(readFileSync(new URL('../../../contracts/fixtures/core.json',import.meta.url),'utf8')) as {scope:string;canonical:string[];policies:TextVector[];summaries:{source:string;text:string}[];commands:string[];engine:TextVector[]};
export function body(v:TextVector):string {let content=Array(v.repeat).fill(v.line).join('\n')+(v.suffix ? '\n'+v.suffix:'');if(v.numbered)content=splitLines(content).map((line,i)=>`${i+1}|${line}`).join('\n');return v.envelope ? JSON.stringify({content,exit_code:0}):content;}
export function record(content:string,id='call'):RecordInput {const invocation={tool_name:'read_file',arguments:{path:'source.txt'}};return {call_id:id,result_position:0,content,content_sha256:sha256(content),invocation,invocation_digest:invocationDigest(invocation),status:'ok'};}
export function snapshot(store:Store):unknown {
  return Object.fromEntries(['meta','items','identities','units','calls','adapter_sessions','adapter_targets'].map(table=>[table,store.driver.all(`SELECT * FROM ${table} ORDER BY 1,2`).map(row=>{
    const result={...row};for(const key of ['created_at','updated_at','recorded_at','last_seen'])if(key in result)result[key]=0;
    for(const key of ['excerpt_lines','invocation_snapshot','context_hint','capabilities'])if(typeof result[key]==='string')result[key]=JSON.parse(String(result[key])) as never;
    return result;
  })]));
}
const summarizeResult=(result:Awaited<ReturnType<Engine['hide']>>)=>({ok:result.ok,error:result.error??null,plan:result.plan??null,item:result.item ? {...result.item,created_at:0,updated_at:0}:null,keep_lines_ignored:result.keep_lines_ignored??[],keep_lines_normalized:result.keep_lines_normalized??[]});
export async function runVectors():Promise<unknown> {
  const policies=fixtures.policies.map(v=>{const content=body(v),r=record(content),retention=normalizeKeepLines(selectableText(content),v.keep??[]);return {name:v.name,sha:sha256(content),digest:r.invocation_digest,id:itemId(fixtures.scope,r.call_id,r.content_sha256,r.invocation_digest),refusal:refusalReason(r)??null,source:selectableText(content),evidence:requiredEvidence(content),selected:selectRule(selectableText(content),retention.accepted)??null,retention,facts:verifiedFacts(content)};});
  const operations=[];
  for(const v of fixtures.engine){const store=new Store(makeDriver(':memory:')),engine=new Engine(store),r=record(body(v));
    const hide=await engine.hide(fixtures.scope,r,v.summary ? {summarizer:async()=>({summary:v.summary})}:{});const id=itemId(fixtures.scope,r.call_id,r.content_sha256,r.invocation_digest);
    const conflict=engine.unhide(fixtures.scope,id,99),unhide=engine.unhide(fixtures.scope,id,1),rehide=await engine.hide(fixtures.scope,r);
    const fork=store.fork(fixtures.scope,'hermes:default:child:unknown');
    operations.push({name:v.name,hide:summarizeResult(hide),conflict:summarizeResult(conflict),unhide:summarizeResult(unhide),rehide:summarizeResult(rehide),fork,rows:snapshot(store)});store.close();
  }
  const store=new Store(makeDriver(':memory:')),scope=fixtures.scope;
  const owner={adapter_id:'hermes',adapter_protocol:1,capabilities:{hide:true,summarize:false,unhide:true},enabled:true,instance_id:'fixture'};
  const registered=[store.register(scope,owner,100),store.register(scope,owner,101),store.register(scope,owner,400)];
  const capability=[store.can(scope,'hide'),store.can(scope,'summarize'),store.can(scope.replace(/unknown$/,'default'),'hide')];
  const targets=Array.from({length:258},(_,i)=>({record:record(`original ${i}`,String(i))}));store.publishTargets(scope,targets);
  const targetCalls=store.targets(scope).map(row=>row.tool_call_id);
  store.ensureMessages(scope,[{unit_id:'message',kind:'user',content_sha256:sha256('hi'),char_count:2}]);
  const messages=[store.setMessageVisibility(scope,'message','user',sha256('hi'),2,'hidden',1),store.setMessageVisibility(scope,'message','user',sha256('hi'),2,'visible',1)];
  store.recordCall(scope,'usage',10,20,30,0.25,100);
  const schemaInfo=Object.fromEntries(['meta','items','identities','units','calls','adapter_sessions','adapter_targets'].map(table=>[table,store.driver.all(`PRAGMA table_info(${table})`)]));
  const shared={registered,capability,targetCalls,messages,hidden:store.hiddenMessages(scope),rows:snapshot(store),schemaInfo};
  const engine=new Engine(store),r=record(body(fixtures.engine[0]),'pending'),item=(await engine.hide(scope,r)).item!;
  store.put(scope,{...item,compaction_source:'summarize_pending',version:2},1);
  const pending=[summarizeResult(engine.settlePending(scope,item.item_id,2,'Routine catalog annotation with no special facts.')),summarizeResult(engine.settlePending(scope,item.item_id,2,'Routine catalog annotation.'))];
  store.close();
  return {canonical:fixtures.canonical.map(raw=>canonical(parseCanonicalJson(raw))),aliases:scopeAliases(fixtures.scope),policies,summaries:fixtures.summaries.map(v=>validateSummary(v.source,{summary:v.text},[])??null),commands:fixtures.commands.map(command=>isDestructive('bash',{command})),operations,shared,pending};
}
