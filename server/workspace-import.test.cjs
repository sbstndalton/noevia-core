const test=require('node:test'),assert=require('node:assert/strict');
const {Readable}=require('node:stream');const {EventEmitter}=require('node:events');
const {proxyWorkspaceImport,MAX_UPLOAD,MAX_REPLY}=require('./workspace-import.cjs');
function response(){const res=new EventEmitter();res.writeHead=(status,headers)=>{res.status=status;res.headers=headers;res.headersSent=true;};res.end=body=>{res.body=JSON.parse(body);res.writableEnded=true;};return res;}
test('import proxy preserves binary and tenant headers, returns no-store',async()=>{
 const old=global.fetch;const body=Buffer.from([80,75,0,255]);let seen;
 global.fetch=async(url,options)=>{seen={url,...options};return {ok:true,status:200,json:async()=>({fingerprint:'reviewed'})};};
 try{const req=Readable.from([body]);req.headers={};const res=response();await proxyWorkspaceImport(req,res,'http://diary/api/workspace-import?action=preview',{'X-Cowork-User-ID':'synthetic'});
 assert.deepEqual(seen.body,body);assert.equal(seen.headers['X-Cowork-User-ID'],'synthetic');assert.equal(res.status,200);assert.equal(res.headers['Cache-Control'],'no-store');}finally{global.fetch=old;}
});
test('oversize import is refused before upstream and error is safe',async()=>{
 const old=global.fetch;let called=false;global.fetch=async()=>{called=true;throw Error('credential secret');};
 try{const req=Readable.from([]);req.headers={'content-length':String(MAX_UPLOAD+1)};const res=response();await proxyWorkspaceImport(req,res,'http://diary',{});assert.equal(res.status,413);assert.equal(called,false);
 const next=Readable.from([Buffer.from('zip')]);next.headers={};const failed=response();await proxyWorkspaceImport(next,failed,'http://diary',{});assert.equal(failed.status,502);assert.ok(!failed.body.error.includes('secret'));assert.match(failed.body.error,/same file and folder/);}finally{global.fetch=old;}
});
test('#920: a preview listing 5000 duplicate files with 120-character paths is parsed, not refused',async()=>{
 const old=global.fetch;
 const files=Array.from({length:5000},(_,i)=>`${'d'.repeat(100)}/file-${String(i).padStart(5,'0')}`.padEnd(120,'y'));
 const preview={fingerprint:'f'.repeat(64),destination:'Imported',fileCount:5000,bytes:1,files,directories:files.slice(0,5000),conflicts:[],duplicates:files,mode:'new-folder-only',alreadyApplied:false};
 const payload=JSON.stringify(preview);assert.ok(payload.length>1024*1024&&payload.length<MAX_REPLY,`payload ${payload.length}`);
 global.fetch=async()=>new Response(payload,{status:200});
 try{const req=Readable.from([Buffer.from('zip')]);req.headers={};const res=response();await proxyWorkspaceImport(req,res,'http://diary/api/workspace-import?action=preview',{});
 assert.equal(res.status,200);assert.equal(res.body.duplicates.length,5000);assert.equal(res.body.files[0].length,120);}finally{global.fetch=old;}
});
test('#920: an endless preview reply is cut at the cap and answered with the retry message',async()=>{
 const old=global.fetch;let pulled=0;
 global.fetch=async()=>new Response(new ReadableStream({pull(c){pulled+=65536;c.enqueue(new Uint8Array(65536).fill(97));}},{highWaterMark:0}),{status:200});
 try{const req=Readable.from([Buffer.from('zip')]);req.headers={};const res=response();await proxyWorkspaceImport(req,res,'http://diary',{});
 assert.equal(res.status,502);assert.ok(pulled<=MAX_REPLY+4*65536,`pulled ${pulled}`);}finally{global.fetch=old;}
});
