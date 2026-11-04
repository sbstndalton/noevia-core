'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOwner, scheduleLegacy, PROTOCOL } = require('./rust-embedding-background.cjs');
const { createEmbeddingConfig } = require('./embedding-config.cjs');
const { createEmbeddingMigration } = require('./embedding-migration.cjs');
const { createEmbeddingService } = require('./embedding-service.cjs');
const { createAdmission } = require('./inference-admission-lease.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { NOEVIA_START_ID: 'synthetic-start', NOEVIA_PROJECT_STORE_TOKEN: 'synthetic-token', MODEL_LOADER_URL: 'http://127.0.0.1:9999' };
  let clock = 100000;
  const owner = createOwner({ dataDir: dir, env, now: () => clock, features: () => 'rust-embedding-background-v1' });
  return { dir, env, owner, now: () => clock, advance: ms => { clock += ms; } };
}
test('compiled owner refuses missing start, secret or capability', () => {
  assert.throws(() => createOwner({ env: {}, features: () => '' }));
  assert.throws(() => createOwner({ env: { NOEVIA_START_ID: 'a', NOEVIA_PROJECT_STORE_TOKEN: 'b' }, features: () => 'old' }));
});
test('paired boot never registers Node timers; shutdown cannot activate fallback', async t => {
  const { owner, env } = fixture(t);
  let callbacks = [], refresh = 0, fill = 0;
  const config = createEmbeddingConfig({ env: { EMBEDDING_NEXT_MODEL: 'next' }, log() {} });
  const migration = createEmbeddingMigration({ config, rag: { listIndexes: () => { fill++; return []; } }, nativeOwner: owner });
  const stop = scheduleLegacy({ owner, env, config, service: { refresh() { refresh++; } }, migration, afterReady: fn => callbacks.push(fn) });
  assert.equal(callbacks.length, 0);
  migration.kick(); await stop(); migration.kick();
  assert.equal(refresh, 0); assert.equal(fill, 0);
});
test('legacy boot refreshes immediately, schedules both timers, and shutdown cancels them', async () => {
  let ready, refresh = 0, kick = 0, stopped = 0, timers = [], cleared = [];
  const stop = scheduleLegacy({ env: { MODEL_LOADER_URL: 'synthetic' }, config: { next: () => true }, service: { refresh: () => refresh++ }, migration: { kick: () => kick++, stop: () => stopped++ }, afterReady: fn => { ready = fn; }, interval: (fn, ms) => { const v = { fn, ms }; timers.push(v); return v; }, timeout: (fn, ms) => { const v = { fn, ms }; timers.push(v); return v; }, clear: timer => cleared.push(timer) });
  ready(); assert.equal(refresh, 1); assert.deepEqual(timers.map(t => t.ms), [10000, 30000]); timers[1].fn(); assert.equal(kick, 1);
  await stop(); assert.equal(stopped, 1); assert.deepEqual(cleared, timers);
});
test('shutdown before deferred boot does not start legacy workers', async () => {
  let ready;
  const stop = scheduleLegacy({ env: {}, afterReady: fn => { ready = fn; }, migration: { stop() {} }, config: { next() { throw Error('must not run'); } } });
  await stop(); ready();
});
test('proof authenticates, binds start, stays available before snapshot, revokes on stop', t => {
  const { owner } = fixture(t);
  const req = { url: '/internal/embedding-worker-owner', method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-noevia-store-token': 'synthetic-token' } };
  const json = (_, code, body) => { assert.equal(code, 200); assert.deepEqual(body, { protocol: PROTOCOL, start: 'synthetic-start', nodeWorkersStopped: true }); };
  assert.equal(owner.snapshot(), null); owner.handle(req, {}, json);
  for (const changed of [{ headers: {} }, { socket: { remoteAddress: '192.0.2.1' } }, { headers: { ...req.headers, 'x-noevia-client-ip': '127.0.0.1' } }]) owner.handle({ ...req, ...changed }, {}, (_, code) => assert.equal(code, 404));
  owner.stop(); owner.handle(req, {}, (_, code) => assert.equal(code, 404));
});
test('requests are atomic, monotonic and start-bound; snapshots reject stale/foreign starts', t => {
  const { owner, dir, now, advance } = fixture(t);
  owner.kick(); owner.kick();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'embedding-worker-request.json'))), { start: 'synthetic-start', sequence: 2 });
  const file = path.join(dir, 'embedding-worker-status.json');
  fs.writeFileSync(file, JSON.stringify({ protocol: PROTOCOL, start: 'old', at: now() })); assert.equal(owner.snapshot(), null);
  fs.writeFileSync(file, JSON.stringify({ protocol: PROTOCOL, start: 'synthetic-start', at: now() })); assert.ok(owner.snapshot()); advance(15001); assert.equal(owner.snapshot(), null);
});
test('service native observation protects PUT union against an older in-flight GET and stale snapshot', async t => {
  const f = fixture(t); let snapshot = null, completeGet;
  const nativeOwner = { snapshot: () => snapshot, kick() {} };
  const service = createEmbeddingService({ env: f.env, nativeOwner, now: f.now, log() {}, fetchJson: async (_, o) => o.method === 'GET' ? await new Promise(r => { completeGet = r; }) : { ok: true, body: { managed: true, enabled: true, models: [{ model: 'new' }] } } });
  assert.equal(service.protectionKnown(), false); assert.equal(service.enabled(), null);
  const wait = service.waitLoaded(['old'], { timeoutMs: 0 });
  await service.serve([{ model: 'new' }]);
  completeGet({ ok: true, body: { managed: true, models: [{ model: 'old' }], running: { loaded: ['old'] } } }); await wait;
  assert.ok(service.protectedNames().has('new')); assert.ok(service.protectedNames().has('old'));
  snapshot = { serviceAt: f.now() + 1, service: { managed: true, models: [] } }; f.advance(1);
  assert.ok(service.protectedNames().has('new'), 'pre-mutation GET completed later cannot clear union');
  f.advance(6001); snapshot = { serviceAt: f.now(), service: { managed: true, enabled: true, models: [{ model: 'new' }] } };
  assert.deepEqual([...service.protectedNames()], ['new']);
  snapshot = null; f.advance(15001); assert.equal(service.protectionKnown(), false); assert.equal(service.enabled(), null);
});
test('embedding lease takes maintenance only, renew lifetime releases once and rejects mixed asks', async () => {
  let enters = 0, leaves = 0;
  const admission = createAdmission({ modelManager: { enterInference() { enters++; return () => leaves++; }, acquireLease() { throw Error('engine queue'); } }, admitEngineModel() { throw Error('engine load'); } });
  const held = await admission({ embedding: true, model: 'synthetic' });
  assert.equal(enters, 1); assert.equal(held.headers, null); held.release(); held.release(); assert.equal(leaves, 1);
  for (const ask of [{ embedding: false, model: 'a' }, { embedding: true, model: 'a', role: 'smart', machine: 'b' }]) assert.throws(() => admission(ask), { status: 400 });
});
test('publication flock fences config mutation and cleanup without holding across HTTP', { skip: process.platform !== 'linux' }, async t => {
  const f = fixture(t), { spawn } = require('node:child_process');
  const stateFile = path.join(f.dir, 'embedding-config.json');
  const config = createEmbeddingConfig({ stateFile, env: {}, nativeOwner: f.owner });
  const holder = spawn('flock', ['-x', `${stateFile}.lock`, process.execPath, '-e', "process.stdout.write('ready');process.stdin.resume()"], { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise(resolve => holder.stdout.once('data', resolve));
  let http = 0, cleanup = 0;
  const migration = createEmbeddingMigration({ config, nativeOwner: f.owner, servedModels: async () => { http++; return ['target']; }, rag: { listIndexes: () => [], dropIndexSlot: () => cleanup++ }, log() {} });
  const pending = migration.setNext({ model: 'target' });
  await new Promise(r => setTimeout(r, 100));
  assert.equal(http, 1, 'HTTP completes outside lock'); assert.equal(config.next(), null);
  const closed = new Promise(r => holder.once('close', r)); holder.stdin.end(); await closed;
  await pending; assert.equal(config.next().model, 'target');
  assert.throws(() => config.setNext({ model: 'bypass' }), /publication lock/);
  await migration.clearNext(); assert.equal(config.next(), null); assert.equal(cleanup, 0); migration.stop();
});

test('unconfirmed native embedding ownership cannot publish healthy retrieval', async t => {
  const health = require('./rust-health.cjs');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-health-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let ready = false;
  const p = health.createRagStatusPublisher({ dataDir, ownerReady: () => ready, rag: { ragAvailable: () => true, retrievalStatus: async () => 'available' } });
  await p.publish();
  assert.equal(JSON.parse(fs.readFileSync(p.file)).retrieval, 'unavailable');
  ready = true; await p.publish();
  assert.equal(JSON.parse(fs.readFileSync(p.file)).retrieval, 'available');
});
