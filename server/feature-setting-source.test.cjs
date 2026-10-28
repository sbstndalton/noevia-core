'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createStore, MAX_BYTES } = require('./feature-setting-source.cjs');
const { createDecisionSettings } = require('./decision-settings.cjs');
const { createInferenceMachines } = require('./inference-machines.cjs');
const DECISION = 'decision:configuration';
const MACHINES = 'inference:machines';
function fixture(t) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value)');
  t.after(() => db.close());
  return { db, store: createStore(db) };
}
const machineState = port => ({ version: 1, machines: [{ id: 'synthetic', name: 'Synthetic', address: 'http://192.168.1.20' }], assignments: { decision: { machine: 'synthetic', port } } });

test('stored type, presence and bytes each participate in source identity', t => {
  const { db, store } = fixture(t);
  const sources = [store.readFact(DECISION).source];
  for (const value of [null, '', 'A', Buffer.from('A'), 1, 1.5, 'a\0b']) {
    db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(DECISION, value);
    const observed = store.readFact(DECISION);
    sources.push(observed.source);
    if (Buffer.isBuffer(value)) assert.deepEqual(observed.value, value);
    else assert.equal(observed.value, value);
  }
  assert.equal(new Set(sources).size, sources.length);
  assert.match(sources[0], /^[0-9a-f]{64}$/);
  assert.notEqual(store.readFact(DECISION).source, store.readFact(MACHINES).source);
});

