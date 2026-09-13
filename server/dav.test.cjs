'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto');
const {configuration,createDavSettings}=require('./dav-settings.cjs'),{createDavHandler,properties}=require('./dav.cjs');
const Database=require('better-sqlite3');
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
function fixture(t,config={available:true,scope:'lan',host:'localhost',origin:'http://localhost',cleartext:true}){
 const db=new Database(':memory:');db.exec("PRAGMA foreign_keys=ON;CREATE TABLE users(id TEXT PRIMARY KEY,disabled_at INTEGER);INSERT INTO users VALUES('alice',NULL),('bob',NULL);");t.after(()=>db.close());
 const corpus={alice:{'entry.md':'Synthetic alice'},bob:{'entry.md':'Synthetic bob'}},enabled={alice:true,bob:true},storage={alice:'local',bob:'local'},events=[];
 const auth={db,diaryEnabled:id=>enabled[id],getStorage:id=>({kind:storage[id]}),audit:(...args)=>events.push(args),appPasswords:{list:()=>[{id:'device'}],verifyDav:async(username,password,scope)=>password==='synthetic'&&corpus[username]&&scope===config.scope?{userId:username,credentialId:'device'}:null}};
 const settings=createDavSettings({auth,config});const user=id=>({id,username:id});
 const files={list:async(id,p)=>p?[]:Object.keys(corpus[id]).map(path=>({path,name:path,isDir:false})),read:async(id,p)=>({content:corpus[id][p]??null,version:corpus[id][p]===undefined?null:digest(corpus[id][p])}),write:async(id,b)=>{const old=corpus[id][b.path];if((old===undefined?null:digest(old))!==b.version)throw Object.assign(Error('Conflict'),{status:409});corpus[id][b.path]=b.content;return {version:digest(b.content)};}};
 return {config,db,auth,settings,user,files,corpus,enabled,storage,events};
}
async function server(t,f){
 const s=http.createServer(createDavHandler(f));await new Promise(r=>s.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{s.close(r);s.closeAllConnections();}));
 return (method,path='',body,headers={})=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:s.address().port,path:'/dav/alice/'+path,method,headers:{host:f.config.host,Authorization:'Basic '+Buffer.from('alice:synthetic').toString('base64'),...headers}},res=>{
   const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:new Headers(res.headers),text:async()=>Buffer.concat(chunks).toString()}));
  });req.on('error',reject);req.end(body);
 });
}

