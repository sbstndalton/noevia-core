'use strict';
// #1071: every selector uses Rust policy; frozen JS is an independent test oracle only.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const presets=require('./llamacpp-presets.cjs');
const reference=require('../tests/reference/llamacpp-presets-js.cjs');
const dav=require('./dav-parse-wasm.cjs');
const LIMITS={capMib:1024,hardMaxMib:2048};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'presets-native-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'models.ini');fs.writeFileSync(file,"[*]\nbatch-size = 2048\n\n[synthetic]\nmodel = /models/qa.gguf\nub = 512\n");return file;}
function standIn(over={},calls=[]){const port={
  llamacppPresetsModel:m=>({ok:reference.modelNameOk(m)}),
  llamacppPresetsValues:(pairs,hard)=>({values:pairs.map(([k,v])=>reference.optionValue(k,v,{hardMaxMib:hard})??null)}),
  llamacppPresetsBatch:(u,b)=>({exceeds:reference.microBatchExceeds(u??undefined,b??undefined)}),
  llamacppPresetsCanonical:pairs=>({options:pairs.map(p=>reference.canonicalEntry(...p))}),
};for(const key of Object.keys(port)){const fn=over[key]||port[key];port[key]=(...args)=>{calls.push(key);return fn(...args);};}return()=>port;}
const store=(file,env={},loader=standIn())=>presets.createPresetStore(file,{cacheRam:LIMITS,env,wasmLoader:loader});
const body=(file,options,model='synthetic')=>({model,baseRevision:store(file).get('synthetic').revision,options});
test('retired LLAMACPP_PRESETS_IMPL always selects Rust, preserving accepted INI output',t=>{
 assert.ok(!dav.IMPL_FLAGS.includes('LLAMACPP_PRESETS_IMPL'));assert.equal(dav.RETIRED_FLAGS.LLAMACPP_PRESETS_IMPL,'wasm');
 const file=fixture(t),options={'ctx-size':'8192','cache-ram':' 0700 ',temp:'0.7'};
 const want=reference.createPresetStore(file,{cacheRam:LIMITS,env:{}}).prepare(body(file,options));
 for(const value of [undefined,'','js','wasm','rust']){const calls=[];const env={LLAMACPP_PRESETS_IMPL:value};assert.equal(presets.llamacppPresetsImpl(env),'wasm');assert.equal(store(file,env,standIn({},calls)).prepare(body(file,options)).text,want.text);assert.ok(calls.includes('llamacppPresetsModel')&&calls.includes('llamacppPresetsValues')&&calls.includes('llamacppPresetsBatch'));}
});
test('native value refusal, malformed output and faults retain400 and never write the file',t=>{
 const file=fixture(t),before=fs.readFileSync(file,'utf8');
 for(const value of [()=>({values:[null]}),()=>({values:[]}),()=>{throw Error('synthetic');}]){
  assert.throws(()=>store(file,{LLAMACPP_PRESETS_IMPL:'js'},standIn({llamacppPresetsValues:value})).prepare(body(file,{parallel:'2'})),{status:400,message:'Invalid preset option: parallel'});assert.equal(fs.readFileSync(file,'utf8'),before);
 }
});
test('model and batch refusals retain public errors; missing batch uses2048',t=>{
 const file=fixture(t);
 assert.throws(()=>store(file,{},standIn({llamacppPresetsModel:()=>({ok:false})})).prepare(body(file,{parallel:'2'})),{status:400,message:'Invalid preset model name'});
 for(const model of [123,['synthetic']])assert.throws(()=>store(file).prepare(body(file,{parallel:'2'},model)),{status:400,message:'Invalid preset model name'});
 for(const exceeds of [true,null])assert.throws(()=>store(file,{},standIn({llamacppPresetsBatch:()=>({exceeds})})).prepare(body(file,{'ubatch-size':'64'})),{status:400,message:exceeds===true?'Micro batch cannot exceed batch size':'Invalid preset option: ubatch-size'});
 assert.throws(()=>store(file).prepare(body(file,{'ubatch-size':'2049'})),{status:400,message:'Micro batch cannot exceed batch size'});
 assert.doesNotThrow(()=>store(file).prepare(body(file,{'ubatch-size':'2048'})));
});
test('Rust values are authoritative; the host does not run the removed JS validator',t=>{
 const file=fixture(t);
 const loader=standIn({llamacppPresetsValues:(pairs,hard)=>({values:pairs.map(([k,v])=>k==='temp'?'0.70':reference.optionValue(k,v,{hardMaxMib:hard})??null)})});
 assert.match(store(file,{},loader).prepare(body(file,{temp:'0.7'})).text,/temp = 0.70/);
});
test('canonical projection uses Rust and fails closed on missing, malformed or unknown fields',()=>{
 const input={'--cram':' 512 ',c:4096,model:'/qa.gguf',np:null};const expected=reference.canonicalOptions(input);
 assert.deepEqual(presets.checkedCanonicalOptions(input,{wasmLoader:standIn()}),{options:expected,refused:null});
 for(const fn of [()=>{throw Error('fault');},()=>({options:[]}),pairs=>({options:pairs.map(()=>['not-a-field','x'])})])assert.equal(presets.checkedCanonicalOptions(input,{env:{LLAMACPP_PRESETS_IMPL:'js'},wasmLoader:standIn({llamacppPresetsCanonical:fn})}).refused,'--cram');
 assert.deepEqual(presets.checkedCanonicalOptions({}, {wasmLoader:()=>{throw Error('unused');}}),{options:{},refused:null});
});
test('the test-only reference retains all old rules and only import paths were adapted',()=>{
 const crypto=require('node:crypto');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(require.resolve('../tests/reference/llamacpp-presets-js.cjs'))).digest('hex'),'c64f185fa4cbe3b92017690294afd4fa0f498d4c6836725b4b333db3696efbfd');
 const source=fs.readFileSync(require.resolve('./llamacpp-presets.cjs'),'utf8');for(const removed of ['const integer=','const decimal=','const choice=','valid:','portRefusedOption','llamacpp-presets-js'])assert.ok(!source.includes(removed),removed);
});

