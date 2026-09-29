'use strict';
// MODELS_INI_WRITER (#295): model-loader as the single models.ini writer, with a fake sidecar.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {createModelsIniWriter,reportModelsIniWriter}=require('./models-ini-writer.cjs');
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
  // An older sidecar (404/405) answered without writing: that is a confirmed "nothing changed".
  for(const status of [404,405]){
    const {file}=fixture(t),before=fs.readFileSync(file,'utf8'),side=fakeSidecar(file,{status});
    const store=createPresetStore(file,{writer:createModelsIniWriter({mode:'model-loader',url:'http://ml',fetchJson:side.fetchJson})});
    const c=store.prepare({model:'synthetic',baseRevision:store.get('synthetic').revision,options:{parallel:'2'}});
    await assert.rejects(store.commit(c),{status:503,message:/Model Loader could not save models.ini; nothing was changed/});
    assert.equal(fs.readFileSync(file,'utf8'),before);
  }
  // Transport loss and 5xx may have committed (#339): the raw writer says so, never "nothing changed".
  for(const status of ['down',500,502]){
    const {file}=fixture(t),before=fs.readFileSync(file,'utf8'),side=fakeSidecar(file,{status});
    const store=createPresetStore(file,{writer:createModelsIniWriter({mode:'model-loader',url:'http://ml',fetchJson:side.fetchJson})});
    const c=store.prepare({model:'synthetic',baseRevision:store.get('synthetic').revision,options:{parallel:'2'}});
    const err=await store.commit(c).catch(e=>e);
    assert.equal(err.status,503);assert.equal(err.uncertain,true);
    assert.match(err.message,/did not confirm whether models.ini was saved/);assert.doesNotMatch(err.message,/nothing was changed/i);
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
  const down=await make(fakeSidecar(file,{status:'down'}).fetchJson).applyPreset({model:'synthetic',baseRevision:sha(before),options:{parallel:'4'},confirmReload:true});
  assert.equal(down.ok,false);assert.equal(down.status,503);assert.equal(down.body.retryable,true);
  assert.equal(fs.readFileSync(file,'utf8'),before);
});

// #339: the real applyPreset path with a sidecar whose reply can be lost. `mode` decides what the
// sidecar does to the shared file before the web side sees (or fails to see) its answer.
function lossy(t,mode){
  const {file}=fixture(t),before=fs.readFileSync(file,'utf8'),calls=[];let reloads=0;
  const fetchSide=async(_url,opts)=>{
    const {baseRevision,text}=JSON.parse(opts.body);calls.push({baseRevision,text});
    const current=fs.readFileSync(file,'utf8');
    if(mode==='reject-409')return {ok:false,status:409,body:{detail:'models.ini changed'}};
    if(mode==='reject-400')return {ok:false,status:400,body:{detail:'models.ini text does not parse'}};
    if(baseRevision!==sha(current))return {ok:false,status:409,body:{detail:'changed'}};
    if(mode==='commit-then-lost'){fs.writeFileSync(file,text);throw Error('socket hang up after commit');}
    if(mode==='commit-then-500'){fs.writeFileSync(file,text);return {ok:false,status:500,body:{detail:'Internal Server Error'}};}
    if(mode==='commit-then-garbled'){fs.writeFileSync(file,text);return {ok:true,status:200,body:'<html>proxy</html>'};}
    if(mode==='outage')throw Error('ECONNREFUSED');
    if(mode==='timeout')throw Object.assign(Error('aborted'),{name:'AbortError'});
    if(mode==='third-party'){fs.writeFileSync(file,current+'; operator edit\n');throw Error('socket hang up');}
    if(mode==='vanished'){fs.rmSync(file);throw Error('socket hang up');}
    throw Error('unknown mode');
  };
  const manager=createModelManager({kind:'llamacpp',baseUrl:'http://router.synthetic',presetPath:file,
    fetchJson:async url=>{if(url.includes('reload=1'))reloads++;return {ok:true,status:200,body:{data:[{id:'synthetic',status:{value:'unloaded'}}]}};},
    presetWriter:createModelsIniWriter({mode:'model-loader',url:'http://ml',fetchJson:fetchSide})});
  const apply=()=>manager.applyPreset({model:'synthetic',baseRevision:sha(before),options:{'ctx-size':'16384'},confirmReload:true});
  return {file,before,calls,apply,reloads:()=>reloads};
}

