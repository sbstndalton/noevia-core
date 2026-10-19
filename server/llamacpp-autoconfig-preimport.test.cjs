
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
function preimportScenario() {
  const path = require('node:path'), root = process.argv[1], mode = process.argv[2];
  const oracle = require(process.env.NOEVIA_FROZEN_CORE_ROOT
    ? path.join(process.env.NOEVIA_FROZEN_CORE_ROOT,'server/llamacpp-autoconfig.cjs')
    : path.join(root,'../tests/reference/llamacpp-autoconfig-js.cjs'));
  const original = Object.getOwnPropertyDescriptor(Array.prototype,'every');
  let trace = [];
  const method = function every() { trace.push('call every'); if(mode==='throw') throw new Error('custom every stop'); return false; };
  method.toString = () => 'function every() { [native code] }';
  if(mode==='accessor') Object.defineProperty(Array.prototype,'every',{configurable:true,get(){trace.push('get every');return method;}});
  else if(mode==='proxy') Object.defineProperty(Array.prototype,'every',{configurable:true,writable:true,value:new Proxy(method,{apply(target,receiver,args){trace.push('proxy apply');return Reflect.apply(target,receiver,args);}})});
  else Object.defineProperty(Array.prototype,'every',{configurable:true,writable:true,value:method});
  let result;
  try {
    const candidate = require(path.join(root,'llamacpp-autoconfig.cjs'));
    const importTrace = trace.slice();
    const meta = () => ({blockCount:3,headCount:32,embeddingLength:4096,headCountKv:8,slidingWindow:64,slidingWindowPattern:[true,false,true]});
    const run = api => { trace=[]; try{return {value:api.kvCacheBytes(meta(),4096),trace};}catch(error){return {error:{name:error.name,message:error.message},trace};} };
    result = {importTrace,old:run(oracle),candidate:run(candidate)};
  } finally {Object.defineProperty(Array.prototype,'every',original);}
  process.stdout.write(JSON.stringify(result));
}
test('pre-import collection overrides never masquerade as a native every method', () => {
  for(const mode of ['custom','accessor','proxy','throw']) {
    const script = '(' + preimportScenario.toString() + ')()';
    const result = JSON.parse(execFileSync(process.execPath,['-e',script,__dirname,mode],{encoding:'utf8'}));
    assert.deepEqual(result.importTrace,[],mode+': eligibility must not invoke an override');
    assert.deepEqual(result.candidate,result.old,mode);
    assert.ok(result.old.trace.length>0,mode);
  }
});
