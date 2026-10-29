'use strict';
// Explicit isolated qualification: node this-file <exact noevia-server binary>.
// Uses the REAL Core entrypoint and native binary, synthetic accounts/data only.
// No model endpoints, containers, deployment flags or production storage are touched.
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
assert.equal(probe.status,0);assert.ok(probe.stdout.split('\n').includes('rust-feature-owner'));
const Database=require('better-sqlite3');
const {createAuth}=require('../../server/auth.cjs');
const {seedAccount,seedDeviceToken}=require('../server/seed-account.cjs');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'noevia-feature-pair-'));
const children=new Set();
const logs=[];
const report={schema:1,scope:'isolated production Core entrypoint/native feature pair, synthetic only',checks:[],deployment:false,fullBackendQualification:false};
function note(name){report.checks.push(name);}
async function freePort(){const server=http.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise(r=>server.close(r));return port;}
function launch(command,args,env){const child=spawn(command,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});children.add(child);for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{logs.push(bytes.toString());if(logs.length>100)logs.shift();});child.on('error',()=>{});return child;}
async function stop(child){if(!child||child.exitCode!==null||child.signalCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await Promise.race([done,pause(3000).then(()=>{throw Error('Owned synthetic process did not exit after SIGTERM');})]);}
function call(port,method,url,headers={},body){return new Promise((resolve,reject)=>{const bytes=body===undefined?null:Buffer.from(JSON.stringify(body));const req=http.request({host:'127.0.0.1',port,method,path:url,headers:{...headers,...(bytes?{'content-type':'application/json','content-length':bytes.length}:{})},timeout:2500},res=>{const chunks=[];let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>1024*1024)req.destroy(Error('Response cap exceeded'));else chunks.push(chunk);});res.on('end',()=>{let json=null;try{json=JSON.parse(Buffer.concat(chunks).toString());}catch{}resolve({status:res.statusCode,json});});});req.on('error',reject);req.on('timeout',()=>req.destroy(Error('Request deadline')));if(bytes)req.end(bytes);else req.end();});}
async function until(action,accept,ms,label){const deadline=Date.now()+ms;let result;while(Date.now()<deadline){try{result=await action();if(accept(result))return result;}catch{}await pause(100);}throw Error(`Timed out: ${label}; last status ${result?.status||'unavailable'}`);}
function quiet(fn){const log=console.log,warn=console.warn;console.log=()=>{};console.warn=()=>{};try{return fn();}finally{console.log=log;console.warn=warn;}}
async function main(){
 const front=await freePort(),backend=await freePort(),internal=await freePort();assert.equal(new Set([front,backend,internal]).size,3);
 const origin=`http://127.0.0.1:${front}`;
 const auth=quiet(()=>createAuth({dataDir:dir,publicOrigin:origin}));auth.db.close();
 const admin=seedAccount(dir,{username:'pair-admin',publicOrigin:origin});
 seedDeviceToken(dir,admin.id,{clientName:'Synthetic prior grant'});
 const db=new Database(path.join(dir,'cowork.db'));db.pragma('foreign_keys=ON');
 const counts=()=>({grants:db.prepare('SELECT count(*) AS n FROM device_grants').get().n,tokens:db.prepare('SELECT count(*) AS n FROM device_tokens').get().n,codes:db.prepare('SELECT count(*) AS n FROM device_authorizations').get().n});
 db.prepare("INSERT INTO settings(key,value) VALUES('feature:astraReview','true')").run();
 db.prepare("INSERT INTO settings(key,value) VALUES('feature:kiwix','true')").run();
 db.prepare(`INSERT INTO device_authorizations(device_code_hash,user_code_hash,client_name,ip,user_agent,created_at,expires_at,interval_ms,status) VALUES('prior-code','prior-user-code','Synthetic pending','127.0.0.1','Synthetic',?,?,5000,'pending')`).run(Date.now(),Date.now()+60000);
 const start=crypto.randomBytes(16).toString('hex'),token=crypto.randomBytes(32).toString('hex');
 const env={PATH:process.env.PATH,NODE_PATH:process.env.NODE_PATH,DAV_PARSE_WASM:process.env.DAV_PARSE_WASM,
  UI_DATA_DIR:dir,UI_HOST:'127.0.0.1',PUBLIC_ORIGIN:origin,TRUST_PROXY:'true',LEGACY_AUTH_COMPAT:'false',
  NOEVIA_START_ID:start,NOEVIA_PROJECT_STORE_PORT:String(internal),NOEVIA_PROJECT_STORE_TOKEN:token,
  INFERENCE_BASE_URL:'http://127.0.0.1:9',MODEL_MANAGER_KIND:'none',MODEL_MANAGER_BASE_URL:'http://127.0.0.1:9',MCP_SERVERS:'',MCP_SERVER_URL:'',MCP_INTERNAL_PORT:'',
 };
 const nativeEnv={...env,UI_PORT:String(front),NOEVIA_LEGACY_UPSTREAM:`http://127.0.0.1:${backend}`};
 let native=launch(binary,[],nativeEnv);
 try {
  await until(()=>call(front,'GET','/api/features',admin.headers(origin)),r=>r.status===503,10000,'native missing-context refusal');
  assert.deepEqual(counts(),{grants:1,tokens:2,codes:1});note('missing context refuses without erasing data');
  // Only the owned private-store port is reachable through fetch. Optional model/
  // Diary discovery cannot escape this synthetic qualification process.
  const preload=path.join(dir,'network-fence.cjs');fs.writeFileSync(preload,`const original=global.fetch;global.fetch=(input,options)=>{const u=new URL(typeof input==='string'?input:input.url);if(u.hostname!=='127.0.0.1'||u.port!==${JSON.stringify(String(internal))})return Promise.reject(Error('Synthetic qualification network fence'));return original(input,options);};`);
  let core=launch(process.execPath,['--max-old-space-size=4096','--require',preload,path.join(root,'server/index.cjs')],{...env,UI_PORT:String(backend)});
  try {
   await until(()=>call(backend,'GET','/api/ready'),r=>r.status===200&&r.json?.ready===true,15000,'real Core startup readiness');
   assert.deepEqual(counts(),{grants:0,tokens:0,codes:0});
   const revoked=db.prepare("SELECT actor_user_id,target_user_id,detail FROM audit_events WHERE action='device.revoke_all'").all();
   assert.equal(revoked.length,1);assert.equal(revoked[0].actor_user_id,null);assert.equal(revoked[0].target_user_id,admin.id);assert.equal(JSON.parse(revoked[0].detail).count,1);
   assert.equal(db.prepare("SELECT value FROM settings WHERE key='feature:plannerReview'").get().value,'true');
   assert.equal(db.prepare("SELECT value FROM settings WHERE key='feature:astraReview'").get().value,'true');note('native startup migration+OFF cleanup+audits precede actual Core ready/listener');
   const epoch=()=>db.prepare("SELECT value FROM settings WHERE key='native:feature-runtime:incarnation'").get().value;
   const firstEpoch=epoch();
   const flags=await call(front,'GET','/api/features',admin.headers(origin));assert.equal(flags.status,200);assert.equal(Object.keys(flags.json.flags).length,23);assert.equal(flags.json.flags.plannerReview,true);
   const member=seedAccount(dir,{username:'pair-member',role:'member',publicOrigin:origin});
   assert.equal((await call(front,'GET','/api/features',member.headers(origin))).status,200);
   assert.equal((await call(front,'GET','/api/admin/features',member.headers(origin))).status,403);
   for(const suffix of ['', '/nativeClientAuth','/%','/a/b'])for(const method of ['GET','PUT','POST','DELETE','HEAD','OPTIONS']) {
    const out=await call(backend,method,`/api/admin/features${suffix}`,{}, {enabled:true});assert.equal(out.status,503);if(method!=='HEAD')assert.equal(out.json.code,'RUST_FEATURES_OWNED');
   }
   for(const method of ['GET','PUT','POST','DELETE'])assert.equal((await call(backend,method,'/api/features')).json.code,'RUST_FEATURES_OWNED');note('all namespaces direct Node bypass always refuse, real public auth/23 flags succeed');
   const set=async(name,enabled)=>{const out=await call(front,'PUT',`/api/admin/features/${name}`,admin.headers(origin),{enabled});assert.equal(out.status,200);return out.json;};
   const changed=await set('kiwix',false);assert.equal(changed.pendingRestart,true);assert.equal((await call(front,'GET','/api/features',admin.headers(origin))).json.flags.kiwix,true);
   await stop(native);native=launch(binary,[],nativeEnv);
   await until(()=>call(front,'GET','/api/features',admin.headers(origin)),r=>r.status===200,20000,'same-Core/new-native incarnation recovery');
   assert.notEqual(epoch(),firstEpoch);
   const descriptions=await call(front,'GET','/api/admin/features',admin.headers(origin));const kiwix=descriptions.json.features.find(f=>f.name==='kiwix');assert.equal(kiwix.pendingRestart,true);assert.equal(kiwix.enabled,false);note('native process restart changes durable epoch and retains actual Node restart facts');
   async function issue(){
    const code=await call(front,'POST','/api/auth/device/code',{origin},{client_name:'Synthetic pair device'});assert.equal(code.status,200);
    const approved=await call(front,'POST','/api/auth/device/approve',admin.headers(origin),{user_code:code.json.user_code,approve:true});assert.equal(approved.status,200);
    const tokens=await call(front,'POST','/api/auth/device/token',{origin},{grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:code.json.device_code});assert.equal(tokens.status,200);return tokens.json;
   }
   await set('nativeClientAuth',true);const tokens=await issue();
   const refreshed=await call(front,'POST','/api/auth/device/token',{origin},{grant_type:'refresh_token',refresh_token:tokens.refresh_token});assert.equal(refreshed.status,200);
   assert.equal((await call(front,'GET','/api/auth/session',{authorization:`Bearer ${refreshed.json.access_token}`})).status,200);
   await set('nativeClientAuth',false);assert.deepEqual(counts(),{grants:0,tokens:0,codes:0});
   await set('nativeClientAuth',true);
   assert.equal((await call(front,'POST','/api/auth/device/token',{origin},{grant_type:'refresh_token',refresh_token:refreshed.json.refresh_token})).status,400);
   assert.deepEqual(counts(),{grants:0,tokens:0,codes:0});note('real device code/approval/redemption/refresh work; OFF cleanup and ON do not revive tokens');
   await issue();assert.equal((await call(front,'POST','/api/auth/device/code',{origin},{client_name:'Synthetic pending retained'})).status,200);
   const retained=counts();assert.deepEqual(retained,{grants:1,tokens:2,codes:1});
   await stop(core);
   await until(()=>call(front,'GET','/api/features',admin.headers(origin)),r=>r.status===503,18000,'15-second native lease expires after producer exit');
   assert.deepEqual(counts(),retained);
   assert.equal((await call(front,'POST','/api/auth/device/code',{origin},{client_name:'Must refuse'})).status,503);assert.deepEqual(counts(),retained);note('producer lease expiry refuses feature/device admission without erasing retained credentials');
   core=launch(process.execPath,['--max-old-space-size=4096','--require',preload,path.join(root,'server/index.cjs')],{...env,UI_PORT:String(backend)});
   await until(()=>call(backend,'GET','/api/ready'),r=>r.status===200&&r.json?.ready,15000,'fresh actual Node boot after old lease expired');
   const rebooted=await call(front,'GET','/api/admin/features',admin.headers(origin));assert.equal(rebooted.status,200);assert.equal(rebooted.json.features.find(f=>f.name==='kiwix').pendingRestart,false);assert.deepEqual(counts(),retained);note('fresh Node boot captures new construction values; ON startup keeps existing grants');
  } finally {await stop(core);}
 } finally {await stop(native);db.close();}
 report.success=true;
}
main().catch(error=>{console.error(JSON.stringify({success:false,completedChecks:report.checks,error:String(error.message),scope:report.scope}));process.exitCode=1;}).finally(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null)await stop(child);fs.rmSync(dir,{recursive:true,force:true});if(report.success)console.log(JSON.stringify(report));});
