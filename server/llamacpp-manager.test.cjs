'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {createModelManager}=require('./model-manager.cjs');
const {resolveRuntimeLimit}=require('./chat-context.cjs');
function fixture(){
 const calls=[];let loaded=false;
 const manager=createModelManager({fetchStream:async()=>({ok:false}),kind:'llamacpp',baseUrl:'http://synthetic-router/v1/',apiKey:'fixture-key',fetchJson:async(url,options)=>{
  calls.push({url,options});const path=new URL(url).pathname;
  if(path==='/models/load')loaded=true;
  return {ok:true,status:200,body:path==='/models'?{data:[{id:'fixture/model:Q8_0',status:{value:loaded?'loaded':'unloaded'},meta:{n_ctx_train:262144}}]}:path==='/props'?{default_generation_settings:{n_ctx:32768},total_slots:4}:{success:true}};
 }});return{manager,calls};
}
test('native model lifecycle uses router endpoints and model keys',async()=>{
 const {manager,calls}=fixture();await manager.load('fixture/model:Q8_0');await manager.unload('fixture/model:Q8_0');
 assert.equal(calls[0].url,'http://synthetic-router/models/load');assert.deepEqual(JSON.parse(calls[0].options.body),{model:'fixture/model:Q8_0'});
 assert.equal(calls[2].url,'http://synthetic-router/models/unload');assert.equal(calls[0].options.headers.Authorization,'Bearer fixture-key');
 assert.equal((await manager.load('fixture/model',{save_options:true})).status,501);
});
test('cold model loads before live allocation check; architecture maximum is not used',async()=>{
 const {manager,calls}=fixture();const value=await resolveRuntimeLimit({manager,model:'fixture/model:Q8_0'});
 assert.equal(value.limit,32768);assert.ok(calls.some(c=>c.url.endsWith('/models/load')));
 for(const c of calls.filter(c=>c.url.includes('/props')))assert.equal(new URL(c.url).searchParams.get('autoload'),'false');
});
test('model polling does not load cold models or invent unsupported telemetry',async()=>{
 const {manager,calls}=fixture();await manager.listModels();const health=await manager.health();assert.deepEqual(health.body.all_models_loaded,[]);
 assert.ok(calls.every(c=>c.url.endsWith('/models')));assert.equal((await manager.systemStats()).ok,false);assert.equal((await manager.stats()).body.output_tokens_total,null);
});
test('native cache downloads and deletes use router identities',async()=>{
 const {manager,calls}=fixture();await manager.pull({checkpoint:'fixture/model:Q8_0'});await manager.deleteModel('fixture/model:Q8_0');
 assert.equal(calls[0].url,'http://synthetic-router/models');assert.equal(calls[0].options.method,'POST');
 assert.equal(new URL(calls[1].url).searchParams.get('model'),'fixture/model:Q8_0');assert.equal(calls[1].options.method,'DELETE');
 const count=calls.length;assert.equal((await manager.pull({checkpoint:'https://untrusted.invalid/file'})).status,400);assert.equal(calls.length,count);
});

test('public variant discovery excludes projectors, ambiguous quants and incomplete splits',async()=>{
 const {variants}=require('./llamacpp-variants.cjs');let options;
 const files=[['model-Q8_0.gguf',100],['mmproj-F16.gguf',20],['a-Q4_K_M.gguf',30],['b-Q4_K_M.gguf',40],['model-Q5_K_M-00001-of-00002.gguf',50],['model-IQ4_XS-00001-of-00002.gguf',70],['model-IQ4_XS-00002-of-00002.gguf',80]];
 const r=await variants('synthetic/model',async(url,opts)=>{options=opts;assert.ok(url.startsWith('https://huggingface.co/api/models/'));return {ok:true,body:{siblings:files.map(([rfilename,size])=>({rfilename,lfs:{size}}))}};});
 assert.deepEqual(r.body.variants.map(v=>v.name),['IQ4_XS','Q8_0']);assert.equal(r.body.variants[0].size_bytes,150);assert.deepEqual(options,{});
});
test('native metrics preserve unknown values and use actual speculative counters',()=>{
 const {parseMetrics,summarize}=require('./llamacpp-metrics.cjs');
 const values=parseMetrics('llamacpp:tokens_predicted_total 20\nllamacpp:spec_decode_num_draft_tokens_total 10\nllamacpp:spec_decode_num_accepted_tokens_total 6\nllamacpp:predicted_tokens_seconds NaN');
 const result=summarize([{model:'synthetic',values}]);assert.equal(result.output_tokens_total,20);assert.equal(result.tokens_per_second,null);assert.equal(result.mtp[0].rate,.6);assert.equal(result.input_tokens_total,null);
});
test('download tracking distinguishes completion, failure, unknown and restart',t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const {createDownloadTracker}=require('./llamacpp-downloads.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-downloads-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const config={base:'http://synthetic',headers:()=>({}),file:path.join(dir,'jobs.json'),fetchStream:async()=>({ok:false})};
 const tracker=createDownloadTracker(config);
 tracker.requested('synthetic/a:Q8_0');assert.equal(tracker.snapshot([])[0].status,'unknown');
 tracker.event({model:'synthetic/a:Q8_0',event:'download_failed'});assert.equal(tracker.snapshot([])[0].status,'failed');
 tracker.requested('synthetic/b:Q8_0');tracker.event({model:'synthetic/b:Q8_0',event:'download_finished'});assert.equal(tracker.snapshot([])[0].status,'completed');
 const restored=createDownloadTracker(config);assert.deepEqual(restored.snapshot([]).map(j=>j.status),['completed','failed']);
 tracker.requested('synthetic/c:Q8_0');assert.equal(tracker.snapshot([{id:'synthetic/c:Q8_0',source:'cache',status:{value:'unloaded'}}])[0].status,'completed');
 tracker.close();restored.close();
});

test('native launch acknowledgement is not readiness; failed asynchronous load rejects',async()=>{
 let listed=0;
 const manager=createModelManager({kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:async url=>({ok:true,status:200,body:url.endsWith('/models/load')?{success:true}:{data:[{id:'fixture',status:++listed===1?{value:'loading'}:{value:'unloaded',failed:true}}]}})});
 const result=await manager.load('fixture');assert.equal(result.ok,false);assert.equal(listed,2);
});

test('cancelling a pending native load stops waiting without unloading shared models',async()=>{
 const abort=new AbortController(),calls=[];
 const manager=createModelManager({kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:async url=>{calls.push(url);if(url.endsWith('/models'))abort.abort();return {ok:true,status:200,body:{data:[{id:'fixture',status:{value:'loading'}}]}};}});
 await assert.rejects(manager.load('fixture',{},abort.signal),{name:'AbortError'});assert.ok(!calls.some(c=>c.includes('unload')));
});
