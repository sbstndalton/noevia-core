'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {readGguf,summarize}=require('./gguf-meta.cjs');
const {suggest,kvCacheBytes,parseMemoryLimit,CTX_CANDIDATES}=require('./llamacpp-autoconfig.cjs');
const {createModelManager}=require('./model-manager.cjs');

// Synthetic GGUF v3 writer: header only, no tensors.
function gguf(kv){
  const parts=[Buffer.from('GGUF'),u32(3),u64(0),u64(Object.keys(kv).length)];
  for(const [key,[type,value]] of Object.entries(kv))parts.push(str(key),u32(type),val(type,value));
  return Buffer.concat(parts);
  function u32(n){const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;}
  function u64(n){const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;}
  function str(s){const b=Buffer.from(s);return Buffer.concat([u64(b.length),b]);}
  function val(type,v){
    if(type===4)return u32(v);
    if(type===7)return Buffer.from([v?1:0]);
    if(type===8)return str(v);
    if(type===9){const [sub,items]=v;return Buffer.concat([u32(sub),u64(items.length),...items.map(x=>val(sub,x))]);}
    throw Error('type');
  }
}
const qwen35={'general.architecture':[8,'qwen35'],'qwen35.context_length':[4,262144],'qwen35.embedding_length':[4,4096],'qwen35.block_count':[4,32],'qwen35.attention.head_count':[4,16],'qwen35.attention.head_count_kv':[4,4],'qwen35.attention.key_length':[4,256],'qwen35.attention.value_length':[4,256],'qwen35.full_attention_interval':[4,4],'qwen35.ssm.state_size':[4,128],'tokenizer.chat_template':[8,'{{ messages }}']};
function write(t,name,buf){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autoconfig-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,name);fs.writeFileSync(file,buf);return {dir,file};}

test('GGUF header reader keeps per-layer arrays and skips vocabularies across buffer refills',t=>{
  const pattern=Array.from({length:42},(_,i)=>i%6!==5);
  // ~2 MiB of token strings forces the reader past its first 1 MiB chunk via skips.
  const tokens=Array.from({length:40000},(_,i)=>'token-'+String(i).padStart(40,'x'));
  const {file}=write(t,'m.gguf',gguf({'general.architecture':[8,'gemma4'],'tokenizer.ggml.tokens':[9,[8,tokens]],'gemma4.attention.sliding_window_pattern':[9,[7,pattern]],'gemma4.block_count':[4,42],'tokenizer.chat_template':[8,'x']}));
  const kv=readGguf(file),m=summarize(kv);
  assert.deepEqual(kv['tokenizer.ggml.tokens'],{array:true,count:40000});
  assert.deepEqual(m.slidingWindowPattern,pattern);
  assert.equal(m.blockCount,42);assert.equal(m.hasChatTemplate,true);
  const bad=write(t,'bad.gguf',Buffer.from('NOPE'));
  assert.throws(()=>readGguf(bad.file),/Not a GGUF/);
});

test('KV sizing follows hybrid, sliding-window and plain attention layouts',()=>{
  const hybrid=summarize(Object.fromEntries(Object.entries(qwen35).map(([k,[,v]])=>[k,v])));
  // 8 of 32 layers hold KV: 8 * 4 heads * 512 dims * 1.0625 bytes * ctx, plus 24 SSM states.
  assert.equal(kvCacheBytes(hybrid,262144),8*4*512*1.0625*262144+24*4*1024*1024);
  const plain={blockCount:10,headCount:8,headCountKv:2,embeddingLength:1024};
  assert.equal(kvCacheBytes(plain,4096),10*2*256*1.0625*4096);
  const swa={...plain,blockCount:12,slidingWindow:512,slidingWindowPattern:Array.from({length:12},(_,i)=>i%6!==5),keyLengthSwa:64,valueLengthSwa:64};
  // Two global layers scale with ctx; ten local layers stop at the 512 window.
  assert.equal(kvCacheBytes(swa,65536),2*2*256*1.0625*65536+10*2*128*1.0625*512);
  assert.equal(kvCacheBytes({blockCount:0},4096),0);
});

