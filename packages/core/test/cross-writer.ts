import assert from 'node:assert/strict';
import { Engine, Store } from '../src/index.ts';
import { makeDriver } from './runtime.ts';
import { body, fixtures, record } from './vectors.ts';
const [path,mode]=process.argv.slice(2),store=new Store(makeDriver(path)),engine=new Engine(store),scope=fixtures.scope;
if(mode==='read-python') {
  const [item]=store.items(scope);assert.equal(item.visibility,'hidden');assert.equal(item.original,body(fixtures.engine[0]));assert.equal(engine.unhide(scope,item.item_id,1).ok,true);
  store.register(scope,{adapter_id:'hermes',adapter_protocol:1,instance_id:'ts-cross',capabilities:{hide:true,summarize:false,unhide:true},enabled:true});
  store.publishTargets(scope,[{record:record(item.original)}]);
} else if(mode==='write-ts')assert.equal((await engine.hide(scope,record(body(fixtures.engine[0])))).ok,true);
else {const [item]=store.items(scope);assert.equal(item.visibility,'visible');assert.equal(item.version,2);assert.equal(item.original,body(fixtures.engine[0]));}
store.close();