test('#339 commit then lost response: the file is read back and the guarded reload still runs',async t=>{
  for(const mode of ['commit-then-lost','commit-then-500','commit-then-garbled']){
    const f=lossy(t,mode);
    const r=await f.apply();
    assert.equal(r.ok,true,mode);assert.equal(r.status,200);assert.equal(r.body.applied,true);assert.equal(r.body.options['ctx-size'],'16384');
    assert.equal(f.reloads(),1,mode);assert.equal(f.calls.length,1,'no second write');
    assert.equal(fs.readFileSync(f.file,'utf8'),f.calls[0].text);
  }
});

test('#339 confirmed 409/400 rejections: no reload and an accurate message',async t=>{
  const conflict=lossy(t,'reject-409');
  await assert.rejects(conflict.apply(),{status:409,message:/Presets changed while applying/});
  assert.equal(conflict.reloads(),0);assert.equal(fs.readFileSync(conflict.file,'utf8'),conflict.before);
  const invalid=lossy(t,'reject-400');
  await assert.rejects(invalid.apply(),{status:400,message:/rejected the preset file: models.ini text does not parse/});
  assert.equal(invalid.reloads(),0);assert.equal(fs.readFileSync(invalid.file,'utf8'),invalid.before);
});

test('#339 outage before commit: verified unchanged, retryable, no reload',async t=>{
  for(const mode of ['outage','timeout']){
    const f=lossy(t,mode);
    const r=await f.apply();
    assert.equal(r.ok,false);assert.equal(r.status,503);assert.equal(r.body.retryable,true);
    assert.match(r.body.error,/still holds the previous settings, so the preset was not applied/);
    assert.doesNotMatch(r.body.error,/nothing was changed/i);
    assert.equal(f.reloads(),0,mode);assert.equal(fs.readFileSync(f.file,'utf8'),f.before);
    // The retry the message invites is safe: same base revision, fresh compare-and-swap.
  }
});

test('#339 third-party edit during an uncertain write is reported and never overwritten',async t=>{
  const f=lossy(t,'third-party');
  const err=await f.apply().catch(e=>e);
  assert.equal(err.status,409);assert.match(err.message,/changes from somewhere else. They were left untouched/);
  assert.equal(f.reloads(),0);assert.equal(f.calls.length,1,'no rollback or retry write');
  assert.equal(fs.readFileSync(f.file,'utf8'),f.before+'; operator edit\n');
});

test('#339 an unreadable file after an uncertain write is not guessed at',async t=>{
  const f=lossy(t,'vanished');
  const r=await f.apply();
  assert.equal(r.ok,false);assert.equal(r.status,503);assert.match(r.body.error,/could not be read back to check/);
  assert.equal(r.body.retryable,undefined);assert.equal(f.reloads(),0);
});

test('#339 rollback after a failed reload is reconciled too',async t=>{
  // Reload fails; the restoring PUT commits but its reply is lost: still reported as restored.
  for(const [restore,expect] of [['commit-then-lost',/Previous preset file restored/],['outage',/could not be restored: models.ini still holds the new settings/]]){
    const {file}=fixture(t),before=fs.readFileSync(file,'utf8');let writes=0,reloads=0;
    const manager=createModelManager({kind:'llamacpp',baseUrl:'http://router.synthetic',presetPath:file,
      fetchJson:async url=>{if(url.includes('reload=1')){reloads++;return {ok:false,status:503,body:{}};}return {ok:true,status:200,body:{data:[{id:'synthetic',status:{value:'unloaded'}}]}};},
      presetWriter:createModelsIniWriter({mode:'model-loader',url:'http://ml',fetchJson:async(_u,opts)=>{
        const {baseRevision,text}=JSON.parse(opts.body);writes++;
        if(baseRevision!==sha(fs.readFileSync(file,'utf8')))return {ok:false,status:409,body:{}};
        if(writes===1){fs.writeFileSync(file,text);return {ok:true,status:200,body:{ok:true,revision:sha(text)}};}
        if(restore==='commit-then-lost'){fs.writeFileSync(file,text);throw Error('socket hang up');}
        throw Error('ECONNREFUSED');
      }})});
    const r=await manager.applyPreset({model:'synthetic',baseRevision:sha(before),options:{parallel:'2'},confirmReload:true});
    assert.equal(r.ok,false);assert.equal(r.status,503);assert.match(r.body.error,expect);assert.equal(writes,2);
    if(restore==='commit-then-lost'){assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(reloads,2);}
    else {assert.match(fs.readFileSync(file,'utf8'),/parallel = 2/);assert.equal(reloads,1);}
  }
});

