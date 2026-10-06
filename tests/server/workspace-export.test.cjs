const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {proxyWorkspaceExport}=require('../../server/workspace-export.cjs');
test('export proxy preserves binary bytes and private headers, propagates failures',async()=>{
 const bytes=Buffer.from([0,255,80,75,0,13,10]);let mode='ok',seen;
 const upstream=http.createServer((req,res)=>{seen=req.headers['x-cowork-user-id'];if(mode==='error'){res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({detail:'Finish pending writes'}));}else {res.writeHead(200,{'Content-Type':mode==='wrong'?'text/html':'application/zip'});res.end(bytes);}});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const proxy=http.createServer((req,res)=>void proxyWorkspaceExport(res,`http://127.0.0.1:${upstream.address().port}`,{'X-Cowork-User-ID':'synthetic-tenant'}));
 await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 try{
 const url=`http://127.0.0.1:${proxy.address().port}`;
 let r=await fetch(url);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.match(r.headers.get('content-disposition'),/noevia-workspace.zip/);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes);assert.equal(seen,'synthetic-tenant');
 mode='error';r=await fetch(url);assert.equal(r.status,409);assert.equal((await r.json()).error,'Finish pending writes');
 mode='wrong';r=await fetch(url);assert.equal(r.status,502);assert.match((await r.json()).error,/Retry/);
 }finally{proxy.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>upstream.close(r))]);}
});
