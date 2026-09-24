'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const terminal=new Set(['completed','failed','rejected']);
function createDownloadTracker({base,headers,file,fetchStream=fetch,onCompleted}) {
  const jobs=new Map();let controller=null;
  try {for(const job of JSON.parse(fs.readFileSync(file,'utf8')))if(typeof job.model==='string')jobs.set(job.model,{...job,status:terminal.has(job.status)?job.status:'unknown',progress:null});}catch {}
  function persist(){if(!file)return;try{fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomUUID();try{fs.writeFileSync(temp,JSON.stringify([...jobs.values()]),{mode:0o600});fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}}catch(e){console.error('download tracker persist failed:',e);}}
  // Best-effort import hook for #266: fires once, only on a fresh transition into
  // 'completed', and never blocks or throws into the tracker (a metadata source being down
  // must never make a finished download look unfinished).
  function update(model,status,progress=null){
    const was=jobs.get(model);
    jobs.delete(model);jobs.set(model,{id:model,model,status,progress,updatedAt:Date.now()});while(jobs.size>100)jobs.delete(jobs.keys().next().value);persist();
    if(status==='completed'&&was?.status!=='completed'&&typeof onCompleted==='function'){try{Promise.resolve(onCompleted(model)).catch(()=>{});}catch{}}
  }
  function event(value){if(!value || typeof value.model!=='string')return;if(value.event==='download_finished')update(value.model,'completed',1);if(value.event==='download_failed')update(value.model,'failed');}
  function connect() {
    if(controller)return;
    const ctrl=new AbortController();controller=ctrl;
    const timer=setTimeout(()=>ctrl.abort(),60000);timer.unref?.();
    void(async()=>{
      try {
        const r=await fetchStream(base+'/models/sse',{headers:headers(),redirect:'error',signal:ctrl.signal});
        if(!r.ok||!r.body)return;
        const decoder=new TextDecoder();let buffer='';
        for await(const chunk of r.body){buffer+=decoder.decode(chunk,{stream:true});if(buffer.length>1024*1024)throw Error('Oversized router event');let end;while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);const data=block.split('\n').filter(s=>s.startsWith('data:')).map(s=>s.slice(5).trim()).join('\n');try{event(JSON.parse(data));}catch{}}}
      }catch{}finally{clearTimeout(timer);if(controller===ctrl)controller=null;}
    })();
  }
  function snapshot(models){
    const active=new Map();
    for(const model of models){
      if(model.status?.value==='downloading'){
        const files=Object.values(model.status.progress||model.progress||{}).filter(Boolean);
        const total=files.reduce((n,f)=>n+(Number.isFinite(f.total)&&f.total>0?f.total:0),0),done=files.reduce((n,f)=>n+(Number.isFinite(f.done)&&f.done>=0?f.done:0),0);
        active.set(model.id,{id:model.id,model:model.id,status:'downloading',progress:total?Math.min(1,done/total):null});
      }
    }
    for(const [name,job] of [...jobs]){
      if(active.has(name))continue;
      if(!terminal.has(job.status)) {
        const installed=models.find(m=>m.id===name && m.source==='cache' && ['unloaded','loaded','sleeping'].includes(m.status?.value));
        // Missing status is not success: failed/cancelled transfers can disappear.
        const status=installed?'completed':'unknown';
        if(status!==job.status)update(name,status,installed?1:null);
      }
      active.set(name,jobs.get(name));
    }
    return [...active.values()].reverse();
  }
  return {connect,event,snapshot,requested:model=>{update(model,'requested');connect();},rejected:model=>update(model,'rejected'),close:()=>controller?.abort()};
}
module.exports={createDownloadTracker};
