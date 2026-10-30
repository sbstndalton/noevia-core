'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {createModelManager}=require('./model-manager.cjs');
const {resolveRuntimeLimit}=require('./chat-context.cjs');
const {fakeGate,gateRefusal}=require('./fixtures/fake-inference-gate.cjs');
function fixture(){
 const calls=[];let loaded=false;
 const manager=createModelManager({gate:fakeGate(),fetchStream:async()=>({ok:false}),kind:'llamacpp',baseUrl:'http://synthetic-router/v1/',apiKey:'fixture-key',fetchJson:async(url,options)=>{
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
 const manager=createModelManager({gate:fakeGate(),kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:async url=>({ok:true,status:200,body:url.endsWith('/models/load')?{success:true}:{data:[{id:'fixture',status:++listed===1?{value:'loading'}:{value:'unloaded',failed:true}}]}})});
 const result=await manager.load('fixture');assert.equal(result.ok,false);assert.equal(listed,2);
});

test('cancelling a pending native load stops waiting without unloading shared models',async()=>{
 const abort=new AbortController(),calls=[];
 const manager=createModelManager({gate:fakeGate(),kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:async url=>{calls.push(url);if(url.endsWith('/models'))abort.abort();return {ok:true,status:200,body:{data:[{id:'fixture',status:{value:'loading'}}]}};}});
 await assert.rejects(manager.load('fixture',{},abort.signal),{name:'AbortError'});assert.ok(!calls.some(c=>c.includes('unload')));
});

test('native loaded and cold capability labels use effective flags without leaking argv',async()=>{
 const data=['loaded','unloaded'].flatMap(value=>[
  {id:'opaque-embedding-'+value,status:{value,args:['--embeddings','--model','/private/weights.gguf','--api-key','PRIVATE-CANARY']}},
  {id:'opaque-ranker-'+value,status:{value,args:['--reranking']}},
  {id:'nomic-name-is-not-a-capability-'+value,status:{value,args:['--model','/models/embedding.gguf']},architecture:{input_modalities:['text','image']}},
 ]);
 const manager=createModelManager({gate:fakeGate(),kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:async()=>({ok:true,status:200,body:{data}})});
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
  const manager=createModelManager({gate:fakeGate(),kind:'llamacpp',baseUrl:'http://synthetic-router/v1/',presetPath:ini,evidenceDir:ev,autoconfig:{modelsPath:models},fetchStream:async()=>({ok:false}),
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
  // #2210: the Rust front writes the store (under the live identity); this plays its part.
  const filed=async(rec)=>require('./evidence.cjs').createStore(ev).append({model:'fx',identityHash:(await manager.evidence('fx')).body.identityHash,...rec});
  await filed({category:'context_capacity',result:'passed',value:{ctx:8192},suite:{name:'native-calibration',version:1},source:'calibration'});
  const verified=(await manager.evidence('fx')).body.categories.find(c=>c.category==='context_capacity');
  assert.equal(verified.state,'verified');assert.equal(verified.value.ctx,8192);
  assert.deepEqual(verified.limitationKeys,[],'no limitations, no keys');
  await filed({category:'vision',result:'passed',value:null,suite:{name:'vision-probe',version:1},source:'probe',limitations:['1×1 image accepted; not an accuracy test','A new sentence nobody translated']});
  const vision=(await manager.evidence('fx')).body.categories.find(c=>c.category==='vision');
  assert.deepEqual(vision.limitations,['1×1 image accepted; not an accuracy test','A new sentence nobody translated'],'the English sentences stay for older clients');
  assert.deepEqual(JSON.parse(JSON.stringify(vision.limitationKeys)),[{id:'vision-probe',params:{}},null],'#598: a stable id beside each known sentence, null for the rest');
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

// removeModel (#302 follow-up): unload and delete inside a single mutate() gate, with the
// delete retried once (after one more unload attempt) if the router refuses it the first time.
test('removeModel unloads then deletes as one call, and reports unloaded:true on success',async()=>{
 const calls=[];
 const manager=createModelManager({gate:fakeGate(),fetchStream:async()=>({ok:false}),kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:async(url,options)=>{
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
 const manager=createModelManager({gate:fakeGate(),fetchStream:async()=>({ok:false}),kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:async(url,options)=>{
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
 const manager=createModelManager({gate:fakeGate(),fetchStream:async()=>({ok:false}),kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:async(url,options)=>{
  const path=new URL(url).pathname;
  if(path==='/models/unload')return {ok:false,status:404,body:{error:'not loaded'}};
  if(path==='/models'&&options?.method==='DELETE')return {ok:false,status:409,body:{error:'still busy'}};
  return {ok:true,status:200,body:{}};
 }});
 const r=await manager.removeModel('stuck-model');
 assert.equal(r.ok,false);assert.equal(r.status,409);assert.equal(r.unloaded,false,'the manager never reported a successful unload, on either attempt');
});

test('forgetIdentity drops a cached identity without needing a live request',async()=>{
 const manager=createModelManager({gate:fakeGate(),fetchStream:async()=>({ok:false}),kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:async()=>({ok:true,status:200,body:{}})});
 assert.doesNotThrow(()=>manager.forgetIdentity('whatever-not-cached'));
});

// noevia#2115, #2117: the inference gate decides which chat model runs; this manager no longer evicts anything.
const routerFake=(state,calls,{answer}={})=>async(url,options={})=>{
 const route=new URL(url).pathname,body=options.body?JSON.parse(options.body):{};
 calls.push({route,method:options.method||'GET',body,lease:options.headers?.['X-Noevia-Lease']||null,admin:options.headers?.['X-Noevia-Gate-Admin']||null});
 const custom=answer?.(route,body,options);if(custom)return custom;
 if(route==='/models/load'){for(const id of Object.keys(state))if(state[id]==='loaded')state[id]='unloaded';state[body.model]='loaded';}
 if(route==='/models/unload')state[body.model]='unloaded';
 return {ok:true,status:200,body:route==='/models'?{data:Object.entries(state).map(([id,value])=>({id,status:{value}}))}:{success:true}};
};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('noevia#2115: a load waits for its own lease, carries it and gives it back; it never unloads another model',async()=>{
 const gate=fakeGate({hold:true}),calls=[],state={'chat-a':'loaded','chat-b':'unloaded'};
 const manager=createModelManager({gate,kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:routerFake(state,calls)});
 const loading=manager.load('chat-b');
 await tick();
 assert.deepEqual(calls,[],'nothing reaches the router while the lease waits');
 assert.equal(manager.inferenceBusy(0),true,'a lease being waited for makes the engine busy (an optional title skips)');
 assert.equal(gate.grant(),true);
 assert.equal((await loading).ok,true);
 const load=calls.find(c=>c.route==='/models/load');
 assert.equal(load.body.model,'chat-b');assert.match(load.lease,/^[0-9a-f]{32}$/);
 assert.ok(!calls.some(c=>c.route==='/models/unload'),'the switch is the gate\'s; nothing here unloads the other model');
 assert.deepEqual(gate.log.acquired,['chat-b']);assert.deepEqual(gate.log.released,['chat-b'],'the load\'s own lease is given back');
 assert.equal(manager.inferenceBusy(0),false);
});

test('noevia#2115: a turn\'s explicit load runs under the turn\'s lease and leaves it held',async()=>{
 const gate=fakeGate(),calls=[],state={'chat-b':'unloaded'};
 const manager=createModelManager({gate,kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:routerFake(state,calls)});
 const lease=await manager.acquireLease('chat-b');
 assert.equal((await manager.load('chat-b',{},undefined,{lease})).ok,true);
 assert.equal(calls.find(c=>c.route==='/models/load').lease,lease.token);
 assert.deepEqual(gate.log.acquired,['chat-b'],'no second lease');assert.deepEqual(gate.log.released,[],'the turn gives it back, not the load');
 const value=await resolveRuntimeLimit({manager,model:'chat-b',lease});
 assert.ok(value.limit>0);assert.deepEqual(gate.log.acquired,['chat-b']);
});

test('noevia#2115: a refusal from the gate fails the load with its code and loads nothing',async()=>{
 const refuse={code:'engine_switch_stuck',status:503,retryable:true,message:'The local model engine is still releasing the previous model. Try again shortly.'};
 const calls=[],manager=createModelManager({gate:fakeGate({refuse}),kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:routerFake({beta:'unloaded'},calls)});
 const r=await manager.load('beta');
 assert.equal(r.ok,false);assert.equal(r.status,503);assert.deepEqual(r.body,{error:refuse.message,code:'engine_switch_stuck',retryable:true});
 assert.deepEqual(calls,[]);
 await assert.rejects(manager.acquireLease('beta'),e=>e.name==='GateError'&&e.code==='engine_switch_stuck'&&e.retryable===true&&e.publicMessage===refuse.message);
 // A refusal the gate answers to the load request itself (a lease that ended meanwhile) is passed on the same way.
 const late=createModelManager({gate:fakeGate(),kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:routerFake({beta:'unloaded'},[],{answer:route=>route==='/models/load'?gateRefusal(503,'inference_queue_timeout','Another chat was still using the local model. Try again when it has finished.',true):null})});
 const lateResult=await late.load('beta');
 assert.equal(lateResult.status,503);assert.equal(lateResult.body.code,'inference_queue_timeout');assert.equal(lateResult.body.retryable,true);
});

test('noevia#2115: a load waiting for its lease observes cancellation and loads nothing',async()=>{
 const gate=fakeGate({hold:true}),calls=[];
 const manager=createModelManager({gate,kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:routerFake({beta:'unloaded'},calls)});
 const controller=new AbortController();
 const waiting=manager.load('beta',{},controller.signal);
 await tick();
 controller.abort();
 await assert.rejects(waiting,{name:'AbortError'});
 assert.deepEqual(gate.log.aborted,['beta'],'the wait left the gate\'s queue');assert.deepEqual(calls,[]);
 assert.equal(manager.inferenceBusy(0),false);
});

test('noevia#2115: the gate\'s refusal to unload a model in use reaches the caller; unloading it anyway needs the admin token',async()=>{
 const answer=(route,body,options)=>route==='/models/unload'&&!(body.force===true&&options.headers?.['X-Noevia-Gate-Admin'])?gateRefusal(409,'model_in_use','The model is answering a request. Unload it when it is idle, or unload it anyway as an admin.',true):null;
 const calls=[],plain=createModelManager({gate:fakeGate(),kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:routerFake({alpha:'loaded'},calls,{answer})});
 const refused=await plain.unload('alpha');
 assert.equal(refused.status,409);assert.equal(refused.body.error.code,'model_in_use');
 assert.equal(plain.gateAdmin(),false);
 const noAdmin=await plain.unloadAnyway('alpha');
 assert.equal(noAdmin.status,403);assert.equal(noAdmin.body.code,'admin_required');
 assert.equal(calls.filter(c=>c.route==='/models/unload').length,1,'nothing is sent without the admin token');
 // The memory watchdog without the token: a plain unload, which the gate refuses for a model in use.
 assert.equal((await plain.emergencyUnload('alpha')).status,409);
 assert.deepEqual(calls.at(-1).body,{model:'alpha'});
 const adminCalls=[],admin=createModelManager({gate:fakeGate({admin:'synthetic-admin-0001'}),kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:routerFake({alpha:'loaded'},adminCalls,{answer})});
 assert.equal(admin.gateAdmin(),true);
 assert.equal((await admin.unload('alpha')).status,409,'a plain unload stays refused with a token configured');
 assert.equal((await admin.unloadAnyway('alpha')).ok,true);
 assert.deepEqual(adminCalls.at(-1).body,{model:'alpha',force:true});assert.equal(adminCalls.at(-1).admin,'synthetic-admin-0001');
 assert.equal((await admin.emergencyUnload('alpha')).ok,true);
 assert.deepEqual(adminCalls.at(-1).body,{model:'alpha',force:true});assert.equal(adminCalls.at(-1).admin,'synthetic-admin-0001');
});

test('noevia#2115: nothing here evicts: a switch with another model loaded sends no unload, and a refused load disturbs nothing',async()=>{
 // The deleted local eviction unloaded the loaded model to make room. Now the router sees a load of the new model
 // under a lease and nothing else; the gate decides when the old one goes.
 const gate=fakeGate(),calls=[],state={'chat-a':'loaded','chat-b':'unloaded','chat-big':'unloaded'};
 const manager=createModelManager({gate,kind:'llamacpp',baseUrl:'http://synthetic',inferenceBudget:{budgetGib:()=>64},fetchJson:routerFake(state,calls)});
 manager.quarantine('chat-big',64);
 const refused=await manager.load('chat-big');
 assert.equal(refused.ok,false);assert.equal(refused.status,409);assert.equal(refused.body.code,'inference_budget_unloaded');
 await assert.rejects(manager.acquireLease('chat-big'),e=>e.status===409&&e.code==='inference_budget_unloaded');
 assert.deepEqual(gate.log.acquired,[],'a model over the budget never takes a lease');
 assert.deepEqual(calls.filter(c=>c.route==='/models/load'||c.route==='/models/unload'),[],'nothing was loaded or unloaded');
 assert.equal(state['chat-a'],'loaded','the model in use stays');
 assert.equal((await manager.load('chat-b')).ok,true);
 assert.deepEqual(calls.filter(c=>c.route==='/models/unload'),[],'a switch asks the router to load only');
 assert.deepEqual(calls.filter(c=>c.route==='/models/load').map(c=>c.body.model),['chat-b']);
});

test('noevia#2115: a shutdown gives back the gate leases still held, with the options it was given',async()=>{
 const asked=[];
 const gate={...fakeGate(),releaseAll:async options=>{asked.push(options);return 2;}};
 const manager=createModelManager({gate,kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:routerFake({},[])});
 assert.equal(await manager.releaseLeases({timeoutMs:2000}),2);
 assert.deepEqual(asked,[{timeoutMs:2000}]);
 // A gate without the call (a test double) has nothing to give back.
 const bare=createModelManager({gate:fakeGate(),kind:'llamacpp',baseUrl:'http://synthetic',fetchJson:routerFake({},[])});
 assert.equal(await bare.releaseLeases(),0);
});
test('#2210: a non-reported record carries the identity it was measured on and the time; a reported one does not',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'noevia-evidence-carry-'));
 try{
  const models=path.join(root,'models'),ev=path.join(root,'evidence-0123');fs.mkdirSync(path.join(models,'fx'),{recursive:true});
  fs.writeFileSync(path.join(models,'fx','fx.gguf'),Buffer.alloc(2048,7));
  fs.writeFileSync(path.join(models,'fx','draft.gguf'),Buffer.alloc(1024,3));
  const ini=path.join(root,'models.ini');
  fs.writeFileSync(ini,'version = 1\n\n[fx]\nmodel = /models/fx/fx.gguf\nspec-type = draft-mtp\nspec-draft-model = /models/fx/draft.gguf\n');
  let props=0;
  const manager=createModelManager({gate:fakeGate(),kind:'llamacpp',baseUrl:'http://synthetic-router/v1/',presetPath:ini,evidenceDir:ev,autoconfig:{modelsPath:models},fetchStream:async()=>({ok:false}),
   fetchJson:async(url)=>{const p=new URL(url).pathname;if(p==='/props')props++;return {ok:true,status:200,body:p==='/models'?{data:[{id:'fx',status:{value:'unloaded',args:[]}}]}:p==='/props'?{build_info:'b-synthetic'}:{}};}});
  const inboxDir=require('./evidence-inbox.cjs').inboxDirFor(ev);
  const read=name=>JSON.parse(fs.readFileSync(path.join(inboxDir,name),'utf8'));
  const before=Date.now();
  const passed=await manager.recordEvidence('fx',{category:'vision',result:'passed',value:null,suite:{name:'s',version:1},source:'recheck',limitations:[]});
  const entry=read(passed);
  assert.equal(entry.identityHash,(await manager.evidence('fx')).body.identityHash);
  assert.ok(entry.at>=before&&entry.at<=Date.now());
  // Taken when recorded: a preset change afterwards does not change what the queued entry carries.
  fs.writeFileSync(ini,'version = 1\n\n[fx]\nmodel = /models/fx/fx.gguf\nspec-type = draft-mtp\nctx-size = 4096\n');
  const again=read(await manager.recordEvidence('fx',{category:'vision',result:'failed',value:null,suite:{name:'s',version:1},source:'recheck',limitations:[]}));
  assert.notEqual(again.identityHash,entry.identityHash);
  assert.equal(read(passed).identityHash,entry.identityHash);
  const asked=props;
  const reported=read(await manager.recordEvidence('fx',{category:'throughput',result:'reported',value:{rate:5},suite:{name:'s',version:1},source:'chat',limitations:[]}));
  assert.equal(reported.identityHash,undefined);assert.equal(reported.at,undefined);
  assert.equal(props,asked,'a rate asks the router nothing');
  assert.equal(await manager.recordEvidence('gone',{category:'vision',result:'passed',value:null,suite:{name:'s',version:1},source:'recheck',limitations:[]}),null,'no identity: not queued');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
