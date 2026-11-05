'use strict';
// Explicit isolated qualification: node this-file <exact noevia-server binary>.
// Uses the REAL Core entrypoint and native binary, synthetic accounts/data only.
// Only an owned synthetic loader is contacted; no real engines, containers or production storage are touched.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const crypto=require('node:crypto');
const {spawn,spawnSync}=require('node:child_process');
const {setTimeout:pause}=require('node:timers/promises');
const root=path.resolve(__dirname,'../..');
const binary=process.argv[2];
if(!binary||!fs.statSync(binary).isFile())throw Error('Explicit native server binary is required');
const probe=spawnSync(binary,['--features'],{encoding:'utf8',timeout:5000});
assert.equal(probe.status,0);assert.ok(probe.stdout.split('\n').includes('rust-model-scan-cache-v1'));
const {createAuth}=require('../../server/auth.cjs');
const {seedAccount}=require('../server/seed-account.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-scan-pair-'));
const children=new Set();
const logs=[];
const report={schema:1,scope:'isolated production Core entrypoint/native scan pair, synthetic only',checks:[],deployment:false,fullBackendQualification:false};
function note(name){report.checks.push(name);}
async function freePort(){const server=http.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise(r=>server.close(r));return port;}
function launch(command,args,env){const child=spawn(command,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});children.add(child);for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{logs.push(bytes.toString());if(logs.length>100)logs.shift();});child.on('error',()=>{});return child;}
async function stop(child){if(!child||child.exitCode!==null||child.signalCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await Promise.race([done,pause(3000).then(()=>{throw Error('Owned synthetic process did not exit after SIGTERM');})]);}
function call(port,method,url,headers={},body){return new Promise((resolve,reject)=>{const bytes=body===undefined?null:Buffer.from(JSON.stringify(body));const req=http.request({host:'127.0.0.1',port,method,path:url,headers:{...headers,...(bytes?{'content-type':'application/json','content-length':bytes.length}:{})},timeout:2500},res=>{const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>1024*1024)req.destroy(Error('Response cap exceeded'));else chunks.push(chunk);});res.on('end',()=>{let json=null;try{json=JSON.parse(Buffer.concat(chunks).toString());}catch{}resolve({status:res.statusCode,json});});});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('Request deadline')));if(bytes)req.end(bytes);else req.end();});}
async function until(action,accept,ms,label){const deadline=Date.now()+ms;let result;while(Date.now()<deadline){try{result=await action();if(accept(result))return result;}catch{}await pause(100);}throw Error(`Timed out: ${label}; last status ${result?.status||'unavailable'}`);}
function quiet(fn){const log=console.log,warn=console.warn;console.log=()=>{};console.warn=()=>{};try{return fn();}finally{console.log=log;console.warn=warn;}}
async function main(){
 const front=await freePort(),backend=await freePort(),internal=await freePort();
 const origin=`http://127.0.0.1:${front}`;
 const auth=quiet(()=>createAuth({dataDir:dir,publicOrigin:origin}));auth.db.close();
 const admin=seedAccount(dir,{username:'synthetic-admin',publicOrigin:origin});
 let scans=0,holdScan=false,scanStarted,releaseScan,writeStarted,releaseWrite;
 const loader=http.createServer(async(req,res)=>{
  req.resume();
  if(req.url==='/api/v1/models'){
   scans++;const value=holdScan?'obsolete':'current';
   if(holdScan){scanStarted?.();await new Promise(r=>{releaseScan=r;});}
   res.setHeader('content-type','application/json');res.end(JSON.stringify({models:[{modelId:value,sections:[value],bytes:42}]}));
  }else if(req.url==='/api/v1/synthetic-write'){
   writeStarted?.();await new Promise(r=>{releaseWrite=r;});res.setHeader('content-type','application/json');res.end('{"ok":true}');
  }else{res.setHeader('content-type','application/json');res.end('{}');}
 });
 await new Promise(r=>loader.listen(0,'127.0.0.1',r));
 const token=crypto.randomBytes(32).toString('hex'),start=crypto.randomBytes(16).toString('hex');
 const env={PATH:process.env.PATH,NODE_PATH:process.env.NODE_PATH,DAV_PARSE_WASM:process.env.DAV_PARSE_WASM,DAV_PARSE_WASM_REQUIRED:'1',
  UI_DATA_DIR:dir,UI_HOST:'127.0.0.1',PUBLIC_ORIGIN:origin,TRUST_PROXY:'true',LEGACY_AUTH_COMPAT:'false',
  NOEVIA_SERVER_BIN:binary,NOEVIA_START_ID:start,NOEVIA_PROJECT_STORE_PORT:String(internal),NOEVIA_PROJECT_STORE_TOKEN:token,
  MODEL_LOADER_URL:`http://127.0.0.1:${loader.address().port}`,INFERENCE_BASE_URL:'http://127.0.0.1:9',MODEL_MANAGER_KIND:'none',MODEL_MANAGER_BASE_URL:'http://127.0.0.1:9',MCP_SERVERS:'',MCP_SERVER_URL:'',MCP_INTERNAL_PORT:'',
 };
 let native,core;
 try{
  native=launch(binary,[],{...env,UI_PORT:String(front),NOEVIA_LEGACY_UPSTREAM:`http://127.0.0.1:${backend}`});
  await until(()=>call(internal,'POST','/v1/model-scan/invalidate',{'x-noevia-store-token':token},{}),r=>r.status===200,10000,'native store');
  const fence=path.join(dir,'network-fence.cjs');
  fs.writeFileSync(fence,`const original=global.fetch;global.fetch=(input,options)=>{const u=new URL(typeof input==='string'?input:input.url);if(u.hostname!=='127.0.0.1'||![${internal},${loader.address().port}].includes(Number(u.port)))return Promise.reject(Error('Synthetic qualification network fence'));return original(input,options);};`);
  core=launch(process.execPath,['--require',fence,path.join(root,'server/index.cjs')],{...env,UI_PORT:String(backend)});
  await until(()=>call(backend,'GET','/api/ready'),r=>r.status===200&&r.json?.ready,20000,'real Core startup');note('real Core and native server boot as a coherent pair');
  const headers=admin.headers(origin),url='/api/model-manager/models';
  assert.equal((await call(front,'GET',url,headers)).status,200);const count=scans;
  assert.equal((await call(front,'GET',url,headers)).json.models[0].modelId,'current');assert.equal(scans,count);note('native cache reuses a cold scan');
  assert.equal((await call(backend,'GET',url,headers)).status,503);note('Core refuses bypass and has no scan cache bridge');
  const writing=new Promise(r=>{writeStarted=r;});
  const write=call(front,'POST','/api/model-manager/synthetic-write',headers,{});await writing;
  holdScan=true;const scanning=new Promise(r=>{scanStarted=r;});
  const late=call(front,'GET',url,headers);await scanning;
  releaseWrite();assert.equal((await write).status,200);
  releaseScan();assert.equal((await late).status,200);holdScan=false;
  assert.equal((await call(front,'GET',url,headers)).json.models[0].modelId,'current');note('a scan started during a real Core writer cannot republish after it settles');
  for(const tail of ['sections/a%2fb','sections/a%5cb','sections/%2e%2e']){
   for(const port of [front,backend])assert.deepEqual((await call(port,'GET','/api/model-manager/'+tail,headers)),{status:400,json:{error:'Invalid path'}});
  }
  note('native route boundary rejects decoded traversal and separators');
  assert.equal((await call(internal,'POST','/v1/model-scan/invalidate',{'x-noevia-store-token':token,'x-forwarded-for':''},{})).status,401);
  assert.equal((await call(internal,'POST','/v1/model-scan/invalidate',{},{})).status,401);note('private invalidation rejects forwarded and unauthenticated requests');
 }finally{releaseWrite?.();releaseScan?.();await stop(core);await stop(native);await new Promise(r=>loader.close(r));}
}
main().then(()=>console.log(JSON.stringify(report,null,2))).catch(error=>{console.error(error.stack);console.error(logs.join('').slice(-5000));process.exitCode=1;}).finally(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise(r=>child.once('exit',r));}fs.rmSync(dir,{recursive:true,force:true});});
