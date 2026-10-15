'use strict';
// noevia#1368: execute the actual corpus launcher and capture its spawn boundary, as the stats test
// does: Node behind a replayed front refuses GET /api/integrations/storage only with the front's
// confirmation, so a clean replay through the front is the front's own answer.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{EventEmitter}=require('node:events');
const mocks=require('../tools/contract-corpus/mocks.cjs');
const {rustStorageReadsOwned,refuseRustStorageRead,RUST_STORAGE_READS_REFUSAL}=require('./features.cjs');
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
test('actual corpus child keeps the confirmed storage metadata refusal and drops unconfirmed ownership',async()=>{
  const auth={NOEVIA_RUST_AUTH:'1',NOEVIA_RUST_AUTH_CONFIRMED:'1'};
  for(const [flags,expected]of [
    [{...auth,NOEVIA_RUST_STORAGE_READS:'1',NOEVIA_RUST_STORAGE_READS_CONFIRMED:'1'},true],
    [{...auth,NOEVIA_RUST_STORAGE_READS:'1'},false],
    [{...auth,NOEVIA_RUST_STORAGE_READS:'0',NOEVIA_RUST_STORAGE_READS_CONFIRMED:'1'},false],
    [{...auth,NOEVIA_RUST_STORAGE_READS_CONFIRMED:'1'},false],
    [{NOEVIA_RUST_STORAGE_READS:'1',NOEVIA_RUST_STORAGE_READS_CONFIRMED:'1'},false],
  ]) {
    const env=await childEnv(flags);
    assert.equal(rustStorageReadsOwned(env),expected,JSON.stringify(flags));
    let sent=null;
    const res={setHeader:()=>{}};
    const handled=refuseRustStorageRead({method:'GET',url:'/api/integrations/storage',headers:{host:'127.0.0.1:19021'}},res,{
      owned:rustStorageReadsOwned(env),parseRequestUrl:(req,base)=>new URL(req.url,base||'http://localhost'),badRequestUrl:()=>{throw Error('unexpected bad URL');},json:(_res,status,body)=>{sent={status,body};},
    });
    assert.equal(handled,expected,JSON.stringify(flags));
    assert.deepEqual(sent,expected?{status:503,body:RUST_STORAGE_READS_REFUSAL}:null);
  }
});

test('actual corpus child keeps the confirmed storage browse refusal and drops unconfirmed ownership (#1368)',async()=>{
  const {rustStorageBrowseOwned}=require('./features.cjs');
  const auth={NOEVIA_RUST_AUTH:'1',NOEVIA_RUST_AUTH_CONFIRMED:'1'};
  for(const [flags,expected]of [
    [{...auth,NOEVIA_RUST_STORAGE_BROWSE:'1',NOEVIA_RUST_STORAGE_BROWSE_CONFIRMED:'1'},true],
    [{...auth,NOEVIA_RUST_STORAGE_BROWSE:'1'},false],
    [{...auth,NOEVIA_RUST_STORAGE_BROWSE_CONFIRMED:'1'},false],
    [{NOEVIA_RUST_STORAGE_BROWSE:'1',NOEVIA_RUST_STORAGE_BROWSE_CONFIRMED:'1'},false],
  ]) {
    const env=await childEnv(flags);
    assert.equal(rustStorageBrowseOwned(env),expected,JSON.stringify(flags));
  }
});
