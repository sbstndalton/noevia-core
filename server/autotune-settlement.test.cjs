'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
for (const stage of ['invalidation', 'reload']) test(`cancel during ${stage} waits for effect and prevents additional reload`, async () => {
  const src = fs.readFileSync(require.resolve('./llamacpp-full-autotune.cjs'), 'utf8');
  const code = src.slice(src.indexOf('  async function flushReload('), src.indexOf('  async function runPhase('));
  let enter, release, calls = 0, cancelled = false, terminal = false;
  const entered = new Promise(r => { enter = r; }); const blocked = new Promise(r => { release = r; });
  const context = { ready: async () => {}, state: { job: { _reloadPending: true } }, clearTimeout, reloadTimer: null,
    invalidateBaseline: async () => { if (stage === 'invalidation') { enter(); await blocked; terminal = true; } return true; },
    ownedRequest: async () => { calls++; if (stage === 'reload') { enter(); await blocked; terminal = true; } return { ok: true }; },
    scheduleReload: () => {}, publicFail: Error, note: () => {} };
  vm.createContext(context); vm.runInContext(code + ';this.flushReload=flushReload;', context);
  const pending = context.flushReload(null, () => { if (cancelled) throw Error('cancelled'); });
  await entered; cancelled = true; assert.equal(terminal, false); release();
  await assert.rejects(pending, /cancelled/); assert.equal(terminal, true);
  assert.equal(calls, stage === 'invalidation' ? 0 : 1);
});

test('delayed launch validates current authority generation before any runner effect', async () => {
  const src = fs.readFileSync(require.resolve('./llamacpp-full-autotune.cjs'), 'utf8');
  const start = src.search(/  (?:async )?function launch\(/);
  const end = src.indexOf('  return { start, abort, launch', start);
  let effects = 0;
  const context = { runActive: false, starting: false, fenced: null, state: { history: {} },
    stateClient: { sync: async () => ({ epoch: 9, jobRev: 9, state: { job: { id: 'new', status: 'running' } } }), setRun: () => {} },
    launchRun: () => { effects++; } };
  vm.createContext(context); vm.runInContext(src.slice(start, end) + ';this.launch=launch;', context);
  const answer = await context.launch({ epoch: 8, jobRev: 8, job: { id: 'old', status: 'running' }, history: {} });
  assert.equal(answer.launched, false); assert.equal(effects, 0);
});
