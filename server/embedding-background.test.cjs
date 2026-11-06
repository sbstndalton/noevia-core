'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createOwner, scheduleLegacy, PROTOCOL } = require('./rust-embedding-background.cjs');
const { createEmbeddingConfig } = require('./embedding-config.cjs');
const { createEmbeddingMigration } = require('../tests/fixtures/embedding-migration-node-oracle.cjs');
const { createEmbeddingService } = require('./embedding-service.cjs');
const { createAdmission } = require('./inference-admission-lease.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-owner-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { NOEVIA_START_ID: 'synthetic-start', NOEVIA_PROJECT_STORE_TOKEN: 'synthetic-token', MODEL_LOADER_URL: 'http://127.0.0.1:9999' };
  let clock = 100000;
  const owner = createOwner({ dataDir: dir, env, frontSecret: 'synthetic-token', now: () => clock, features: () => 'rust-embedding-background-v1 rust-index-outbox-v3' });
  return { dir, env, owner, now: () => clock, advance: ms => { clock += ms; } };
}
test('compiled owner refuses missing start, secret or capability', () => {
  assert.throws(() => createOwner({ env: {}, features: () => '' }));
  assert.throws(() => createOwner({ env: { NOEVIA_START_ID: 'a' }, frontSecret: 'b', features: () => 'old' }));
  // #1916: the secret is gone from the environment by the time index.cjs builds the owner; only the captured one counts.
  assert.throws(() => createOwner({ env: { NOEVIA_START_ID: 'a', NOEVIA_PROJECT_STORE_TOKEN: 'b' }, features: () => 'rust-embedding-background-v1 rust-index-outbox-v3' }));
  assert.doesNotThrow(() => createOwner({ env: { NOEVIA_START_ID: 'a' }, frontSecret: 'b', features: () => 'rust-embedding-background-v1 rust-index-outbox-v3' }));
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
  const json = (_, code, body) => { assert.equal(code, 200); assert.deepEqual(body, { protocol: PROTOCOL, start: 'synthetic-start', nodeWorkersStopped: true, indexOutboxStopped: true, foregroundBusy: false }); };
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

test('no-loader host still requires a native migration owner and sends start-bound kicks', t => {
  const f = fixture(t), env = { ...f.env }; delete env.MODEL_LOADER_URL;
  const owner = createOwner({ env, frontSecret: 'synthetic-token', dataDir: f.dir, now: f.now, features: () => 'rust-embedding-background-v1 rust-index-outbox-v3' });
  const config = createEmbeddingConfig({ env: { EMBEDDING_NEXT_MODEL: 'next' }, log() {} });
  const migration = createEmbeddingMigration({ config, nativeOwner: owner, rag: { listIndexes: () => [] } });
  assert.equal(owner.healthy(), false, 'absence of loader is not proof of a migration owner');
  migration.kick();
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.dir, 'embedding-worker-request.json'))).sequence, 1);
  fs.writeFileSync(path.join(f.dir, 'embedding-worker-status.json'), JSON.stringify({ protocol: PROTOCOL, start: env.NOEVIA_START_ID, at: f.now(), configValid: true }));
  assert.equal(owner.healthy(), true); owner.stop(); migration.stop(); assert.equal(owner.healthy(), false);
});

test('paired coverage counts shared custom-directory and orphan indexes supplied by the existing RAG enumerator', t => {
  const f = fixture(t), seen = [];
  const config = createEmbeddingConfig({ env: { EMBEDDING_NEXT_MODEL: 'next' }, log() {} });
  const indexes = [{ userId: null, projectId: 'shared' }, { userId: 'tenant', projectId: 'orphan' }];
  const migration = createEmbeddingMigration({ config, nativeOwner: f.owner, rag: {
    listIndexes: () => indexes,
    indexCoverage(entry, target) { seen.push(entry); return { chunks: 3, vectors: target.model === 'next' ? 2 : 3 }; },
  } });
  const c = migration.status().coverage.next;
  assert.deepEqual(c, { indexes: 2, chunks: 6, vectors: 4, unavailable: 0, complete: false, ready: false });
  assert.ok(seen.includes(indexes[0])); assert.ok(seen.includes(indexes[1])); migration.stop();
});

