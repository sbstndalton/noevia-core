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
  assert.equal(BUDGET_WATCH_OWNER, 'noevia-budget-watch-rust/3');
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

test('#697 a durable pre-unload fence refuses Core admissions through IPC loss and process restart', async (t) => {
  const os = require('node:os');
  const { createHash } = require('node:crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-fence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ini = path.join(dir, 'models.ini');
  fs.writeFileSync(ini, '[chat]\nctx-size = 8192\n');
  let budget = 12;
  const opts = { kind: 'llamacpp', baseUrl: 'http://synthetic', presetPath: ini, budgetWatchDir: dir, inferenceBudget: { budgetGib: () => budget }, gate: require('./fixtures/fake-inference-gate.cjs').fakeGate(), fetchJson: async () => ({ ok: true, status: 200, body: { data: [] } }) };
  const m = createModelManager(opts);
  const revision = m.presetFacts('chat').revision;
  const file = path.join(dir, createHash('sha256').update('chat').digest('hex') + '.json');
  fs.writeFileSync(file, JSON.stringify({ model: 'chat', revision, budgetGib: 12, at: 1000, recorded: false }));
  for (const live of [m, createModelManager(opts)]) {
    assert.equal((await live.loadRefusal('chat')).code, 'inference_budget_unloaded');
    await assert.rejects(live.prepareLoad('chat'), /stays unloaded/);
  }
  const { handle, sent } = bridge(m);
  // Lost acknowledgements are retried idempotently against exactly the old revision/budget.
  for (let i = 0; i < 2; i++) await handle(trusted({ want: 'quarantine', model: 'chat', budgetGib: 12, revision }), {});
  assert.deepEqual(sent, [{ status: 200, body: { ok: true, invalidated: false } }, { status: 200, body: { ok: true, invalidated: false } }]);
  assert.equal((await m.loadRefusal('chat')).code, 'inference_budget_unloaded');
  budget = 16;
  assert.equal(await m.loadRefusal('chat'), null);
  await handle(trusted({ want: 'quarantine', model: 'chat', budgetGib: 12, revision }), {});
  assert.deepEqual(sent.pop().body, { ok: true, invalidated: true });
  budget = 12;
  fs.writeFileSync(ini, '[chat]\nctx-size = 4096\n');
  assert.equal(await m.loadRefusal('chat'), null);
  await handle(trusted({ want: 'quarantine', model: 'chat', budgetGib: 12, revision }), {});
  assert.deepEqual(sent.pop().body, { ok: true, invalidated: true }, 'do not quarantine a newer preset on retry');
  fs.writeFileSync(file, 'incomplete');
  assert.equal((await m.loadRefusal('chat')).code, 'inference_budget_pending', 'damaged fences fail closed');
});

test('#697 a damaged fence affects only its hash and its durable context releases admission on configuration change', async (t) => {
  const os = require('node:os'), { createHash } = require('node:crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-damage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ini = path.join(dir,'models.ini'); fs.writeFileSync(ini,'[chat]\nctx-size=1024\n[other]\n[third]\n');
  let budget=12;
  const opts={kind:'llamacpp',baseUrl:'http://synthetic',presetPath:ini,budgetWatchDir:dir,inferenceBudget:{budgetGib:()=>budget},gate:require('./fixtures/fake-inference-gate.cjs').fakeGate(),fetchJson:async()=>({ok:true,status:200,body:{data:[]}})};
  const m=createModelManager(opts), revision=m.presetFacts('chat').revision;
  const hash=model=>createHash('sha256').update(model).digest('hex');
  for (const [model,budgetGib] of [['chat',12],['other',8],['third',12]]) {
    fs.writeFileSync(path.join(dir,hash(model)+'.json'),JSON.stringify({model,revision,budgetGib,at:0,recorded:false}));
    fs.writeFileSync(path.join(dir,hash(model)+'.context'),JSON.stringify({revision,revisionKnown:true,budgetGib}));
  }
  fs.writeFileSync(path.join(dir,hash('chat')+'.json'),'damaged');
  assert.equal((await m.loadRefusal('chat')).code,'inference_budget_pending');
  assert.equal(await m.loadRefusal('other'),null);
  assert.equal((await m.loadRefusal('third')).code,'inference_budget_unloaded');
  fs.renameSync(path.join(dir,hash('chat')+'.json'),path.join(dir,hash('chat')+'.json.damaged-1'));
  assert.equal((await createModelManager(opts).loadRefusal('chat')).code,'inference_budget_pending','renamed damage remains fenced after restart');
  budget=24; assert.equal(await m.loadRefusal('chat'),null);
  budget=12; fs.writeFileSync(ini,'[chat]\nctx-size=2048\n[other]\n[third]\n');
  assert.equal(await m.loadRefusal('chat'),null,'a changed revision releases damaged state without IPC');
});
