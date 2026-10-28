'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createRustAuthGuard } = require('./rust-auth.cjs');
const { createStore } = require('./feature-setting-source.cjs');
const { createDecisionSettings } = require('./decision-settings.cjs');
const { createInferenceMachines } = require('./inference-machines.cjs');
const { createContextCollector, createFeatureRuntime } = require('./feature-runtime.cjs');
const { createClient } = require('./project-store-client.cjs');
const START = '1'.repeat(32), INC = '2'.repeat(32), NEXT = '3'.repeat(32);
const facts = () => ({ env: Array(23).fill(null), restart: [false, true], browser: 'playwright', code: false, trustProxy: true });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture(t, behavior = () => {}) {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-feature-client-'));
  const db = new Database(path.join(directory, 'synthetic.sqlite'));
  db.pragma('journal_mode=WAL');
  db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value)');
  const nativeActor = new Database(path.join(directory, 'synthetic.sqlite'));
  db.prepare('INSERT INTO settings VALUES(?,?)').run('native:feature-runtime:incarnation', INC);
  const replaceEpoch = value => nativeActor.prepare("UPDATE settings SET value=? WHERE key='native:feature-runtime:incarnation'").run(value);
  createRustAuthGuard().install(db);
  t.after(() => { nativeActor.close(); db.close(); fs.rmSync(directory, { recursive: true }); });
  const store = createStore(db), env = {};
  const inferenceMachines = createInferenceMachines({ store, env, log: () => {} });
  const decisionSettings = createDecisionSettings({ store, env, machineUrl: () => inferenceMachines.urlFor('decision') });
  const collector = createContextCollector({ db, store, inferenceMachines, decisionSettings, env });
  let time = 0, id = 1, tick, intervals = 0;
  const calls = [], originalFacts = facts();
  const storeClient = { async featureContext(wire, options) {
    const payload = JSON.parse(wire); calls.push({ wire, payload, options });
    const replacement = await behavior(payload, { setTime: n => { time = n; }, replaceEpoch, calls });
    if (replacement !== undefined) return replacement;
    if (payload.op === 'hello') return JSON.stringify({ op: payload.op, request: payload.request, start: START, incarnation: INC });
    return JSON.stringify({ op: payload.op, request: payload.request, start: START, incarnation: payload.incarnation,
      boot: payload.boot, session: payload.session, sequence: payload.sequence,
      status: payload.op === 'release' ? 'released' : 'ready', ...(payload.op === 'release' ? {} : { leaseMs: 15000 }) });
  } };
  const runtime = createFeatureRuntime({ db, storeClient, collector, bootFacts: originalFacts, start: START,
    now: () => time, newId: () => `00000000-0000-4000-8000-${String(id++).padStart(12, '0')}`,
    setIntervalImpl: (fn, interval) => { assert.equal(interval, 5000); tick = fn; intervals++; return { unref() {} }; },
    clearIntervalImpl: () => { tick = null; },
  });
  return { db, store, runtime, originalFacts, calls, replaceEpoch, setTime(n) { time = n; }, tick() { tick?.(); }, intervals() { return intervals; } };
}
test('register retry reuses immutable identity/body and EARLIEST send anchor', async t => {
  let attempts = 0;
  const f = fixture(t, (p, api) => {
    if (p.op === 'register' && ++attempts === 1) { api.setTime(2000); throw Error('synthetic lost committed reply'); }
  });
  assert.throws(() => f.runtime.read(() => true), { code: 'FEATURE_RUNTIME_CONTEXT_UNAVAILABLE' });
  await f.runtime.ready();
  const registrations = f.calls.filter(c => c.payload.op === 'register');
  assert.equal(registrations.length, 2);
  assert.equal(registrations[0].wire, registrations[1].wire);
  assert.equal(registrations[1].options.timeoutMs, 500);
  f.setTime(14999); assert.equal(f.runtime.read(() => true), true);
  f.setTime(15000); assert.throws(() => f.runtime.read(() => true), { status: 503 });
});
test('same Node boot/construction facts survive native restart but session and incarnation change', async t => {
  let native = INC;
  const f = fixture(t, p => {
    if (p.op === 'hello') return JSON.stringify({ op: p.op, request: p.request, start: START, incarnation: native });
  });
  await f.runtime.ready();
  f.originalFacts.restart[1] = false; // caller mutation cannot change captured actual construction facts.
  native = NEXT; f.replaceEpoch(NEXT);
  assert.throws(() => f.runtime.read(() => true), { status: 503 });
  await f.runtime.ready();
  const registered = f.calls.filter(c => c.payload.op === 'register').map(c => c.payload);
  assert.equal(registered[0].boot, registered[1].boot);
  assert.notEqual(registered[0].session, registered[1].session);
  assert.notEqual(registered[0].incarnation, registered[1].incarnation);
  assert.deepEqual(registered[0].facts, registered[1].facts);
});
test('changed source refuses ordinary reads until a fresh acknowledged owner renewal', async t => {
  const f = fixture(t); await f.runtime.ready();
  f.store.set('decision:configuration', JSON.stringify({ url: 'http://192.168.1.20:8040', timeoutMs: 1500 }));
  assert.throws(() => f.runtime.read(() => true), { status: 503 });
  await f.runtime.renew();
  assert.equal(f.runtime.read(() => true), true);
  assert.equal(f.calls.at(-1).payload.snapshot.availability.chatFraming, null);
});
test('renew retry never reanchors and a reply after prior local expiry never resurrects', async t => {
  let count = 0;
  const f = fixture(t, (p, api) => {
    if (p.op === 'renew' && ++count === 1) { api.setTime(7000); throw Error('synthetic lost renewal'); }
  });
  await f.runtime.ready(); f.setTime(5000); await f.runtime.renew();
  const renewed = f.calls.filter(c => c.payload.op === 'renew');
  assert.equal(renewed[0].wire, renewed[1].wire);
  f.setTime(20000); assert.throws(() => f.runtime.read(() => true), { status: 503 });
  const late = fixture(t, (p, api) => { if (p.op === 'renew') api.setTime(15000); });
  await late.runtime.ready(); late.setTime(14000);
  await assert.rejects(late.runtime.renew(), { status: 503 });
  assert.throws(() => late.runtime.read(() => true), { status: 503 });
});
test('release revokes BEFORE awaiting pending renewal; late replies cannot install authority', async t => {
  const arrived = deferred(), finish = deferred();
  const f = fixture(t, async p => { if (p.op === 'renew') { arrived.resolve(); await finish.promise; } });
  await f.runtime.ready(); const renewal = f.runtime.renew();
  await arrived.promise;
  const released = f.runtime.release();
  assert.throws(() => f.runtime.read(() => true), { status: 503 });
  finish.resolve();
  await assert.rejects(renewal, { status: 503 });
  await released;
  assert.throws(() => f.runtime.read(() => true), { status: 503 });
  assert.equal(f.calls.at(-1).payload.op, 'release');
});
test('release before queued registration begins causes zero RPCs and cannot start maintenance', async t => {
  const f = fixture(t);
  const registration = f.runtime.ready(); const release = f.runtime.release();
  await assert.rejects(registration, { status: 503 }); await release;
  assert.equal(f.calls.length, 0); assert.equal(f.intervals(), 0);
});
test('lost release reply retries the same scoped identity without restoring local reads', async t => {
  let count = 0;
  const f = fixture(t, p => { if (p.op === 'release' && ++count === 1) throw Error('lost release'); });
  await f.runtime.ready(); await f.runtime.release();
  const releases = f.calls.filter(c => c.payload.op === 'release');
  assert.equal(releases[0].wire, releases[1].wire);
  assert.throws(() => f.runtime.read(() => true), { status: 503 });
});
test('duplicate/unknown/cross-start/cross-session reply fields and bad epoch cannot acknowledge', async t => {
  for (const change of [
    p => `{"op":"bad",${JSON.stringify(p).slice(1)}`,
    p => JSON.stringify({ ...p, extra: true }),
    p => JSON.stringify({ ...p, start: '4'.repeat(32) }),
    p => JSON.stringify({ ...p, session: '00000000-0000-4000-8000-999999999999' }),
  ]) {
    const f = fixture(t, p => {
      if (p.op !== 'register') return undefined;
      return change({ op: p.op, request: p.request, start: p.start, incarnation: p.incarnation,
        boot: p.boot, session: p.session, sequence: p.sequence, status: 'ready', leaseMs: 15000 });
    });
    await assert.rejects(f.runtime.ready(), { status: 503 });
    assert.throws(() => f.runtime.read(() => true), { status: 503 });
  }
  const f = fixture(t); await f.runtime.ready(); f.replaceEpoch(INC + '\0' + 'x'.repeat(2 * 1024 * 1024));
  assert.throws(() => f.runtime.read(() => true), { status: 503 });
});
test('monotonic regression/NaN and async read callbacks confer no authority', async t => {
  for (const fault of [NaN, -1]) {
    const f = fixture(t); await f.runtime.ready(); f.setTime(fault);
    assert.throws(() => f.runtime.read(() => true), { status: 503 });
    f.setTime(1); await assert.rejects(f.runtime.ready(), { status: 503 });
  }
  const f = fixture(t); await f.runtime.ready();
  assert.throws(() => f.runtime.read(() => Promise.resolve(true)), { status: 503 });
});
test('private store transport caps request/reply, requires no-store and bounds hanging fetch/body', async () => {
  const token = 'synthetic-store-token-'.padEnd(64, 'x');
  const calls = [];
  const client = createClient({ port: 12345, token, fetchImpl: async (url, init) => {
    calls.push({ url, init }); return new Response('{"ok":true}', { headers: { 'cache-control': 'no-store' } });
  } });
  assert.equal(await client.featureContext('{}'), '{"ok":true}');
  assert.equal(calls[0].url, 'http://127.0.0.1:12345/v1/features/context');
  assert.equal(calls[0].init.headers['x-noevia-store-token'], token);
  await assert.rejects(client.featureContext('x'.repeat(32769)), { status: 503 });
  for (const fetchImpl of [
    async () => new Response('x'.repeat(2049), { headers: { 'cache-control': 'no-store' } }),
    async () => new Response('{}'),
    async () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), { headers: { 'cache-control': 'no-store' } }),
  ]) await assert.rejects(createClient({ port: 12345, token, fetchImpl }).featureContext('{}', { timeoutMs: 20 }), { status: 503 });
});