for (const action of ['clear-next', 'rollback', 'finish']) {
  test(`paired ${action} catches asynchronous refusal, still calls the other scope and audits`, { skip: process.platform !== 'linux' }, async t => {
    const f = fixture(t);
    const stateFile = path.join(f.dir, 'embedding-config.json');
    const config = createEmbeddingConfig({ stateFile, nativeOwner: f.owner, env: {} });
    // clear-next's real change() refusal occurs inside the same asynchronous
    // publication lock as the noPrevious errors for rollback and finish.
    if (action === 'clear-next') config.refuseSeeded({ active: 'synthetic address refusal' });
    const migration = createEmbeddingMigration({ config, nativeOwner: f.owner, rag: { listIndexes: () => [] }, log() {} });
    const audits = [], diaryCalls = [], replies = [];
    let diaryRefuses = false;
    const routes = require('../tests/fixtures/embedding-route-node-oracle.cjs').createEmbeddingRoutes({
      json: (_, status, body) => replies.push({ status, body }),
      readJson: async req => req.body,
      migration, authService: { audit: (...args) => audits.push(args) },
      DIARY_BASE: 'http://diary.invalid', fetchJson: async (_, options) => {
        diaryCalls.push(options);
        return diaryRefuses ? { ok: false, status: 409, body: { error: 'No previous target', code: 'noPrevious' } } : { ok: true, body: { done: true } };
      },
    });
    const call = async scope => routes({ method: 'POST', body: { action, scope } }, { setHeader() {} }, { path: '/api/embedding', authn: { user: { id: 'synthetic', role: 'admin' } } });
    await call('projects');
    assert.equal(replies.at(-1).status, 409);
    assert.equal(replies.at(-1).body.projects.code, action === 'clear-next' ? 'badState' : 'noPrevious');
    assert.equal(diaryCalls.length, 0);
    await call('all');
    assert.equal(replies.at(-1).status, 207);
    assert.equal(replies.at(-1).body.projects.status, 409);
    assert.deepEqual(replies.at(-1).body.diary, { done: true });
    assert.equal(diaryCalls.length, 1);
    diaryRefuses = true; await call('all');
    assert.equal(replies.at(-1).status, 409);
    assert.equal(audits.length, 3);
    assert.equal(audits[1][0], `embedding.${action}`);
    assert.equal(audits[1][3].projects, 'refused'); assert.equal(audits[1][3].diary, 'ok');
    assert.equal(audits[2][3].diary, 'refused');
    migration.stop();
  });
}

for (const scenario of ['damaged config', 'unknown profile', 'long pass']) {
  test(`${scenario} degrades retrieval while the initialized process stays ready`, async t => {
    const f = fixture(t);
    const configFile = path.join(f.dir, 'embedding-config.json');
    if (scenario === 'damaged config') fs.writeFileSync(configFile, '{damaged');
    const config = require('./embedding-config.cjs').loadEmbeddingConfig({
      stateFile: configFile, env: scenario === 'unknown profile' ? { EMBEDDING_PROFILE: 'unknown' } : {}, log() {},
    });
    if (scenario === 'damaged config') assert.ok(config.damaged);
    if (scenario === 'unknown profile') assert.equal(config.active().profile, 'unknown');
    const snapshot = { protocol: PROTOCOL, start: f.env.NOEVIA_START_ID, at: f.now(), configValid: scenario === 'long pass', configInvalid: scenario === 'long pass' ? null : scenario };
    fs.writeFileSync(path.join(f.dir, 'embedding-worker-status.json'), JSON.stringify(snapshot));
    if (scenario === 'long pass') f.advance(30000); // no native observation until the pass completes
    assert.equal(f.owner.healthy(), false);
    const replies = [];
    const routes = require('./routes/health.cjs').createReadyRoutes({ json: (_, status, body) => replies.push({ status, body }), isReady: () => true, version: 'synthetic' });
    await routes({ method: 'GET' }, {}, { path: '/api/ready' });
    assert.deepEqual(replies, [{ status: 200, body: { ready: true, version: 'synthetic' } }]);
    const health = require('./rust-health.cjs').createRagStatusPublisher({ dataDir: f.dir, ownerReady: () => f.owner.healthy(), rag: { ragAvailable: () => true, retrievalStatus: async () => 'available' } });
    await health.publish();
    assert.equal(JSON.parse(fs.readFileSync(health.file)).retrieval, 'unavailable');
  });
}