test('suggestion picks the largest fitting context and adds projector and MTP settings',()=>{
  const meta=summarize(Object.fromEntries(Object.entries(qwen35).map(([k,[,v]])=>[k,v])));
  const gib=1024**3;
  const r=suggest({meta,modelBytes:5.56*gib,mmprojBytes:0.86*gib,budgetGib:14,current:{'ubatch-size':'1024'}});
  assert.equal(r.values['ctx-size'],'262144');
  assert.equal(r.values['image-max-tokens'],'1024');assert.equal(r.values['ubatch-size'],'1024');
  assert.equal(r.values['cache-ram'],'1024');assert.equal(r.values['spec-type'],undefined);
  assert.ok(r.estimateGib<=14&&r.rows.every(row=>row.fits===(row.totalGib<=14)));
  const small=suggest({meta,modelBytes:5.56*gib,mmprojBytes:0.86*gib,budgetGib:10});
  assert.ok(Number(small.values['ctx-size'])<262144&&small.estimateGib<=10);
  const mtp=suggest({meta:{...meta,nextnPredictLayers:1},modelBytes:4.3*gib,budgetGib:14});
  assert.equal(mtp.values['spec-type'],'draft-mtp');
  assert.equal(suggest({meta,modelBytes:4.3*gib,budgetGib:14,current:{'spec-type':'draft-mtp'}}).values['spec-type'],'none');
  assert.match(suggest({meta,modelBytes:20*gib,budgetGib:14}).error,/smaller quantization/);
  assert.match(suggest({meta:{...meta,hasChatTemplate:false,arch:'nomic-bert'},modelBytes:gib,budgetGib:14}).error,/chat models only/);
  assert.match(suggest({meta:{arch:'mystery',hasChatTemplate:true},modelBytes:gib,budgetGib:14}).error,/Cannot size/);
  assert.equal(parseMemoryLimit('14g'),14);assert.equal(parseMemoryLimit('512m'),0.5);assert.equal(parseMemoryLimit('lots'),null);
});

test('manager suggestion reads only files inside the read-only model mount and never writes presets',async t=>{
  const models=write(t,'x',Buffer.alloc(0)).dir;
  fs.writeFileSync(path.join(models,'q.gguf'),gguf(qwen35));
  const outside=write(t,'secret.gguf',gguf(qwen35));
  const ini=path.join(models,'models.ini');
  fs.writeFileSync(ini,`version = 1\n[good]\nmodel = /models/q.gguf\nc = 4096\n[escape]\nmodel = /models/../${path.relative(path.dirname(models),outside.file)}\n[foreign]\nmodel = ${outside.file}\n[missing-projector]\nmodel = /models/q.gguf\nmmproj = /models/none.gguf\n`);
  const before=fs.readFileSync(ini,'utf8');
  const make=autoconfig=>createModelManager({kind:'llamacpp',baseUrl:'http://synthetic',presetPath:ini,fetchJson:async()=>{throw Error('no router call expected');},autoconfig});
  const manager=make({modelsPath:models,budgetGib:14});
  const good=await manager.suggestPreset('good');
  assert.equal(good.status,200);assert.equal(good.body.arch,'qwen35');assert.ok(Number(good.body.values['ctx-size'])>=4096);
  for(const name of ['escape','foreign','missing-projector'])assert.equal((await manager.suggestPreset(name)).status,404,name);
  assert.equal((await manager.suggestPreset('absent')).status,404);
  assert.equal((await make({budgetGib:14}).suggestPreset('good')).status,501);
  assert.equal((await make({modelsPath:models}).suggestPreset('good')).status,501);
  assert.equal(fs.readFileSync(ini,'utf8'),before);
});

test('the context ladder matches the Python planner exactly', () => {
  // These two lists are the same list in two languages. The planner
  // (services/model-manager/app/autoconfig.py) decides what to recommend; the
  // calibrator (llamacpp-calibration.cjs) walks the JS copy to verify what
  // actually loads. When they drift, noevia recommends contexts it can never
  // verify — which is what had happened: six values existed only in Python,
  // added by the densification explained in that file's own comment and never
  // carried across.
  const py = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'services', 'model-manager', 'app', 'autoconfig.py'), 'utf8');
  const block = /_CTX_CANDIDATES = \(([\s\S]*?)\)/.exec(py);
  assert.ok(block, 'the planner still declares _CTX_CANDIDATES as a tuple');
  const expected = block[1].match(/\d+/g).map(Number);
  assert.deepEqual(CTX_CANDIDATES, expected);
  // Alignment invariant the Python comment relies on.
  assert.ok(CTX_CANDIDATES.every((v) => v % 4096 === 0), 'every candidate is 4096-aligned');
  assert.deepEqual(CTX_CANDIDATES, [...CTX_CANDIDATES].sort((a, b) => a - b), 'and ascending');
});