test('#339 the reproduction from the issue: changed file, reload runs, no false claim',async t=>{
  const {file}=fixture(t),before=fs.readFileSync(file,'utf8');let reloads=0;
  const manager=createModelManager({kind:'llamacpp',baseUrl:'http://router.invalid',presetPath:file,
    fetchJson:async url=>{if(url.includes('reload=1'))reloads++;return {ok:true,status:200,body:{data:[{id:'synthetic',status:{value:'unloaded'}}]}};},
    presetWriter:createModelsIniWriter({mode:'model-loader',url:'http://sidecar.invalid',fetchJson:async(_url,opts)=>{
      const body=JSON.parse(opts.body);assert.equal(body.baseRevision,sha(fs.readFileSync(file,'utf8')));
      fs.writeFileSync(file,body.text);throw Error('response lost after commit');}})});
  const r=await manager.applyPreset({model:'synthetic',baseRevision:sha(before),options:{'ctx-size':'16384'},confirmReload:true}).catch(e=>e);
  assert.equal(r.ok,true);assert.notEqual(fs.readFileSync(file,'utf8'),before);assert.equal(reloads,1);
  assert.doesNotMatch(JSON.stringify(r.body),/nothing was changed/i);
});

test('#339 web writer mode is untouched: local errors are not reinterpreted',async t=>{
  const {file}=fixture(t);
  const store=createPresetStore(file),c=store.prepare({model:'synthetic',baseRevision:store.get('synthetic').revision,options:{parallel:'2'}});
  const {commitReconciled}=require('./models-ini-writer.cjs');
  await commitReconciled(store,c);assert.equal(fs.readFileSync(file,'utf8'),c.text);
  await assert.rejects(commitReconciled(store,c),{status:409,message:/Presets changed while applying/});
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

// #269: compose mounts web's /llamacpp-config :ro with model-loader as the default writer. A dir
// without write permission stands in for the read-only bind (root ignores mode bits, so skip).
const asRoot=process.getuid?.()===0;
// fixture()'s cleanup hook runs first (after hooks are FIFO), so restore the mode in-test.
async function readOnlyDir(dir,body){fs.chmodSync(dir,0o500);try{await body();}finally{fs.chmodSync(dir,0o700);}}
const router=async()=>({ok:true,status:200,body:{data:[{id:'synthetic',status:{value:'unloaded'}}]}});

test('web mode on a read-only config dir: startup logs once, saves fail explicitly, nothing is written',{skip:asRoot&&'root bypasses directory permissions'},async t=>{
  const {dir,file}=fixture(t),before=fs.readFileSync(file,'utf8');
  await readOnlyDir(dir,async()=>{
  const logs=[];
  assert.ok(reportModelsIniWriter({mode:undefined,presetPath:file,log:m=>logs.push(m)}));
  assert.equal(logs.length,1);assert.match(logs[0],/MODELS_INI_WRITER=web but .* is not writable/);assert.match(logs[0],/MODELS_INI_WRITER=model-loader/);
  // The raw store refuses before any backup or temp file: a clear 503, not EROFS/EACCES.
  const store=createPresetStore(file);
  const c=store.prepare({model:'synthetic',baseRevision:store.get('synthetic').revision,options:{parallel:'2'}});
  await assert.rejects(store.commit(c),e=>e.status===503&&e.code==='MODELS_INI_READ_ONLY'&&/read-only mount while MODELS_INI_WRITER=web, so nothing was changed/.test(e.publicMessage));
  // Through the manager the admin gets that message, and reads keep working.
  const manager=createModelManager({kind:'llamacpp',baseUrl:'http://synthetic',presetPath:file,fetchJson:router,presetWriter:createModelsIniWriter({mode:'web'})});
  const r=await manager.applyPreset({model:'synthetic',baseRevision:sha(before),options:{parallel:'3'},confirmReload:true});
  assert.equal(r.ok,false);assert.equal(r.status,503);assert.match(r.body.error,/remove :ro from the \/llamacpp-config mount/);
  assert.equal(fs.readFileSync(file,'utf8'),before);assert.deepEqual(fs.readdirSync(dir),['models.ini']);
  assert.equal(store.get('synthetic').options['ctx-size'],'8192');
  });
});

test('model-loader mode on a read-only config dir: startup is silent and saves go through the sidecar',{skip:asRoot&&'root bypasses directory permissions'},async t=>{
  const {dir,file}=fixture(t);
  await readOnlyDir(dir,async()=>{
  const logs=[];
  assert.equal(reportModelsIniWriter({mode:'model-loader',presetPath:file,log:m=>logs.push(m)}),null);assert.deepEqual(logs,[]);
  const side=fakeSidecar(file);
  const manager=createModelManager({kind:'llamacpp',baseUrl:'http://synthetic',presetPath:file,fetchJson:router,presetWriter:createModelsIniWriter({mode:'model-loader',url:'http://ml',fetchJson:side.fetchJson})});
  const r=await manager.applyPreset({model:'synthetic',baseRevision:sha(fs.readFileSync(file,'utf8')),options:{parallel:'3'},confirmReload:true});
  assert.equal(r.ok,true);assert.equal(side.calls.length,1);assert.match(fs.readFileSync(file,'utf8'),/parallel = 3/);
  assert.deepEqual(fs.readdirSync(dir),['models.ini']);
  });
});

test('web mode on a writable dir: no startup error and the in-process write still works',async t=>{
  const {dir,file}=fixture(t),logs=[];
  assert.equal(reportModelsIniWriter({mode:'web',presetPath:file,log:m=>logs.push(m)}),null);assert.deepEqual(logs,[]);
  assert.equal(reportModelsIniWriter({mode:'web',presetPath:'',log:m=>logs.push(m)}),null);
  const store=createPresetStore(file),c=store.prepare({model:'synthetic',baseRevision:store.get('synthetic').revision,options:{parallel:'2'}});
  await store.commit(c);assert.equal(store.get('synthetic').options.parallel,'2');
  assert.ok(fs.readdirSync(dir).some(n=>n.startsWith('models.ini.noevia-backup-')));
});

// The shipped llama.cpp overlays keep web read-only with model-loader as the writer (#269). No
// compose validation runs in CI; walk the web service block by indentation (compose-embed.test).
test('llama.cpp compose files mount web /llamacpp-config :ro and default to the model-loader writer',()=>{
  const root=path.resolve(__dirname,'..','..','..');
  for(const rel of ['compose.llamacpp.yaml','deploy/examples/unraid-llamacpp.override.yml']){
    const lines=fs.readFileSync(path.join(root,rel),'utf8').split('\n'),start=lines.indexOf('  web:');
    assert.ok(start>=0,rel);
    const end=lines.findIndex((l,i)=>i>start&&/^ {0,2}\S/.test(l)&&!/^\s*#/.test(l));
    const web=lines.slice(start,end<0?undefined:end).filter(l=>!/^\s*#/.test(l)).join('\n');
    assert.match(web,/^\s+MODELS_INI_WRITER: \$\{MODELS_INI_WRITER:-model-loader\}$/m,rel);
    assert.match(web,/^\s+- \$\{LLAMACPP_CONFIG_DIR\}:\/llamacpp-config:ro$/m,rel);
    assert.doesNotMatch(web,/:\/llamacpp-config(:rw)?$/m,rel);
    assert.match(web,/MODEL_LOADER_URL: http:\/\/model-loader:8090/,rel);
  }
});
