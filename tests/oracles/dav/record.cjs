'use strict';
// Node 22 synthetic oracle for the retired listener; no sockets or real users.
const {Readable}=require('node:stream'),crypto=require('node:crypto');
const {createDavHandler}=require('../dav.cjs');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const cases=[
 ['options','OPTIONS','/dav/alice/'],['get','GET','/dav/alice/entry.md'],['head','HEAD','/dav/alice/entry.md'],
 ['root get','GET','/dav/alice/'],['missing','GET','/dav/alice/missing.md'],
 ['depth omitted','PROPFIND','/dav/alice/'],['depth zero','PROPFIND','/dav/alice/','',{depth:'0'}],['depth one','PROPFIND','/dav/alice/','',{depth:'1'}],
 ['named properties','PROPFIND','/dav/alice/entry.md','<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getcontentlength/></d:prop></d:propfind>',{depth:'0'}],
 ['unsupported','LOCK','/dav/alice/'],['path traversal','GET','/dav/alice/%2e%2e/a.md'],['encoded slash','GET','/dav/alice/a%2fb.md'],['bad escape','GET','/dav/alice/%GG'],
 ['write type','PUT','/dav/alice/new.txt','x',{'if-none-match':'*'}],['write create','PUT','/dav/alice/new.md','New',{'if-none-match':'*'}],['write unconditional','PUT','/dav/alice/entry.md','Replacement'],
 ['write conflict','PUT','/dav/alice/entry.md','New',{'if-none-match':'*'}],['conditional unsupported','PUT','/dav/alice/entry.md','x',{'if':'x'}],
 ['mkdir','MKCOL','/dav/alice/folder'],['mkdir root','MKCOL','/dav/alice/'],['mkdir body','MKCOL','/dav/alice/folder','x'],
 ['delete','DELETE','/dav/alice/entry.md'],['copy','COPY','/dav/alice/entry.md','',{destination:'/dav/alice/copy.md',overwrite:'F'}],['move','MOVE','/dav/alice/entry.md','',{destination:'/dav/alice/moved.md'}],['root delete','DELETE','/dav/alice/']
];
(async()=>{
 const output=[];
 for(const [name,method,url,body='',extra={}] of cases){
  const files=new Map([['entry.md','Synthetic']]);
  const auth={appPasswords:{list:()=>[{id:'device'}],verifyDav:async(u,p)=>u==='alice'&&p==='synthetic'?{userId:'alice',credentialId:'device'}:null},db:{prepare:()=>({get:()=>({id:'alice'})})},diaryEnabled:()=>true,getStorage:()=>({kind:'local'}),audit:()=>{}};
  const adapter={list:async()=>[...files].map(([path])=>({path,name:path,isDir:false,modified:1})),read:async(_,p)=>files.has(p)?{content:files.get(p),version:hash(files.get(p))}:{content:null},write:async(_,v)=>{if((files.has(v.path)?hash(files.get(v.path)):null)!==v.version)throw Object.assign(Error('changed'),{status:409});files.set(v.path,v.content);return{version:hash(v.content)};},mkdir:async()=>{},ops:async(_,v)=>{if(v.op==='stat'){if(!files.has(v.path))throw Object.assign(Error('missing'),{status:404});return{version:hash(files.get(v.path)),isDir:false};}if(v.op==='preserve')return{trash:'synthetic-trash'};if(v.op==='delete'){files.delete(v.path);return{trash:['synthetic-trash']};}const content=files.get(v.path),replaced=files.has(v.destination);files.set(v.destination,content);if(v.op==='move')files.delete(v.path);return{replaced};}};
  const handle=createDavHandler({auth,settings:{scope:()=> 'lan'},config:{available:true,scope:'lan',host:'sharing.test:8031',origin:'http://sharing.test:8031',cleartext:true},files:adapter});
  const req=Readable.from([Buffer.from(body)]);Object.assign(req,{method,url,headers:{host:'sharing.test:8031',authorization:'Basic '+Buffer.from('alice:synthetic').toString('base64'),...extra},socket:{remoteAddress:'192.0.2.1'}});
  const headers={};let status=200,text='';const res={destroyed:false,set statusCode(v){status=v},setHeader(k,v){headers[k.toLowerCase()]=v},end(v){text=v||''}};
  await handle(req,res);
  output.push({name,method,path:url,body,headers:extra,expected:{status,body:text,allow:headers.allow||null,dav:headers.dav||null,etag:headers.etag||null,type:headers['content-type']}});
 }
 process.stdout.write(JSON.stringify(output,null,2)+'\n');
})();
