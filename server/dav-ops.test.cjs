'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const Database=require('better-sqlite3');
const {createDavHandler}=require('./dav.cjs');
const {createDavSettings}=require('./dav-settings.cjs');
const {destinationPath,destinationTag}=require('./dav-ops.cjs');
const TAG='a'.repeat(64),DEST='b'.repeat(64);

async function setup(t,{ops}={}){
 const config={available:true,scope:'lan',host:'localhost',origin:'http://localhost',cleartext:true};
 const db=new Database(':memory:');db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,disabled_at INTEGER);INSERT INTO users VALUES('alice',NULL);");t.after(()=>db.close());
 const events=[],calls=[];
 const auth={db,diaryEnabled:()=>true,getStorage:()=>({kind:'local'}),audit:(...a)=>events.push(a),appPasswords:{list:()=>[{id:'device'}],verifyDav:async(u,p)=>p==='synthetic'&&u==='alice'?{userId:'alice',credentialId:'device'}:null}};
 const settings=createDavSettings({auth,config});settings.save({id:'alice',username:'alice'},{scope:'lan',acknowledgeCleartext:true});
 const files={list:async(id,p)=>p?[]:[{path:'notes',name:'notes',isDir:true},{path:'a.md',name:'a.md',isDir:false}],read:async()=>({content:'x',version:TAG}),write:async()=>({version:TAG}),
  ops:ops||(async(id,body)=>{calls.push([id,body]);if(body.op==='stat')return {isDir:body.path==='notes',version:DEST};return body.op==='delete'?{trash:['t']}:{replaced:!!body.destinationVersion};})};
 const s=http.createServer(createDavHandler({auth,settings,config,files}));await new Promise(r=>s.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{s.close(r);s.closeAllConnections();}));
 const request=(method,path='',headers={},body)=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:s.address().port,path:'/dav/alice/'+path,method,headers:{host:'localhost',Authorization:'Basic '+Buffer.from('alice:synthetic').toString('base64'),...headers}},res=>{const c=[];res.on('data',x=>c.push(x));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(c).toString()}));});
  req.on('error',reject);req.end(body);
 });
 return {request,calls,events};
}

test('OPTIONS advertises class 1 and the new methods, never LOCK',async t=>{
 const {request}=await setup(t);const r=await request('OPTIONS');
 assert.equal(r.headers.dav,'1');assert.match(r.headers.allow,/DELETE, MOVE, COPY/);assert.doesNotMatch(r.headers.allow,/LOCK/);
 assert.equal((await request('LOCK','a.md')).status,405);
});

test('DELETE forwards If-Match, or the version read now when a client sends none; audit has no content',async t=>{
 const {request,calls,events}=await setup(t);
 // rclone, Finder and Obsidian sync send no If-Match (docs/dav.md, interop run 1): Trash makes it reversible.
 assert.equal((await request('DELETE','a.md')).status,204);
 assert.deepEqual(calls.slice(-2).map(c=>c[1]),[{op:'stat',path:'a.md'},{op:'delete',path:'a.md',version:DEST}]);
 assert.equal(events.at(-1)[3].unconditional,true);
 assert.equal((await request('DELETE','a.md',{'If-Match':'"weak"'})).status,400);
 assert.equal((await request('DELETE','',{'If-Match':`"${TAG}"`})).status,403);
 assert.equal((await request('DELETE','a.md',{'If-Match':`"${TAG}"`})).status,204);
 assert.deepEqual(calls.at(-1),['alice',{op:'delete',path:'a.md',version:TAG}]);
 assert.deepEqual(events.at(-1),['dav.delete','alice','alice',{credentialId:'device',path:'a.md',trashed:1,unconditional:false}]);
 assert.equal((await request('DELETE','a.md',{'If-Match':`"${TAG}"`,Depth:'1'})).status,400);
});

