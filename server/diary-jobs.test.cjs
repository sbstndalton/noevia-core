'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const jobs=require('./diary-jobs.cjs'),{proxyDiaryStream}=require('./diary-stream.cjs');
const data={entryDay:'2026-09-12',exchangeId:'synthetic-exchange-12345',message:'SYNTHETIC diary request'};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'diary-jobs-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return{dir};}
test('records before dispatch, blocks duplicate IDs, scopes by tenant and day',t=>{
 const w=fixture(t),other=fixture(t),j=jobs.start(w,data);
 assert.equal(jobs.list(w,data.entryDay)[0].state,'running');assert.deepEqual(jobs.list(other,data.entryDay),[]);
 assert.throws(()=>jobs.start(w,data),e=>e.status===409);assert.throws(()=>jobs.start(w,{...data,exchangeId:'../../x'}),e=>e.status===400);
 assert.equal(jobs.validDay('2026-99-99'),false);
 j.event({type:'answer',text:'Synthetic answer'});j.event({type:'diary',decision:'logged'});j.event({type:'done'});j.finish();
 assert.equal(jobs.list(w,data.entryDay)[0].state,'complete');
});
test('missing completion, saving errors and orphaned running files recover as uncertain',t=>{
 const w=fixture(t),j=jobs.start(w,data);j.event({type:'answer',text:'Answer without save acknowledgement'});j.finish();assert.equal(jobs.list(w,data.entryDay)[0].state,'uncertain');
 const file=path.join(w.dir,'diary-conversations',data.entryDay,data.exchangeId+'.json');const row=JSON.parse(fs.readFileSync(file));row.state='running';fs.writeFileSync(file,JSON.stringify(row));assert.equal(jobs.list(w,data.entryDay)[0].state,'uncertain');
});
test('continues collecting a single synthetic exchange after browser disconnect',async t=>{
 const w=fixture(t);let calls=0,release;const gate=new Promise(r=>release=r);
 const upstream=http.createServer(async(req,res)=>{calls++;res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"type":"status","text":"Synthetic processing"}\n\n');await gate;res.end('data: {"type":"answer","text":"RECOVERED-ANSWER"}\n\ndata: {"type":"diary","decision":"logged"}\n\ndata: {"type":"done"}\n\n');});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>upstream.close());
 let complete;const done=new Promise(r=>complete=r);
 const proxy=http.createServer(async(req,res)=>{await proxyDiaryStream(res,`http://127.0.0.1:${upstream.address().port}`,{}, {job:jobs.start(w,data),heartbeatMs:50});complete();});
 await new Promise(r=>proxy.listen(0,'127.0.0.1',r));t.after(()=>proxy.close());
 const controller=new AbortController();const response=await fetch(`http://127.0.0.1:${proxy.address().port}`,{signal:controller.signal});await response.body.getReader().read();controller.abort();
 release();await done;const [row]=jobs.list(w,data.entryDay);assert.equal(row.content,'RECOVERED-ANSWER');assert.equal(row.state,'complete');assert.equal(calls,1);
});
test('optional preparation survives interruption without retaining approval actions',t=>{
 const w=fixture(t),j=jobs.start(w,{...data,kind:'preparation'});
 j.event({type:'tool_pending',index:0,name:'synthetic_write',args:'{"text":"fixture"}',id:'live-approval-secret'});j.finish();
 const [row]=jobs.list(w,data.entryDay);assert.equal(row.kind,'preparation');assert.equal(row.state,'uncertain');
 assert.equal(row.tools[0].status,'denied');assert.equal(JSON.stringify(row).includes('live-approval-secret'),false);
 assert.throws(()=>jobs.start(w,{...data,exchangeId:'capture-synthetic-12345',preparationId:data.exchangeId}),e=>e.status===409);
});
test('completed preparation links only within its tenant, day and matching message',t=>{
 const w=fixture(t),j=jobs.start(w,{...data,kind:'preparation'});
 j.event({type:'tool_result',index:0,name:'synthetic_read',text:'Synthetic result'});j.event({type:'done'});j.finish();
 assert.equal(jobs.list(w,data.entryDay)[0].state,'complete');
 assert.throws(()=>jobs.start(w,{...data,exchangeId:'capture-synthetic-12345',preparationId:data.exchangeId,message:'different'}),e=>e.status===409);
 assert.throws(()=>jobs.start(fixture(t),{...data,exchangeId:'capture-synthetic-12345',preparationId:data.exchangeId}));
 const capture=jobs.start(w,{...data,exchangeId:'capture-synthetic-12345',preparationId:data.exchangeId});capture.finish();
 assert.equal(jobs.list(w,data.entryDay).find(row=>row.id==='capture-synthetic-12345').preparationId,data.exchangeId);
});
test('preparation history is bounded and explicitly marks truncated results',t=>{
 const w=fixture(t),j=jobs.start(w,{...data,kind:'preparation'});
 for(let index=0;index<96;index++)j.event({type:'tool_result',index,name:'synthetic',text:'x'.repeat(20000)});
 j.finish();const [row]=jobs.list(w,data.entryDay);assert.equal(row.truncated,true);assert.ok(row.tools.reduce((n,t)=>n+t.args.length,0)<=64000);
});
test('#874 streamed deltas are written at most every interval; decisions, done and finish write at once',t=>{
 const w=fixture(t);
 let clock=1000;const timers=[];
 const j=jobs.start(w,data,{saveIntervalMs:500,now:()=>clock,setTimer:(fn,ms)=>{const timer={fn,ms,unref(){}};timers.push(timer);return timer;},clearTimer:timer=>{const i=timers.indexOf(timer);if(i>=0)timers.splice(i,1);}});
 const file=path.join(w.dir,'diary-conversations',data.entryDay,data.exchangeId+'.json');
 const onDisk=()=>JSON.parse(fs.readFileSync(file,'utf8'));
 let writes=0;const original=fs.renameSync;fs.renameSync=(...args)=>{if(String(args[1])===file)writes++;return original(...args);};t.after(()=>{fs.renameSync=original;});
 for(let i=0;i<1000;i++)j.event({type:'delta',text:'x'});
 assert.equal(writes,0,'1000 deltas inside one interval write nothing yet');
 assert.equal(timers.length,1,'one trailing write is scheduled');assert.equal(timers[0].ms,500);
 timers.shift().fn();
 assert.equal(writes,1);assert.equal(onDisk().content.length,1000);
 clock+=499;j.event({type:'delta',text:'y'});assert.equal(writes,1);
 clock+=1;j.event({type:'delta',text:'z'});assert.equal(writes,2,'an interval has passed: written');
 j.event({type:'delta',text:'w'});assert.equal(writes,2);
 j.event({type:'diary',decision:'logged'});assert.equal(writes,3,'a decision is written at once');
 assert.equal(onDisk().content,'x'.repeat(1000)+'yzw');assert.equal(timers.length,0,'nothing left pending');
 j.event({type:'delta',text:'!'});j.event({type:'done'});assert.equal(writes,4);assert.equal(onDisk().state,'complete');
 j.event({type:'reasoning',text:'tail'});j.finish();
 assert.equal(writes,5,'finish flushes a pending write');assert.equal(onDisk().reasoning,'tail');assert.equal(timers.length,0);
 assert.equal(jobs.list(w,data.entryDay)[0].state,'complete');
});
test('#874 a failed throttled write is retried by finish()',t=>{
 const w=fixture(t);let clock=1000;const timers=[];
 const j=jobs.start(w,data,{saveIntervalMs:500,now:()=>clock,setTimer:fn=>{const timer={fn,unref(){}};timers.push(timer);return timer;},clearTimer:timer=>{const i=timers.indexOf(timer);if(i>=0)timers.splice(i,1);}});
 const file=path.join(w.dir,'diary-conversations',data.entryDay,data.exchangeId+'.json');
 j.event({type:'delta',text:'kept '});j.event({type:'diary',decision:'logged'});j.event({type:'done'});
 // A late text event after done: only the throttled path can write it.
 j.event({type:'delta',text:'text'});
 const original=fs.renameSync;let fail=true;fs.renameSync=(...args)=>{if(fail&&String(args[1])===file)throw Object.assign(Error('disk full'),{code:'ENOSPC'});return original(...args);};t.after(()=>{fs.renameSync=original;});
 timers.shift().fn();
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).content,'kept ','the timer write failed');
 fail=false;clock+=10;j.finish();
 const row=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(row.content,'kept text');assert.equal(row.state,'complete');
});
test('#894 a failed immediate write (done) is retried by finish()',t=>{
 const w=fixture(t);
 const j=jobs.start(w,data,{saveIntervalMs:500,now:()=>1000,setTimer:()=>({unref(){}}),clearTimer:()=>{}});
 const file=path.join(w.dir,'diary-conversations',data.entryDay,data.exchangeId+'.json');
 j.event({type:'diary',decision:'logged'});
 const original=fs.renameSync;let fail=true;fs.renameSync=(...args)=>{if(fail&&String(args[1])===file)throw Object.assign(Error('disk full'),{code:'ENOSPC'});return original(...args);};t.after(()=>{fs.renameSync=original;});
 assert.throws(()=>j.event({type:'done'}),/disk full/);
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).state,'running','the done write failed');
 fail=false;j.finish();
 assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).state,'complete','finish() retried the failed write');
 assert.equal(jobs.list(w,data.entryDay)[0].state,'complete');
});
