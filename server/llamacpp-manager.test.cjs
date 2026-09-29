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
  assert.deepEqual(unverified.samplingRecommendation,{state:'unverified',values:null,source:null,provenance:null,limitations:[]});
  assert.equal(unverified.samplingPlan.tier,'preset','no source and no family: task preset fallback');assert.equal(unverified.samplingPlan.sourceId,'task-preset');assert.deepEqual(unverified.samplingPlan.values,{});
  const artifact=require('./evidence.cjs').fileFingerprint(path.join(models,'fx','fx.gguf'));
  require('./evidence.cjs').createStore(ev).append({model:'fx',category:'external_sampling_config',result:'reported',
    identityHash:require('./model-evidence-import.cjs').artifactIdentityHash(artifact),value:{temperature:0.7,top_p:0.9},
    provenance:{sourceUrl:'https://huggingface.co/acme/fx/resolve/'+'a'.repeat(40)+'/generation_config.json',revision:'a'.repeat(40),retrievedAt:1000},
    limitations:['Source-reported, not measured locally']});
  const reported=(await manager.evidence('fx')).body.samplingRecommendation;
  assert.equal(reported.state,'reported');
  assert.deepEqual(reported.values,{temperature:0.7,top_p:0.9});
  assert.equal(reported.source,'generation_config.json');
  const plan=(await manager.evidence('fx')).body.samplingPlan;
  assert.equal(plan.tier,'model-card');assert.deepEqual(plan.values,{temperature:0.7,top_p:0.9});assert.equal(plan.provenance.revision,'a'.repeat(40));
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
  const stale=(await manager.evidence('fx')).body.samplingRecommendation;
  assert.equal(stale.state,'stale');assert.equal(stale.values,null,'old artifact recommendation is never offered as current');
  assert.equal((await manager.evidence('fx')).body.samplingPlan.tier,'preset','a stale source claim is not the plan');
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

test('concurrent distinct native loads serialize eviction and admission',async()=>{
 const calls=[],state={alpha:'unloaded',beta:'unloaded'};
 const manager=createModelManager({kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:async(url,options={})=>{
  const route=new URL(url).pathname,body=options.body?JSON.parse(options.body):{};
  calls.push(`${options.method||'GET'} ${route}${body.model?' '+body.model:''}`);
  if(route==='/models')return {ok:true,status:200,body:{data:Object.entries(state).map(([id,value])=>({id,status:{value}}))}};
  if(route==='/models/unload'){state[body.model]='unloaded';return {ok:true,status:200,body:{success:true}};}
  if(route==='/models/load'){state[body.model]='loaded';return {ok:true,status:200,body:{success:true}};}
  throw Error(`Unexpected route ${route}`);
 }});
 const results=await Promise.all([manager.load('alpha'),manager.load('beta')]);
 assert.ok(results.every(r=>r.ok));
 assert.deepEqual(state,{alpha:'unloaded',beta:'loaded'});
 assert.ok(calls.indexOf('POST /models/unload alpha')<calls.indexOf('POST /models/load beta'));
});

test('a failed or unconfirmed eviction stops native admission, including the chat preflight',async()=>{
 for(const confirm of [false,true]){
  const calls=[];
  const manager=createModelManager({kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:async(url,options={})=>{
   const route=new URL(url).pathname,body=options.body?JSON.parse(options.body):{};
   calls.push(`${options.method||'GET'} ${route}${body.model?' '+body.model:''}`);
   if(route==='/models')return {ok:true,status:200,body:{data:[{id:'alpha',status:{value:'loaded'}},{id:'beta',status:{value:'unloaded'}}]}};
   if(route==='/models/unload')return {ok:confirm,status:confirm?200:409,body:{success:confirm}};
   if(route==='/models/load')throw Error('must not load after failed eviction');
   throw Error(`Unexpected route ${route}`);
  }});
  const result=await manager.load('beta');
  assert.equal(result.ok,false);
  assert.equal(result.status,409);
  await assert.rejects(manager.makeRoomFor('beta'),{status:409});
  assert.equal(calls.some(c=>c==='POST /models/load beta'),false);
 }
});

