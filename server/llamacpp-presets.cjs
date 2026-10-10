'use strict';
// LLAMACPP_PRESETS_IMPL=js|wasm (default js; any other value means js, with one warning), read from
// the store's `env` option (process.env) on every call. Preset values reach llama-server's command
// line and an oversized one can livelock the host (#697, #1132), so wasm also asks noevia-rs's
// llamacpp-presets crate (dav-parse.wasm llamacpp_presets) and can only refuse more: the JS answer
// is computed first; an option is written only if the port accepts it with the identical value
// (after the cache-ram clamp), the model name only if both accept it, the micro-batch check passes
// only if both say it passes, and canonicalOptions() is used only if the port folds every entry to
// the same field and value. A mismatch, a fault or an undecided answer refuses with the caller's
// existing refusal (400 Invalid preset option / Invalid preset model name; presetRefusal's
// invalid_size, also a 400). Warnings are logged once per event and reason and carry no input. The
// flag is in dav-parse-wasm.cjs IMPL_FLAGS (a missing or tampered module stops startup).
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const integer=(min,max)=>v=>/^\d+$/.test(v)&&Number(v)>=min&&Number(v)<=max;
const decimal=(min,max)=>v=>/^\d+(\.\d{1,3})?$/.test(v)&&Number(v)>=min&&Number(v)<=max;
const choice=(...values)=>v=>values.includes(v);
// Only resource/runtime knobs, never executable paths, templates, URLs or credentials.
const fields={
  'ctx-size':{aliases:['c','LLAMA_ARG_CTX_SIZE'],valid:integer(2048,1048576)},
  parallel:{aliases:['np','LLAMA_ARG_N_PARALLEL'],valid:integer(1,16)},
  'n-gpu-layers':{aliases:['ngl','gpu-layers','LLAMA_ARG_N_GPU_LAYERS'],valid:v=>integer(0,999)(v)||['auto','all'].includes(v)},
  'cache-type-k':{aliases:['ctk','LLAMA_ARG_CACHE_TYPE_K'],valid:choice('f32','f16','bf16','q8_0','q4_0','q4_1','iq4_nl','q5_0','q5_1')},
  'cache-type-v':{aliases:['ctv','LLAMA_ARG_CACHE_TYPE_V'],valid:choice('f32','f16','bf16','q8_0','q4_0','q4_1','iq4_nl','q5_0','q5_1')},
  'flash-attn':{aliases:['fa','LLAMA_ARG_FLASH_ATTN'],valid:choice('on','off','auto')},
  'batch-size':{aliases:['b','LLAMA_ARG_BATCH'],valid:integer(32,8192)},
  'ubatch-size':{aliases:['ub','LLAMA_ARG_UBATCH'],valid:integer(32,8192)},
  // #697: prepare() clamps -1 (unbounded) and values above the hard maximum before this check,
  // and writes an explicit value when a section would otherwise run on llama-server's 8 GiB default.
  'cache-ram':{aliases:['cram','LLAMA_ARG_CACHE_RAM'],valid:integer(0,1048576)},
  'image-max-tokens':{aliases:['LLAMA_ARG_IMAGE_MAX_TOKENS'],valid:integer(64,16384)},
  'spec-type':{aliases:['LLAMA_ARG_SPEC_TYPE'],valid:choice('none','draft-mtp','ngram-simple','draft-mtp,ngram-simple')},
  'spec-draft-n-max':{aliases:['LLAMA_ARG_SPEC_DRAFT_N_MAX'],valid:integer(1,32)},
  'spec-draft-p-min':{aliases:['LLAMA_ARG_SPEC_DRAFT_P_MIN'],valid:v=>/^(0(\.\d{1,3})?|1(\.0{1,3})?)$/.test(v)},
  // Sampling defaults (#308): apply only to requests that send no value of their own.
  temp:{aliases:[],valid:decimal(0,2)},
  'top-p':{aliases:[],valid:decimal(0,1)},
  'top-k':{aliases:['LLAMA_ARG_TOP_K'],valid:integer(0,100000)},
  'min-p':{aliases:[],valid:decimal(0,1)},
  'repeat-penalty':{aliases:[],valid:decimal(0,3)},
};
const canonical=key=>Object.keys(fields).find(k=>k===key||fields[k].aliases.includes(key));
// The pure checks prepare() makes, at module level so the Rust port is asked with the same inputs.
const modelNameOk=model=>typeof model==='string'&&/^[\w./:-]{1,200}$/.test(model);
/** One entry of prepare()'s option loop: the value as it would be written (cache-ram clamped to
 *  `limits`, inference-budget.cjs clampCacheRam), or undefined where the write is refused. */
