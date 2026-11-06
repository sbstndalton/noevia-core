'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createPresetStore}=require('./llamacpp-presets.cjs');
const {createModelManager}=require('./model-manager.cjs');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-presets-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'models.ini');fs.writeFileSync(file,'version = 1\n[*]\ncache-type-k = q8_0\n[synthetic]\n; keep projector and private operator options\nmodel = /models/test.gguf\nmmproj = /models/mmproj.gguf\nc = 8192\nLLAMA_ARG_CTX_SIZE = 16384\nngl = 999\njinja = true\n[other]\nc = 4096\n');return {file,store:createPresetStore(file)};}
test('profile update preserves unrelated options and sections, replaces all aliases atomically',async t=>{const {file,store}=fixture(t),profile=store.get('synthetic');const c=store.prepare({model:'synthetic',baseRevision:profile.revision,options:{'ctx-size':'32768','cache-type-v':'q8_0'}});await store.commit(c);const text=fs.readFileSync(file,'utf8');assert.match(text,/mmproj = \/models\/mmproj.gguf/);assert.match(text,/ngl = 999/);assert.match(text,/\[other\]\nc = 4096/);assert.doesNotMatch(text,/LLAMA_ARG_CTX_SIZE/);assert.equal(store.get('synthetic').options['ctx-size'],'32768');assert.equal(store.get('synthetic').defaults['cache-type-k'],'q8_0');await assert.rejects(store.commit(c),{status:409});});
test('unsafe options, injection, stale revisions and invalid allocations cannot change the file',t=>{const {file,store}=fixture(t),profile=store.get('synthetic'),before=fs.readFileSync(file,'utf8');for(const options of [{'model':'/private/file'},{'ctx-size':'0'},{parallel:'1000'},{'ctx-size':'32768\nmodel = /evil'},{'spec-type':'shell'}])assert.throws(()=>store.prepare({model:'synthetic',baseRevision:profile.revision,options}),{status:400});assert.throws(()=>store.prepare({model:'synthetic',baseRevision:'stale',options:{parallel:'1'}}),{status:409});assert.equal(fs.readFileSync(file,'utf8'),before);});
test('a models.ini write under the maintenance hold excludes concurrent native lifecycle mutations',async t=>{
 const {file}=fixture(t);let release;
 const waiting=new Promise(resolve=>{release=resolve;});
 const manager=createModelManager({kind:'llamacpp',baseUrl:'http://synthetic',presetPath:file,fetchJson:async url=>({ok:true,status:200,body:{data:[{id:'synthetic',status:{value:'unloaded'}}]}})});
 const writing=manager.writePresets(async()=>{await waiting;return 'written';},()=>false);
 await new Promise(resolve=>setImmediate(resolve));
 assert.throws(()=>manager.enterInference(),{status:503});
 for(const operation of [()=>manager.load('synthetic'),()=>manager.unload('synthetic'),()=>manager.deleteModel('synthetic'),()=>manager.pull({checkpoint:'synthetic/model:Q8_0'})])await assert.rejects(operation(),{status:503});
 release();assert.deepEqual(await writing,{written:'written',reload:null});
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
test('sampling defaults are accepted as bounded decimals and rejected otherwise',async t=>{
 const {file,store}=fixture(t),profile=store.get('synthetic');
 const c=store.prepare({model:'synthetic',baseRevision:profile.revision,options:{temp:'0.6','top-p':'0.95','top-k':'20','min-p':'0','repeat-penalty':'1.05'}});
 await store.commit(c);
 assert.deepEqual(['temp','top-p','top-k','min-p','repeat-penalty'].map(k=>store.get('synthetic').options[k]),['0.6','0.95','20','0','1.05']);
 const rev=store.get('synthetic').revision,before=fs.readFileSync(file,'utf8');
 for(const options of [{temp:'2.5'},{temp:'-1'},{temp:'0.6\nmodel = /evil'},{'top-p':'1.5'},{'top-k':'0.5'},{'min-p':'abc'},{'repeat-penalty':'4'}])
  assert.throws(()=>store.prepare({model:'synthetic',baseRevision:rev,options}),{status:400});
 assert.equal(fs.readFileSync(file,'utf8'),before);
});

test('#874 web writes keep only the newest recovery copies of models.ini',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-presets-prune-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'models.ini');fs.writeFileSync(file,'version = 1\n[synthetic]\nmodel = /models/test.gguf\nc = 8192\n');
 // Unrelated neighbours are never touched: another file's backups, a non-revision suffix, a directory.
 const keepers=['other.ini.noevia-backup-'+'a'.repeat(64),'models.ini.noevia-backup-notes','models.ini.bak-20260101-000000'];
 for(const n of keepers)fs.writeFileSync(path.join(dir,n),'x');
 fs.mkdirSync(path.join(dir,'models.ini.noevia-backup-'+'b'.repeat(64)));
 const store=createPresetStore(file,{backupKeep:3});
 const made=[];
 for(let i=0;i<6;i++){
  const before=store.get('synthetic').revision;
  await store.commit(store.prepare({model:'synthetic',baseRevision:before,options:{'ctx-size':String(8192+1024*(i+1))}}));
  made.push('models.ini.noevia-backup-'+before);
  // Distinct, increasing mtimes so "newest" is unambiguous on coarse filesystems.
  const at=new Date(Date.UTC(2020,0,1,0,0,i));fs.utimesSync(path.join(dir,made.at(-1)),at,at);
 }
 const left=fs.readdirSync(dir).filter(n=>/^models\.ini\.noevia-backup-[0-9a-f]{64}$/.test(n)&&fs.statSync(path.join(dir,n)).isFile()).sort();
 assert.deepEqual(left,made.slice(-3).sort(),'the three newest copies remain');
 for(const n of keepers)assert.ok(fs.existsSync(path.join(dir,n)),n);
 assert.ok(fs.statSync(path.join(dir,'models.ini.noevia-backup-'+'b'.repeat(64))).isDirectory());
 assert.match(fs.readFileSync(file,'utf8'),/c = 14336|ctx-size = 14336/);
});

test('#1003 commit with backup:false keeps no recovery copy; the default still does',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-presets-1003-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'models.ini');fs.writeFileSync(file,'version = 1\n[synthetic]\nmodel = /models/test.gguf\nc = 8192\n');
 const store=createPresetStore(file);
 const copies=()=>fs.readdirSync(dir).filter(n=>n.startsWith('models.ini.noevia-backup-'));
 await store.commit(store.prepare({model:'synthetic',baseRevision:store.get('synthetic').revision,options:{'ctx-size':'4096'}}),{backup:false});
 assert.deepEqual(copies(),[]);
 assert.match(fs.readFileSync(file,'utf8'),/4096/);
 await store.commit(store.prepare({model:'synthetic',baseRevision:store.get('synthetic').revision,options:{'ctx-size':'8192'}}));
 assert.equal(copies().length,1);
});

test('#1231 a non-string model name is refused, not coerced into a section name',t=>{
 for(const [model,section] of [[['m'],'m'],[123,'123']]){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-presets-1231-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'models.ini');fs.writeFileSync(file,`version = 1\n[${section}]\nmodel = /models/test.gguf\nc = 8192\n`);
  const store=createPresetStore(file);
  assert.throws(()=>store.prepare({model,baseRevision:store.get(section).revision,options:{'ctx-size':'4096'}}),e=>e.status===400&&/Invalid preset model name/.test(e.message));
 }
});