test('actual loopback HTTP uses the existing capability and times out an unterminated reply', async t => {
  const http = require('node:http');
  const token = 'synthetic-feature-token-'.padEnd(64, 'x');
  const observed = [];
  const server = http.createServer((req, res) => {
    observed.push({ url: req.url, token: req.headers['x-noevia-store-token'] });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    if (observed.length === 1) res.end('{"ok":true}');
    else res.write('{'); // actual TCP headers/body arrive but end never does.
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const client = createClient({ port: server.address().port, token });
  assert.equal(await client.featureContext('{}'), '{"ok":true}');
  await assert.rejects(client.featureContext('{}', { timeoutMs: 80 }), { status: 503 });
  assert.deepEqual(observed, Array(2).fill({ url: '/v1/features/context', token }));
});

test('1024-session budget retains real boot identity and refuses another recovery instead of reuse', async t => {
  const f = fixture(t);
  for (let index = 0; index < 1024; index++) { await f.runtime.ready(); await f.runtime.release(); }
  const registered = f.calls.filter(c => c.payload.op === 'register').map(c => c.payload);
  assert.equal(new Set(registered.map(p => p.boot)).size, 1);
  assert.equal(new Set(registered.map(p => p.session)).size, 1024);
  await assert.rejects(f.runtime.ready(), { status: 503 });
  assert.equal(f.calls.filter(c => c.payload.op === 'register').length, 1024);
});
test('sparse or malformed boot facts cannot be serialized into invented construction values', () => {
  for (const bootFacts of [{ ...facts(), env: Array(23) }, { ...facts(), restart: Array(2) },
    { ...facts(), browser: 'private unknown reason' }, { ...facts(), extra: true }]) {
    assert.throws(() => createFeatureRuntime({ db: null, storeClient: { featureContext() {} },
      collector: null, bootFacts, start: START }), { status: 503 });
  }
});

test('a known register ACK with concurrently changed source stays unreadable and renews SAME session', async t => {
  let changed = false;
  const f = fixture(t, p => {
    if (p.op === 'register' && !changed) {
      changed = true;
      f.store.set('decision:configuration', JSON.stringify({ url: 'http://192.168.1.20:8040', timeoutMs: 1500 }));
    }
  });
  await assert.rejects(f.runtime.ready(), { status: 503 });
  assert.throws(() => f.runtime.read(() => true), { status: 503 });
  const registration = f.calls.find(c => c.payload.op === 'register').payload;
  await f.runtime.ready();
  assert.equal(f.calls.filter(c => c.payload.op === 'register').length, 1);
  assert.equal(f.calls.at(-1).payload.op, 'renew');
  assert.equal(f.calls.at(-1).payload.session, registration.session);
  assert.equal(f.runtime.read(() => true), true);
});
test('a known renew ACK overtaken by a source change recovers by next sequence without restarting session', async t => {
  let changed = false;
  const f = fixture(t, p => {
    if (p.op === 'renew' && !changed) {
      changed = true;
      f.store.set('decision:configuration', JSON.stringify({ url: 'http://192.168.1.21:8040', timeoutMs: 1500 }));
    }
  });
  await f.runtime.ready();
  await assert.rejects(f.runtime.renew(), { status: 503 });
  assert.throws(() => f.runtime.read(() => true), { status: 503 });
  await f.runtime.ready();
  const renewals = f.calls.filter(c => c.payload.op === 'renew').map(c => c.payload);
  assert.deepEqual(renewals.map(p => p.sequence), [1, 2]);
  assert.equal(renewals[0].session, renewals[1].session);
  assert.equal(f.calls.filter(c => c.payload.op === 'register').length, 1);
  assert.equal(f.runtime.read(() => true), true);
});
