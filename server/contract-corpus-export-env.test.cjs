'use strict';
// #1315: execute the actual corpus launcher and capture its spawn boundary, as the stats test does:
// Node behind a replayed front refuses the export GET only with the front's confirmation.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const mocks=require('../tools/contract-corpus/mocks.cjs');
const {exportRustOwned}=require('./routes/export.cjs');
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
test('actual corpus child keeps the confirmed export refusal and drops unconfirmed ownership',async()=>{
  const m4={NOEVIA_RUST_AUTH:'1',NOEVIA_RUST_AUTH_CONFIRMED:'1',NOEVIA_RUST_PROJECTS:'1',NOEVIA_RUST_PROJECTS_CONFIRMED:'1',NOEVIA_RUST_FREE_CHATS_CONFIRMED:'1'};
  for(const [flags,expected]of [
    [{...m4,NOEVIA_RUST_EXPORT:'1',NOEVIA_RUST_EXPORT_CONFIRMED:'1'},true],
    [{...m4,NOEVIA_RUST_EXPORT:'1'},false],
    [{...m4,NOEVIA_RUST_EXPORT:'0',NOEVIA_RUST_EXPORT_CONFIRMED:'1'},false],
    [{...m4,NOEVIA_RUST_EXPORT_CONFIRMED:'1'},false],
    [{...m4,NOEVIA_RUST_FREE_CHATS_CONFIRMED:'',NOEVIA_RUST_EXPORT:'1',NOEVIA_RUST_EXPORT_CONFIRMED:'1'},false],
  ]) {
    const env=await childEnv(flags);
    assert.equal(exportRustOwned(env),expected,JSON.stringify(flags));
  }
});
