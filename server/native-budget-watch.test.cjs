'use strict';
// #697 native move: the memory watchdog is the Rust front's (rust-budget-watch.cjs). This process does not
// start it, exports the marker the release and the supervisor pair on, and answers the front's loopback
// calls for the maintenance state and the quarantine. Synthetic manager and requests only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createModelManager } = require('./model-manager.cjs');
const { BUDGET_WATCH_OWNER, PATH, createBudgetWatchBridge } = require('./rust-budget-watch.cjs');

const secret = 'synthetic-front-secret';
const trusted = (body, extra = {}) => ({ url: PATH, method: 'POST', headers: { 'x-noevia-store-token': secret, ...extra }, socket: { remoteAddress: '127.0.0.1' }, body });

function bridge(manager, logs = []) {
  const sent = [];
  const handle = createBudgetWatchBridge({ secret, modelManager: manager, json: (_res, status, body) => sent.push({ status, body }), readJson: async (req) => { if (req.body === 'bad') throw Object.assign(Error('invalid JSON'), { status: 400 }); return req.body; }, log: (m) => logs.push(m) });
  return { handle, sent };
}

function manager() {
  // A router that lists one model and loads anything: no engine involved.
  return createModelManager({ kind: 'llamacpp', baseUrl: 'http://synthetic', inferenceBudget: { budgetGib: () => 12 }, gate: require('./fixtures/fake-inference-gate.cjs').fakeGate(),
    fetchJson: async (url) => ({ ok: true, status: 200, body: new URL(url).pathname === '/models' ? { data: [{ id: 'chat', status: { value: 'unloaded' } }] } : { success: true } }) });
}

test('#697 Core exports the budget watch marker the release pairs on', () => {
  assert.equal(BUDGET_WATCH_OWNER, 'noevia-budget-watch-rust/1');
  assert.equal(PATH, '/internal/budget-watch');
});

test('#697 index.cjs no longer creates or starts the watchdog, and wires the bridge', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.equal(/createInferenceBudgetWatch\s*\(/.test(source), false);
  assert.equal(/inferenceBudgetWatch/.test(source), false);
  assert.equal(/require\(\s*['"]\.\/inference-budget-watch\.cjs['"]\s*\)/.test(source), false);
  assert.match(source, /require\('\.\/rust-budget-watch\.cjs'\)\.createBudgetWatchBridge\(/);
  assert.match(source, /if \(await budgetWatchBridge\(req, res\)\) return;/);
});

test('#697 the held fact is the manager\'s maintenance state', async () => {
  const m = manager();
  const { handle, sent } = bridge(m);
  assert.equal(await handle(trusted({ want: 'held' }), {}), true);
  const release = await m.holdMaintenance('synthetic sweep');
  assert.equal(await handle(trusted({ want: 'held' }), {}), true);
  release();
  assert.equal(await handle(trusted({ want: 'held' }), {}), true);
  assert.deepEqual(sent, [{ status: 200, body: { held: false } }, { status: 200, body: { held: true } }, { status: 200, body: { held: false } }]);
});

test('#697 the quarantine the front hands over refuses the next load until the budget changes', async () => {
  let budget = 12;
  const m = createModelManager({ kind: 'llamacpp', baseUrl: 'http://synthetic', inferenceBudget: { budgetGib: () => budget }, gate: require('./fixtures/fake-inference-gate.cjs').fakeGate(),
    fetchJson: async (url) => ({ ok: true, status: 200, body: new URL(url).pathname === '/models' ? { data: [] } : { success: true } }) });
  const { handle, sent } = bridge(m);
  assert.equal(await handle(trusted({ want: 'quarantine', model: 'chat', budgetGib: 12 }), {}), true);
  assert.deepEqual(sent.pop(), { status: 200, body: { ok: true } });
  const refused = await m.loadRefusal('chat');
  assert.equal(refused.code, 'inference_budget_unloaded');
  assert.equal(refused.budgetGib, 12);
  assert.equal(await m.loadRefusal('other'), null, 'another model is unaffected');
  budget = 16;
  assert.equal(await m.loadRefusal('chat'), null, 'a new budget releases it');
});

test('#697 the bridge answers only the front, only POST, only known facts', async () => {
  const m = manager();
  const { handle, sent } = bridge(m);
  assert.equal(await handle({ url: '/internal/other', method: 'POST', headers: {}, socket: {} }, {}), false);
  await handle({ ...trusted({ want: 'held' }), headers: {} }, {});
  await handle({ ...trusted({ want: 'held' }), socket: { remoteAddress: '10.0.0.5' } }, {});
  await handle(trusted({ want: 'held' }, { 'x-forwarded-for': '1.2.3.4' }), {});
  await handle({ ...trusted({ want: 'held' }), method: 'GET' }, {});
  assert.deepEqual(sent.splice(0), Array(4).fill({ status: 404, body: { error: 'Not found' } }));
  await handle(trusted('bad'), {});
  await handle(trusted({ want: 'budget' }), {});
  await handle(trusted(null), {});
  for (const bad of [{ model: 5, budgetGib: 12 }, { model: '', budgetGib: 12 }, { model: 'x'.repeat(513), budgetGib: 12 }, { model: 'chat', budgetGib: 0 }, { model: 'chat', budgetGib: '12' }, { model: 'chat', budgetGib: Infinity }]) {
    await handle(trusted({ want: 'quarantine', ...bad }), {});
  }
  assert.deepEqual(sent.map((s) => s.status), [400, 400, 400, 400, 400, 400, 400, 400, 400]);
});

test('#697 a manager without the quarantine answers ok:false, and a failing one 503 without its message', async () => {
  const logs = [];
  const { handle, sent } = bridge({ maintenanceHeld: () => { throw Object.assign(Error('secret detail'), { code: 'EBROKEN' }); } }, logs);
  await handle(trusted({ want: 'quarantine', model: 'chat', budgetGib: 12 }), {});
  await handle(trusted({ want: 'held' }), {});
  assert.deepEqual(sent, [{ status: 200, body: { ok: false } }, { status: 503, body: { error: 'The maintenance state is unavailable.' } }]);
  assert.deepEqual(logs, ['[inference-budget] held fact failed: EBROKEN']);
  const none = bridge({});
  await none.handle(trusted({ want: 'held' }), {});
  assert.deepEqual(none.sent, [{ status: 200, body: { held: false } }], 'no maintenance gate is never held (Node: !undefined)');
});
