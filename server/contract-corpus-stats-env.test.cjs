'use strict';
// #1650: execute the actual corpus launcher and capture its spawn boundary, as the sampling test
// does: Node behind a replayed front refuses GET /api/stats only with the front's confirmation.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const mocks=require('../tools/contract-corpus/mocks.cjs');
const {createModelRoutes,statsRustOwned}=require('./routes/models.cjs');
async function childEnv(overrides) {
  let captured;
  const fakeMocks={inference:{address:()=>({port:19001})},diary:{address:()=>({port:19002})},close:()=>{}};
  const child=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
  await vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../tools/contract-corpus/serve.cjs'),'utf8'),{
    require:name=>name==='node:child_process'?{spawn:(_bin,_args,options)=>{captured=options.env;return child;}}:name==='./mocks.cjs'?{...mocks,startMocks:async()=>fakeMocks}:require(name),
    process:{argv:[process.execPath,path.join(__dirname,'../tools/contract-corpus/serve.cjs')],env:{UI_DATA_DIR:'/synthetic/corpus',UI_PORT:'18021',PRIVATE_TEST_VALUE:'must-not-inherit',...overrides},execPath:process.execPath,on:()=>{},exit:()=>{throw Error('unexpected launcher exit');}},console,
  },{filename:'tools/contract-corpus/serve.cjs'});
  assert.ok(captured);assert.equal(captured.PRIVATE_TEST_VALUE,undefined);return captured;
}
test('actual corpus child keeps the confirmed stats refusal and drops unconfirmed ownership',async()=>{
  const auth={NOEVIA_RUST_AUTH:'1',NOEVIA_RUST_AUTH_CONFIRMED:'1'};
  for(const [flags,expected]of [
    [{NOEVIA_RUST_STATS:'1',NOEVIA_RUST_STATS_CONFIRMED:'1'},true],
    [{NOEVIA_RUST_STATS:'1'},false],
    [{NOEVIA_RUST_STATS:'0',NOEVIA_RUST_STATS_CONFIRMED:'1'},false],
    [{NOEVIA_RUST_STATS_CONFIRMED:'1'},false],
  ]) {
    const env=await childEnv({...auth,...flags});
    assert.equal(statsRustOwned(env),expected,JSON.stringify(flags));
    // The corpus engine stays the `none` kind whatever the front is told.
    assert.equal(env.MODEL_MANAGER_KIND,'none');
    if(!expected)continue;
    let sent;
    const engine=()=>{throw Error('confirmed Node must not read the engine');};
    const routes=createModelRoutes({json:(_res,status,body)=>{sent={status,body};},readBody:async()=>'',readJson:async()=>({}),fetchJson:engine,env,
      modelManager:{enabled:true,kind:'llamacpp',stats:engine,systemStats:engine,health:engine,metrics:engine,listModels:engine},
      getProvider:()=>null,providerHeaders:()=>({}),DEFAULT_PROVIDER_ID:'default',createVisionProbe:()=>async()=>({}),reportedTokenRate:()=>null,missingRoles:()=>[],
      currentWorkspace:()=>{throw Error('confirmed Node must not load the workspace');},service:{}});
    assert.equal(await routes({method:'GET'},{},{path:'/api/stats',authn:{user:{id:'synthetic',role:'member'}},url:new URL('http://localhost/api/stats')}),true);
    assert.deepEqual(sent,{status:503,body:{error:'Engine statistics are owned by the Rust front.'}});
  }
});
