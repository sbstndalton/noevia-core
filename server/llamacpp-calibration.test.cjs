'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createModelManager}=require('./model-manager.cjs');
const {ladder}=require('./llamacpp-calibration.cjs');

// Synthetic llama.cpp router: a model loads only while its preset context is at or below
// `loadCap`, and recalls the start marker only at or below `longCap`.
function fixture(t,{loadCap=40960,longCap=Infinity,native=131072,memory=()=>20,other=false,onLoad,speed=100000}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'calibration-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const ini=path.join(dir,'models.ini'),stateFile=path.join(dir,'state.json');
  const original='version = 1\n[*]\ncache-type-k = q8_0\n[synthetic]\n; operator note stays\nmodel = /models/s.gguf\nc = 8192\nparallel = 1\n[other]\nc = 4096\n';
  fs.writeFileSync(ini,original);
  const router={status:{synthetic:'unloaded',other:other?'loaded':'unloaded'},calls:[],loads:[]};
  const ctxOf=()=>Number(/\[synthetic\][^[]*?(?:^|\n)(?:c|ctx-size)\s*=\s*(\d+)/.exec(fs.readFileSync(ini,'utf8'))?.[1]);
  const fetchJson=async(url,opts={})=>{
    const u=new URL(url),body=opts.body?JSON.parse(opts.body):{};router.calls.push(u.pathname);
    if(opts.signal?.aborted)throw Object.assign(Error('aborted'),{name:'AbortError'});
    if(u.pathname==='/models'&&(!opts.method||opts.method==='GET'))return {ok:true,status:200,body:{data:Object.entries(router.status).map(([id,value])=>({id,status:{value},meta:id==='synthetic'?{n_ctx_train:native}:{}}))}};
    if(u.pathname==='/models/load'){const ctx=ctxOf();router.loads.push(ctx);await onLoad?.(ctx,router);router.status.synthetic=ctx<=loadCap?'loaded':'unloaded';return {ok:true,status:200,body:{}};}
    if(u.pathname==='/models/unload'){router.status[body.model]='unloaded';return {ok:true,status:200,body:{}};}
    if(u.pathname==='/tokenize')return {ok:true,status:200,body:{tokens:Array(600).fill(1)}};
    if(u.pathname==='/props')return {ok:true,status:200,body:{build_info:'b-synthetic'}};
    if(u.pathname==='/v1/chat/completions'){
      const text=body.messages[0].content,marker=/start marker: (CAL-[\d-]+)/.exec(text)?.[1];
      if(!marker)return {ok:true,status:200,body:{choices:[{message:{content:'OK'}}],usage:{prompt_tokens:12}}};
      const ctx=ctxOf();return {ok:true,status:200,body:{choices:[{message:{content:ctx<=longCap?marker:'I do not know'}}],usage:{prompt_tokens:Math.floor(text.length/5.3)}}};
    }
    return {ok:true,status:200,body:{}};
  };
  // Streaming completion: emits prompt progress every 1024 tokens at `speed` tokens/s on a
  // fake clock, then the answer. Recalls the marker only at or below `longCap`.
  const clock={t:0};
  const fetchStream=async(url,opts={})=>{
    const body=JSON.parse(opts.body),text=body.messages[0].content,marker=/start marker: (CAL-[\d-]+)/.exec(text)[1];
    assert.equal(body.stream,true);assert.equal(body.return_progress,true);
    const total=Math.floor(text.length/5.3),ctx=ctxOf(),enc=new TextEncoder();router.streams=(router.streams||0)+1;
    async function* events(){
      // Like llama.cpp: a zero and a one-token event before the first real batch.
      yield enc.encode(`data: ${JSON.stringify({prompt_progress:{total,cache:0,processed:0,time_ms:0}})}\n\n`);
      yield enc.encode(`data: ${JSON.stringify({prompt_progress:{total,cache:0,processed:1,time_ms:23}})}\n\n`);
      for(let processed=Math.min(1024,total);;processed=Math.min(total,processed+1024)){
        if(opts.signal?.aborted)throw Object.assign(Error('aborted'),{name:'AbortError'});
        clock.t+=1024/speed*1000;
        yield enc.encode(`data: ${JSON.stringify({prompt_progress:{total,cache:0,processed,time_ms:processed/speed*1000}})}\n\n`);
        if(processed>=total)break;
      }
      yield enc.encode(`data: ${JSON.stringify({choices:[{delta:{content:ctx<=longCap?marker:'I do not know'}}],timings:{prompt_n:total,prompt_ms:total/speed*1000,prompt_per_second:speed}})}\n\ndata: [DONE]\n\n`);
    }
    // Like Node's fetch body: aborting errors the stream, so leaving a read loop after an
    // abort re-throws. A stop must therefore exit the loop before aborting.
    const iterator=events();
    const readable=new ReadableStream({
      start(ctl){opts.signal?.addEventListener('abort',()=>{try{ctl.error(Object.assign(Error('aborted'),{name:'AbortError'}));}catch{}},{once:true});},
      async pull(ctl){const {value,done}=await iterator.next();if(done)ctl.close();else ctl.enqueue(value);},
      async cancel(){await iterator.return?.();},
    });
    return new Response(readable,{status:200});
  };
  const manager=createModelManager({kind:'llamacpp',baseUrl:'http://synthetic',presetPath:ini,fetchJson,fetchStream,calibrationStatePath:stateFile,autoconfig:{},calibrationOptions:{sleep:async()=>{},readMemory:memory,now:()=>clock.t,timeouts:{memoryPoll:5}}});
  return {manager,ini,stateFile,original,router,ctxOf};
}
async function finished(manager){for(let i=0;i<2000;i++){const job=manager.calibration.status().body.job;if(job&&job.status!=='running')return job;await new Promise(r=>setImmediate(r));}throw Error('calibration did not finish');}

test('ladder covers 4096 up to the trained context, or 128K when unknown',()=>{
  assert.equal(ladder(32768).at(-1),32768);assert.equal(ladder(0).at(-1),131072);assert.ok(ladder(100000).includes(100000));assert.equal(ladder(262144)[0],4096);
});

test('load checks bound the search; long prompts start mid-range and stop at the time limit',async t=>{
  const {manager,ini,router,ctxOf}=fixture(t,{loadCap:131072,speed:1000});
  assert.equal((await manager.calibration.start('synthetic',{promptBudgetSeconds:60})).status,400);
  assert.equal((await manager.calibration.start('synthetic',{promptBudgetSeconds:5,confirmPause:true})).status,400);
  const started=await manager.calibration.start('synthetic',{promptBudgetSeconds:60,confirmPause:true});
  assert.equal(started.status,202);assert.equal(started.body.originalText,undefined);
  const job=await finished(manager);
  assert.equal(job.status,'passed',job.error);
  assert.deepEqual(job.steps.filter(s=>s.kind==='load').map(s=>s.ctx),[8192,16384,32768,65536,131072]);
  const long=job.steps.filter(s=>s.kind==='long');
  // 17 sizes from 8K to 128K: the first long test is the middle one, then it moves up.
  assert.deepEqual(long.map(s=>[s.ctx,s.status]),[[65536,'passed'],[98304,'failed'],[81920,'failed'],[73728,'failed']]);
  for(const s of long.filter(s=>s.status==='failed'))assert.match(s.reason,/over the 60 s limit/);
  // 98K and 80K are clearly over and stop on the forecast; 72K is close, so it runs to
  // the end and fails on the engine's measured time (66 s).
  assert.match(long[1].reason,/would take about/);assert.match(long[3].reason,/took 66 s, over the 60 s limit/);
  assert.ok(long[0].promptSeconds>50&&long[0].promptSeconds<=60,String(long[0].promptSeconds));
  // The calibrated profile is loaded and ready when the run ends.
  assert.equal(job.result.loaded,true);assert.equal(router.status.synthetic,'loaded');assert.equal(router.loads.at(-1),65536);
  assert.equal(long[0].promptPerSecond,1000);
  assert.equal(job.result.loadCtx,131072);assert.equal(job.result.verifiedCtx,65536);assert.equal(job.result.appliedCtx,65536);
  assert.equal(ctxOf(),65536);
  const text=fs.readFileSync(ini,'utf8');assert.match(text,/; operator note stays/);assert.match(text,/\[other\]\nc = 4096/);
  const history=manager.calibration.status('synthetic').body.history[0];
  assert.equal(history.appliedCtx,65536);assert.equal(history.promptBudgetSeconds,60);assert.equal(history.build,'b-synthetic');
  const leave=manager.enterInference();leave();
});

test('a size whose long prompt loses the start marker fails even when it is fast',async t=>{
  const {manager,ctxOf}=fixture(t,{loadCap:131072,longCap:32768});
  await manager.calibration.start('synthetic',{promptBudgetSeconds:120,confirmPause:true});
  const job=await finished(manager);
  assert.equal(job.status,'passed',job.error);assert.equal(job.result.verifiedCtx,32768);assert.equal(ctxOf(),32768);
  assert.ok(job.steps.some(s=>s.kind==='long'&&s.status==='failed'&&/marker/.test(s.reason)));
});

test('when no size can be filled in time the run fails and keeps the original profile',async t=>{
  const {manager,ini,original}=fixture(t,{loadCap:131072,speed:10});
  await manager.calibration.start('synthetic',{promptBudgetSeconds:60,confirmPause:true});
  const job=await finished(manager);
  assert.equal(job.status,'failed');assert.match(job.error,/No size passed the long-prompt test within 60 s/);
  assert.equal(fs.readFileSync(ini,'utf8'),original);
});

test('chat pauses with an explanation for the whole run and resumes afterwards',async t=>{
  let release;const gate=new Promise(r=>{release=r;});
  const {manager}=fixture(t,{onLoad:ctx=>ctx===16384?gate:undefined});
  await manager.calibration.start('synthetic',{promptBudgetSeconds:120,confirmPause:true});
  for(let i=0;i<50;i++)await new Promise(r=>setImmediate(r));
  assert.throws(()=>manager.enterInference(),e=>e.status===503&&/calibrates synthetic/.test(e.message));
  assert.equal((await manager.calibration.start('synthetic',{promptBudgetSeconds:120,confirmPause:true})).status,409);
  release();await finished(manager);
  const leave=manager.enterInference();leave();
});

test('calibration will not start while requests are in flight',async t=>{
  const {manager}=fixture(t);
  const leave=manager.enterInference();
  assert.equal((await manager.calibration.start('synthetic',{promptBudgetSeconds:120,confirmPause:true})).status,409);
  leave();
});

test('another client loading a model aborts and restores the original preset',async t=>{
  const {manager,ini,original}=fixture(t,{onLoad:(ctx,router)=>{if(ctx===16384)router.status.other='loaded';}});
  await manager.calibration.start('synthetic',{promptBudgetSeconds:120,confirmPause:true});
  const job=await finished(manager);
  assert.equal(job.status,'failed');assert.match(job.error,/Another client/);assert.equal(job.restored,true);
  assert.equal(fs.readFileSync(ini,'utf8'),original);
});

test('the memory floor turns a size into a failure without crashing the run',async t=>{
  // Free memory drops below the floor only while a 64K-or-larger model is resident.
  let loadedCtx=0,router;
  const f=fixture(t,{loadCap:131072,memory:()=>router?.status.synthetic==='loaded'&&loadedCtx>=65536?1:20,onLoad:ctx=>{loadedCtx=ctx;}});
  router=f.router;const {manager}=f;
  await manager.calibration.start('synthetic',{promptBudgetSeconds:120,confirmPause:true});
  const job=await finished(manager);
  assert.equal(job.status,'passed',job.error+JSON.stringify(job.steps.map(s=>[s.ctx,s.kind,s.status,s.reason])));assert.ok(job.result.appliedCtx<65536,String(job.result.appliedCtx));
  assert.ok(job.steps.some(s=>s.memoryFloorHit&&/below 2 GiB/.test(s.reason)));
});

test('cancelling restores the original preset and releases chat',async t=>{
  let release;const gate=new Promise(r=>{release=r;});
  const {manager,ini,original}=fixture(t,{onLoad:ctx=>ctx===16384?gate:undefined});
  await manager.calibration.start('synthetic',{promptBudgetSeconds:120,confirmPause:true});
  for(let i=0;i<50;i++)await new Promise(r=>setImmediate(r));
  assert.equal(manager.calibration.cancel().status,202);release();
  const job=await finished(manager);
  assert.equal(job.status,'cancelled');assert.equal(fs.readFileSync(ini,'utf8'),original);
  const leave=manager.enterInference();leave();
  assert.equal(manager.calibration.cancel().status,409);
});

test('a model that cannot load at the starting size fails and keeps the original preset',async t=>{
  const {manager,ini,original}=fixture(t,{loadCap:4096});
  await manager.calibration.start('synthetic',{promptBudgetSeconds:120,confirmPause:true});
  const job=await finished(manager);
  assert.equal(job.status,'failed');assert.match(job.error,/did not load even at 8,192/);assert.equal(fs.readFileSync(ini,'utf8'),original);
});

test('an interrupted run is restored on startup only if the file is still the job\'s version',async t=>{
  const {manager,ini,stateFile,original}=fixture(t);
  const written=original.replace('c = 8192','ctx-size = 65536');fs.writeFileSync(ini,written);
  const revision=require('node:crypto').createHash('sha256').update(written).digest('hex');
  fs.writeFileSync(stateFile,JSON.stringify({job:{model:'synthetic',status:'running',steps:[],originalText:original,lastRevision:revision},history:{}}));
  await manager.calibration.recover();
  assert.equal(fs.readFileSync(ini,'utf8'),original);
  const job=manager.calibration.status().body.job;assert.equal(job.status,'interrupted');assert.equal(job.originalText,undefined);
  // A later operator edit is never overwritten.
  const edited=original+'\n; edited later\n';fs.writeFileSync(ini,edited);
  fs.writeFileSync(stateFile,JSON.stringify({job:{model:'synthetic',status:'running',steps:[],originalText:original,lastRevision:revision},history:{}}));
  await manager.calibration.recover();
  assert.equal(fs.readFileSync(ini,'utf8'),edited);
  // ...and the admin is told the calibration size may still be in the profile.
  const kept=manager.calibration.status().body.job;
  assert.equal(kept.restored,false);assert.match(kept.error,/not restored/);
});

test('calibration refuses to start on Laya, by id or by --model path, and unloads nothing',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'calibration-laya-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const ini=path.join(dir,'models.ini'),stateFile=path.join(dir,'state.json');
  fs.writeFileSync(ini,'version = 1\n[laya_multilingual_f16]\nmodel = /models/laya_multilingual_f16.gguf\nctx-size = 8192\n[router_a]\nmodel = /models/laya_multilingual_f16.gguf\nctx-size = 8192\n[synthetic]\nmodel = /models/s.gguf\nctx-size = 8192\n');
  const status={laya_multilingual_f16:'unloaded',router_a:'unloaded',synthetic:'unloaded'};
  const args={laya_multilingual_f16:[],router_a:['--model','/models/laya_multilingual_f16.gguf'],synthetic:[]};
  let unloadCalls=0;
  const fetchJson=async(url,opts={})=>{
    const u=new URL(url),body=opts.body?JSON.parse(opts.body):{};
    if(u.pathname==='/models'&&(!opts.method||opts.method==='GET'))return {ok:true,status:200,body:{data:Object.entries(status).map(([id,value])=>({id,status:{value,args:args[id]},meta:{}}))}};
    if(u.pathname==='/models/unload'){unloadCalls++;status[body.model]='unloaded';return {ok:true,status:200,body:{}};}
    return {ok:true,status:200,body:{}};
  };
  const manager=createModelManager({kind:'llamacpp',baseUrl:'http://synthetic',presetPath:ini,fetchJson,calibrationStatePath:stateFile,autoconfig:{},calibrationOptions:{sleep:async()=>{},readMemory:()=>20}});
  const byId=await manager.calibration.start('laya_multilingual_f16',{promptBudgetSeconds:60,confirmPause:true});
  assert.equal(byId.status,400);assert.equal(byId.body.error,'System routing model — not tuned');
  const byPath=await manager.calibration.start('router_a',{promptBudgetSeconds:60,confirmPause:true});
  assert.equal(byPath.status,400);assert.equal(byPath.body.error,'System routing model — not tuned');
  assert.equal(unloadCalls,0);
  assert.equal(manager.calibration.status().body.job,null);
  assert.equal(fs.readFileSync(ini,'utf8'),'version = 1\n[laya_multilingual_f16]\nmodel = /models/laya_multilingual_f16.gguf\nctx-size = 8192\n[router_a]\nmodel = /models/laya_multilingual_f16.gguf\nctx-size = 8192\n[synthetic]\nmodel = /models/s.gguf\nctx-size = 8192\n');
});

test('memory that stays low with the model unloaded stops the run instead of failing every size',async t=>{
  const {manager,ini,original}=fixture(t,{loadCap:131072,memory:()=>1});
  await manager.calibration.start('synthetic',{promptBudgetSeconds:120,confirmPause:true});
  const job=await finished(manager);
  assert.equal(job.status,'failed');assert.match(job.error,/stayed below 2 GiB even with the model unloaded/);
  assert.equal(job.steps.length,1);assert.equal(fs.readFileSync(ini,'utf8'),original);
});
