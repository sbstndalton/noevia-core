'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createRustAuthGuard } = require('./rust-auth.cjs');
const { createReadOnlyFeatures, REGISTRY } = require('./features.cjs');
const { createStore } = require('./feature-setting-source.cjs');
const { createDecisionSettings } = require('./decision-settings.cjs');
const { createInferenceMachines } = require('./inference-machines.cjs');
const { createContextCollector, createFeatureRuntime } = require('./feature-runtime.cjs');
function fixture(t, env = {}) {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-feature-readonly-'));
  const db = new Database(path.join(directory, 'synthetic.sqlite'));
  db.pragma('journal_mode=WAL'); db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value)');
  const native = new Database(path.join(directory, 'synthetic.sqlite'));
  const put = native.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)');
  put.run('native:feature-runtime:incarnation', '2'.repeat(32));
  createRustAuthGuard().install(db);
  t.after(() => { db.close(); native.close(); fs.rmSync(directory, { recursive: true }); });
  const sourceStore = createStore(db);
  const inferenceMachines = createInferenceMachines({ store: sourceStore, env, log: () => {} });
  const decisionSettings = createDecisionSettings({ store: sourceStore, env, machineUrl: () => inferenceMachines.urlFor('decision') });
  const collector = createContextCollector({ db, store: sourceStore, decisionSettings, inferenceMachines, env });
  const availability = Object.fromEntries(['stepSupervision', 'toolGate', 'chatFraming', 'framingReasoner'].map(n => [n, () => decisionSettings.unavailable('choice')]));
  availability.systemOneRouting = () => decisionSettings.unavailable() && require('./system-one-router.cjs').configuration(env).reason;
  let runtime;
  const adapter = createReadOnlyFeatures({ db, env, availability, runtime: () => runtime });
  let time = 0;
  runtime = createFeatureRuntime({ db, collector, bootFacts: adapter.bootFacts, start: '1'.repeat(32), now: () => time,
    setIntervalImpl: () => ({ unref() {} }), clearIntervalImpl() {},
    storeClient: { async featureContext(wire) {
      const p = JSON.parse(wire);
      return JSON.stringify(p.op === 'hello' ? { op: p.op, request: p.request, start: p.start, incarnation: '2'.repeat(32) }
        : { op: p.op, request: p.request, start: p.start, incarnation: p.incarnation, boot: p.boot,
          session: p.session, sequence: p.sequence, status: p.op === 'release' ? 'released' : 'ready', ...(p.op === 'release' ? {} : { leaseMs: 15000 }) });
    } },
  });
  return { ...adapter, db, put: (key, value) => put.run(key, value), runtime, setTime(n) { time = n; } };
}
test('construction exposes ONLY two actual boot values/warnings; all execution reads require live native context', async t => {
  const f = fixture(t, { [REGISTRY.kiwix.env]: 'true' });
  assert.equal(f.construction.kiwix, true);
  assert.deepEqual(Object.keys(f.construction).sort(), ['diaryMcpWrite', 'kiwix', 'startupWarnings']);
  assert.ok(Object.isFrozen(f.construction) && Object.isFrozen(f.bootFacts) && Object.isFrozen(f.bootFacts.env));
  assert.equal(f.bootFacts.env.length, 23);
  assert.equal(typeof f.features.set, 'undefined');
  for (const read of [() => f.features.enabled('kiwix'), () => f.features.flags(), () => f.features.describe()]) assert.throws(read, { status: 503 });
  await f.runtime.ready();
  assert.equal(Object.keys(f.features.flags()).length, 23);
  assert.equal(f.features.enabled('kiwix'), f.construction.kiwix);
  f.setTime(15000);
  assert.throws(() => f.features.enabled('kiwix'), { status: 503 });
});
test('every canonical selection follows fresh typed native SQL rows without Node cache or writer', async t => {
  const f = fixture(t); await f.runtime.ready();
  for (const [name, spec] of Object.entries(REGISTRY)) {
    for (const value of ['true', 'false', Buffer.from('true'), 1, null]) {
      f.put('feature:' + name, value);
      const described = f.features.describe().find(row => row.name === name);
      assert.equal(described.enabled, value === 'true' ? true : value === 'false' ? false : spec.default === true, name);
      assert.equal(described.source, value === 'true' || value === 'false' ? 'admin' : 'default');
    }
  }
});
test('native selected restart changes remain pending against ACTUAL immutable Node construction', async t => {
  const f = fixture(t); await f.runtime.ready();
  for (const name of ['diaryMcpWrite', 'kiwix']) {
    const boot = f.construction[name]; f.put('feature:' + name, String(!boot));
    assert.equal(f.features.enabled(name), boot);
    const row = f.features.describe().find(row => row.name === name);
    assert.equal(row.enabled, !boot); assert.equal(row.pendingRestart, true);
  }
});
test('legacy fallback is read-only and aliases follow a later valid canonical native selection', async t => {
  const f = fixture(t); f.put('feature:astraReview', 'true'); await f.runtime.ready();
  assert.equal(f.features.enabled('astraReview'), true);
  assert.equal(f.db.prepare("SELECT value FROM settings WHERE key='feature:plannerReview'").get(), undefined);
  f.put('feature:plannerReview', 'false'); assert.equal(f.features.enabled('astraReview'), false);
  assert.equal(f.features.resolve('astraReview'), 'plannerReview');
});
test('operator locks stay immutable and factory refuses mismatched transaction DB', async t => {
  const locked = REGISTRY.previews.env;
  const env = { [locked]: 'true' }; const f = fixture(t, env); await f.runtime.ready();
  env[locked] = 'false'; f.put('feature:previews', 'false');
  const row = f.features.describe().find(r => r.name === 'previews');
  assert.equal(row.enabled, true); assert.equal(row.source, 'env'); assert.equal(row.locked, true);
  const other = new Database(':memory:'); t.after(() => other.close()); other.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value)');
  const availability = Object.fromEntries(['stepSupervision', 'toolGate', 'chatFraming', 'framingReasoner', 'systemOneRouting'].map(n => [n, () => null]));
  const wrong = createReadOnlyFeatures({ db: other, availability, runtime: () => f.runtime });
  assert.throws(() => wrong.features.flags(), { status: 503 });
});
