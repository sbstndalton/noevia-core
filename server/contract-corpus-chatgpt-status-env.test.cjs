'use strict';
// noevia#1373: execute the actual corpus launcher and capture its spawn boundary, as the storage
// test does: Node behind a replayed front refuses GET /api/providers/chatgpt only with the front's
// confirmation, so a clean replay through the front is the front's own answer.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const mocks=require('../tools/contract-corpus/mocks.cjs');
const {rustChatgptStatusOwned}=require('./features.cjs');
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
test('actual corpus child keeps the confirmed ChatGPT status refusal and drops unconfirmed ownership (#1373)',async()=>{
  const auth={NOEVIA_RUST_AUTH:'1',NOEVIA_RUST_AUTH_CONFIRMED:'1'};
  for(const [flags,expected]of [
    [{...auth,NOEVIA_RUST_CHATGPT_STATUS:'1',NOEVIA_RUST_CHATGPT_STATUS_CONFIRMED:'1'},true],
    [{...auth,NOEVIA_RUST_CHATGPT_STATUS:'1'},false],
    [{...auth,NOEVIA_RUST_CHATGPT_STATUS:'0',NOEVIA_RUST_CHATGPT_STATUS_CONFIRMED:'1'},false],
    [{...auth,NOEVIA_RUST_CHATGPT_STATUS_CONFIRMED:'1'},false],
    [{NOEVIA_RUST_CHATGPT_STATUS:'1',NOEVIA_RUST_CHATGPT_STATUS_CONFIRMED:'1'},false],
  ]) {
    const env=await childEnv(flags);
    assert.equal(rustChatgptStatusOwned(env),expected,JSON.stringify(flags));
    if(!flags.NOEVIA_RUST_CHATGPT_STATUS) assert.equal(env.NOEVIA_RUST_CHATGPT_STATUS_CONFIRMED,undefined,'an inherited confirmation never passes alone');
  }
});