function optionValue(key,value,limits){
  if(key==='cache-ram'&&typeof value==='string'&&value!=='')value=require('./inference-budget.cjs').clampCacheRam(value,limits);
  if(!Object.hasOwn(fields,key) || typeof value!=='string' || value!==''&&!fields[key].valid(value))return undefined;
  return value;
}
/** One canonicalOptions() entry over its projection (the key and String(value), or null for a
 *  null/undefined value): [field or null, trimmed value or null]. */
const canonicalEntry=(key,value)=>[canonical(key.trim().replace(/^-+/,''))??null,value===null?null:value.trim()];
/** prepare()'s micro-batch check over the effective values (strings or undefined). */
const microBatchExceeds=(ubatch,batch)=>Number(ubatch)>Number(batch);
// #1248: llama.cpp's own batch size is 2048 when none is set, so an unset batch-size is compared as that.
// Kept out of microBatchExceeds, whose behaviour the Rust port mirrors byte for byte (differential fixtures).
const DEFAULT_BATCH_SIZE='2048';
const microBatchExceedsEffective=(ubatch,batch)=>microBatchExceeds(ubatch,batch===undefined||batch===null||batch===''?DEFAULT_BATCH_SIZE:batch);
const error=(status,message)=>Object.assign(Error(message),{status});
const revision=text=>crypto.createHash('sha256').update(text).digest('hex');
// #874: recovery copies `<file>.noevia-backup-<revision>` are whole-file snapshots taken before each
// web write; calibration and auto-tune write many. Keep the newest BACKUP_KEEP of this file.
const BACKUP_KEEP=20;
function pruneBackups(file,keep){
  if(!(keep>0))return [];
  const dir=path.dirname(file),prefix=path.basename(file)+'.noevia-backup-';
  let names;try{names=fs.readdirSync(dir);}catch{return [];}
  const rows=[];
  for(const name of names){
    if(!name.startsWith(prefix)||!/^[0-9a-f]{64}$/.test(name.slice(prefix.length)))continue;
    try{const st=fs.lstatSync(path.join(dir,name));if(st.isFile())rows.push({name,mtime:st.mtimeMs});}catch{}
  }
  rows.sort((a,b)=>b.mtime-a.mtime||(a.name<b.name?-1:1));
  const removed=[];
  for(const {name} of rows.slice(keep)){try{fs.unlinkSync(path.join(dir,name));removed.push(name);}catch{}}
  return removed;
}
function parse(text) {
  if (Buffer.byteLength(text)>1024*1024) throw error(413,'Preset file exceeds the editor limit');
  const sections=new Map();let current=null;
  const lines=text.split('\n');
  lines.forEach((line,index)=>{
    const header=/^\s*\[([^\]\r\n]+)\]\s*(?:[;#].*)?$/.exec(line);
    if (header) {
      if (sections.has(header[1])) throw error(409,'Duplicate preset sections require operator repair');
      current={start:index,end:lines.length,options:{}};
      const previous=[...sections.values()].at(-1);if(previous)previous.end=index;
      sections.set(header[1],current);
    } else if(current) {
      const match=/^\s*([^=\s]+)\s*=\s*(.*?)\s*$/.exec(line),key=match&&canonical(match[1]);
      if(key)current.options[key]=match[2];
    }
  });
  return {lines,sections};
}
// ── LLAMACPP_PRESETS_IMPL ───────────────────────────────────────────────────
const IMPLS=new Set(['js','wasm']);
let warnedImpl='';
/** LLAMACPP_PRESETS_IMPL: 'js' (default) or 'wasm'. */
function llamacppPresetsImpl(env=process.env){
  const raw=env?.LLAMACPP_PRESETS_IMPL;
  if(raw===undefined||raw==='')return 'js';
  const v=String(raw).trim().toLowerCase();
  if(IMPLS.has(v))return v;
  if(warnedImpl!==v){warnedImpl=v;console.warn(`[llamacpp-presets] LLAMACPP_PRESETS_IMPL=${JSON.stringify(String(raw))} is not js or wasm; using js`);}
  return 'js';
}
const defaultLoader=()=>require('./dav-parse-wasm.cjs');
const warnedPort=new Set();
function portWarn(event,reason){
  const key=`${event}:${reason}`;
  if(warnedPort.has(key))return;
  warnedPort.add(key);
  console.warn(`[llamacpp-presets] ${event} (${reason}); the option was refused`);
}
/** Asks the port; undefined (after a warning) when it throws. */
function ask(wasmLoader,fn){
  try{return fn(wasmLoader());}catch(err){portWarn('llamacpp_presets.wasm_fault',String(err?.reason||'unexpected').slice(0,40));return undefined;}
}
// The hard maximum clampCacheRam reads, as the port takes it (a finite number or null).
const hardMaxOf=limits=>{const h=limits?.hardMaxMib;return typeof h==='number'&&Number.isFinite(h)?h:null;};
/** Under wasm: the key of the first option the port does not accept with the identical value, or
 *  null when it accepts them all. `raw` are the options as sent, `updates` what the JS accepted. */
function portRefusedOption(wasmLoader,raw,updates,limits){
  const pairs=Object.entries(raw);
  const r=ask(wasmLoader,w=>w.llamacppPresetsValues(pairs,hardMaxOf(limits)));
  if(!r)return pairs[0][0];
  for(let i=0;i<pairs.length;i++)if(r.values[i]!==updates[pairs[i][0]]){portWarn('llamacpp_presets.mismatch','option');return pairs[i][0];}
  return null;
}
function createPresetStore(file,{writer=null,cacheRam=null,backupKeep=BACKUP_KEEP,env=process.env,wasmLoader=defaultLoader}={}) {
  const budget=require('./inference-budget.cjs');
  const limits=()=>cacheRam||budget.cacheRamLimits();
  if(!file || !path.isAbsolute(file))throw error(500,'LLAMACPP_PRESET_PATH must be an absolute path');
  function read() {
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink())throw error(409,'Preset path must be a regular file');
    const text=fs.readFileSync(file,'utf8');return {text,revision:revision(text),...parse(text)};
  }
  function get(model) {
    const data=read(),section=data.sections.get(model);
    return {model,revision:data.revision,exists:!!section,options:section?.options || {},defaults:data.sections.get('*')?.options || {},fields:Object.keys(fields)};
  }
  function prepare({model,baseRevision,options}) {
    if(!modelNameOk(model))throw error(400,'Invalid preset model name');
    const wasm=llamacppPresetsImpl(env)==='wasm';
    if(wasm&&(ask(wasmLoader,w=>w.llamacppPresetsModel(model))?.ok!==true))throw error(400,'Invalid preset model name');
    if(!options||typeof options!=='object'||Array.isArray(options))throw error(400,'Preset options are required');
    const updates={};
    for(const [key,raw] of Object.entries(options)) {
      const value=optionValue(key,raw,limits());
      if(value===undefined)throw error(400,`Invalid preset option: ${key}`);
      updates[key]=value;
    }
    if(!Object.keys(updates).length)throw error(400,'No preset changes supplied');
    if(wasm){const refused=portRefusedOption(wasmLoader,options,updates,limits());if(refused!==null)throw error(400,`Invalid preset option: ${refused}`);}
    const data=read();if(baseRevision!==data.revision)throw error(409,'Presets changed. Reload the profile before saving; your draft is retained.');
    const section=data.sections.get(model);let lines=[...data.lines];
    // #697: every write leaves this model with an explicit, bounded prompt cache. Unset (or a
    // cleared value) would mean llama-server's 8 GiB default; an older value above the hard
    // maximum is brought down to it.
    {
      const {capMib}=limits();
      const own=Object.hasOwn(updates,'cache-ram')?updates['cache-ram']:section?.options['cache-ram'];
      const inherited=data.sections.get('*')?.options['cache-ram'];
      // Mode flags are not editable preset fields, so they are read from the section's own lines.
      const flag=k=>!!section&&lines.slice(section.start+1,section.end).some(l=>new RegExp(`^\\s*-{0,2}${k}\\s*=\\s*(true|1|on)\\s*$`,'i').test(l));
      // #723: embedding and reranking presets have no prompt cache; say so explicitly.
      const noCache=flag('embedding')||flag('embeddings')||flag('reranking')||flag('rerank')||/embed|rerank/i.test(model);
      const effective=own===undefined||own===''?inherited:own;
      if(noCache&&(own===undefined||own===''))updates['cache-ram']='0';
      else if(effective===undefined||effective==='')updates['cache-ram']=String(capMib);
      else if(budget.clampCacheRam(effective,limits())!==String(effective).trim())updates['cache-ram']=budget.clampCacheRam(effective,limits());
    }
    if(section) {
      const content=lines.slice(section.start+1,section.end).filter(line=>{
        const match=/^\s*([^=\s]+)\s*=/.exec(line);return !match||!Object.hasOwn(updates,canonical(match[1]));
      });
      const additions=Object.entries(updates).filter(([,v])=>v!=='').map(([k,v])=>`${k} = ${v}`);
      lines.splice(section.start+1,section.end-section.start-1,...content,...additions);
    } else lines.push('',`[${model}]`,...Object.entries(updates).filter(([,v])=>v!=='').map(([k,v])=>`${k} = ${v}`));
    const text=lines.join('\n').replace(/\n*$/,'\n');
    const local={...(section?.options||{})};
    for(const [key,value] of Object.entries(updates)){if(value==='')delete local[key];else local[key]=value;}
    const effective={...(data.sections.get('*')?.options||{}),...local};
    if(microBatchExceedsEffective(effective['ubatch-size'],effective['batch-size']))throw error(400,'Micro batch cannot exceed batch size');
    if(wasm){
      const v=k=>effective[k]===undefined?null:effective[k];
      const r=ask(wasmLoader,w=>w.llamacppPresetsBatch(v('ubatch-size'),v('batch-size')));
      if(r?.exceeds===true)throw error(400,'Micro batch cannot exceed batch size');
      if(r?.exceeds!==false){if(r)portWarn('llamacpp_presets.undecided','batch');throw error(400,'Invalid preset option: ubatch-size');}
    }
    return {before:data.text,baseRevision:data.revision,text,revision:revision(text)};
  }
  // Async in both modes so callers need not know who the writer is.
  // backup:false (#1003): a write inside an auto-tune run that already kept its one recovery copy.
  // The web writer skips its copy; Model Loader gets the same hint (older sidecars ignore it).
  async function commit(candidate,{backup=true}={}) {
    if(read().revision!==candidate.baseRevision)throw error(409,'Presets changed while applying. Reload before retrying.');
    // Single-writer mode: the sidecar does the revision check, backup and atomic rename.
    if(writer){await writer.write({baseRevision:candidate.baseRevision,text:candidate.text,...(backup===false?{backup:false}:{})});return;}
    // Web writer on a read-only mount: an explicit 503 before the backup, not a raw EROFS (#269).
    require('./models-ini-writer.cjs').assertWebWritable(file);
    // Immutable recovery copy precedes the new file; contains operator settings.
    const backupFile=file+'.noevia-backup-'+candidate.baseRevision;
    if(backup!==false)try {const fd=fs.openSync(backupFile,'wx',0o600);try{fs.writeFileSync(fd,read().text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}catch(e){if(e.code!=='EEXIST')throw e;}
    const temporary=file+'.noevia-'+crypto.randomUUID();
    try {
      // Directory bind mount required: rename is atomic and router sees the new inode.
      const fd=fs.openSync(temporary,'wx',fs.statSync(file).mode & 0o777);
      try {fs.writeFileSync(fd,candidate.text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.renameSync(temporary,file);
      const fdDir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(fdDir);}finally{fs.closeSync(fdDir);}
    } finally {fs.rmSync(temporary,{force:true});}
    // Only after the new file is in place; best-effort, never fails the write.
    try{pruneBackups(file,backupKeep);}catch{}
  }
  // Container paths of the files a section loads. Read-only; used for size estimates.
  function files(model) {
    const data=read(),section=data.sections.get(model),out={};
    if(!section)return out;
    for(const line of data.lines.slice(section.start+1,section.end)){
      const match=/^\s*(model|mmproj|m)\s*=\s*(.*?)\s*$/.exec(line);
      if(match)out[match[1]==='m'?'model':match[1]]=match[2];
    }
    return out;
  }
  const snapshot=()=>{const data=read();return {text:data.text,revision:data.revision};};
  return {get,prepare,commit,files,snapshot};
}
// Known option keys under their canonical names (aliases such as LLAMA_ARG_CACHE_RAM or cram
// folded in); unknown keys are dropped. Later keys win, like the router's last-wins reading.
function canonicalOptions(options){
  const out={};
  for(const [key,value] of Object.entries(options||{})){const c=canonical(String(key).trim().replace(/^-+/,''));if(c&&value!=null)out[c]=String(value).trim();}
  return out;
}
/** canonicalOptions(options) and, under LLAMACPP_PRESETS_IMPL=wasm, the key of the first entry the
 *  port folds to another field or value (or the first key, on a fault): `{ options, refused }`.
 *  A refused entry is never dropped quietly; the caller refuses the whole save. */
function checkedCanonicalOptions(options,{env=process.env,wasmLoader=defaultLoader}={}){
  const out=canonicalOptions(options);
  if(llamacppPresetsImpl(env)!=='wasm')return {options:out,refused:null};
  const entries=Object.entries(options||{});
  if(!entries.length)return {options:out,refused:null};
  let pairs;
  try{pairs=entries.map(([k,v])=>[String(k),v==null?null:String(v)]);}catch{portWarn('llamacpp_presets.wasm_fault','projection');return {options:out,refused:String(entries[0][0])};}
  const r=ask(wasmLoader,w=>w.llamacppPresetsCanonical(pairs));
  if(!r)return {options:out,refused:pairs[0][0]};
  for(let i=0;i<pairs.length;i++){
    const [c,t]=canonicalEntry(...pairs[i]),k=pairs[i][0];
    const [pc,pv]=r.options[i];
    if(pc!==c||pv!==t){portWarn('llamacpp_presets.mismatch','canonical');return {options:out,refused:k};}
  }
  return {options:out,refused:null};
}
module.exports={createPresetStore,parse,fields,canonical,canonicalOptions,checkedCanonicalOptions,llamacppPresetsImpl,modelNameOk,optionValue,canonicalEntry,microBatchExceeds,microBatchExceedsEffective,pruneBackups,BACKUP_KEEP};