test('MOVE and COPY resolve Destination inside the same tenant only',async t=>{
 const {request,calls}=await setup(t);const h={'If-Match':`"${TAG}"`};
 assert.equal((await request('MOVE','a.md',{...h,Destination:'http://localhost/dav/alice/notes/b.md'})).status,201);
 assert.deepEqual(calls.at(-1)[1],{op:'move',path:'a.md',destination:'notes/b.md',overwrite:false,version:TAG});
 assert.equal((await request('MOVE','a.md',{...h,Destination:'http://localhost/dav/bob/b.md'})).status,403);
 assert.equal((await request('MOVE','a.md',{...h,Destination:'http://evil.example/dav/alice/b.md'})).status,502);
 assert.equal((await request('MOVE','a.md',{...h,Destination:'/dav/alice/.hidden.md'})).status,403);
 assert.equal((await request('MOVE','a.md',{...h,Destination:'/dav/alice/%2e%2e/x.md'})).status,403);
 assert.equal((await request('MOVE','a.md',{Destination:'/dav/alice/b.md'})).status,201);
 assert.deepEqual(calls.at(-1)[1],{op:'move',path:'a.md',destination:'b.md',overwrite:false,version:DEST});
 // An untagged Overwrite: T reads the destination's version; the companion sends it to Trash.
 assert.equal((await request('MOVE','a.md',{Destination:'/dav/alice/b.md',Overwrite:'T'})).status,204);
 assert.equal(calls.at(-1)[1].destinationVersion,DEST);
 assert.equal((await request('MOVE','a.md',{...h,Destination:'/dav/alice/b.md',Overwrite:'maybe'})).status,400);
 const replaced=await request('MOVE','a.md',{...h,Destination:'/dav/alice/b.md',Overwrite:'T',If:`</dav/alice/b.md> (["${DEST}"])`});
 assert.equal(replaced.status,204);assert.equal(calls.at(-1)[1].destinationVersion,DEST);
 assert.equal((await request('COPY','a.md',{Destination:'/dav/alice/c.md'})).status,201);
 assert.deepEqual(calls.at(-1)[1],{op:'copy',path:'a.md',destination:'c.md',overwrite:false});
 assert.equal((await request('COPY','notes',{Destination:'/dav/alice/n2',Depth:'0'})).status,403);
 assert.equal((await request('MOVE','a.md',{...h,Destination:'/dav/alice/b.md'},'body')).status,415);
});

test('companion refusals pass through; an unknown outcome is 503 with Retry-After',async t=>{
 for(const status of [403,404,409,412,507]){
  const {request}=await setup(t,{ops:async()=>{throw Object.assign(Error('refused synthetic'),{status});}});
  const r=await request('DELETE','a.md',{'If-Match':`"${TAG}"`});assert.equal(r.status,status);assert.equal(r.text,'refused synthetic');
 }
 const {request}=await setup(t,{ops:async()=>{throw Error('socket hang up');}});
 const r=await request('DELETE','a.md',{'If-Match':`"${TAG}"`});assert.equal(r.status,503);assert.equal(r.headers['retry-after'],'5');
});

test('PROPFIND reports a folder ETag from the companion',async t=>{
 const {request}=await setup(t);
 const r=await request('PROPFIND','',{Depth:'1'},'<propfind xmlns="DAV:"><prop><getetag/></prop></propfind>');
 assert.equal(r.status,207);assert.match(r.text,new RegExp(`/dav/alice/notes/</d:href><d:propstat><d:prop><d:getetag>&quot;${DEST}&quot;`));
});

test('destination helpers',()=>{
 assert.equal(destinationPath('http://localhost/dav/alice/a%20b/c.md',{origin:'http://localhost',username:'alice'}),'a b/c.md');
 assert.throws(()=>destinationPath('http://localhost/dav/alice/',{origin:'http://localhost',username:'alice'}),e=>e.status===403);
 assert.throws(()=>destinationPath('http://localhost/dav/alice/x.md?y',{origin:'http://localhost',username:'alice'}),e=>e.status===400);
 assert.equal(destinationTag(`<http://localhost/dav/alice/b.md> (["${DEST}"])`,'http://localhost/dav/alice/b.md'),DEST);
 assert.equal(destinationTag(`<http://localhost/dav/alice/other.md> (["${DEST}"])`,'http://localhost/dav/alice/b.md'),null);
});

test('an unconditional PUT keeps the previous version in Trash, then writes against it',async t=>{
 const {request,calls,events}=await setup(t);
 const r=await request('PUT','a.md',{},'new text');
 assert.equal(r.status,204);
 assert.deepEqual(calls.at(-1),['alice',{op:'preserve',path:'a.md',version:TAG}]);
 assert.equal(events.at(-1)[0],'dav.write');assert.equal(events.at(-1)[3].unconditional,true);
});