test('every native policy fault refuses without exposing option values or writing',t=>{
 const file=fixture(t),before=fs.readFileSync(file,'utf8');
 const fault=()=>{throw Object.assign(Error('synthetic'),{reason:'trap'});};
 const warn=console.warn,seen=[];console.warn=m=>seen.push(String(m));
 try{for(const [name,message] of [['llamacppPresetsModel','Invalid preset model name'],['llamacppPresetsValues','Invalid preset option: parallel'],['llamacppPresetsBatch','Invalid preset option: ubatch-size']])for(let n=0;n<2;n++)assert.throws(()=>store(file,{},standIn({[name]:fault})).prepare(body(file,{parallel:'2'})),{status:400,message});}
 finally{console.warn=warn;}
 assert.ok(seen.length<=1,seen.join('\n'));assert.ok(seen.every(m=>!m.includes('parallel')&&!m.includes('synthetic')));assert.equal(fs.readFileSync(file,'utf8'),before);
});
test('manager section save retains400 invalid_size when canonical policy cannot answer',async t=>{
 const file=fixture(t),before=fs.readFileSync(file,'utf8'),wasmPath=require.resolve('./dav-parse-wasm.cjs'),saved=require.cache[wasmPath];
 let autoconfigCalls=0;
 // Fault only the preset policy under test: manager/calibration imports need
 // the real Rust-backed autoconfig constants and every other bridge export.
 const overlay=(over,calls)=>({...dav,...standIn(over,calls)(),llamacppAutoconfig(...args){autoconfigCalls++;return dav.llamacppAutoconfig(...args);}});
 const failedCalls=[];
 require.cache[wasmPath]={id:wasmPath,filename:wasmPath,loaded:true,exports:overlay({llamacppPresetsCanonical:()=>{throw Error('synthetic');}},failedCalls)};
 t.after(()=>{if(saved)require.cache[wasmPath]=saved;else delete require.cache[wasmPath];});
 const {createLlamaCppManager}=require('./llamacpp-manager.cjs');
 const manager=createLlamaCppManager({baseUrl:'http://synthetic',presetPath:file,fetchJson:async()=>({ok:true,status:200,body:{data:[]}})});
 assert.ok(autoconfigCalls>0,'manager imports must reach the actual Rust autoconfig bridge');
 const refusal=await manager.presetRefusal('synthetic',{c:'1048576',parallel:'1'});
 assert.equal(refusal.code,'invalid_size');assert.equal(refusal.error,'Not saved: the preset option "c" could not be checked.');
 assert.ok(failedCalls.includes('llamacppPresetsCanonical'),'the scoped canonical fault must be exercised');
 assert.equal(fs.readFileSync(file,'utf8'),before);
 const healthyCalls=[];
 require.cache[wasmPath]={id:wasmPath,filename:wasmPath,loaded:true,exports:overlay({},healthyCalls)};
 assert.equal(await manager.presetRefusal('synthetic',{parallel:'1'}),null);
 assert.ok(healthyCalls.includes('llamacppPresetsCanonical'),'the healthy canonical control must be exercised');
 assert.equal(fs.readFileSync(file,'utf8'),before);
});
