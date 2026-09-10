const test=require('node:test'),assert=require('node:assert/strict');
const {Writable}=require('node:stream');
const {proxyDiaryStream}=require('./diary-stream.cjs');
function response(){
 const chunks=[];const res=new Writable({write(chunk,_,next){chunks.push(chunk.toString());next();}});
 res.writeHead=(status,headers)=>{res.status=status;res.headers=headers;};
 return {res,text:()=>chunks.join('')};
}
test('Diary sends headers and heartbeat before a slow upstream and relays live reasoning before completion',async t=>{
 let release;const gate=new Promise(r=>release=r);let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;await gate;return new Response(new ReadableStream({start(c){
  c.enqueue(new TextEncoder().encode('data: {"type":"reasoning","text":"Synthetic thought"}\n\n'));
  c.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'));c.close();
 }}),{headers:{'Content-Type':'text/event-stream'}});});
 const {res,text}=response();const run=proxyDiaryStream(res,'http://synthetic',{}, {heartbeatMs:5});
 assert.equal(res.status,200);assert.match(text(),/Connecting/);
 await new Promise(r=>setTimeout(r,20));assert.match(text(),/keep-alive/);
 release();await run;assert.match(text(),/Synthetic thought/);assert.equal(calls,1);
});
test('Diary upstream HTML errors are sanitized without retrying the exchange',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('<html>private proxy detail</html>',{status:524});});
 const {res,text}=response();await proxyDiaryStream(res,'http://synthetic',{});
 assert.match(text(),/may still be saving/);assert.doesNotMatch(text(),/html|private proxy/);assert.equal(calls,1);
});
test('disconnect aborts the transport and does not retry or crash',async t=>{
 let signal,calls=0;t.mock.method(globalThis,'fetch',async(_,opts)=>{calls++;signal=opts.signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('closed'))));});
 const {res}=response();const run=proxyDiaryStream(res,'http://synthetic',{});res.destroy();await run;
 assert.equal(signal.aborted,true);assert.equal(calls,1);
});
test('heartbeats cannot split a fragmented upstream SSE event',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream({start(c){
  c.enqueue(new TextEncoder().encode('data: {"type":"reasoning","text":"'));
  setTimeout(()=>{c.enqueue(new TextEncoder().encode('Synthetic"}\n\ndata: {"type":"done"}\n\n'));c.close();},20);
 }}),{headers:{'Content-Type':'text/event-stream'}}));
 const {res,text}=response();await proxyDiaryStream(res,'http://synthetic',{}, {heartbeatMs:5});
 const events=text().split('\n\n').filter(s=>s.startsWith('data: ')).map(s=>JSON.parse(s.slice(6)));
 assert.equal(events.find(e=>e.type==='reasoning').text,'Synthetic');
 assert.match(text(),/keep-alive/);
});
