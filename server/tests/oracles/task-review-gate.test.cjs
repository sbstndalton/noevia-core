'use strict';const{test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');const{createRequire}=require('node:module');
test('ordinary code review always leaves acceptance to the scoped human card',async()=>{
 const file=path.join(__dirname,'../../code-review.test.cjs');const source=fs.readFileSync(file,'utf8');const prefix=source.slice(0,source.indexOf("test('flag off:"));const module={exports:{}};
 vm.runInNewContext(prefix+'\nmodule.exports={run};',{require:createRequire(file),module,console,process,Buffer,structuredClone,setTimeout,clearTimeout,setImmediate,clearImmediate,AbortController,AbortSignal,__dirname:path.dirname(file),__filename:file},{timeout:2000});
 const fixtures=[];for(const input of [{decision:'approve'},{decision:'approve_all'},{decision:'deny'},{decision:'timeout'},{decision:'aborted'},{decision:'approve',unavailable:true},{decision:'deny',unchanged:true}]){
  const verdict={verdict:'approve',summary:'Fine',findings:[]};const outcome=input.unavailable?{ok:false,code:'unavailable',reason:'No reviewer model is configured on this server.'}:{ok:true,verdict,corrected:false};
  const r=await module.exports.run({review:{enabled:()=>true,review:async()=>outcome},answers:[input.decision],...(input.unchanged?{script:async()=>{}}:{})});
  const base=r.job.checkpoint.baseSha,head=r.job.checkpoint.headSha;
  const normalize=value=>{let encoded=JSON.stringify(value).replaceAll(r.taskId,'TASK').replaceAll(base,'BASE');if(head!==base)encoded=encoded.replaceAll(head,'HEAD');return JSON.parse(encoded);};
  fixtures.push({input,result:normalize(r.job.result.review),events:normalize(r.events.filter(e=>e.type.startsWith('review.')||e.type.startsWith('approval.')).map(e=>({type:e.type,data:e.data})))});
  assert.equal(r.job.result.review.accepted,['approve','approve_all'].includes(input.decision));
 }
 if(process.env.TASK_JOURNAL_EVIDENCE)fs.writeFileSync(path.join(process.env.TASK_JOURNAL_EVIDENCE,'task-review-gate-node.json'),JSON.stringify(fixtures,null,2)+'\n');
});