test('native source notifications schedule the Node media owner without a second drainer', async () => {
  const { Readable } = require('node:stream');
  const calls = [], replies = [];
  const owner = createOwner({ env: { NOEVIA_START_ID: 'synthetic-start' }, frontSecret: 'synthetic-token', features: () => 'rust-embedding-background-v1 rust-index-outbox-v3', sourceMember: () => true, sourceChanged: (u,p) => calls.push([u,p]) });
  const body = { start: 'synthetic-start', user: '11111111-1111-4111-8111-111111111111', project: 'synthetic-project', file: 'source.md' };
  const req = (value, headers = { 'x-noevia-store-token': 'synthetic-token' }) => Object.assign(Readable.from([JSON.stringify(value)]), { method: 'POST', url: '/internal/embedding-worker-owner/source-changed', headers, socket: { remoteAddress: '127.0.0.1' } });
  const json = (_,status,value) => replies.push({status,value});
  await owner.handleSourceChanged(req(body), {}, json);
  assert.deepEqual(calls, [[body.user,body.project]]);
  assert.equal(replies.at(-1).status, 200);
  await owner.handleSourceChanged(req(body, {}), {}, json);
  await owner.handleSourceChanged(req({...body,start:'old-start'}), {}, json);
  assert.equal(calls.length, 1);
  assert.equal(replies.at(-1).status, 400);
  assert.equal(require('./rust-index-outbox.cjs').createIndexOutbox({userDir:()=>'.'}).drain, undefined);
});

test('Node skill oracle excludes a tracked source after its front matter is removed', () => {
  const file = {name:'source.md',content:'ordinary readable text with no front matter'};
  const {inspect} = require('./instruction-skills.cjs');
  assert.equal(inspect(file, {}), null);
  assert.ok(inspect(file, {instructionSkills:{'source.md':{enabled:false}}}));
});

test('consumer membership guard refreshes the tenant workspace and fails closed', () => {
  const {createSourceMembershipGuard}=require('./rust-embedding-background.cjs');
  let active=true, revoked=false, lookups=0;
  let saved=[{id:'p',files:[{name:'source.md'}]}];
  const workspace={projects:[],assertActive(){if(revoked)throw Error('inactive');},projectsFile:{refresh(items){items.splice(0,items.length,...saved);}}};
  const guard=createSourceMembershipGuard({userExists:u=>active && u==='tenant',workspaceFor:u=>{assert.equal(u,'tenant');lookups++;return workspace;}});
  assert.equal(guard('tenant','p','source.md'),true);
  saved=[{id:'p',files:[]}];assert.equal(guard('tenant','p','source.md'),false);
  saved=[];assert.equal(guard('tenant','p','source.md'),false);
  saved=[{id:'p',files:[{name:'source.md'}]}];revoked=true;assert.equal(guard('tenant','p','source.md'),false);
  revoked=false;active=false;const before=lookups;assert.equal(guard('tenant','p','source.md'),false);assert.equal(lookups,before);
  active=true;assert.equal(guard('other','p','source.md'),false);
});