test('a native context off the calibrated ladder is snapped down, never suggested raw', () => {
  const gib = 1024 ** 3;
  // 100000 sits strictly between the qualified 98304 and 106496 rungs.
  const meta = { ...summarize(Object.fromEntries(Object.entries(qwen35).map(([k, [, v]]) => [k, v]))), contextLength: 100000 };
  const r = suggest({ meta, modelBytes: 5.56 * gib, budgetGib: 200 });
  assert.equal(r.values['ctx-size'], '98304');
  assert.ok(CTX_CANDIDATES.includes(Number(r.values['ctx-size'])));
  assert.ok(r.rows.every((row) => CTX_CANDIDATES.includes(row.ctx)), 'every offered row is a qualified, verifiable candidate');
  assert.ok(!r.rows.some((row) => row.ctx === 100000), 'the raw native value itself is never a candidate');
});

test('a native context below the smallest qualified candidate is a clear error, not a false out-of-budget one', () => {
  const gib = 1024 ** 3;
  // An old model whose native context (2048) sits below CTX_CANDIDATES[0] (4096): there is
  // nothing calibrator-verified to offer, so this must not fall through to "needs more memory".
  const meta = { ...summarize(Object.fromEntries(Object.entries(qwen35).map(([k, [, v]]) => [k, v]))), contextLength: 2048 };
  const r = suggest({ meta, modelBytes: 5.56 * gib, budgetGib: 200 });
  assert.match(r.error, /native context \(2048\) is below the smallest supported context size \(4096\)/);
  assert.equal(r.values, undefined);
  assert.equal(r.rows, undefined);
});

test('estimate inputs are read-only facts: q8 KV rows, pinned projector memory, current settings (#204)',async t=>{
  const {estimateInputs}=require('./llamacpp-autoconfig.cjs');
  const meta=summarize(Object.fromEntries(Object.entries(qwen35).map(([k,[,v]])=>[k,v])));
  const gib=1024**3;
  const plain=estimateInputs({meta,modelBytes:5.5*gib,current:{'ctx-size':'16384','cache-type-k':'q8_0'}});
  assert.equal(plain.chat,true);assert.equal(plain.sizeable,true);assert.equal(plain.modelGib,5.5);assert.equal(plain.pinnedGib,0);
  assert.deepEqual(plain.current,{ctx:16384,kv:'q8_0'});
  assert.equal(plain.rows.at(-1).ctx,262144);
  const row=plain.rows.find(r=>r.ctx===32768);
  assert.equal(row.kvQ8Gib,Math.round(kvCacheBytes(meta,32768)/gib*100)/100);
  assert.ok(plain.rows.every((r,i)=>i===0||r.kvQ8Gib>=plain.rows[i-1].kvQ8Gib),'KV grows with context');
  const vision=estimateInputs({meta,modelBytes:5.5*gib,mmprojBytes:0.9*gib});
  assert.ok(vision.pinnedGib>1.3&&vision.pinnedGib<2,'projector plus its compute scratch');
  const embed=estimateInputs({meta:{arch:'nomic-bert',hasChatTemplate:false},modelBytes:gib});
  assert.equal(embed.chat,false);assert.equal(embed.sizeable,false);assert.deepEqual(embed.rows,[]);
  // The manager reads only the mounted file and never writes the preset file.
  const models=write(t,'x',Buffer.alloc(0)).dir;
  fs.writeFileSync(path.join(models,'q.gguf'),gguf(qwen35));
  const ini=path.join(models,'models.ini');
  fs.writeFileSync(ini,'version = 1\n[good]\nmodel = /models/q.gguf\nc = 8192\n');
  const before=fs.readFileSync(ini,'utf8');
  const make=autoconfig=>createModelManager({kind:'llamacpp',baseUrl:'http://synthetic',presetPath:ini,fetchJson:async()=>{throw Error('no router call expected');},autoconfig});
  const r=await make({modelsPath:models,budgetGib:14}).estimateMemory('good');
  assert.equal(r.status,200);assert.equal(r.body.budgetGib,14);assert.equal(r.body.model,'good');assert.ok(r.body.rows.length>10);
  assert.equal((await make({modelsPath:models}).estimateMemory('good')).body.budgetGib,null,'no budget is not an error');
  assert.equal((await make({budgetGib:14}).estimateMemory('good')).status,501);
  assert.equal((await make({modelsPath:models}).estimateMemory('absent')).status,404);
  assert.equal(fs.readFileSync(ini,'utf8'),before);
});
