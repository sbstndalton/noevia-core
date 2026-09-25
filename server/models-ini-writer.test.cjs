'use strict';
// MODELS_INI_WRITER (#295): model-loader as the single models.ini writer, with a fake sidecar.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createModelsIniWriter}=require('./models-ini-writer.cjs');
const {createPresetStore}=require('./llamacpp-presets.cjs');
const {createModelManager}=require('./model-manager.cjs');
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ini-writer-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'models.ini');fs.writeFileSync(file,'version = 1\n[*]\ncache-type-k = q8_0\n[synthetic]\n; operator note\nmodel = /models/s.gguf\nctx-size = 8192\n');return {dir,file};}
// Fake sidecar: same compare-and-swap semantics as PUT /api/v1/models-ini, writing the shared file.
function fakeSidecar(file,{status}={}){const calls=[];return {calls,fetchJson:async(url,opts)=>{calls.push({url,opts,body:JSON.parse(opts.body)});
  if(status==='parse'){const {text}=JSON.parse(opts.body);if(/^\s*\[[^\]]*$/m.test(text))return {ok:false,status:400,body:{detail:'models.ini text does not parse'}};}
  else if(status==='down')throw Error('ECONNREFUSED');if(status)return {ok:false,status,body:{detail:'Not Found'}};
  const {baseRevision,text}=JSON.parse(opts.body);if(baseRevision!==sha(fs.readFileSync(file,'utf8')))return {ok:false,status:409,body:{detail:'changed'}};
  fs.writeFileSync(file,text);return {ok:true,status:200,body:{ok:true,revision:sha(text)}};}};}

test('flag defaults to the in-process web writer and validates its value',()=>{
  assert.equal(createModelsIniWriter({}),null);
  assert.equal(createModelsIniWriter({mode:'web',url:'http://ml'}),null);
  assert.throws(()=>createModelsIniWriter({mode:'sidecar',url:'http://ml'}),/unsupported MODELS_INI_WRITER/);
  assert.throws(()=>createModelsIniWriter({mode:'model-loader'}),/requires MODEL_LOADER_URL/);
});

test('model-loader mode sends the prepared file through the sidecar with the token',async t=>{
  const {file}=fixture(t),side=fakeSidecar(file);
  const writer=createModelsIniWriter({mode:'model-loader',url:'http://ml:8090/',token:'fixture-token',fetchJson:side.fetchJson});
  const store=createPresetStore(file,{writer}),c=store.prepare({model:'synthetic',baseRevision:store.get('synthetic').revision,options:{parallel:'2'}});
  await store.commit(c);
  assert.equal(side.calls.length,1);const [call]=side.calls;
  assert.equal(call.url,'http://ml:8090/api/v1/models-ini');assert.equal(call.opts.method,'PUT');assert.equal(call.opts.headers['X-Model-Loader-Token'],'fixture-token');
  assert.equal(call.body.baseRevision,c.baseRevision);assert.equal(fs.readFileSync(file,'utf8'),c.text);
  assert.match(c.text,/; operator note/);assert.equal(store.get('synthetic').options.parallel,'2');
  // Web made no temp or backup files of its own: the sidecar is the only writer.
  assert.deepEqual(fs.readdirSync(path.dirname(file)),['models.ini']);
  await assert.rejects(store.commit(c),{status:409});
});

test('sidecar down, older sidecar and conflicts fail explicitly without changing the file',async t=>{
  for(const status of ['down',404,405,500]){
    const {file}=fixture(t),before=fs.readFileSync(file,'utf8'),side=fakeSidecar(file,{status});
    const store=createPresetStore(file,{writer:createModelsIniWriter({mode:'model-loader',url:'http://ml',fetchJson:side.fetchJson})});
    const c=store.prepare({model:'synthetic',baseRevision:store.get('synthetic').revision,options:{parallel:'2'}});
    await assert.rejects(store.commit(c),{status:503,message:/Model Loader could not save models.ini; nothing was changed/});
    assert.equal(fs.readFileSync(file,'utf8'),before);
  }
  const {file}=fixture(t),side=fakeSidecar(file);
  const store=createPresetStore(file,{writer:createModelsIniWriter({mode:'model-loader',url:'http://ml',fetchJson:async(u,o)=>{fs.appendFileSync(file,'; raced\n');return side.fetchJson(u,o);}})});
  const c=store.prepare({model:'synthetic',baseRevision:store.get('synthetic').revision,options:{parallel:'2'}});
  await assert.rejects(store.commit(c),{status:409});assert.doesNotMatch(fs.readFileSync(file,'utf8'),/parallel/);
});

