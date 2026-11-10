import { EngineError } from './driver.ts';
import { evaluateCompaction } from './compaction.ts';
import { defaults, itemId, scopeKey, type Config, type Item, type Json, type Plan, type RecordInput, type Result, type ScopeLike } from './model.ts';
import { isDestructive, normalizeKeepLines, refusalReason, requiredEvidence, selectRule, selectableText } from './policy.ts';
import { validateSummary } from './summary.ts';
import { Store } from './store.ts';
export type Summarizer=(original:string,evidence:string[],invocation:Json)=>Promise<unknown>;
export class Engine {
  private pending=new Set<string>();
  readonly store:Store;
  readonly config:Config;
  constructor(store:Store,config:Config=defaults) {this.store=store;this.config=config;}
  private plan(item:Item,record:RecordInput):Plan {return {item_id:item.item_id,expected_content_sha256:record.content_sha256,replacement_text:item.compacted,visibility_version:item.version,tool_call_id:record.call_id,...(record.host_handle===undefined ? {}:{host_handle:record.host_handle})};}
  async hide(scope:ScopeLike,record:RecordInput,options:{keep_lines?:Json;options_omitted?:boolean;summarizer?:Summarizer;allow_fallback?:boolean}={}):Promise<Result> {
    if(options.keep_lines!==undefined && options.summarizer)return {ok:false,error:'invalid_keep_lines_action'};
    if(options.keep_lines!==undefined && !Array.isArray(options.keep_lines))return {ok:false,error:'invalid_keep_lines'};
    const retention=normalizeKeepLines(selectableText(record.content),(options.keep_lines??[]) as Json[]);
    const diagnostics={keep_lines_ignored:retention.ignored,keep_lines_normalized:retention.normalized};
    try {return {...await this.apply(scope,record,retention.accepted,options),...diagnostics};}catch(e){if(e instanceof EngineError)return {ok:false,error:e.code,...diagnostics};throw e;}
  }
  summarize(scope:ScopeLike,record:RecordInput,summarizer:Summarizer,options_omitted=false):Promise<Result> {return this.hide(scope,record,{summarizer,allow_fallback:false,options_omitted});}
  private async apply(scope:ScopeLike,record:RecordInput,keep:string[],options:{options_omitted?:boolean;summarizer?:Summarizer;allow_fallback?:boolean}):Promise<Result> {
    const refused=refusalReason(record,this.config);if(refused)return {ok:false,error:refused};
    const id=itemId(scope,record.call_id,record.content_sha256,record.invocation_digest,record.result_position),existing=this.store.get(scope,id);
    if(existing){if(keep.some(line=>!existing.compacted.includes(line)))return {ok:false,error:'keep_lines_conflict'};if(existing.invocation_digest!==record.invocation_digest)return {ok:false,error:'invocation_conflict'};
      const result=existing.visibility==='hidden' ? {ok:true,item:existing} : this.store.put(scope,{...existing,visibility:'hidden',version:existing.version+1},existing.version);return result.ok ? {...result,plan:this.plan(result.item!,record)}:result;}
    const baseline=selectRule(selectableText(record.content),keep,this.config);if(!baseline)return {ok:false,error:'verification_failed'};
    const key=`${scopeKey(scope)}\0${id}`;if(this.pending.has(key))return {ok:false,error:'in_progress'};if(this.pending.size>=this.config.max_pending)return {ok:false,error:'pending_full'};this.pending.add(key);
    try {
      let summary:unknown;
      if(options.summarizer)try{summary=(await options.summarizer(record.content,requiredEvidence(record.content),record.invocation))??null;}catch(e){if(options.allow_fallback===false)return {ok:false,error:typeof (e as {reason?:unknown}).reason==='string' ? (e as {reason:string}).reason:'summarization_failed'};}
      const evaluated=evaluateCompaction(record.content,id,selectableText(record.content),baseline,summary,record.invocation,options.options_omitted,options.allow_fallback!==false);
      if(evaluated.error || !evaluated.choice || evaluated.rendered===undefined)return {ok:false,error:evaluated.error??'verification_failed'};
      const choice=evaluated.choice,item:Item={item_id:id,tool_call_id:record.call_id,result_position:record.result_position,content_sha256:record.content_sha256,invocation_digest:record.invocation_digest,original:record.content,compacted:evaluated.rendered,excerpt_lines:choice.lines,visibility:'hidden',version:1,tool_name:typeof record.invocation.tool_name==='string' ? record.invocation.tool_name:null,compaction_source:choice.source,invocation_snapshot:choice.source==='llm' ? record.invocation:null,context_hint:null,invocation_options_omitted:choice.source==='llm' && !!options.options_omitted,created_at:0,updated_at:0};
      if(this.store.get(scope,id))return {ok:false,error:'version_conflict'};
      const result=this.store.put(scope,item,undefined,true);return result.ok ? {...result,plan:this.plan(item,record)}:result;
    }finally{this.pending.delete(key);}
  }
  unhide(scope:ScopeLike,id:string,version?:number):Result {try{return this.store.restore(scope,id,version);}catch(e){if(e instanceof EngineError)return {ok:false,error:e.code};throw e;}}
  project(scope:ScopeLike,records:RecordInput[]):Plan[] {return records.flatMap(record=>{const item=this.store.get(scope,itemId(scope,record.call_id,record.content_sha256,record.invocation_digest,record.result_position));return item?.visibility==='hidden' ? [this.plan(item,record)]:[];});}
  listItems(scope:ScopeLike,query=''):Item[] {return this.store.items(scope).filter(item=>!query || item.compacted.toLowerCase().includes(query.toLowerCase()) || item.item_id.toLowerCase().includes(query.toLowerCase()));}
  async manage(scope:ScopeLike,records:RecordInput[],ids:string[],action:'hide'|'summarize'|'auto',summarizer?:Summarizer,keep_lines?:Json):Promise<{id:string;result:Result}[]> {
    const results:{id:string;result:Result}[]=[];
    for(const id of [...new Set(ids)]){const matches=records.filter(r=>r.call_id===id);let result:Result;
      if(!matches.length)result={ok:false,error:'not_found'};else if(matches.length>1)result={ok:false,error:'ambiguous'};else{const record=matches[0];const item=this.store.get(scope,itemId(scope,id,record.content_sha256,record.invocation_digest,record.result_position));
        if(item?.visibility==='hidden')result={ok:false,error:'already_hidden'};else if(isDestructive(record.invocation.tool_name,record.invocation.arguments))result={ok:false,error:'destructive_command'};
        else if(action==='summarize' && !summarizer)result={ok:false,error:'summarizer_unavailable'};
        else result=await this.hide(scope,record,{keep_lines,summarizer:action==='hide' ? undefined:summarizer,allow_fallback:action!=='summarize'});}
      results.push({id,result});
    }return results;
  }
  settlePending(scope:ScopeLike,id:string,version:number,text?:string):Result {
    const item=this.store.get(scope,id);if(!item || item.version!==version)return {ok:false,error:'version_conflict',item};
    if(item.visibility!=='hidden' || item.compaction_source!=='summarize_pending')return {ok:false,error:'not_pending',item};
    const words=new Set(item.original.toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu)??[]);
    const valid=typeof text==='string' && [...text].length<[...item.original].length && (text.toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu)??[]).some(w=>words.has(w)) && validateSummary(item.original,{summary:text},requiredEvidence(item.original),item.invocation_snapshot);
    const result=this.store.put(scope,{...item,compacted:valid ? text! : item.compacted,compaction_source:valid ? 'llm_summary':'explicit_user_hide',version:version+1},version);
    return result.ok && text!==undefined && !valid ? {...result,ok:false,error:'verification_failed'}:result;
  }
}