test('a newly appearing loaded model after eviction blocks native admission',async()=>{
 const calls=[],state={alpha:'loaded',beta:'unloaded'};
 const manager=require('./llamacpp-manager.cjs').createLlamaCppManager({unloadWait:{timeoutMs:0},baseUrl:'http://synthetic',fetchJson:async(url,options={})=>{
  const route=new URL(url).pathname,body=options.body?JSON.parse(options.body):{};
  calls.push(`${options.method||'GET'} ${route}${body.model?' '+body.model:''}`);
  if(route==='/models')return {ok:true,status:200,body:{data:Object.entries(state).map(([id,value])=>({id,status:{value}}))}};
  if(route==='/models/unload'){
   assert.equal(body.model,'alpha');state.alpha='unloaded';state.gamma='loaded';
   return {ok:true,status:200,body:{success:true}};
  }
  if(route==='/models/load')throw Error('must not admit while a newly appearing model is loaded');
  throw Error(`Unexpected route ${route}`);
 }});
 const result=await manager.load('beta');
 assert.equal(result.ok,false);assert.equal(result.status,409);
 assert.deepEqual(calls,['GET /models','POST /models/unload alpha','GET /models']);
});

test('a queued native load observes cancellation before it can evict or load',async()=>{
 let releaseFirst;const holdFirst=new Promise(resolve=>{releaseFirst=resolve;});
 let firstStarted;const firstPost=new Promise(resolve=>{firstStarted=resolve;});
 const calls=[],state={alpha:'unloaded',beta:'unloaded'};
 const manager=createModelManager({kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:async(url,options={})=>{
  const route=new URL(url).pathname,body=options.body?JSON.parse(options.body):{};
  calls.push(`${options.method||'GET'} ${route}${body.model?' '+body.model:''}`);
  if(route==='/models')return {ok:true,status:200,body:{data:Object.entries(state).map(([id,value])=>({id,status:{value}}))}};
  if(route==='/models/load'&&body.model==='alpha'){firstStarted();await holdFirst;state.alpha='loaded';return {ok:true,status:200,body:{success:true}};}
  if(route==='/models/unload'){state[body.model]='unloaded';return {ok:true,status:200,body:{success:true}};}
  if(route==='/models/load'&&body.model==='beta'){state.beta='loaded';return {ok:true,status:200,body:{success:true}};}
  throw Error(`Unexpected route ${route}`);
 }});
 const first=manager.load('alpha');await firstPost;
 const controller=new AbortController();
 const second=manager.load('beta',{},controller.signal);
 controller.abort();
 await assert.rejects(second,{name:'AbortError'});
 assert.deepEqual(calls,['GET /models','POST /models/load alpha'],'cancellation settles while the first load is held');
 const third=manager.load('beta');
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,['GET /models','POST /models/load alpha'],'later admissions cannot pass the held first load or cancelled queue slot');
 releaseFirst();
 assert.equal((await first).ok,true);
 assert.equal((await third).ok,true);
 assert.equal(calls.filter(c=>c==='POST /models/load beta').length,1);
 assert.ok(calls.indexOf('POST /models/unload alpha')<calls.indexOf('POST /models/load beta'));
});

test('chat room checks and explicit unload wait for a pending native admission',async()=>{
 let releaseFirst;const holdFirst=new Promise(resolve=>{releaseFirst=resolve;});
 let firstStarted;const firstPost=new Promise(resolve=>{firstStarted=resolve;});
 const calls=[],state={alpha:'unloaded',beta:'unloaded'};
 const manager=createModelManager({kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:async(url,options={})=>{
  const route=new URL(url).pathname,body=options.body?JSON.parse(options.body):{};
  calls.push(`${options.method||'GET'} ${route}${body.model?' '+body.model:''}`);
  if(route==='/models')return {ok:true,status:200,body:{data:Object.entries(state).map(([id,value])=>({id,status:{value}}))}};
  if(route==='/models/load'){firstStarted();await holdFirst;state[body.model]='loaded';return {ok:true,status:200,body:{success:true}};}
  if(route==='/models/unload'){state[body.model]='unloaded';return {ok:true,status:200,body:{success:true}};}
  throw Error(`Unexpected route ${route}`);
 }});
 const loading=manager.load('alpha');await firstPost;
 const room=manager.makeRoomFor('beta');
 const explicit=manager.unload('alpha');
 assert.deepEqual(calls,['GET /models','POST /models/load alpha'],'neither later operation reaches the router while admission is pending');
 releaseFirst();
 assert.equal((await loading).ok,true);
 await room;
 assert.equal((await explicit).ok,true);
 assert.ok(calls.indexOf('POST /models/unload alpha')>calls.indexOf('POST /models/load alpha'));
});

