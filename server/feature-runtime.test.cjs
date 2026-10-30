'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createRustAuthGuard } = require('./rust-auth.cjs');
const { createStore } = require('./feature-setting-source.cjs');
const { createDecisionSettings } = require('./decision-settings.cjs');
const { createInferenceMachines } = require('./inference-machines.cjs');
const { createContextCollector } = require('./feature-runtime.cjs');
const { rustSavesDecision } = require('../tests/server/rust-decision-row.cjs');
const D = 'decision:configuration', M = 'inference:machines';
function fixture(t, options = {}) {
  // #2190: the Rust front writes decision:configuration; `rust` is its (unguarded) connection.
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-feature-runtime-'));
  const db = new Database(path.join(dir, 'synthetic.sqlite'));
  db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value)');
  const rust = new Database(path.join(dir, 'synthetic.sqlite'));
  if (options.guarded) createRustAuthGuard().install(db);
  t.after(() => { rust.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = createStore(db);
  let fail = false;
  const store = { ...base, readFact(key) { if (fail) throw Error('private synthetic secret'); return base.readFact(key); } };
  const env = options.env || {};
  const inferenceMachines = createInferenceMachines({ store, env, log: () => {} });
  const decisionSettings = createDecisionSettings({ store, env, kinds: options.kinds,
    machineUrl: () => inferenceMachines.urlFor('decision') });
  const collector = createContextCollector({ db, store, decisionSettings, inferenceMachines, env });
  const rustSaves = (value) => rustSavesDecision(rust, value);
  return { db, rust, rustSaves, store, decisionSettings, inferenceMachines, collector, fail(value) { fail = value; } };
}
const configured = { url: 'http://192.168.1.20:8040', timeoutMs: 1500 };
test('actual guarded owners collect coherent source identities and closed reasons only', t => {
  const f = fixture(t, { guarded: true });
  let facts = f.collector.collect();
  assert.equal(facts.availability.stepSupervision, 'decision-service-unconfigured');
  assert.equal(facts.availability.systemOneRouting, 'system-one-unconfigured');
  // Node's guarded connection refuses the key; the Rust front's write is what Node re-reads.
  assert.throws(() => f.store.writeFact(D, JSON.stringify(configured)), { code: 'RUST_DECISION_SETTINGS_OWNED' });
  f.rustSaves(configured);
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
    if (decision) f.rustSaves(configured);
    const facts = f.collector.collect();
    assert.equal(facts.availability.systemOneRouting, decision || legacy ? null : 'system-one-unconfigured');
    assert.equal(facts.availability.toolGate, decision ? 'choice-unsupported' : 'decision-service-unconfigured');
  }
});
test('external saved-row changes refresh through both ORIGINAL owner parsers in one snapshot', t => {
  const f = fixture(t);
  const before = f.collector.collect();
  f.store.set(D, JSON.stringify(configured));
  // #2190: the owner re-reads on every use, so it is current before any collection (it used to be stale).
  assert.equal(f.decisionSettings.unavailable('choice'), null);
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
test('an AFTER-trigger discrepancy on the Rust write cannot publish stale owner facts', t => {
  const f = fixture(t);
  f.db.exec("CREATE TRIGGER change AFTER INSERT ON settings WHEN new.key='decision:configuration' BEGIN UPDATE settings SET value='{' WHERE key=new.key; END");
  f.rustSaves(configured);
  // What is stored is '{', and that is what the owner reads: Node's malformed-row fallback.
  assert.equal(f.decisionSettings.unavailable('choice'), 'Set up the decision service below before enabling this experiment.');
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

test('a real second WAL connection can commit during callbacks without mixing snapshot generations', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-feature-snapshot-'));
  const db = new Database(path.join(dir, 'synthetic.sqlite'));
  db.pragma('journal_mode=WAL');
  db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value)');
  const external = new Database(path.join(dir, 'synthetic.sqlite'));
  t.after(() => { external.close(); db.close(); fs.rmSync(dir, { recursive: true }); });
  const store = createStore(db), other = createStore(external);
  const inferenceMachines = createInferenceMachines({ store, env: {}, log: () => {} });
  const original = createDecisionSettings({ store, env: {}, machineUrl: () => inferenceMachines.urlFor('decision') });
  let changed = false;
  const actualOwner = { ...original, unavailable(kind) {
    if (!changed) { changed = true; other.set(D, JSON.stringify(configured)); }
    return original.unavailable(kind);
  } };
  const collector = createContextCollector({ db, store, inferenceMachines, decisionSettings: actualOwner, env: {} });
  const before = store.readFact(D).source;
  const snapshot = collector.collect();
  assert.equal(snapshot.sources.decision, before);
  assert.equal(snapshot.availability.chatFraming, 'decision-service-unconfigured');
  assert.notEqual(snapshot.sources.decision, store.readFact(D).source); // newer producer commit after our snapshot began
  const refreshed = collector.collect();
  assert.equal(refreshed.sources.decision, store.readFact(D).source);
  assert.equal(refreshed.availability.chatFraming, null);
});
