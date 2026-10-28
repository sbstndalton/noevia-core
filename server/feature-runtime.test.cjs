'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createRustAuthGuard } = require('./rust-auth.cjs');
const { createStore } = require('./feature-setting-source.cjs');
const { createDecisionSettings } = require('./decision-settings.cjs');
const { createInferenceMachines } = require('./inference-machines.cjs');
const { createContextCollector } = require('./feature-runtime.cjs');
const D = 'decision:configuration', M = 'inference:machines';
function fixture(t, options = {}) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value)');
  if (options.guarded) createRustAuthGuard().install(db);
  t.after(() => db.close());
  const base = createStore(db);
  let fail = false;
  const store = { ...base, readFact(key) { if (fail) throw Error('private synthetic secret'); return base.readFact(key); } };
  const env = options.env || {};
  const inferenceMachines = createInferenceMachines({ store, env, log: () => {} });
  const decisionSettings = createDecisionSettings({ store, env, kinds: options.kinds,
    machineUrl: () => inferenceMachines.urlFor('decision'), audit: options.audit || (() => {}) });
  const collector = createContextCollector({ db, store, decisionSettings, inferenceMachines, env });
  return { db, store, decisionSettings, inferenceMachines, collector, fail(value) { fail = value; } };
}
const configured = { url: 'http://192.168.1.20:8040', timeoutMs: 1500 };
test('actual guarded owners collect coherent source identities and closed reasons only', t => {
  const f = fixture(t, { guarded: true });
  let facts = f.collector.collect();
  assert.equal(facts.availability.stepSupervision, 'decision-service-unconfigured');
  assert.equal(facts.availability.systemOneRouting, 'system-one-unconfigured');
  f.decisionSettings.save(configured, 'synthetic');
  facts = f.collector.collect();
  assert.deepEqual(Object.values(facts.availability), [null, null, null, null, null]);
  assert.equal(facts.sources.decision, f.store.readFact(D).source);
  assert.equal(facts.sources.machines, f.store.readFact(M).source);
  assert.ok(Object.isFrozen(facts) && Object.isFrozen(facts.sources) && Object.isFrozen(facts.availability));
  assert.doesNotMatch(JSON.stringify(facts), /192\.168|8040|private synthetic secret/);
});
test('system-one callback preserves all four original AND outcomes and choice support', t => {
  for (const decision of [false, true]) for (const legacy of [false, true]) {
    const f = fixture(t, { env: legacy ? { COWORK_SYSTEM_ONE_URL: 'http://192.168.1.21:8040' } : {}, kinds: [] });
    if (decision) f.decisionSettings.save(configured, 'synthetic');
    const facts = f.collector.collect();
    assert.equal(facts.availability.systemOneRouting, decision || legacy ? null : 'system-one-unconfigured');
    assert.equal(facts.availability.toolGate, decision ? 'choice-unsupported' : 'decision-service-unconfigured');
  }
});
test('external saved-row changes refresh through both ORIGINAL owner parsers in one snapshot', t => {
  const f = fixture(t);
  const before = f.collector.collect();
  f.store.set(D, JSON.stringify(configured));
  assert.equal(f.decisionSettings.unavailable('choice') !== null, true); // stale owner before collection
  const changed = f.collector.collect();
  assert.equal(changed.availability.chatFraming, null);
  assert.notEqual(changed.sources.decision, before.sources.decision);
  f.store.set(D, '{'); // original malformed fallback, not native reconstruction
  assert.equal(f.collector.collect().availability.chatFraming, 'decision-service-unconfigured');
  f.store.set(M, JSON.stringify({ version: 1, machines: [{ id: 'synthetic', name: 'Synthetic', address: 'http://192.168.1.22' }], assignments: { decision: { machine: 'synthetic', port: 8040 } } }));
  const assigned = f.collector.collect();
  assert.equal(assigned.availability.chatFraming, null);
  assert.equal(f.decisionSettings.get().url, 'http://192.168.1.22:8040');
  assert.notEqual(assigned.sources.machines, before.sources.machines);
});
test('unknown, oversized or mismatched cache inputs refuse; successful recovery reparses actual data', t => {
  const f = fixture(t);
  f.fail(true);
  assert.throws(() => f.collector.collect(), { code: 'FEATURE_RUNTIME_CONTEXT_UNAVAILABLE' });
  f.fail(false);
  f.store.set(D, JSON.stringify(configured));
  assert.equal(f.collector.collect().availability.chatFraming, null);
  f.db.prepare('UPDATE settings SET value=zeroblob(1048577) WHERE key=?').run(D);
  assert.throws(() => f.collector.collect(), { code: 'FEATURE_RUNTIME_CONTEXT_UNAVAILABLE' });
  f.store.set(D, '{}');
  assert.equal(f.collector.collect().availability.chatFraming, 'decision-service-unconfigured');
  const badOwner = { ...f.decisionSettings, runtimeContextSource: () => null, refreshRuntimeContextSource: () => null };
  const bad = createContextCollector({ db: f.db, store: f.store, inferenceMachines: f.inferenceMachines, decisionSettings: badOwner, env: {} });
  assert.throws(() => bad.collect(), { code: 'FEATURE_RUNTIME_CONTEXT_UNAVAILABLE' });
});
test('committed save/audit failure and AFTER-trigger discrepancy cannot publish stale owner facts', t => {
  const f = fixture(t, { audit: () => { throw Error('private synthetic secret'); } });
  f.db.exec("CREATE TRIGGER change AFTER INSERT ON settings WHEN new.key='decision:configuration' BEGIN UPDATE settings SET value='{' WHERE key=new.key; END");
  assert.throws(() => f.decisionSettings.save(configured, 'synthetic'), /private synthetic secret/);
  assert.equal(f.decisionSettings.unavailable('choice'), null);
  const facts = f.collector.collect();
  assert.equal(facts.availability.stepSupervision, 'decision-service-unconfigured');
  assert.equal(facts.sources.decision, f.store.readFact(D).source);
});
test('unrecognized/freeform callback reasons never leave the collector', t => {
  const f = fixture(t);
  const bad = createContextCollector({ db: f.db, store: f.store, inferenceMachines: f.inferenceMachines,
    decisionSettings: { ...f.decisionSettings, unavailable: () => 'http://private.example/?key=synthetic' }, env: {} });
  assert.throws(() => bad.collect(), err => err.code === 'FEATURE_RUNTIME_CONTEXT_UNAVAILABLE' && !err.message.includes('private.example'));
});
