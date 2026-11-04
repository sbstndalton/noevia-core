'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {createNativeFacts}=require('./rust-model-facts.cjs');
const {createModelService}=require('./models.cjs');
const {createClient}=require('./project-store-client.cjs');
test('installedFacts: sidecar names and reports, one scan, and the first loaded model is remembered once', async () => {
  const fetched = [];
  const env = { MODEL_LOADER_URL: 'http://loader', EMBEDDING_MODEL: 'syn-embed' };
  const fetchJson = async (url) => {
    fetched.push(url);
    if (url.endsWith('/backends')) return { ok: true, body: { backends: [{ status: 'running', loaded_model: 'syn-embed, other' }, { status: 'stopped', loaded_model: 'no' }] } };
    return { ok: true, body: { models: [{ modelId: 'syn-chat', sections: ['syn-chat'], bytes: 5e9, shape: { layers: 1 }, secretPath: '/data/x' }] } };
  };
  const service = createModelService({ fetchJson, env, modelManager: {}, currentWorkspace: () => ({}) });
  const [a, b] = await Promise.all([
    service.installedFacts({ ids: ['syn-chat', 'syn-embed'], scan: true, firstLoaded: 'syn-chat' }),
    service.installedFacts({ ids: ['syn-chat'], scan: true, firstLoaded: 'later' }),
  ]);
  assert.deepEqual(a, { sidecarNames: ['syn-embed'], sidecarLoaded: ['syn-embed', 'other'], scan: [{ modelId: 'syn-chat', sections: ['syn-chat'], bytes: 5e9, shape: { layers: 1 } }] });
  assert.deepEqual(b.sidecarLoaded, [], 'no sidecar among the ids: the loader is not asked');
  assert.equal(service.lastLoadedModel(), 'syn-chat');
  assert.equal(fetched.filter((u) => u.endsWith('/models')).length, 1, 'concurrent cold reads share one scan');
  const none = await service.installedFacts({ ids: [], scan: false });
  assert.equal(none.scan, null);
});

test('installedFacts never returns a scan captured before cache invalidation (#2386)', async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const service = createModelService({
    fetchJson: () => pending,
    env: { MODEL_LOADER_URL: 'http://synthetic-loader' },
    modelManager: {}, currentWorkspace: () => ({}),
  });
  const reading = service.installedFacts({ ids: [], scan: true });
  // Let installedFacts pass its sidecar await and capture the scan generation.
  await new Promise((resolve) => setImmediate(resolve));
  service.modelScanCache.clear();
  finish({ ok: true, body: { models: [{ modelId: 'synthetic-deleted', bytes: 5e9 }] } });
  assert.equal((await reading).scan, null);
  assert.equal(service.modelScanCache.get('models'), undefined);
});

function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-facts-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const write=s=>fs.writeFileSync(path.join(root,'model-facts.json'),typeof s==='string'?s:JSON.stringify(s));
 const state={protocol:'model-facts/1',start:'synthetic-start',generation:1,at:1000,budget:{budgetGib:7,source:'deployment'},sidecarNames:['synthetic-sidecar']};
 write(state);return {write,state,root};
}
test('Node budget enforcement and sidecar protection read the native snapshot',t=>{
 const {root,write,state}=fixture(t); const native=createNativeFacts({dataDir:root,start:state.start,now:()=>1000});
 assert.equal(native.budgetGib(),7);assert.deepEqual([...native.sidecarNames()],['synthetic-sidecar']);
 write({...state,generation:2,budget:{budgetGib:11,source:'admin'}});assert.equal(native.budgetGib(),11);
 write(state);assert.throws(()=>native.budgetGib(),{code:'MODEL_FACTS_UNAVAILABLE'});
});
test('missing, torn, stale and wrong-start snapshots fail closed',t=>{
 const {root,write,state}=fixture(t); const native=createNativeFacts({dataDir:root,start:state.start,now:()=>17000});
 for(const value of ['{"protocol":', {...state,at:1000},{...state,at:17000,start:'other-start'},{...state,at:18000},{...state,at:17000,budget:{budgetGib:0}}]) {
  write(value);assert.throws(()=>native.budgetGib(),{status:503});
 }
 fs.unlinkSync(path.join(root,'model-facts.json'));assert.throws(()=>native.budgetGib(),{status:503});
});
test('budget writes and installed reads go through native private store',async t=>{
 const {root,state}=fixture(t);const seen=[];
 const client=createClient({port:12345,token:'s'.repeat(40),fetchImpl:async(url,init)=>{seen.push([url,JSON.parse(init.body)]);return new Response(JSON.stringify(url.endsWith('/budget')?{budgetGib:9}:[{name:'synthetic',status:'loading'}]),{status:200});}});
 const native=createNativeFacts({dataDir:root,start:state.start,now:()=>1000,storeClient:client});
 assert.equal((await native.save({budgetGib:9},'synthetic-user')).budgetGib,9);
 assert.equal((await native.installed())[0].status,'loading');
 assert.match(seen[0][0],/model-facts\/budget$/);assert.match(seen[1][0],/model-facts\/installed$/);
 assert.equal(native.budgetGib(),7,'Node never publishes a speculative saved value');
});
test('runtime wiring retires the Node budget and facts bridge',()=>{
 const index=fs.readFileSync(path.join(__dirname,'index.cjs'),'utf8');
 assert.match(index,/createNativeFacts/);assert.doesNotMatch(index,/createInferenceBudget|modelFactsBridge/);
});

