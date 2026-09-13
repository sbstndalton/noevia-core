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
 assert.equal(jobs.list(w,data.entryDay)[1].preparationId,data.exchangeId);
});
test('preparation history is bounded and explicitly marks truncated results',t=>{
 const w=fixture(t),j=jobs.start(w,{...data,kind:'preparation'});
 for(let index=0;index<96;index++)j.event({type:'tool_result',index,name:'synthetic',text:'x'.repeat(20000)});
 j.finish();const [row]=jobs.list(w,data.entryDay);assert.equal(row.truncated,true);assert.ok(row.tools.reduce((n,t)=>n+t.args.length,0)<=64000);
});
