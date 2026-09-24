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
 const loadCall=calls.find(c=>c.url.endsWith('/models/load')),unloadCall=calls.find(c=>c.url.endsWith('/models/unload'));
 assert.equal(loadCall.url,'http://synthetic-router/models/load');assert.deepEqual(JSON.parse(loadCall.options.body),{model:'fixture/model:Q8_0'});
 assert.equal(unloadCall.url,'http://synthetic-router/models/unload');assert.equal(loadCall.options.headers.Authorization,'Bearer fixture-key');
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
// #266: a metadata-import hook wired to onCompleted is best-effort by contract. Even when
// the hook itself throws synchronously or returns a rejected promise, the job the tracker
// just finished must stay 'completed' — a broken import must never make a finished download
// look unfinished — and it must fire exactly once per fresh completion, not on every snapshot.
test('onCompleted throwing or rejecting never reverts or re-marks a completed download',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const {createDownloadTracker}=require('./llamacpp-downloads.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-downloads-onCompleted-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const calls=[];
 const tracker=createDownloadTracker({base:'http://synthetic',headers:()=>({}),file:path.join(dir,'jobs.json'),fetchStream:async()=>({ok:false}),
  onCompleted:model=>{calls.push(model);throw Error('metadata source unavailable');}});
 tracker.requested('synthetic/a:Q8_0');
 tracker.event({model:'synthetic/a:Q8_0',event:'download_finished'});
 assert.equal(tracker.snapshot([])[0].status,'completed');
 assert.deepEqual(calls,['synthetic/a:Q8_0']);
 // A duplicate 'download_finished' (or any other update while already completed) is not a
 // fresh transition and must not re-fire the hook.
 tracker.event({model:'synthetic/a:Q8_0',event:'download_finished'});
 assert.equal(tracker.snapshot([])[0].status,'completed');
 assert.deepEqual(calls,['synthetic/a:Q8_0']);
 const rejecting=createDownloadTracker({base:'http://synthetic',headers:()=>({}),file:path.join(dir,'jobs2.json'),fetchStream:async()=>({ok:false}),
  onCompleted:()=>Promise.reject(Error('metadata source unavailable'))});
 rejecting.requested('synthetic/b:Q8_0');
 rejecting.event({model:'synthetic/b:Q8_0',event:'download_finished'});
 assert.equal(rejecting.snapshot([])[0].status,'completed');
 await new Promise(r=>setImmediate(r)); // let the rejected promise settle; must not surface as an unhandled rejection
 tracker.close();rejecting.close();
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

test('native loaded and cold capability labels use effective flags without leaking argv',async()=>{
 const data=['loaded','unloaded'].flatMap(value=>[
  {id:'opaque-embedding-'+value,status:{value,args:['--embeddings','--model','/private/weights.gguf','--api-key','PRIVATE-CANARY']}},
  {id:'opaque-ranker-'+value,status:{value,args:['--reranking']}},
  {id:'nomic-name-is-not-a-capability-'+value,status:{value,args:['--model','/models/embedding.gguf']},architecture:{input_modalities:['text','image']}},
 ]);
 const manager=createModelManager({kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:async()=>({ok:true,status:200,body:{data}})});
 const rows=(await manager.listModels()).body.data;
 assert.deepEqual(rows.map(m=>m.id),data.map(m=>m.id));
 for(let i=0;i<rows.length;i+=3){assert.deepEqual(rows[i].labels,['embeddings']);assert.deepEqual(rows[i+1].labels,['reranking']);assert.deepEqual(rows[i+2].labels,['vision']);}
 assert.doesNotMatch(JSON.stringify(rows),/PRIVATE-CANARY|private\/weights|status.*args/);
});
test('qualification evidence is tied to the live configuration and goes stale when it changes',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'noevia-evidence-mgr-'));
 try{
  const models=path.join(root,'models'),ev=path.join(root,'evidence');fs.mkdirSync(path.join(models,'fx'),{recursive:true});
  fs.writeFileSync(path.join(models,'fx','fx.gguf'),Buffer.alloc(2048,7));
  const ini=path.join(root,'models.ini');
  fs.writeFileSync(ini,'version = 1\n\n[fx]\nmodel = /models/fx/fx.gguf\nctx-size = 8192\n');
  const manager=createModelManager({kind:'llamacpp',baseUrl:'http://synthetic-router/v1/',presetPath:ini,evidenceDir:ev,autoconfig:{modelsPath:models},fetchStream:async()=>({ok:false}),
   fetchJson:async(url)=>{const p=new URL(url).pathname;return {ok:true,status:200,body:p==='/models'?{data:[{id:'fx',status:{value:'unloaded',args:[]}}]}:p==='/props'?{build_info:'b-synthetic'}:{}};}});
  const unverified=(await manager.evidence('fx')).body;
  assert.equal(unverified.categories.find(c=>c.category==='context_capacity').state,'unverified');
  await manager.recordEvidence('fx',{category:'context_capacity',result:'passed',value:{ctx:8192},suite:{name:'native-calibration',version:1},source:'calibration'});
  const verified=(await manager.evidence('fx')).body.categories.find(c=>c.category==='context_capacity');
  assert.equal(verified.state,'verified');assert.equal(verified.value.ctx,8192);
  assert.ok(!fs.readFileSync(path.join(ev,'evidence.jsonl'),'utf8').includes('synthetic-router'),'raw endpoint must not be stored');
  fs.writeFileSync(ini,'version = 1\n\n[fx]\nmodel = /models/fx/fx.gguf\nctx-size = 16384\n');
  assert.equal((await manager.evidence('fx')).body.categories.find(c=>c.category==='context_capacity').state,'stale','preset change');
  fs.writeFileSync(ini,'version = 1\n\n[fx]\nmodel = /models/fx/fx.gguf\nctx-size = 8192\n');
  assert.equal((await manager.evidence('fx')).body.categories.find(c=>c.category==='context_capacity').state,'verified','restored preset matches again');
  fs.writeFileSync(path.join(models,'fx','fx.gguf'),Buffer.alloc(4096,9));
  assert.equal((await manager.evidence('fx')).body.categories.find(c=>c.category==='context_capacity').state,'stale','replaced artifact');
  fs.rmSync(path.join(models,'fx','fx.gguf'));
  assert.equal((await manager.evidence('fx')).body.categories.find(c=>c.category==='context_capacity').state,'unavailable','missing file');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('before a chat model loads, other chat models are unloaded but the embedding model stays',async()=>{
 const prev=process.env.EMBEDDING_MODEL;process.env.EMBEDDING_MODEL='fixture-embed';
 const unloaded=[];let state={'chat-a':'loaded','fixture-embed':'loaded','chat-b':'unloaded'};
 const manager=createModelManager({fetchStream:async()=>({ok:false}),kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:async(url,options)=>{
  const path=new URL(url).pathname,body=options?.body?JSON.parse(options.body):{};
  if(path==='/models/unload'){unloaded.push(body.model);state[body.model]='unloaded';}
  if(path==='/models/load')state[body.model]='loaded';
  return {ok:true,status:200,body:path==='/models'?{data:Object.entries(state).map(([id,value])=>({id,status:{value}}))}:{success:true}};
 }});
 try{
  assert.equal((await manager.load('chat-b')).ok,true);
  assert.deepEqual(unloaded,['chat-a']);assert.equal(state['fixture-embed'],'loaded');
  await manager.makeRoomFor('chat-b',['fixture-embed']);assert.deepEqual(unloaded,['chat-a'],'nothing else to unload');
 }finally{if(prev===undefined)delete process.env.EMBEDDING_MODEL;else process.env.EMBEDDING_MODEL=prev;}
});

test('with RAG rerank on, the reranker also stays beside the chat model',async()=>{
 const keys=['EMBEDDING_MODEL','NOEVIA_FEATURE_RAG_RERANK','RERANK_MODEL'],prev=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{EMBEDDING_MODEL:'fixture-embed',NOEVIA_FEATURE_RAG_RERANK:'1',RERANK_MODEL:'fixture-rerank'});
 const unloaded=[];const state={'chat-a':'loaded','fixture-rerank':'loaded','chat-b':'unloaded'};
 const manager=createModelManager({fetchStream:async()=>({ok:false}),kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:async(url,options)=>{
  const path=new URL(url).pathname,body=options?.body?JSON.parse(options.body):{};
  if(path==='/models/unload'){unloaded.push(body.model);state[body.model]='unloaded';}
  if(path==='/models/load')state[body.model]='loaded';
  return {ok:true,status:200,body:path==='/models'?{data:Object.entries(state).map(([id,value])=>({id,status:{value}}))}:{success:true}};
 }});
 try{
  assert.equal((await manager.load('chat-b')).ok,true);
  assert.deepEqual(unloaded,['chat-a']);assert.equal(state['fixture-rerank'],'loaded');
 }finally{for(const k of keys){if(prev[k]===undefined)delete process.env[k];else process.env[k]=prev[k];}}
});