test('DAV deployment transport configuration fails closed',()=>{
 assert.equal(configuration({}).available,false);
 const base={COWORK_DAV_PORT:'8031',COWORK_DAV_SCOPE:'lan',COWORK_DAV_ORIGIN:'http://files.local:8031'};
 assert.equal(configuration(base,'https://app.example').cleartext,true);
 for(const change of [{COWORK_DAV_PORT:'8021'},{COWORK_DAV_SCOPE:'bad'},{COWORK_DAV_ORIGIN:'http://user@files.local'},{COWORK_DAV_ORIGIN:'http://files.local/path'},{COWORK_DAV_SCOPE:'public'},{COWORK_DAV_ORIGIN:'https://files.local'}])assert.throws(()=>configuration({...base,...change}));
 assert.throws(()=>configuration(base,'http://files.local:8031'));
 assert.equal(configuration({...base,COWORK_DAV_SCOPE:'public',COWORK_DAV_ORIGIN:'https://files.example',COWORK_DAV_PROXY_TOKEN:'a'.repeat(64)}).available,true);
});
test('sharing opt-in requires eligibility, matching endpoint and explicit cleartext acknowledgement',t=>{
 const f=fixture(t);assert.equal(f.settings.get(f.user('alice')).scope,'off');
 assert.throws(()=>f.settings.save(f.user('alice'),{scope:'lan'}),/Acknowledge/);
 assert.throws(()=>f.settings.save(f.user('alice'),{scope:'public'}),/not configured/);
 f.settings.save(f.user('alice'),{scope:'lan',acknowledgeCleartext:true});assert.equal(f.settings.scope('bob'),'off');
 f.storage.alice='webdav';assert.throws(()=>f.settings.save(f.user('alice'),{scope:'lan',acknowledgeCleartext:true}),/local storage/);
 f.settings.save(f.user('alice'),{scope:'off'});assert.equal(f.settings.scope('alice'),'off');
});
test('property parser supports namespaces and refuses DTD, malformed XML and unsupported selectors',()=>{
 assert.equal(properties(''),null);assert.equal(properties('<D:propfind xmlns:D="DAV:"><D:allprop/></D:propfind>'),null);
 assert.deepEqual(properties('<propfind xmlns="DAV:"><prop><getetag/><x:custom xmlns:x="urn:test"/></prop></propfind>'),[{local:'getetag',uri:'DAV:'},{local:'custom',uri:'urn:test'}]);
 for(const b of ['<','<!DOCTYPE x><propfind/>','<propfind xmlns="DAV:"><prop></propfind>','<propfind xmlns="DAV:"><propname/></propfind>','<propfind xmlns="DAV:"><prop>&xx;</prop></propfind>'])assert.throws(()=>properties(b));
});
test('DAV files stay tenant scoped, with HEAD/OPTIONS/property status and conditional writes',async t=>{
 const f=fixture(t),request=await server(t,f);assert.equal((await request('GET','entry.md')).status,403);
 f.settings.save(f.user('alice'),{scope:'lan',acknowledgeCleartext:true});
 let r=await request('GET','entry.md');assert.equal(await r.text(),'Synthetic alice');const tag=r.headers.get('etag');
 r=await request('HEAD','entry.md');assert.equal(await r.text(),'');assert.equal(r.headers.get('etag'),tag);assert.equal(r.headers.get('content-length'),'15');
 assert.equal((await request('GET','entry.md',undefined,{'If-None-Match':tag})).status,304);
 r=await request('OPTIONS');assert.match(r.headers.get('allow'),/PROPFIND/);assert.equal(r.headers.get('dav'),null);
 r=await request('PROPFIND','', '<propfind xmlns="DAV:"><prop><getetag/><getlastmodified/><resourcetype/></prop></propfind>',{Depth:'1'});
 assert.equal(r.status,207);const body=await r.text();assert.match(body,/entry.md/);assert.match(body,/404 Not Found/);assert.ok(!body.includes('Synthetic bob'));
 assert.equal((await request('PROPFIND')).status,403);
 assert.equal((await request('PUT','entry.md','lost update')).status,428);
 assert.equal((await request('PUT','entry.md','new',{'If-Match':'"'+'0'.repeat(64)+'"'})).status,412);
 assert.equal((await request('PUT','entry.md','new',{'If-Match':tag})).status,204);
 assert.equal(f.corpus.alice['entry.md'],'new');assert.equal(f.corpus.bob['entry.md'],'Synthetic bob');
 assert.equal((await request('PUT','new.md','created',{'If-None-Match':'*'})).status,201);
 assert.equal((await request('PUT','new.md','replace',{'If-None-Match':'*'})).status,412);
 assert.equal((await request('PUT','folder/new.md','created',{'If-None-Match':'*'})).status,409);
 assert.equal((await request('DELETE','entry.md')).status,405);
 assert.equal((await request('GET','entry.md',undefined,{Authorization:'Bearer synthetic'})).status,401);
 assert.equal((await request('GET','entry.md',undefined,{Authorization:'Basic '+Buffer.from('bob:synthetic').toString('base64')})).status,401);
 assert.equal((await request('GET','%2eprivate.md')).status,400);
 assert.equal((await request('GET','a%2fb.md')).status,400);
 f.enabled.alice=false;assert.equal((await request('GET','entry.md')).status,403);
});
test('DAV public transport refuses spoofed HTTPS without dedicated proxy secret and wrong authority',async t=>{
 const f=fixture(t,{available:true,scope:'public',host:'files.example',origin:'https://files.example',cleartext:false,proxyToken:'a'.repeat(64)}),request=await server(t,f);
 f.settings.save(f.user('alice'),{scope:'public'});
 assert.equal((await request('GET','entry.md',undefined,{'x-forwarded-proto':'https'})).status,403);
 assert.equal((await request('GET','entry.md',undefined,{'x-forwarded-proto':'https','x-cowork-dav-proxy-token':'a'.repeat(64),host:'other.example'})).status,421);
 assert.equal((await request('GET','entry.md',undefined,{'x-forwarded-proto':'https','x-cowork-dav-proxy-token':'a'.repeat(64)})).status,200);
});
test('DAV rejects oversized writes and fails storage errors without leaking internals',async t=>{
 const f=fixture(t),request=await server(t,f);f.settings.save(f.user('alice'),{scope:'lan',acknowledgeCleartext:true});
 assert.equal((await request('PUT','large.md','x'.repeat(512*1024+1),{'If-None-Match':'*'})).status,413);
 f.files.list=async()=>{throw Error('private backend detail');};const r=await request('GET','entry.md');assert.equal(r.status,502);assert.equal(await r.text(),'Diary storage is unavailable');
});
test('MKCOL is create-only, scoped and refuses bodies and unsupported conditions',async t=>{
 const f=fixture(t),made=[];
 f.files.mkdir=async(id,path)=>{if(path==='missing/child')throw Object.assign(Error('Missing parent'),{status:409});if(made.includes(path)||path==='entry.md')throw Object.assign(Error('Exists'),{status:405});assert.equal(id,'alice');made.push(path);};
 const request=await server(t,f);
 assert.equal((await request('MKCOL','folder/')).status,403);
 f.settings.save(f.user('alice'),{scope:'lan',acknowledgeCleartext:true});
 assert.match((await request('OPTIONS')).headers.get('allow'),/MKCOL/);
 assert.equal((await request('MKCOL','folder/')).status,201);
 assert.equal((await request('MKCOL','folder/')).status,405);
 assert.equal((await request('MKCOL','entry.md')).status,405);
 assert.equal((await request('MKCOL','missing/child/')).status,409);
 assert.equal((await request('MKCOL','')).status,405);
 assert.equal((await request('MKCOL','body','<collection/>')).status,415);
 assert.equal((await request('MKCOL','conditional',undefined,{'If-None-Match':'*'})).status,400);
 assert.equal((await request('MKCOL','%2e%2e/escape')).status,400);
 f.storage.alice='webdav';assert.equal((await request('MKCOL','remote')).status,403);
 assert.deepEqual(made,['folder']);assert.equal(f.events.filter(e=>e[0]==='dav.mkdir').length,1);
});
