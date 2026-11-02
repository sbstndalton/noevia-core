'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createAutotuneUntunedFacts}=require('./rust-autotune-untuned-facts.cjs');
const {refuseOwned}=require('./rust-autotune-untuned.cjs');
const secret='synthetic-only-'.repeat(4);
async function call({headers={},peer='127.0.0.1',body={scan:false},tuner=null}={}){
 let sent;const route=createAutotuneUntunedFacts({secret,json:(_r,status,value)=>{sent={status,value};},readJson:async()=>body,autotune:()=>tuner});
 await route({method:'POST',url:'/internal/autotune-untuned/facts',headers:{'x-noevia-store-token':secret,...headers},socket:{remoteAddress:peer}},{});return sent;
}
test('private raw-facts bridge denies remote/forged/forwarded requests before owner work',async()=>{
 let calls=0;const tuner={scanFacts:()=>{calls++;throw Error('must not call');}};
 for(const options of [{peer:'192.0.2.1'},{headers:{'x-noevia-store-token':'wrong'}},{headers:{'x-forwarded-for':''}},{headers:{'x-noevia-client-ip':''}}])assert.equal((await call({...options,tuner})).status,404);
 assert.equal(calls,0);assert.equal((await call({body:{scan:true,model:'other'},tuner})).status,400);assert.equal(calls,0);
});
test('availability-only read never invokes metadata collector and missing actor is explicit',async()=>{
 let calls=0;const tuner={scanFacts:async()=>{calls++;return{version:1,rows:[]};}};
 assert.deepEqual(await call(),{status:200,value:{available:false}});
 assert.deepEqual(await call({tuner}),{status:200,value:{available:true}});assert.equal(calls,0);
 assert.deepEqual(await call({tuner,body:{scan:true}}),{status:200,value:{available:true,version:1,rows:[]}});assert.equal(calls,1);
});
test('only closed producer failures cross the private boundary; freeform error text is discarded',async()=>{
 for(const [error,failure] of [[Object.assign(Error('http://private/?token=synthetic'),{publicMessage:'The model server is not responding.'}),'router'],[Object.assign(Error('private'),{publicMessage:'Model identity could not be read.'}),'identity'],[Error('http://private/?token=synthetic'),'unavailable']]){
 const r=await call({body:{scan:true},tuner:{scanFacts:async()=>{throw error;}}});assert.deepEqual(r,{status:503,value:{failure}});assert.doesNotMatch(JSON.stringify(r),/private|token|synthetic/);
 }
});
test('all public methods are refused directly by Node without parsing body or choosing a model',()=>{
 for(const method of ['GET','POST','HEAD','DELETE']){let sent;assert.equal(refuseOwned({method,url:'/api/models/autotune/untuned?model=other'}, {},{parseRequestUrl:req=>new URL(req.url,'http://synthetic'),json:(_r,status,body)=>{sent={status,body};}}),true);assert.equal(sent.status,503);assert.equal(sent.body.code,'RUST_AUTOTUNE_UNTUNED_OWNED');}
});
const wasm=require('./dav-parse-wasm.cjs'),wasmFile=process.env.DAV_PARSE_WASM||wasm.DEFAULT_WASM;
const skipWasm=!fs.existsSync(wasmFile)&&process.env.DAV_PARSE_WASM_REQUIRED!=='1'&&'new pinned dav-parse.wasm not built';
test('actual shared WASM policy makes Node collector read identities only for eligible rows',{skip:skipWasm},async t=>{
 const fixtures=JSON.parse(fs.readFileSync(path.join(__dirname,'fixtures/autotune-untuned-node.json'),'utf8'));
 const fixture=fixtures.find(c=>c.name==='ordered-scan'),rows=fixture.input.rows,reads=[];
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'untuned-facts-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const stateFile=path.join(dir,'state.json');fs.writeFileSync(stateFile,JSON.stringify({history:Object.fromEntries(rows.filter(r=>r.latest).map(r=>[r.id,[r.latest]])),settings:Object.fromEntries(rows.filter(r=>r.allowQ5Kv).map(r=>[r.id,{allowQ5Kv:true}]))}));
 const system=require('./model-system.cjs');system.rememberSectionRoles(JSON.stringify({system:'system-routing'}));t.after(()=>system.rememberSectionRoles(''));
 const {createFullAutotuner}=require('./llamacpp-full-autotune.cjs');
 const tuner=createFullAutotuner({stateFile,servingChecks:{},planner:{},loadAdvisor:{},longProfiles:{pairsOf:()=>rows.filter(r=>r.long).map(r=>({long:r.id}))},rawModels:async()=>({ok:true,body:{data:rows.map(r=>({id:r.id,status:{args:r.args}}))}}),presets:{get:id=>rows.find(r=>r.id===id).profile},fileMissing:r=>rows.find(x=>x.id===r.id).missing,identityFor:async id=>{reads.push(id);const identity=rows.find(r=>r.id===id).identity;assert.notEqual(identity,null,'skipped identity must not be read');return identity;}});
 const facts=await tuner.scanFacts();assert.deepEqual(reads,fixture.identityReads);assert.deepEqual(wasm.autotuneScan({op:'scan',...facts}),fixture.expected);
 const controller=new AbortController();controller.abort();reads.length=0;await assert.rejects(tuner.scanFacts({signal:controller.signal}));assert.deepEqual(reads,[]);
});
