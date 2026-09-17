'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const integer=(min,max)=>v=>/^\d+$/.test(v)&&Number(v)>=min&&Number(v)<=max;
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
  'cache-ram':{aliases:['LLAMA_ARG_CACHE_RAM'],valid:integer(0,16384)},
  'image-max-tokens':{aliases:['LLAMA_ARG_IMAGE_MAX_TOKENS'],valid:integer(64,16384)},
  'spec-type':{aliases:['LLAMA_ARG_SPEC_TYPE'],valid:choice('none','draft-mtp','ngram-simple','draft-mtp,ngram-simple')},
  'spec-draft-n-max':{aliases:['LLAMA_ARG_SPEC_DRAFT_N_MAX'],valid:integer(1,32)},
  'spec-draft-p-min':{aliases:['LLAMA_ARG_SPEC_DRAFT_P_MIN'],valid:v=>/^(0(\.\d{1,3})?|1(\.0{1,3})?)$/.test(v)},
};
const canonical=key=>Object.keys(fields).find(k=>k===key||fields[k].aliases.includes(key));
const error=(status,message)=>Object.assign(Error(message),{status});
const revision=text=>crypto.createHash('sha256').update(text).digest('hex');
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
function createPresetStore(file) {
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
    if(!/^[\w./:-]{1,200}$/.test(model || ''))throw error(400,'Invalid preset model name');
    if(!options||typeof options!=='object'||Array.isArray(options))throw error(400,'Preset options are required');
    const updates={};
    for(const [key,value] of Object.entries(options)) {
      if(!Object.hasOwn(fields,key) || typeof value!=='string' || value!==''&&!fields[key].valid(value))throw error(400,`Invalid preset option: ${key}`);
      updates[key]=value;
    }
    if(!Object.keys(updates).length)throw error(400,'No preset changes supplied');
    const data=read();if(baseRevision!==data.revision)throw error(409,'Presets changed. Reload the profile before saving; your draft is retained.');
    const section=data.sections.get(model);let lines=[...data.lines];
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
    if(Number(effective['ubatch-size'])>Number(effective['batch-size']))throw error(400,'Micro batch cannot exceed batch size');
    return {before:data.text,baseRevision:data.revision,text,revision:revision(text)};
  }
  function commit(candidate) {
    if(read().revision!==candidate.baseRevision)throw error(409,'Presets changed while applying. Reload before retrying.');
    // Immutable recovery copy precedes the new file; contains operator settings.
    const backup=file+'.noevia-backup-'+candidate.baseRevision;
    try {const fd=fs.openSync(backup,'wx',0o600);try{fs.writeFileSync(fd,read().text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}catch(e){if(e.code!=='EEXIST')throw e;}
    const temporary=file+'.noevia-'+crypto.randomUUID();
    try {
      // Directory bind mount required: rename is atomic and router sees the new inode.
      const fd=fs.openSync(temporary,'wx',fs.statSync(file).mode & 0o777);
      try {fs.writeFileSync(fd,candidate.text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.renameSync(temporary,file);
      const fdDir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(fdDir);}finally{fs.closeSync(fdDir);}
    } finally {fs.rmSync(temporary,{force:true});}
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
module.exports={createPresetStore,parse,fields};
