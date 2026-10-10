'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const phase='node --test --test-concurrency=1 tests/server/code-actions-performance.qualification.cjs';
test('core runner and shipped runtime both require isolated timing qualification',()=>{
 const workflow=fs.readFileSync(path.join(__dirname,'../../.github/workflows/ci.yml'),'utf8');
 assert.equal(workflow.split(phase).length-1,2,'both required qualification invocations must remain');
 const source=fs.readFileSync(path.join(__dirname,'../../tests/server/code-actions-performance.qualification.cjs'),'utf8');
 assert.ok(!/skip\s*:|skipWasm/.test(source),'qualification cannot skip');
 assert.match(source,/required qualification WASM missing/);
 assert.match(source,/n <= 1000 \? 10 : 50/);assert.match(source,/ms < 50/);
});