test('source API refuses every unrelated product/metadata key without mutation', t => {
  const { db, store } = fixture(t);
  for (const key of ['feature:plannerReview', 'native:feature-runtime:incarnation', 'unknown']) {
    for (const fn of [() => store.readFact(key), () => store.writeFact(key, 'true'), () => store.deleteFact(key)]) assert.throws(fn, /Unsupported/);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM settings').get().n, 0);
});

test('row cap applies before returning raw/hex payload and oversized writes do not replace data', t => {
  const { db, store } = fixture(t);
  store.writeFact(DECISION, 'x');
  assert.throws(() => store.writeFact(DECISION, 'a'.repeat(MAX_BYTES + 1)), { code: 'FEATURE_RUNTIME_SOURCE_UNAVAILABLE' });
  assert.equal(store.get(DECISION), 'x');
  db.prepare('UPDATE settings SET value=? WHERE key=?').run(Buffer.alloc(MAX_BYTES + 1), DECISION);
  assert.throws(() => store.readFact(DECISION), { code: 'FEATURE_RUNTIME_SOURCE_UNAVAILABLE' });
  db.prepare('UPDATE settings SET value=? WHERE key=?').run('a'.repeat(MAX_BYTES), DECISION);
  assert.equal(store.readFact(DECISION).value.length, MAX_BYTES);
});

test('statement provenance cannot silently follow a later trigger-written value', t => {
  const { db, store } = fixture(t);
  db.exec("CREATE TRIGGER rewrite AFTER INSERT ON settings BEGIN UPDATE settings SET value='changed' WHERE key=new.key; END;");
  const written = store.writeFact(DECISION, 'original');
  const actual = store.readFact(DECISION);
  assert.equal(written.value, 'original');
  assert.equal(actual.value, 'changed');
  assert.notEqual(written.source, actual.source);
});

test('ignored writes cannot give an unstored cache value a missing-row fingerprint', t => {
  const { db, store } = fixture(t);
  db.exec("CREATE TRIGGER refuse BEFORE INSERT ON settings BEGIN SELECT RAISE(IGNORE); END;");
  const owner = createDecisionSettings({ store, env: {} });
  const before = owner.runtimeContextSource();
  assert.throws(() => owner.save({ url: 'http://192.168.1.20:8040', timeoutMs: 1500 }, 'synthetic'), { code: 'FEATURE_RUNTIME_SOURCE_UNAVAILABLE' });
  assert.equal(store.get(DECISION), undefined);
  assert.equal(owner.get().source, 'deployment');
  assert.equal(owner.runtimeContextSource(), before);
});

test('decision source is unknown after read failure, then refreshes using the actual owner parser', t => {
  const { store } = fixture(t);
  const first = { url: 'http://192.168.1.20:8040', timeoutMs: 1500 };
  store.set(DECISION, JSON.stringify(first));
  let fail = true;
  const flaky = { ...store, readFact: key => { if (fail) throw Error('synthetic read failure'); return store.readFact(key); } };
  const owner = createDecisionSettings({ store: flaky, env: {} });
  assert.equal(owner.runtimeContextSource(), null);
  assert.equal(owner.get().url, '');
  fail = false;
  assert.equal(owner.refreshRuntimeContextSource(), store.readFact(DECISION).source);
  assert.equal(owner.get().url, first.url);
  const previous = owner.runtimeContextSource();
  store.set(DECISION, JSON.stringify({ ...first, url: 'http://192.168.1.21:8040' }));
  assert.equal(owner.get().url, first.url); // Context collection must detect this stale closure.
  assert.equal(owner.runtimeContextSource(), previous);
  assert.notEqual(previous, store.readFact(DECISION).source);
  owner.refreshRuntimeContextSource();
  assert.equal(owner.get().url, 'http://192.168.1.21:8040');
  assert.equal(owner.runtimeContextSource(), store.readFact(DECISION).source);
});

test('known malformed decision data and committed save/reset with failed audit keep correct provenance', t => {
  const { store } = fixture(t);
  store.set(DECISION, '{');
  const owner = createDecisionSettings({ store, env: {}, audit: () => { throw Error('synthetic audit failure'); } });
  assert.equal(owner.get().url, '');
  assert.equal(owner.runtimeContextSource(), store.readFact(DECISION).source);
  assert.throws(() => owner.save({ url: 'http://192.168.1.20:8040', timeoutMs: 1500 }, 'synthetic'), /audit/);
  assert.equal(new URL(owner.get().url).hostname, '192.168.1.20');
  assert.equal(owner.runtimeContextSource(), store.readFact(DECISION).source);
  assert.throws(() => owner.reset('synthetic'), /audit/);
  assert.equal(owner.get().source, 'deployment');
  assert.equal(owner.runtimeContextSource(), store.readFact(DECISION).source);
  assert.equal(store.get(DECISION), undefined);
});

test('machine read failure/recovery and changed assignment refresh actual cached routing state', t => {
  const { store } = fixture(t);
  store.set(MACHINES, JSON.stringify(machineState(8040)));
  let fail = true;
  const flaky = { ...store, readFact: key => { if (fail) throw Error('synthetic read failure'); return store.readFact(key); } };
  const owner = createInferenceMachines({ store: flaky, log: () => {} });
  assert.equal(owner.runtimeContextSource(), null);
  assert.equal(owner.urlFor('decision'), null);
  fail = false;
  owner.refreshRuntimeContextSource();
  assert.equal(new URL(owner.urlFor('decision')).port, '8040');
  assert.equal(owner.runtimeContextSource(), store.readFact(MACHINES).source);
  store.set(MACHINES, JSON.stringify(machineState(8041)));
  assert.equal(new URL(owner.urlFor('decision')).port, '8040');
  assert.notEqual(owner.runtimeContextSource(), store.readFact(MACHINES).source);
  owner.refreshRuntimeContextSource();
  assert.equal(new URL(owner.urlFor('decision')).port, '8041');
  assert.equal(owner.runtimeContextSource(), store.readFact(MACHINES).source);
});

test('committed machine assignment and failed audit bind cache to the successful statement', t => {
  const { store } = fixture(t);
  store.set(MACHINES, JSON.stringify(machineState(8040)));
  const owner = createInferenceMachines({ store, log: () => {}, audit: () => { throw Error('synthetic audit failure'); } });
  assert.throws(() => owner.assign({ service: 'decision', machine: 'local' }, 'synthetic'), /audit/);
  assert.equal(owner.urlFor('decision'), null);
  assert.equal(owner.runtimeContextSource(), store.readFact(MACHINES).source);
  assert.deepEqual(JSON.parse(store.get(MACHINES)).assignments, {});
});
