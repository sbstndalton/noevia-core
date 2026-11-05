'use strict';
// #1071: Rust owns preset value, model-name and micro-batch policy.
// #2387: Rust also owns the parse, the editor limit, the revision and the facts (field names,
// aliases, defaults): the llamacpp-presets crate, run here through dav-parse.wasm and by the Rust
// front for GET /api/models/preset and its conditional writes. This host keeps only file IO and the
// cache-budget inputs, so a revision read here and a revision read there cannot disagree.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {PROTOCOL}=require('./rust-preset-facts.cjs');
const modelNameOk=model=>typeof model==='string'&&ask(defaultLoader,w=>w.llamacppPresetsModel(model))?.ok===true;
function optionValue(key,value,limits,wasmLoader=defaultLoader){
  if(typeof key!=='string'||typeof value!=='string')return undefined;
  const r=ask(wasmLoader,w=>w.llamacppPresetsValues([[key,value]],hardMaxOf(limits)));
  return r&&Array.isArray(r.values)&&r.values.length===1&&typeof r.values[0]==='string'?r.values[0]:undefined;
}
function canonicalEntry(key,value){
  const r=ask(defaultLoader,w=>w.llamacppPresetsCanonical([[key,value]]));
  if(!r||!Array.isArray(r.options)||r.options.length!==1)throw error(400,'Preset options could not be checked');
  return r.options[0];
}
function microBatchExceeds(ubatch,batch){
  const text=v=>v===undefined||v===null?null:String(v);
  const r=ask(defaultLoader,w=>w.llamacppPresetsBatch(text(ubatch),text(batch)));
  if(typeof r?.exceeds!=='boolean')throw error(400,'Invalid preset option: ubatch-size');
  return r.exceeds;
}
const DEFAULT_BATCH_SIZE='2048';
const microBatchExceedsEffective=(ubatch,batch)=>microBatchExceeds(ubatch,batch===undefined||batch===null||batch===''?DEFAULT_BATCH_SIZE:batch);
const error=(status,message)=>Object.assign(Error(message),{status});
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
const FAULTS={oversized:()=>error(413,'Preset file exceeds the editor limit'),duplicate:()=>error(409,'Duplicate preset sections require operator repair')};
const warnedRead=new Set();
function readWarn(reason){
  if(warnedRead.has(reason))return;
  warnedRead.add(reason);
  console.warn(`[llamacpp-presets] ${PROTOCOL} read fault (${reason}); preset state is unavailable`);
}
/** Asks the native reader; a refusal of the module itself is an unavailable parser, not a bad file. */
function native(wasmLoader,fn){
  let r;
  try{r=fn(wasmLoader());}
  catch(err){
    readWarn(String(err?.reason||'unexpected').slice(0,40));
    // The transport bound covers every file inside the limit written at its widest, so a request past it
    // is a text past the limit too: Node's own answer for that is the 413. (The limit is decided by the
    // parser; this is only what a request too big to reach it means.)
    throw err?.reason==='too_large'?FAULTS.oversized():error(503,'Preset state is unavailable. Try again shortly.');
  }
  if(r?.fault!==undefined){
    if(!Object.hasOwn(FAULTS,r.fault))throw error(503,'Preset state is unavailable. Try again shortly.');
    throw FAULTS[r.fault]();
  }
  return r;
}
let knownFields=null;
/** `Object.keys(fields)`: the editable option names, in the native reader's order. */
function fieldNames(){
  if(!knownFields)knownFields=Object.freeze(native(defaultLoader,w=>w.llamacppPresetsFacts('','')).fields);
  return knownFields;
}
const objectOf=pairs=>{const out={};for(const [k,v] of pairs)out[k]=v;return out;};
/** `text.split('\n')` lines and the sections of the native parse: Map name -> {start,end,options}. */
function parse(text,wasmLoader=defaultLoader) {
  const r=native(wasmLoader,w=>w.llamacppPresetsParse(text));
  const sections=new Map();
  for(const s of r.sections)sections.set(s.name,{start:s.start,end:s.end,options:objectOf(s.options),assignments:s.assignments});
  return {lines:text.split('\n'),sections,revision:r.revision};
}
/** The revision of `text` as the native reader (and so the Rust front) computes it. */
const revision=(text,wasmLoader=defaultLoader)=>native(wasmLoader,w=>w.llamacppPresetsParse(text)).revision;
// ── LLAMACPP_PRESETS_IMPL ───────────────────────────────────────────────────
function llamacppPresetsImpl(){return 'wasm';}
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
function createPresetStore(file,{writer=null,cacheRam=null,backupKeep=BACKUP_KEEP,env=process.env,wasmLoader=defaultLoader}={}) {
  const budget=require('./inference-budget.cjs');
  const limits=()=>cacheRam||budget.cacheRamLimits();
  if(!file || !path.isAbsolute(file))throw error(500,'LLAMACPP_PRESET_PATH must be an absolute path');
  // #1596: the Laya marker is models.roles.json beside models.ini, never a key in models.ini.
  require('./model-system.cjs').useRolesBeside(file);
  function readText() {
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink())throw error(409,'Preset path must be a regular file');
    return fs.readFileSync(file,'utf8');
  }
  function read() {
    const text=readText();
    return {text,...parse(text)};
  }
  // #2387: the facts of one snapshot, from the native reader: the same parse, revision, defaults and
  // field names the Rust front answers GET /api/models/preset with and checks its writes against.
  function get(model) {
    const text=readText();
    const r=native(defaultLoader,w=>w.llamacppPresetsFacts(text,typeof model==='string'?model:''));
    return {model,revision:r.revision,exists:r.exists,options:objectOf(r.options),defaults:objectOf(r.defaults),fields:r.fields};
  }
  function prepare({model,baseRevision,options}) {
    if(typeof model!=='string'||ask(wasmLoader,w=>w.llamacppPresetsModel(model))?.ok!==true)throw error(400,'Invalid preset model name');
    if(!options||typeof options!=='object'||Array.isArray(options))throw error(400,'Preset options are required');
    const updates={};
    for(const [key,raw] of Object.entries(options)) {
      const value=optionValue(key,raw,limits(),wasmLoader);
      if(value===undefined)throw error(400,`Invalid preset option: ${key}`);
      updates[key]=value;
    }
    if(!Object.keys(updates).length)throw error(400,'No preset changes supplied');
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
      const checkedCache=value=>{
        const answer=optionValue('cache-ram',String(value),limits(),wasmLoader);
        if(answer===undefined)throw error(400,'Invalid preset option: cache-ram');
        return answer;
      };
      if(noCache&&(own===undefined||own===''))updates['cache-ram']=checkedCache('0');
      else if(effective===undefined||effective==='')updates['cache-ram']=checkedCache(capMib);
      else {const checked=checkedCache(effective);if(checked!==String(effective).trim())updates['cache-ram']=checked;}
    }
    if(section) {
      // The lines that assign a field being written are the native reader's (assignments).
      const replaced=new Set(section.assignments.filter(([,field])=>Object.hasOwn(updates,field)).map(([line])=>line));
      const content=lines.slice(section.start+1,section.end).filter((line,i)=>!replaced.has(section.start+1+i));
      const additions=Object.entries(updates).filter(([,v])=>v!=='').map(([k,v])=>`${k} = ${v}`);
      lines.splice(section.start+1,section.end-section.start-1,...content,...additions);
    } else lines.push('',`[${model}]`,...Object.entries(updates).filter(([,v])=>v!=='').map(([k,v])=>`${k} = ${v}`));
    const text=lines.join('\n').replace(/\n*$/,'\n');
    const local={...(section?.options||{})};
    for(const [key,value] of Object.entries(updates)){if(value==='')delete local[key];else local[key]=value;}
    const effective={...(data.sections.get('*')?.options||{}),...local};
    {
      const v=k=>effective[k]===undefined?null:effective[k];
      const batch=v('batch-size');
      const r=ask(wasmLoader,w=>w.llamacppPresetsBatch(v('ubatch-size'),batch===null||batch===''?DEFAULT_BATCH_SIZE:batch));
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
  // The speculative draft model's file: not an editable option, so parse() does not keep it (#2215).
  function draftFile(model) {
    const data=read(),section=data.sections.get(model);
    if(!section)return null;
    let file=null;
    for(const line of data.lines.slice(section.start+1,section.end)){
      const match=/^\s*spec-draft-model\s*=\s*(.*?)\s*$/.exec(line);
      if(match&&match[1])file=match[1];
    }
    return file;
  }
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
  return {get,prepare,commit,files,draftFile,snapshot};
}
// Known option keys under their canonical names (aliases such as LLAMA_ARG_CACHE_RAM or cram
// folded in); unknown keys are dropped. Later keys win, like the router's last-wins reading.
function canonicalOptions(options){
  const result=checkedCanonicalOptions(options);
  if(result.refused!==null)throw error(400,`Invalid preset option: ${result.refused}`);
  return result.options;
}
/** Use the Rust canonical projection; failure names the first unverified input entry. */
function checkedCanonicalOptions(options,{wasmLoader=defaultLoader}={}){
  const entries=Object.entries(options||{});
  if(!entries.length)return {options:{},refused:null};
  let pairs;
  try{pairs=entries.map(([k,v])=>[String(k),v==null?null:String(v)]);}catch{return {options:{},refused:String(entries[0][0])};}
  const r=ask(wasmLoader,w=>w.llamacppPresetsCanonical(pairs));
  if(!r||!Array.isArray(r.options)||r.options.length!==pairs.length)return {options:{},refused:pairs[0][0]};
  const out={};
  for(let i=0;i<pairs.length;i++){
    const pair=r.options[i];
    if(!Array.isArray(pair)||pair.length!==2||!(pair[0]===null||typeof pair[0]==='string'&&fieldNames().includes(pair[0]))||!(pair[1]===null||typeof pair[1]==='string'))return {options:{},refused:pairs[i][0]};
    if(pair[0]!==null&&pair[1]!==null)out[pair[0]]=pair[1];
  }
  return {options:out,refused:null};
}
module.exports={createPresetStore,parse,revision,fieldNames,canonicalOptions,checkedCanonicalOptions,llamacppPresetsImpl,modelNameOk,optionValue,canonicalEntry,microBatchExceeds,microBatchExceedsEffective,pruneBackups,BACKUP_KEEP};
