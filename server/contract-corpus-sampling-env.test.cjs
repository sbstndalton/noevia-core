'use strict';
// Execute the actual corpus launcher; capture its spawn boundary, not a copied environment rule.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const mocks=require('../tools/contract-corpus/mocks.cjs');
const {createSamplingSettingsRoutes,enabledFrom}=require('./routes/sampling-settings.cjs');
async function childEnv(overrides) {
  let captured;
  const fakeMocks={inference:{address:()=>({port:19001})},diary:{address:()=>({port:19002})},close:()=>{}};
  const child=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{};
  await vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../tools/contract-corpus/serve.cjs'),'utf8'),{
    require:name=>name==='node:child_process'?{spawn:(_bin,_args,options)=>{captured=options.env;return child;}}:name==='./mocks.cjs'?{...mocks,startMocks:async()=>fakeMocks}:require(name),
    process:{env:{UI_DATA_DIR:'/synthetic/corpus',UI_PORT:'18021',PRIVATE_TEST_VALUE:'must-not-inherit',...overrides},execPath:process.execPath,on:()=>{},exit:()=>{throw Error('unexpected launcher exit');}},console,
  },{filename:'tools/contract-corpus/serve.cjs'});
  assert.ok(captured);assert.equal(captured.PRIVATE_TEST_VALUE,undefined);return captured;
}
test('actual corpus child keeps confirmed sampling refusal and drops unconfirmed ownership',async()=>{
  const auth={NOEVIA_RUST_AUTH:'1',NOEVIA_RUST_AUTH_CONFIRMED:'1'};
  for(const [flags,expected]of [
    [{NOEVIA_RUST_SAMPLING_SETTINGS:'1',NOEVIA_RUST_SAMPLING_SETTINGS_CONFIRMED:'1'},true],
    [{NOEVIA_RUST_SAMPLING_SETTINGS:'1'},false],
    [{NOEVIA_RUST_SAMPLING_SETTINGS:'0',NOEVIA_RUST_SAMPLING_SETTINGS_CONFIRMED:'1'},false],
    [{NOEVIA_RUST_SAMPLING_SETTINGS_CONFIRMED:'1'},false],
  ]) {
    const env=await childEnv({...auth,...flags});assert.equal(enabledFrom(env),expected);
    if(!expected)continue;
    let sent;
    const routes=createSamplingSettingsRoutes({env,json:(_res,status,body)=>{sent={status,body};},readBody:()=>{throw Error('confirmed Node must not parse');},authService:{db:{prepare:()=>{throw Error('confirmed Node must not decide/read/write');}},audit:()=>{throw Error('confirmed Node must not audit');}}});
    assert.equal(await routes({method:'GET'},{},{path:'/api/sampling-settings',authn:{user:{id:'synthetic',role:'member'}}}),true);
    assert.deepEqual(sent,{status:503,body:{error:'Sampling settings are owned by the Rust front.'}});
  }
});