test('applyPreset through the manager: success and sidecar outage keep the UI contract',async t=>{
  const router=async url=>({ok:true,status:200,body:{data:[{id:'synthetic',status:{value:'unloaded'}}]}});
  const {file}=fixture(t),side=fakeSidecar(file);
  const make=fetchSide=>createModelManager({kind:'llamacpp',baseUrl:'http://synthetic',presetPath:file,fetchJson:router,
    presetWriter:createModelsIniWriter({mode:'model-loader',url:'http://ml',fetchJson:fetchSide})});
  const ok=await make(side.fetchJson).applyPreset({model:'synthetic',baseRevision:sha(fs.readFileSync(file,'utf8')),options:{parallel:'3'},confirmReload:true});
  assert.equal(ok.ok,true);assert.equal(ok.body.options.parallel,'3');assert.equal(side.calls.length,1);
  const before=fs.readFileSync(file,'utf8');
  await assert.rejects(make(fakeSidecar(file,{status:'down'}).fetchJson).applyPreset({model:'synthetic',baseRevision:sha(before),options:{parallel:'4'},confirmReload:true}),{status:503});
  assert.equal(fs.readFileSync(file,'utf8'),before);
});

test('failed reload restores the previous file through the sidecar too',async t=>{
  const {file}=fixture(t),side=fakeSidecar(file),before=fs.readFileSync(file,'utf8');
  const manager=createModelManager({kind:'llamacpp',baseUrl:'http://synthetic',presetPath:file,
    fetchJson:async url=>({ok:!url.includes('reload'),status:url.includes('reload')?503:200,body:{data:[{id:'synthetic',status:{value:'unloaded'}}]}}),
    presetWriter:createModelsIniWriter({mode:'model-loader',url:'http://ml',fetchJson:side.fetchJson})});
  const r=await manager.applyPreset({model:'synthetic',baseRevision:sha(before),options:{parallel:'2'},confirmReload:true});
  assert.equal(r.status,503);assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(side.calls.length,2);
});

test('401/403 get their own token message without echoing the token',async t=>{
  for(const status of [401,403]){
    const {file}=fixture(t),before=fs.readFileSync(file,'utf8'),side=fakeSidecar(file,{status});
    const writer=createModelsIniWriter({mode:'model-loader',url:'http://ml',token:'fixture-secret',fetchJson:side.fetchJson});
    const err=await writer.write({baseRevision:sha(before),text:before}).catch(e=>e);
    assert.equal(err.status,503);assert.match(err.message,/rejected the token; check MODEL_LOADER_TOKEN/);assert.doesNotMatch(err.message,/fixture-secret/);
    assert.equal(fs.readFileSync(file,'utf8'),before);
  }
});

test('unparseable text maps to 400 with the sidecar detail and no write',async t=>{
  const {file}=fixture(t),before=fs.readFileSync(file,'utf8'),side=fakeSidecar(file,{status:'parse'});
  const writer=createModelsIniWriter({mode:'model-loader',url:'http://ml',fetchJson:side.fetchJson});
  await assert.rejects(writer.write({baseRevision:sha(before),text:'[broken\nx = 1\n'}),{status:400,message:/rejected the preset file: models.ini text does not parse/});
  assert.equal(fs.readFileSync(file,'utf8'),before);
});

test('no token configured: the token header is omitted',async t=>{
  const {file}=fixture(t),side=fakeSidecar(file),before=fs.readFileSync(file,'utf8');
  const writer=createModelsIniWriter({mode:'model-loader',url:'http://ml',fetchJson:side.fetchJson});
  await writer.write({baseRevision:sha(before),text:before+'; x\n'});
  assert.equal('X-Model-Loader-Token' in side.calls[0].opts.headers,false);
});

test('preamble before the first section round-trips through the sidecar',async t=>{
  const {file}=fixture(t),side=fakeSidecar(file);
  const store=createPresetStore(file,{writer:createModelsIniWriter({mode:'model-loader',url:'http://ml',fetchJson:side.fetchJson})});
  await store.commit(store.prepare({model:'synthetic',baseRevision:store.get('synthetic').revision,options:{parallel:'2'}}));
  const after=fs.readFileSync(file,'utf8');
  assert.match(after,/^version = 1\n\[\*\]\n/);assert.match(after,/cache-type-k = q8_0/);assert.equal(store.get('synthetic').options.parallel,'2');
});
