'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createModelManager}=require('./model-manager.cjs');
const {ladder}=require('./llamacpp-calibration.cjs');

// Synthetic llama.cpp router: a model loads only while its preset context is at or below
// `loadCap`, and recalls the start marker only at or below `longCap`.
function fixture(t,{loadCap=40960,longCap=Infinity,native=131072,memory=()=>20,other=false,onLoad}={}){
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
  const manager=createModelManager({kind:'llamacpp',baseUrl:'http://synthetic',presetPath:ini,fetchJson,calibrationStatePath:stateFile,autoconfig:{},calibrationOptions:{sleep:async()=>{},readMemory:memory,timeouts:{memoryPoll:5}}});
  return {manager,ini,stateFile,original,router,ctxOf};
}
async function finished(manager){for(let i=0;i<2000;i++){const job=manager.calibration.status().body.job;if(job&&job.status!=='running')return job;await new Promise(r=>setImmediate(r));}throw Error('calibration did not finish');}

test('ladder covers 4096 up to the trained context, or 128K when unknown',()=>{
  assert.equal(ladder(32768).at(-1),32768);assert.equal(ladder(0).at(-1),131072);assert.ok(ladder(100000).includes(100000));assert.equal(ladder(262144)[0],4096);
});

test('quick calibration climbs, refines between pass and failure, and saves the largest loading size',async t=>{
  const {manager,ini,router,ctxOf}=fixture(t);
  assert.equal((await manager.calibration.start('synthetic',{mode:'quick'})).status,400);
  const started=await manager.calibration.start('synthetic',{mode:'quick',confirmPause:true});
  assert.equal(started.status,202);assert.equal(started.body.originalText,undefined);
  const job=await finished(manager);
  assert.equal(job.status,'passed');assert.equal(job.result.appliedCtx,40960);
  assert.deepEqual(router.loads,[8192,16384,32768,65536,49152,40960]);
  assert.equal(ctxOf(),40960);
  const text=fs.readFileSync(ini,'utf8');assert.match(text,/; operator note stays/);assert.match(text,/\[other\]\nc = 4096/);
  assert.equal(manager.calibration.status('synthetic').body.history[0].appliedCtx,40960);
  assert.equal(manager.calibration.status('synthetic').body.history[0].build,'b-synthetic');
  const leave=manager.enterInference();leave();
});

test('thorough calibration steps down when the long-prompt recall fails',async t=>{
  const {manager,ctxOf}=fixture(t,{loadCap:40960,longCap:32768});
  await manager.calibration.start('synthetic',{mode:'thorough',confirmPause:true});
  const job=await finished(manager);
  assert.equal(job.status,'passed');assert.equal(job.result.loadCtx,40960);assert.equal(job.result.verifiedCtx,32768);
  assert.equal(ctxOf(),32768);
  const long=job.steps.filter(s=>s.kind==='long');assert.deepEqual(long.map(s=>[s.ctx,s.status]),[[40960,'failed'],[32768,'passed']]);
  assert.match(long[0].reason,/marker/);
});

test('chat pauses with an explanation for the whole run and resumes afterwards',async t=>{
  let release;const gate=new Promise(r=>{release=r;});
  const {manager}=fixture(t,{onLoad:ctx=>ctx===16384?gate:undefined});
  await manager.calibration.start('synthetic',{mode:'quick',confirmPause:true});
  for(let i=0;i<50;i++)await new Promise(r=>setImmediate(r));
  assert.throws(()=>manager.enterInference(),e=>e.status===503&&/calibrates synthetic/.test(e.message));
  assert.equal((await manager.calibration.start('synthetic',{mode:'quick',confirmPause:true})).status,409);
  release();await finished(manager);
  const leave=manager.enterInference();leave();
});

test('calibration will not start while requests are in flight',async t=>{
  const {manager}=fixture(t);
  const leave=manager.enterInference();
  assert.equal((await manager.calibration.start('synthetic',{mode:'quick',confirmPause:true})).status,409);
  leave();
});

test('another client loading a model aborts and restores the original preset',async t=>{
  const {manager,ini,original}=fixture(t,{onLoad:(ctx,router)=>{if(ctx===16384)router.status.other='loaded';}});
  await manager.calibration.start('synthetic',{mode:'quick',confirmPause:true});
  const job=await finished(manager);
  assert.equal(job.status,'failed');assert.match(job.error,/Another client/);assert.equal(job.restored,true);
  assert.equal(fs.readFileSync(ini,'utf8'),original);
});

test('the memory floor turns a size into a failure without crashing the run',async t=>{
  let current=20;
  const {manager}=fixture(t,{loadCap:131072,memory:()=>current,onLoad:ctx=>{current=ctx>=65536?1:20;}});
  await manager.calibration.start('synthetic',{mode:'quick',confirmPause:true});
  const job=await finished(manager);
  assert.equal(job.status,'passed');assert.ok(job.result.appliedCtx<65536,String(job.result.appliedCtx));
  assert.ok(job.steps.some(s=>s.memoryFloorHit&&/below 2 GiB/.test(s.reason)));
});

test('cancelling restores the original preset and releases chat',async t=>{
  let release;const gate=new Promise(r=>{release=r;});
  const {manager,ini,original}=fixture(t,{onLoad:ctx=>ctx===16384?gate:undefined});
  await manager.calibration.start('synthetic',{mode:'quick',confirmPause:true});
  for(let i=0;i<50;i++)await new Promise(r=>setImmediate(r));
  assert.equal(manager.calibration.cancel().status,202);release();
  const job=await finished(manager);
  assert.equal(job.status,'cancelled');assert.equal(fs.readFileSync(ini,'utf8'),original);
  const leave=manager.enterInference();leave();
  assert.equal(manager.calibration.cancel().status,409);
});

test('a model that cannot load at the starting size fails and keeps the original preset',async t=>{
  const {manager,ini,original}=fixture(t,{loadCap:4096});
  await manager.calibration.start('synthetic',{mode:'quick',confirmPause:true});
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
});