// removeModel (#302 follow-up): unload and delete inside a single mutate() gate, with the
// delete retried once (after one more unload attempt) if the router refuses it the first time.
test('removeModel unloads then deletes as one call, and reports unloaded:true on success',async()=>{
 const calls=[];
 const manager=createModelManager({fetchStream:async()=>({ok:false}),kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:async(url,options)=>{
  const path=new URL(url).pathname;calls.push(`${options?.method||'GET'} ${path}`);
  if(path==='/models/unload')return {ok:true,status:200,body:{success:true}};
  if(path==='/models'&&options?.method==='DELETE')return {ok:true,status:200,body:{deleted:true}};
  return {ok:true,status:200,body:{}};
 }});
 const r=await manager.removeModel('gone');
 assert.equal(r.ok,true);assert.equal(r.unloaded,true);
 assert.deepEqual(calls,['POST /models/unload','DELETE /models'],'unload happens before delete, exactly once each on the happy path');
});

test('removeModel retries the unload once, then retries the delete, if the first delete is refused',async()=>{
 const calls=[];let deleteAttempts=0;
 const manager=createModelManager({fetchStream:async()=>({ok:false}),kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:async(url,options)=>{
  const path=new URL(url).pathname;calls.push(`${options?.method||'GET'} ${path}`);
  if(path==='/models/unload')return {ok:true,status:200,body:{success:true}};
  if(path==='/models'&&options?.method==='DELETE'){deleteAttempts+=1;return deleteAttempts===1?{ok:false,status:409,body:{error:'busy'}}:{ok:true,status:200,body:{deleted:true}};}
  return {ok:true,status:200,body:{}};
 }});
 const r=await manager.removeModel('busy-model');
 assert.equal(r.ok,true);assert.equal(deleteAttempts,2);
 assert.deepEqual(calls,['POST /models/unload','DELETE /models','POST /models/unload','DELETE /models'],'a refused delete gets one more unload+delete attempt, inside the same mutate() gate');
});

test('removeModel gives up after the retry and still reports whether anything actually unloaded',async()=>{
 const manager=createModelManager({fetchStream:async()=>({ok:false}),kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:async(url,options)=>{
  const path=new URL(url).pathname;
  if(path==='/models/unload')return {ok:false,status:404,body:{error:'not loaded'}};
  if(path==='/models'&&options?.method==='DELETE')return {ok:false,status:409,body:{error:'still busy'}};
  return {ok:true,status:200,body:{}};
 }});
 const r=await manager.removeModel('stuck-model');
 assert.equal(r.ok,false);assert.equal(r.status,409);assert.equal(r.unloaded,false,'the manager never reported a successful unload, on either attempt');
});

test('forgetIdentity drops a cached identity without needing a live request',async()=>{
 const manager=createModelManager({fetchStream:async()=>({ok:false}),kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:async()=>({ok:true,status:200,body:{}})});
 assert.doesNotThrow(()=>manager.forgetIdentity('whatever-not-cached'));
});

test('#578: switching models waits for the old model to finish unloading instead of failing the first time', async () => {
 const {createLlamaCppManager}=require('./llamacpp-manager.cjs');
 for(const [polls,timeoutMs,expectOk] of [[3,30000,true],[1000,0,false]]){
  const state={'chat-a':'loaded','chat-b':'unloaded'};let stillLoaded=polls,unloadedAt=false,sleeps=[],loadedBeforeUnloadDone=false;
  const manager=createLlamaCppManager({baseUrl:'http://synthetic',unloadWait:{timeoutMs,sleep:async ms=>{sleeps.push(ms);}},fetchJson:async(url,options={})=>{
   const path=new URL(url).pathname,body=options.body?JSON.parse(options.body):{};
   if(path==='/models/unload'){unloadedAt=true;return {ok:true,status:200,body:{success:true}};}
   if(path==='/models/load'){loadedBeforeUnloadDone=state['chat-a']==='loaded';state[body.model]='loaded';return {ok:true,status:200,body:{success:true}};}
   if(path==='/models'){if(unloadedAt&&stillLoaded>0){stillLoaded--;if(stillLoaded===0)state['chat-a']='unloaded';}
    return {ok:true,status:200,body:{data:Object.entries(state).map(([id,value])=>({id,status:{value}}))}};}
   throw Error('unexpected '+path);
  }});
  const result=await manager.load('chat-b');
  assert.equal(result.ok,expectOk,JSON.stringify(result));
  if(expectOk){assert.equal(loadedBeforeUnloadDone,false,'load only after unload finished');assert.ok(sleeps.length>=1);assert.ok(sleeps.every((v,i)=>i===0||v>=sleeps[i-1]),'backoff does not shrink');}
  else{assert.equal(result.status,409);assert.match(result.body.error,/still unloading/);}
 }
});
