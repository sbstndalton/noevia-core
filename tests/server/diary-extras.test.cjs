'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript');
const server = require('../../server/diary-extras.cjs');
const source = fs.readFileSync(path.join(__dirname, '../../src/diary-extras.ts'), 'utf8').replace(/^import .*;\n/m, '').replace(/export /g, '');
const js = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function runner(streamChat) { const ctx = {streamChat}; vm.createContext(ctx); vm.runInContext(js, ctx); return ctx.prepareDiaryExtras; }
test('extras off never starts an optional inference or tool exchange', async () => {
  assert.equal(await runner(() => { throw Error('must not run'); })(false, 'private diary', 'fixture', () => {}), '');
  for (const enabled of [undefined, false, 'true', 1]) assert.equal(server.reference({ extrasEnabled: enabled, extraContext: 'untrusted' }), '');
});
test('extras keep approvals/results paired and send only the current question', async () => {
  const seen = []; let request;
  const run = runner(async function* (body) { request = body; yield {type:'tool',index:0,name:'write',args:'{}'}; yield {type:'tool_pending',index:0,id:'approval-fixture'}; yield {type:'tool_result',index:0,text:'ERROR: the user denied'}; yield {type:'delta',text:'Write was denied.'}; yield {type:'done'}; });
  assert.equal(await run(true,'synthetic question','fixture-session',e=>seen.push(e)), 'Write was denied.');
  assert.equal(request.extrasEnabled, true); assert.equal(request.history.length, 0); assert.equal(request.projectId, undefined);
  assert.deepEqual(seen.filter(e=>e.index===0).map(e=>e.type), ['tool','tool_pending','tool_result']);
});
test('failed or interrupted optional context rejects before capture; reference is bounded', async () => {
  await assert.rejects(runner(async function* () { yield {type:'error',text:'unavailable'}; })(true,'q','s',()=>{}), /unavailable/);
  await assert.rejects(runner(async function* () { yield {type:'delta',text:'partial'}; })(true,'q','s',()=>{}), /interrupted/);
  const framed=server.reference({extrasEnabled:true,extraContext:'x'.repeat(20000)});assert.equal(framed.length,12000);assert.match(framed,/^<untrusted kind="Diary attachment excerpts">[\s\S]*<\/untrusted>$/);
});
test('internal contexts have no optional tools by default and free chats remain distinct', () => {
  assert.deepEqual(server.newProject().toolboxes, []);
  assert.notEqual(server.chatProjectId('c-one'),server.chatProjectId('c-two'));
  assert.equal(server.chatProjectId('../other'),null);
  assert.equal(server.internalProject(server.newProject()),true);
  assert.equal(server.internalProject({id:'normal-project'}),false);
});