test('the installed service consumes native rows, including unavailable backend errors',async t=>{
 const facts=require('./rust-model-facts.cjs');const old=facts.current();t.after(()=>facts.install(old));
 const rows=[{name:'synthetic',status:'loading',failed:false}];
 facts.install({installed:async()=>rows});
 const service=createModelService({env:{},modelManager:{},currentWorkspace:()=>({}),fetchJson:()=>{throw Error('Node must not derive facts');}});
 assert.equal(await service.modelsInstalledFresh(),rows);
 facts.install({installed:async()=>{throw Object.assign(Error('unavailable'),{status:503});}});
 await assert.rejects(service.modelsInstalledFresh(),{status:503});
});

test('sidecar config changes invalidate the native projection until it catches up',t=>{
 const {root,write,state}=fixture(t);let revision='v1';
 write({...state,configRevision:'v1'});
 const native=createNativeFacts({dataDir:root,start:state.start,now:()=>1000,configRevision:()=>revision});
 assert.equal(native.sidecarNames().has('synthetic-sidecar'),true);
 revision='v2';assert.throws(()=>native.sidecarNames(),{status:503});
 write({...state,configRevision:'v2',sidecarNames:['synthetic-next']});
 assert.deepEqual([...native.sidecarNames()],['synthetic-next']);
});

test('a missing native snapshot refuses the actual Node load admission path',async t=>{
 const facts=require('./rust-model-facts.cjs'); const old=facts.current();t.after(()=>facts.install(old));
 const {root,state}=fixture(t);fs.unlinkSync(path.join(root,'model-facts.json'));
 const native=createNativeFacts({dataDir:root,start:state.start,now:()=>1000});
 facts.install(native);
 const manager=require('./llamacpp-manager.cjs').createLlamaCppManager({baseUrl:'http://synthetic-router',fetchJson:async()=>{throw Error('no engine writes permitted');},inferenceBudget:native});
 await assert.rejects(manager.loadRefusal('synthetic'),{status:503,code:'MODEL_FACTS_UNAVAILABLE'});
});

test('raw config export is bounded to model config and rejects forwarded callers',async()=>{
 const {configuration,createBridge}=require('./rust-model-config.cjs');
 const raw=configuration({EMBEDDING_MODEL:'synthetic-embed',RERANK_MODEL:'synthetic-rerank',SECRET_DONT_EXPORT:'hidden-value'});
 assert.equal(raw.env.EMBEDDING_MODEL,'synthetic-embed');assert.doesNotMatch(JSON.stringify(raw),/hidden-value|SECRET_DONT_EXPORT/);
 let answer;const bridge=createBridge({secret:'s'.repeat(40),json:(_,status,body)=>{answer={status,body};},readJson:async()=>({}),env:{},service:{}});
 await bridge({method:'POST',url:'/internal/model-config',headers:{'x-noevia-store-token':'s'.repeat(40),'x-forwarded-for':''},socket:{remoteAddress:'127.0.0.1'}},{});
 assert.equal(answer.status,404);
});
