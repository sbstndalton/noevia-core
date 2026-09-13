'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {inspect,validate,check,prefix,LIMIT}=require('./mtp-artifact.cjs');
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;},u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;},str=s=>Buffer.concat([u64(Buffer.byteLength(s)),Buffer.from(s)]);
function gguf(names=[],layers=0,split=1){return Buffer.concat([Buffer.from('GGUF'),u32(3),u64(names.length),u64(3),str('general.architecture'),u32(8),str('qwen35'),str('qwen35.nextn_predict_layers'),u32(4),u32(layers),str('split.count'),u32(4),u32(split),...names.flatMap(n=>[str(n),u32(1),u64(2),u32(0),u64(0)])]);}
test('inspects actual tensor directory, not model name or metadata claim',()=>{
 assert.deepEqual(inspect(gguf(['blk.32.nextn.eh_proj.weight'],1)).tensors,['blk.32.nextn.eh_proj.weight']);
 assert.deepEqual(inspect(gguf(['token_embd.weight'])).tensors,[]);
 assert.equal(inspect(gguf([],1)).declaredLayers,1);
 assert.throws(()=>inspect(gguf().subarray(0,50)),/truncated/);
 assert.throws(()=>inspect(Buffer.alloc(24)),/GGUF/);
});
test('rejects path escape and unbounded shard sets',()=>{
 for(const repo of ['https://evil/x','owner/../x','../x'])assert.throws(()=>validate(repo,['file.gguf']));
 for(const files of [['../f.gguf'],['/f.gguf'],['f.gguf?x'],Array(5).fill('f.gguf')])assert.throws(()=>validate('owner/repo',files));
});
test('checks pinned remote bytes and distinguishes present, absent, inconsistent and incomplete',async()=>{
 for(const [name,buffer,status] of [['yes',gguf(['nextn.pre_projection.weight'],1),'present'],['no',gguf(['token_embd.weight']),'absent'],['claim',gguf([],1),'unknown'],['split',gguf([],0,2),'unknown']]){
  const urls=[];const result=await check('fixture/'+name,['model.gguf'],{fetchImpl:async url=>{urls.push(url);return url.includes('/api/')?new Response(JSON.stringify({sha:'a'.repeat(40)})):new Response(buffer);}});
  assert.equal(result.status,status);assert.ok(urls[1].includes('/resolve/'+'a'.repeat(40)+'/'));
 }
});
test('range-ignoring server cannot make an unbounded weight download',async()=>{
 let cancelled=false;
 const b=await prefix('https://huggingface.co/test',async()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}})));
 assert.equal(b.length,LIMIT);assert.equal(cancelled,true);
});
