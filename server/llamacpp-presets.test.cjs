'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createPresetStore}=require('./llamacpp-presets.cjs');
const {createModelManager}=require('./model-manager.cjs');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-presets-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'models.ini');fs.writeFileSync(file,'version = 1\n[*]\ncache-type-k = q8_0\n[synthetic]\n; keep projector and private operator options\nmodel = /models/test.gguf\nmmproj = /models/mmproj.gguf\nc = 8192\nLLAMA_ARG_CTX_SIZE = 16384\nngl = 999\njinja = true\n[other]\nc = 4096\n');return {file,store:createPresetStore(file)};}
test('profile update preserves unrelated options and sections, replaces all aliases atomically',t=>{const {file,store}=fixture(t),profile=store.get('synthetic');const c=store.prepare({model:'synthetic',baseRevision:profile.revision,options:{'ctx-size':'32768','cache-type-v':'q8_0'}});store.commit(c);const text=fs.readFileSync(file,'utf8');assert.match(text,/mmproj = \/models\/mmproj.gguf/);assert.match(text,/ngl = 999/);assert.match(text,/\[other\]\nc = 4096/);assert.doesNotMatch(text,/LLAMA_ARG_CTX_SIZE/);assert.equal(store.get('synthetic').options['ctx-size'],'32768');assert.equal(store.get('synthetic').defaults['cache-type-k'],'q8_0');assert.throws(()=>store.commit(c),{status:409});});
test('unsafe options, injection, stale revisions and invalid allocations cannot change the file',t=>{const {file,store}=fixture(t),profile=store.get('synthetic'),before=fs.readFileSync(file,'utf8');for(const options of [{'model':'/private/file'},{'ctx-size':'0'},{parallel:'1000'},{'ctx-size':'32768\nmodel = /evil'},{'spec-type':'shell'}])assert.throws(()=>store.prepare({model:'synthetic',baseRevision:profile.revision,options}),{status:400});assert.throws(()=>store.prepare({model:'synthetic',baseRevision:'stale',options:{parallel:'1'}}),{status:409});assert.equal(fs.readFileSync(file,'utf8'),before);});
test('native apply refuses active inference, loaded router models, and missing explicit reload acknowledgement',async t=>{const {file,store}=fixture(t);let loaded=true;const calls=[];const manager=createModelManager({kind:'llamacpp',baseUrl:'http://synthetic',presetPath:file,fetchJson:async(url)=>{calls.push(url);return {ok:true,status:200,body:{data:[{id:'synthetic',status:{value:loaded?'loaded':'unloaded'}}]}};}});const body={model:'synthetic',baseRevision:store.get('synthetic').revision,options:{parallel:'1'},confirmReload:true};assert.equal((await manager.applyPreset({...body,confirmReload:false})).status,400);assert.equal((await manager.applyPreset(body)).status,409);loaded=false;const leave=manager.enterInference();await assert.rejects(manager.applyPreset(body),{status:409});leave();assert.equal((await manager.applyPreset(body)).ok,true);assert.equal(calls.filter(u=>u.includes('reload=1')).length,1);});
test('failed native reload restores prior file without claiming runtime success',async t=>{const {file,store}=fixture(t),before=fs.readFileSync(file,'utf8');const manager=createModelManager({kind:'llamacpp',baseUrl:'http://synthetic',presetPath:file,fetchJson:async url=>({ok:!url.includes('reload'),status:url.includes('reload')?503:200,body:{data:[{id:'synthetic',status:{value:'unloaded'}}]}})});const result=await manager.applyPreset({model:'synthetic',baseRevision:store.get('synthetic').revision,options:{parallel:'1'},confirmReload:true});assert.equal(result.status,503);assert.equal(fs.readFileSync(file,'utf8'),before);});

test('applying a preset refuses Laya, by id or by --model path, without reloading',async t=>{
 const {file,store}=fixture(t),before=fs.readFileSync(file,'utf8');
 const calls=[];
 const manager=createModelManager({kind:'llamacpp',baseUrl:'http://synthetic',presetPath:file,fetchJson:async(url,opts={})=>{
  calls.push(url);
  if(new URL(url).pathname==='/models')return {ok:true,status:200,body:{data:[
   {id:'laya_multilingual_f16',status:{value:'unloaded',args:[]}},
   {id:'router_a',status:{value:'unloaded',args:['--model','/models/laya_multilingual_f16.gguf']}},
   {id:'synthetic',status:{value:'unloaded',args:[]}},
   {id:'other',status:{value:'unloaded',args:[]}},
  ]}};
  return {ok:true,status:200,body:{}};
 }});
 const byId=await manager.applyPreset({model:'laya_multilingual_f16',baseRevision:store.get('synthetic').revision,options:{parallel:'1'},confirmReload:true});
 assert.equal(byId.status,400);assert.equal(byId.body.error,'System routing model — not tuned');
 const byPath=await manager.applyPreset({model:'router_a',baseRevision:store.get('synthetic').revision,options:{parallel:'1'},confirmReload:true});
 assert.equal(byPath.status,400);assert.equal(byPath.body.error,'System routing model — not tuned');
 assert.ok(!calls.some(u=>u.includes('reload=1')));
 assert.equal(fs.readFileSync(file,'utf8'),before);
 const allowed=await manager.applyPreset({model:'synthetic',baseRevision:store.get('synthetic').revision,options:{parallel:'1'},confirmReload:true});
 assert.equal(allowed.ok,true);
});

test('preset reload excludes concurrent native lifecycle mutations',async t=>{
 const {file,store}=fixture(t);let release;
 const waiting=new Promise(resolve=>{release=resolve;});
 const manager=createModelManager({kind:'llamacpp',baseUrl:'http://synthetic',presetPath:file,fetchJson:async url=>{if(url==='http://synthetic/models')await waiting;return {ok:true,status:200,body:{data:[{id:'synthetic',status:{value:'unloaded'}}]}};}});
 const applying=manager.applyPreset({model:'synthetic',baseRevision:store.get('synthetic').revision,options:{parallel:'1'},confirmReload:true});
 assert.throws(()=>manager.enterInference(),{status:503});
 for(const operation of [()=>manager.load('synthetic'),()=>manager.unload('synthetic'),()=>manager.deleteModel('synthetic'),()=>manager.pull({checkpoint:'synthetic/model:Q8_0'})])await assert.rejects(operation(),{status:503});
 release();assert.equal((await applying).ok,true);
 const leave=manager.enterInference();leave();
});

test('reloading presets refuses while a model is loaded unless asked to unload it first',async t=>{
 const {file}=fixture(t);let loaded=true;const calls=[];
 const manager=createModelManager({kind:'llamacpp',baseUrl:'http://synthetic',presetPath:file,fetchJson:async(url,opts={})=>{calls.push(`${opts.method||'GET'} ${new URL(url).pathname}${new URL(url).search}`);if(url.endsWith('/models/unload'))loaded=false;return {ok:true,status:200,body:{data:[{id:'synthetic',status:{value:loaded?'loaded':'unloaded'}}]}};}});
 const refused=await manager.reloadPresets();
 assert.equal(refused.status,409);assert.deepEqual(refused.body.loaded,['synthetic']);assert.ok(!calls.some(c=>c.includes('reload=1')));
 const applied=await manager.reloadPresets({unload:true});
 assert.equal(applied.status,200);assert.deepEqual(applied.body.unloaded,['synthetic']);
 assert.ok(calls.indexOf('POST /models/unload')<calls.indexOf('GET /models?reload=1'));
 const leave=manager.enterInference();await assert.rejects(manager.reloadPresets({unload:true}),{status:409});leave();
});
