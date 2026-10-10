'use strict';
// Synthetic historical #1212 control; matching old oracle ABI, never live state.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const old=path.resolve(process.argv[2]||''),wasm=path.resolve(process.argv[3]||'');
assert.equal(crypto.createHash('sha256').update(fs.readFileSync(wasm)).digest('hex'),'68cf8a00c86f436fd5c5a5bbcc22ae3f9071c77b100e2b584ef19594ed488a9d','immutable pre-#1212 module');
const small=cp.spawnSync(process.execPath,['-e',`const assert=require('node:assert/strict'),w=require(${JSON.stringify(path.join(old,'server/dav-parse-wasm.cjs'))}),ca=require(${JSON.stringify(path.join(old,'server/code-actions.cjs'))});const c={kind:'execute',rawInput:{command:'echo synthetic'},locations:[]};assert.equal(w.codeActionsClassify(ca.classifyInput(c)).text,JSON.stringify(ca.classifyJs(c)));console.log('small_valid_call=passed');`],{env:{...process.env,DAV_PARSE_WASM:wasm},encoding:'utf8',timeout:2000});
assert.equal(small.status,0,small.stderr);assert.match(small.stdout,/small_valid_call=passed/);
// Copy the exact qualification into an isolated old oracle tree to retain its matching ABI.
const target=path.join(old,'tests/server/code-actions-performance.qualification.cjs');
fs.copyFileSync(path.join(__dirname,'../../tests/server/code-actions-performance.qualification.cjs'),target);
const bad=cp.spawnSync(process.execPath,['--test','--test-concurrency=1',target],{env:{...process.env,DAV_PARSE_WASM:wasm,DAV_PARSE_WASM_REQUIRED:'1'},encoding:'utf8',timeout:2000,killSignal:'SIGKILL'});
assert.match((bad.stdout||'')+(bad.stderr||''),/qualification_case=chain:40/,'bad chain reached after valid module call');
assert.ok(bad.error?.code==='ETIMEDOUT'||(bad.status!==0&&/40 levels:.*ms/.test((bad.stdout||'')+(bad.stderr||''))),'must fail actual chain qualification, not unrelated startup');
console.log('small_valid_call=passed; historical_chain_qualification=rejected');
