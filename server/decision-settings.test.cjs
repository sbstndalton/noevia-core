'use strict';
// Needs dav-parse.wasm: provider egress is Rust-only since #1071. Skipped without it unless DAV_PARSE_WASM_REQUIRED=1.
if (!require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1') {
  require('node:test').test('needs dav-parse.wasm (not built)', { skip: 'dav-parse.wasm not built' }, () => {});
  return;
}
// #2190: the Rust front writes the decision configuration (its validation, audit and connection test
// are tested in noevia-rs tests/decision_settings.rs). Here: Node re-reads what Rust wrote on every use.
const test=require('node:test'),assert=require('node:assert/strict');
const {createDecisionSettings}=require('./decision-settings.cjs');
const {createFeatures}=require('../tests/server/oracles/features-legacy.cjs');
const {createSystemOneRouter}=require('./system-one-router.cjs');
const {rustSavesDecision,rustResetsDecision}=require('../tests/server/rust-decision-row.cjs');
function fixture(fetchImpl=async()=>Response.json({ready:true})) {
  const map=new Map(),store={get:k=>map.get(k),set:(k,v)=>map.set(k,v),delete:k=>map.delete(k)};
  const settings=createDecisionSettings({store,env:{},fetchImpl});
  const features=createFeatures({store,env:{},availability:{stepSupervision:settings.unavailable,systemOneRouting:settings.unavailable}});
  return {store,settings,features};
}
test('a save by the Rust front unlocks both experiments at once, with no restart',()=>{
  const {store,settings,features}=fixture();
  assert.throws(()=>features.set('systemOneRouting',true,'admin'),/Set up/);
  rustSavesDecision(store,{url:'http://laya:8040',timeoutMs:900});
  for(const feature of ['stepSupervision','systemOneRouting']) {features.set(feature,true,'admin');assert.equal(features.enabled(feature),true);}
  assert.deepEqual(settings.get(),{url:'http://laya:8040',timeoutMs:900,source:'admin'});
  rustResetsDecision(store);
  assert.deepEqual(settings.get(),{url:'',timeoutMs:1500,source:'deployment'},'a reset is seen on the next use too');
});
test('the write API is gone: Node never writes the row',()=>{
  const {settings}=fixture();
  for(const name of ['save','reset','test']) assert.equal(name in settings,false,name);
});
test('Laya routing follows each Rust save on the next decision (live endpoint replacement)',async()=>{
  const urls=[];const {store,settings}=fixture(async(url,init)=>{urls.push(url);const body=JSON.parse(init.body);assert.deepEqual(body.options.map(o=>o.id),['fast','smart']);return Response.json({selected:'smart',scores:{fast:0.2,smart:0.8}});});
  rustSavesDecision(store,{url:'http://laya:8040',timeoutMs:1000});
  const router=createSystemOneRouter({enabled:()=>true,roles:()=>({fast:'a',smart:'b'}),fallback:()=>assert.fail('Unexpected fallback'),getBackend:settings.backend,getDeadlineMs:()=>settings.get().timeoutMs});
  assert.equal(await router.classify('synthetic task'),'smart');
  rustSavesDecision(store,{url:'http://127.0.0.1:8041',timeoutMs:1000});
  assert.equal(await router.classify('second tenant synthetic task'),'smart');
  assert.deepEqual(urls,['http://laya:8040/v1/decisions','http://127.0.0.1:8041/v1/decisions']);
});
test('a chosen model is read back as stored; rows Node cannot parse keep the old fallbacks',()=>{
  const {store,settings}=fixture();
  rustSavesDecision(store,{url:'http://laya:8040',timeoutMs:900,model:'kev-0.8b'});
  assert.equal(settings.get().model,'kev-0.8b');
  store.set('decision:configuration','{');
  assert.deepEqual(settings.get(),{url:'',timeoutMs:1500,source:'admin'});
  store.set('decision:configuration','null');
  assert.equal(settings.get().source,'deployment');
});
