'use strict';
// GGUF v2/v3 tensor directory inspection, bounded independently of weight size.
// https://github.com/ggml-org/llama.cpp/blob/master/gguf-py/gguf/constants.py
const LIMIT = 16 * 1024 * 1024;
function inspect(buffer) {
  let at=0;
  const need=n=>{if(!Number.isSafeInteger(n)||n<0||at+n>buffer.length)throw Error('GGUF header exceeds inspection limit or is truncated.');};
  const u32=()=>{need(4);const v=buffer.readUInt32LE(at);at+=4;return v;};
  const u64=()=>{need(8);const v=Number(buffer.readBigUInt64LE(at));at+=8;if(!Number.isSafeInteger(v))throw Error('GGUF count exceeds safe limits.');return v;};
  const str=(keep=true)=>{const n=u64();need(n);const v=keep?buffer.toString('utf8',at,at+n):null;at+=n;return v;};
  function value(type,keep=false,depth=0){
    if(depth>2)throw Error('Unsupported nested GGUF metadata.');
    if(type===8)return str(keep);
    if(type===9){const t=u32(),n=u64();if(n>2000000)throw Error('GGUF array exceeds inspection limit.');for(let i=0;i<n;i++)value(t,false,depth+1);return null;}
    const sizes={0:1,1:1,2:2,3:2,4:4,5:4,6:4,7:1,10:8,11:8,12:8};const n=sizes[type];if(!n)throw Error('Unsupported GGUF value type.');need(n);
    let v=null;if(keep){if(type===2)v=buffer.readUInt16LE(at);else if(type===0)v=buffer.readUInt8(at);else if(type===4)v=buffer.readUInt32LE(at);else if(type===5)v=buffer.readInt32LE(at);else if(type===10)v=Number(buffer.readBigUInt64LE(at));}
    at+=n;return v;
  }
  need(24);if(buffer.toString('ascii',0,4)!=='GGUF')throw Error('Not a supported little-endian GGUF file.');at=4;
  if(![2,3].includes(u32()))throw Error('Unsupported GGUF version.');
  const count=u64(),kv=u64();if(count>200000||kv>100000)throw Error('GGUF directory exceeds inspection limit.');
  let architecture='',declaredLayers=null,splitCount=1;
  for(let i=0;i<kv;i++){const key=str();const v=value(u32(),key==='general.architecture'||key.endsWith('.nextn_predict_layers')||key==='split.count');if(key==='general.architecture')architecture=v;if(key.endsWith('.nextn_predict_layers'))declaredLayers=v;if(key==='split.count')splitCount=v;}
  const tensors=[];
  for(let i=0;i<count;i++){const name=str(),dims=u32();if(dims>8)throw Error('Unsupported GGUF tensor dimensions.');for(let d=0;d<dims;d++)u64();u32();u64();if(/(?:^|\.)(?:nextn|mtp)(?:\.|_)/i.test(name)&&tensors.length<8)tensors.push(name);}
  return {architecture,declaredLayers,splitCount,tensorCount:count,tensors};
}
async function prefix(url,fetchImpl=fetch){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
  try{
    const r=await fetchImpl(url,{headers:{Range:`bytes=0-${LIMIT-1}`},signal:controller.signal});
    if(!r.ok||!r.body)throw Error(`Artifact metadata unavailable (${r.status}).`);
    if(r.status===206&&!/^bytes 0-/i.test(r.headers.get('content-range')||''))throw Error('Unexpected artifact byte range.');
    const reader=r.body.getReader(),chunks=[];let size=0;
    try{while(size<LIMIT){const {done,value}=await reader.read();if(done)break;const part=value.subarray(0,LIMIT-size);chunks.push(Buffer.from(part));size+=part.length;}}finally{await reader.cancel();}
    return Buffer.concat(chunks);
  }finally{clearTimeout(timer);}
}
function validate(repo,files){
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo)||repo.split('/').some(p=>p==='.'||p==='..'))throw Error('Invalid public Hugging Face repository.');
  if(!Array.isArray(files)||!files.length||files.length>4||new Set(files).size!==files.length||files.some(f=>typeof f!=='string'||!f.endsWith('.gguf')||f.startsWith('/')||f.split('/').some(p=>!p||p==='.'||p==='..')||/[?#\\\x00-\x1f]/.test(f)))throw Error('Inspection supports up to four selected GGUF shards.');
}
const cache=new Map(),pending=new Map();
async function check(repo,files,{fetchImpl=fetch}={}){
  const unknown=reason=>({status:'unknown',reason,files,checkedAt:new Date().toISOString()});
  try{validate(repo,files);}catch(e){return unknown(e.message);}
  const key=JSON.stringify([repo,files]);const saved=cache.get(key);if(saved&&Date.now()-saved.time<300000)return saved.value;
  if(pending.has(key))return pending.get(key);
  if(pending.size>=2)return unknown('Two artifact checks are already running. Try again shortly.');
  const run=(async()=>{
    try{
      const response=await fetchImpl(`https://huggingface.co/api/models/${repo}`,{signal:AbortSignal.timeout(10000)});
      if(!response.ok)throw Error('Public repository revision unavailable.');
      const meta=await response.json(),revision=meta.sha;if(!/^[a-f0-9]{40,64}$/.test(revision||''))throw Error('Immutable repository revision unavailable.');
      const evidence=[];
      for(const file of files){const url=`https://huggingface.co/${repo}/resolve/${revision}/${file.split('/').map(encodeURIComponent).join('/')}`;evidence.push({file,...inspect(await prefix(url,fetchImpl))});}
      if(evidence.some(e=>e.splitCount>files.length))throw Error('The selected variant does not enumerate every GGUF shard.');
      const found=evidence.some(e=>e.tensors.length);
      const inconsistent=!found&&evidence.some(e=>e.declaredLayers>0);
      const result={status:found?'present':inconsistent?'unknown':'absent',reason:found?'MTP/NextN tensors are present in the selected files. Backend compatibility and a working head still require a load test.':inconsistent?'Metadata declares MTP layers, but no recognized MTP tensors were found.':'No recognized MTP/NextN tensors in the complete selected tensor directories. Separate head files are not included in this check.',files,revision,evidence,checkedAt:new Date().toISOString()};
      if(cache.size>=100)cache.delete(cache.keys().next().value);cache.set(key,{time:Date.now(),value:result});return result;
    }catch(e){return unknown(e.name==='TimeoutError'||e.name==='AbortError'?'Artifact check timed out.':e.message);}
  })();pending.set(key,run);try{return await run;}finally{pending.delete(key);}
}
module.exports={inspect,prefix,validate,check,LIMIT};
