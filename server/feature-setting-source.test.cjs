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
  assert.throws(() => store.set(DECISION, JSON.stringify({ url: 'http://192.168.1.20:8040', timeoutMs: 1500 })), { code: 'FEATURE_RUNTIME_SOURCE_UNAVAILABLE' });
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
  // #2190: a write by the Rust front is in force on the owner's next use, with no refresh or restart.
  store.set(DECISION, JSON.stringify({ ...first, url: 'http://192.168.1.21:8040' }));
  assert.equal(owner.get().url, 'http://192.168.1.21:8040');
  assert.notEqual(owner.runtimeContextSource(), previous);
  assert.equal(owner.runtimeContextSource(), store.readFact(DECISION).source);
  // A read failure is never answered from the last good value.
  fail = true;
  assert.equal(owner.get().url, '');
  assert.equal(owner.runtimeContextSource(), null);
  fail = false;
  assert.equal(owner.get().url, 'http://192.168.1.21:8040');
});

test('known malformed decision data and Rust saves/resets keep correct provenance', t => {
  const { store } = fixture(t);
  store.set(DECISION, '{');
  const owner = createDecisionSettings({ store, env: {} });
  assert.equal(owner.get().url, '');
  assert.equal(owner.runtimeContextSource(), store.readFact(DECISION).source);
  store.set(DECISION, JSON.stringify({ url: 'http://192.168.1.20:8040', timeoutMs: 1500 }));
  assert.equal(new URL(owner.get().url).hostname, '192.168.1.20');
  assert.equal(owner.runtimeContextSource(), store.readFact(DECISION).source);
  store.delete(DECISION);
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

test('actual guarded connection accepts only the two exact source-store write shapes', t => {
  const { db } = fixture(t);
  const guard = require('./rust-auth.cjs').createRustAuthGuard();
  guard.install(db);
  const store = createStore(db); // MUST prepare statements after installation.
  const decision = createDecisionSettings({ store, env: {} });
  // #2190: decision:configuration is the Rust front's; Node's guarded connection refuses both shapes.
  assert.throws(() => store.writeFact(DECISION, JSON.stringify({ url: 'http://192.168.1.20:8040', timeoutMs: 1500 })), { code: 'RUST_DECISION_SETTINGS_OWNED' });
  assert.throws(() => store.deleteFact(DECISION), { code: 'RUST_DECISION_SETTINGS_OWNED' });
  assert.equal(decision.runtimeContextSource(), store.readFact(DECISION).source);
  assert.equal(store.get(DECISION), undefined);
  store.set(MACHINES, JSON.stringify(machineState(8040)));
  const machines = createInferenceMachines({ store, log: () => {} });
  machines.assign({ service: 'decision', machine: 'local' }, 'synthetic');
  assert.equal(machines.runtimeContextSource(), store.readFact(MACHINES).source);
  assert.equal(machines.urlFor('decision'), null);
  const { WRITE_SQL } = require('./feature-setting-source.cjs');
  for (const key of ['feature:plannerReview', 'native:feature-runtime:incarnation', 'public_origin_admin', 'unknown']) {
    assert.throws(() => guard.exempt(() => db.prepare(WRITE_SQL).get(key, 'forged')), { code: 'RUST_AUTH_OWNED' });
  }
  assert.throws(() => guard.exempt(() => db.prepare('DELETE FROM settings WHERE key=?').run(DECISION)), { code: 'RUST_AUTH_OWNED' });
  assert.throws(() => db.prepare(`${WRITE_SQL}, 1 AS extra`).get(DECISION, 'forged'), { code: 'RUST_AUTH_OWNED' });
  assert.throws(() => guard.exempt(() => db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('native:feature-runtime:incarnation', 'forged')), { code: 'RUST_FEATURE_RUNTIME_OWNED' });
  // The bound key is what the guard judges: the machines key Node still owns (#2190: not the decision key).
  const args = [MACHINES, '{"url":"http://192.168.1.20:8040","timeoutMs":1500}'];
  const statement = db.prepare(WRITE_SQL).bind(args);
  args[0] = 'native:feature-runtime:incarnation';
  statement.get(); // SQLite and the guard both retained the original machines key.
  assert.equal(JSON.parse(store.get(MACHINES)).timeoutMs, 1500);
  const prohibited = db.prepare(WRITE_SQL).bind('native:feature-runtime:incarnation', 'forged').raw();
  assert.throws(() => guard.exempt(() => prohibited.get()), { code: 'RUST_AUTH_OWNED' });
});

test('epoch guard also refuses indirect trigger writes even inside exemptions', t => {
  const { db } = fixture(t);
  db.exec("CREATE TABLE synthetic_source(x); CREATE TRIGGER forge_epoch AFTER INSERT ON synthetic_source BEGIN INSERT OR REPLACE INTO settings(key,value) VALUES('native:feature-runtime:incarnation','forged'); END;");
  const guard = require('./rust-auth.cjs').createRustAuthGuard();
  guard.install(db);
  assert.throws(() => guard.exempt(() => db.prepare('INSERT INTO synthetic_source VALUES(?)').run('synthetic')), /RUST_FEATURE_RUNTIME_OWNED/);
  assert.equal(db.prepare("SELECT count(*) AS n FROM settings WHERE key='native:feature-runtime:incarnation'").get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM synthetic_source').get().n, 0);
});
