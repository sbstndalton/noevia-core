'use strict';
// Track R11: /api/embedding is the Rust front's under NOEVIA_RUST_EMBEDDING_ADMIN=rust, and this process then reads
// embedding-config.json again whenever the front changes it; unset, nothing changes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SWITCH, OWNED_PATH, ROUTE_REFUSAL, frontOwns, owned, refuseOwned } = require('./rust-embedding-admin.cjs');
const { createEmbeddingConfig, loadEmbeddingConfig } = require('./embedding-config.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const ask = (method, url, env) => {
  const seen = [];
  const refused = refuseOwned({ method, url, headers: {} }, {}, { parseRequestUrl, json: (_, s, b) => seen.push([s, b]), env });
  return { refused, seen };
};

test('only the switch set to rust hands /api/embedding to the front, every method', () => {
  assert.equal(SWITCH, 'NOEVIA_RUST_EMBEDDING_ADMIN');
  for (const env of [{}, { [SWITCH]: '' }, { [SWITCH]: 'on' }, { [SWITCH]: 'Rust' }, { [SWITCH]: 'node' }]) {
    assert.equal(frontOwns(env), false, JSON.stringify(env));
    for (const m of ['GET', 'POST', 'PUT']) assert.deepEqual(ask(m, OWNED_PATH, env), { refused: false, seen: [] }, m);
  }
  const env = { [SWITCH]: 'rust' };
  assert.equal(frontOwns(env), true);
  for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'HEAD']) assert.deepEqual(ask(m, `${OWNED_PATH}?x=1`, env), { refused: true, seen: [[503, ROUTE_REFUSAL]] }, m);
  assert.equal(ROUTE_REFUSAL.code, 'RUST_EMBEDDING_ADMIN_OWNED');
});

test('every other path stays where it was', () => {
  const env = { [SWITCH]: 'rust' };
  for (const p of ['/api/embedding/', '/api/embeddings', '/api/embedding/x', '/api/internal/embedding', '/internal/embedding-worker-owner']) {
    assert.equal(owned(p), false, p);
    assert.deepEqual(ask('POST', p, env), { refused: false, seen: [] }, p);
  }
});

test('index.cjs mounts the refusal before authentication and reads the switch for the configuration', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  const at = index.indexOf("require('./rust-embedding-admin.cjs').refuseOwned(req, res, { parseRequestUrl, json })");
  assert.ok(at > 0);
  assert.ok(at > index.indexOf('async function handleRequestInner('));
  assert.ok(at < index.indexOf('await embeddingRoutes(req, res'));
  assert.ok(at < index.indexOf('const preAuth = requestAuth.authenticate(req)'));
  assert.match(index, /reread: require\('\.\/rust-embedding-admin\.cjs'\)\.frontOwns\(\)/);
});

const target = (model, extra = {}) => ({ baseUrl: null, model, profile: 'nomic-v1', ...extra });
// As the front writes it: a new file renamed over the old one.
function frontWrites(file, state) {
  const tmp = `${file}.front.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...state }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-embed-reread-'));
  return { dir, file: path.join(dir, 'embedding-config.json'), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('reread: the front\'s change is read before the next read of the configuration, and listeners hear it', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const lines = [];
  const config = createEmbeddingConfig({ env: { EMBEDDING_MODEL: 'qa-embed-a' }, stateFile: f.file, reread: true, log: (l) => lines.push(l) });
  assert.equal(config.get().source, 'environment');
  assert.equal(config.active().model, 'qa-embed-a');
  const heard = [];
  config.onChange((c) => heard.push(c.next?.model ?? null));
  const v0 = config.version();
  frontWrites(f.file, { active: target('qa-embed-a'), next: target('qa-embed-b'), previous: null });
  assert.equal(config.next().model, 'qa-embed-b');
  assert.equal(config.get().source, 'saved');
  assert.equal(config.version(), v0 + 1);
  assert.deepEqual(heard, ['qa-embed-b']);
  // Unchanged file: no further read, no version bump.
  config.get(); config.active();
  assert.equal(config.version(), v0 + 1);
  frontWrites(f.file, { active: target('qa-embed-b'), next: null, previous: target('qa-embed-a') });
  assert.deepEqual(config.modelNames(), ['qa-embed-b', 'qa-embed-a']);
  assert.equal(config.previous().model, 'qa-embed-a');
  assert.deepEqual(lines, []);
});

test('reread: a damaged file switches embedding off and locks changes; a readable one brings it back', (t) => {
  const f = fixture(); t.after(f.cleanup);
  frontWrites(f.file, { active: target('qa-embed-a'), next: null, previous: null });
  const lines = [];
  const config = createEmbeddingConfig({ env: {}, stateFile: f.file, reread: true, log: (l) => lines.push(l) });
  assert.equal(config.active().model, 'qa-embed-a');
  fs.writeFileSync(`${f.file}.bad`, '{damaged'); fs.renameSync(`${f.file}.bad`, f.file);
  assert.equal(config.active().profile, 'unavailable');
  assert.match(config.damaged, /cannot be read/);
  assert.throws(() => config.clearNext(), (e) => e.code === 'badState' && e.status === 409);
  config.get(); // logged once, not on every read
  assert.equal(lines.length, 1);
  frontWrites(f.file, { active: target('qa-embed-c'), next: null, previous: null });
  assert.equal(config.active().model, 'qa-embed-c');
  assert.equal(config.active().profile, 'nomic-v1');
  assert.equal(config.damaged, undefined);
});

test('reread: a removed file keeps the configuration in use; the process\'s own write is not read back', (t) => {
  const f = fixture(); t.after(f.cleanup);
  frontWrites(f.file, { active: target('qa-embed-a'), next: target('qa-embed-b'), previous: null });
  const config = createEmbeddingConfig({ env: { EMBEDDING_MODEL: 'qa-embed-env' }, stateFile: f.file, reread: true, log() {} });
  fs.rmSync(f.file);
  assert.equal(config.active().model, 'qa-embed-a');
  assert.equal(config.next().model, 'qa-embed-b');
  const v = config.version();
  config.clearNext(); // no native owner here: the process's own change, written by persist()
  assert.equal(config.version(), v + 1);
  config.get();
  assert.equal(config.version(), v + 1);
});

test('reread: a saved file wins over the start-up refusal of a seeded address', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const config = createEmbeddingConfig({ env: { EMBEDDING_MODEL: 'qa-embed-a', EMBEDDING_BASE_URL: 'http://qa-embed.invalid' }, stateFile: f.file, reread: true, log() {} });
  config.refuseSeeded({ active: 'qa refused' });
  assert.equal(config.active().profile, 'unavailable');
  frontWrites(f.file, { active: target('qa-embed-b', { baseUrl: 'http://10.0.0.9:8080' }), next: null, previous: null });
  assert.equal(config.active().model, 'qa-embed-b');
  assert.equal(config.damaged, undefined);
  assert.equal(config.refuseSeeded({ active: 'again' }).active.model, 'qa-embed-b');
});

test('unset: the file is read at start-up only, as before', (t) => {
  const f = fixture(); t.after(f.cleanup);
  for (const make of [() => createEmbeddingConfig({ env: {}, stateFile: f.file, log() {} }), () => loadEmbeddingConfig({ env: {}, stateFile: f.file, log() {} })]) {
    frontWrites(f.file, { active: target('qa-embed-a'), next: null, previous: null });
    const config = make();
    const v = config.version();
    frontWrites(f.file, { active: target('qa-embed-b'), next: null, previous: null });
    assert.equal(config.active().model, 'qa-embed-a');
    assert.equal(config.version(), v);
  }
});

test('reread: a file that is there but cannot be read is damaged, retried, and recovers', (t) => {
  const f = fixture(); t.after(f.cleanup);
  frontWrites(f.file, { active: target('qa-embed-a'), next: null, previous: null });
  const lines = [];
  const config = createEmbeddingConfig({ env: {}, stateFile: f.file, reread: true, log: (l) => lines.push(l) });
  assert.equal(config.active().model, 'qa-embed-a');
  fs.rmSync(f.file); fs.mkdirSync(f.file); // EISDIR on read, even as root
  assert.equal(config.active().profile, 'unavailable');
  assert.match(config.damaged, /cannot be read/);
  assert.deepEqual(config.modelNames(), ['qa-embed-a']);
  config.get(); config.active(); // retried, logged once
  assert.equal(lines.length, 1);
  fs.rmdirSync(f.file);
  frontWrites(f.file, { active: target('qa-embed-b'), next: null, previous: null });
  assert.equal(config.active().model, 'qa-embed-b');
  assert.equal(config.damaged, undefined);
});

test('reread: a damaged file is not undone by the seeded-address guard releasing its hold', (t) => {
  const f = fixture(); t.after(f.cleanup);
  const config = createEmbeddingConfig({ env: { EMBEDDING_MODEL: 'qa-embed-a', EMBEDDING_BASE_URL: 'http://qa-embed.invalid' }, stateFile: f.file, reread: true, log() {} });
  config.refuseSeeded({ active: 'qa not resolved yet' }, { transient: true });
  fs.writeFileSync(`${f.file}.bad`, '{"version":2}'); fs.renameSync(`${f.file}.bad`, f.file);
  config.releaseSeeded('active');
  assert.equal(config.active().profile, 'unavailable');
  assert.match(config.damaged, /cannot be read/);
});

test('reread: a file damaged at start-up starts embedding off and recovers once a readable file replaces it', (t) => {
  const f = fixture(); t.after(f.cleanup);
  fs.writeFileSync(f.file, '{damaged');
  const lines = [];
  const config = loadEmbeddingConfig({ env: { EMBEDDING_MODEL: 'qa-embed-env' }, stateFile: f.file, reread: true, log: (l) => lines.push(l) });
  assert.deepEqual(config.active(), { baseUrl: null, model: 'unavailable', profile: 'unavailable' });
  assert.equal(config.get().source, 'environment');
  assert.match(config.damaged, /cannot be read/);
  assert.throws(() => config.setNext(target('qa-embed-x')), (e) => e.code === 'badState' && e.status === 409);
  assert.equal(lines.length, 1);
  frontWrites(f.file, { active: target('qa-embed-b'), next: null, previous: null });
  assert.equal(config.active().model, 'qa-embed-b');
  assert.equal(config.get().source, 'saved');
  assert.equal(config.damaged, undefined);
  // Unset: the start-up stand-in stays off until a restart, as before.
  fs.writeFileSync(`${f.file}.bad`, '{damaged'); fs.renameSync(`${f.file}.bad`, f.file);
  const old = loadEmbeddingConfig({ env: {}, stateFile: f.file, log() {} });
  frontWrites(f.file, { active: target('qa-embed-c'), next: null, previous: null });
  assert.equal(old.active().model, 'unavailable');
});

// Track R11: the front's service change, announced in embedding-service-intent.json, protects what it asks for.
const { createEmbeddingService } = require('./embedding-service.cjs');
function serviceFixture(t, { intent = true } = {}) {
  const f = fixture(); t.after(f.cleanup);
  let clock = 1_000_000, snapshot = null;
  const intentFile = path.join(f.dir, 'embedding-service-intent.json');
  const service = createEmbeddingService({ env: { NOEVIA_START_ID: 'qa-start', MODEL_LOADER_URL: 'http://qa-loader.invalid' }, now: () => clock, log() {},
    nativeOwner: { snapshot: () => snapshot, kick() {} }, fetchJson: async () => { throw Error('no network in tests'); }, intentFile: intent ? intentFile : null });
  const write = (body) => { fs.writeFileSync(`${intentFile}.tmp`, JSON.stringify(body)); fs.renameSync(`${intentFile}.tmp`, intentFile); };
  const announce = (models, done, at = clock) => write({ protocol: 'rust-embedding-service-intent-v1', start: 'qa-start', at, models, done });
  return { service, intentFile, write, announce, now: () => clock, advance: (ms) => { clock += ms; }, set: (snap) => { snapshot = snap; }, seen: (models) => { snapshot = { serviceAt: clock, service: { managed: true, enabled: true, models, running: { loaded: models.map((m) => m.model) } } }; } };
}
const OLD = { model: 'qa-embed-old', file: '/models/qa-embed-old.gguf' }, NEW = { model: 'qa-embed-new', file: '/models/qa-embed-new.gguf' };

test('intent: while the front\'s change runs its models are protected and the status is stale', (t) => {
  const s = serviceFixture(t);
  s.seen([OLD]);
  assert.deepEqual([...s.service.protectedNames()].sort(), ['/models/qa-embed-old.gguf', 'qa-embed-old']);
  assert.equal(s.service.protectionKnown(), true);
  s.announce([OLD, NEW], false);
  assert.ok(s.service.protectedNames().has('qa-embed-new'));
  assert.ok(s.service.protectedNames().has('/models/qa-embed-new.gguf'));
  assert.equal(s.service.protectionKnown(), false);
  assert.equal(s.service.enabled(), null);
  s.advance(1000); s.seen([OLD]); // a native GET during the change cannot clear it
  assert.ok(s.service.protectedNames().has('qa-embed-new'));
  assert.equal(s.service.protectionKnown(), false);
});

test('intent: once done, a native GET from before the change cannot clear its protection; a later one can', (t) => {
  const s = serviceFixture(t);
  s.seen([OLD]);
  s.announce([NEW], false); s.service.protectedNames();
  s.advance(2000); s.announce([NEW], true);
  const done = s.now();
  s.advance(3000); s.seen([OLD]); // started before the PUT ended: within the 6 s bound
  assert.ok(s.service.protectedNames().has('qa-embed-new'));
  assert.ok(s.service.protectedNames().has('qa-embed-old'));
  s.advance(4000); s.seen([NEW]); // past done + 6 s: the service's own answer decides
  assert.ok(s.now() > done + 6000);
  assert.deepEqual([...s.service.protectedNames()].sort(), ['/models/qa-embed-new.gguf', 'qa-embed-new']);
  assert.equal(s.service.protectionKnown(), true);
  s.advance(1000); s.seen([]); // later answers are not overridden by the old intent
  assert.deepEqual([...s.service.protectedNames()], []);
});

test('intent: a change nobody read while it ran is still protected once done, until a later native answer', (t) => {
  const s = serviceFixture(t);
  s.seen([OLD]); s.service.protectedNames();
  s.announce([NEW], false); // nothing asks while the PUT runs
  s.advance(2000); s.announce([NEW], true);
  s.advance(3000); s.seen([OLD]); // inside the 6 s fence
  assert.ok(s.service.protectedNames().has('qa-embed-new'));
  assert.ok(s.service.protectedNames().has('/models/qa-embed-new.gguf'));
  s.advance(5000);
  s.set({ serviceAt: s.now() + 5000, service: { managed: true, enabled: true, models: [OLD] } }); // ahead of this clock: not adopted
  assert.ok(s.service.protectedNames().has('qa-embed-new'));
  s.set({ serviceAt: s.now() }); // no service in it: not adopted either
  assert.ok(s.service.protectedNames().has('qa-embed-new'));
  s.seen([OLD]); // a real answer past the fence decides
  assert.deepEqual([...s.service.protectedNames()].sort(), ['/models/qa-embed-old.gguf', 'qa-embed-old']);
});

test('intent: a change still open after its deadline, another start, a bad file or no switch count for nothing', (t) => {
  const s = serviceFixture(t);
  s.seen([OLD]);
  s.announce([NEW], false, s.now() - 120_001);
  assert.equal(s.service.protectionKnown(), true);
  assert.equal(s.service.protectedNames().has('qa-embed-new'), false);
  for (const body of [{ protocol: 'rust-embedding-service-intent-v1', start: 'other-start', at: s.now(), models: [NEW], done: false },
    { protocol: 'v0', start: 'qa-start', at: s.now(), models: [NEW], done: false },
    { protocol: 'rust-embedding-service-intent-v1', start: 'qa-start', at: s.now() + 60_000, models: [NEW], done: false },
    { protocol: 'rust-embedding-service-intent-v1', start: 'qa-start', at: s.now(), models: 'x', done: false }]) {
    s.write(body);
    assert.equal(s.service.protectedNames().has('qa-embed-new'), false, JSON.stringify(body));
    assert.equal(s.service.protectionKnown(), true, JSON.stringify(body));
  }
  fs.writeFileSync(s.intentFile, '{not json');
  assert.equal(s.service.protectionKnown(), true);
  const u = serviceFixture(t, { intent: false });
  u.seen([OLD]); u.announce([NEW], false);
  assert.equal(u.service.protectedNames().has('qa-embed-new'), false);
  assert.equal(u.service.protectionKnown(), true);
});

test('index.cjs hands the intent file to the service only under the switch', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.match(index, /intentFile: require\('\.\/rust-embedding-admin\.cjs'\)\.frontOwns\(\) \? path\.join\(DATA_DIR, 'embedding-service-intent\.json'\) : null/);
});

test('reread: a read that failed (not the content) is tried again on the next read, without the file changing', (t) => {
  const f = fixture(); t.after(f.cleanup);
  frontWrites(f.file, { active: target('qa-embed-a'), next: null, previous: null });
  const lines = [];
  const config = createEmbeddingConfig({ env: {}, stateFile: f.file, reread: true, log: (l) => lines.push(l) });
  assert.equal(config.active().model, 'qa-embed-a');
  frontWrites(f.file, { active: target('qa-embed-b'), next: null, previous: null });
  const read = fs.readFileSync;
  const failing = t.mock.method(fs, 'readFileSync', function (file, ...rest) {
    if (file === f.file) throw Object.assign(Error('too many open files'), { code: 'EMFILE' });
    return read.call(fs, file, ...rest);
  });
  assert.equal(config.active().profile, 'unavailable');
  config.get();
  assert.equal(lines.length, 1);
  failing.mock.restore(); // the same file, untouched: only the retry can bring it back
  assert.equal(config.active().model, 'qa-embed-b');
  assert.equal(config.damaged, undefined);
  const stat = fs.statSync;
  frontWrites(f.file, { active: target('qa-embed-c'), next: null, previous: null });
  const unseen = t.mock.method(fs, 'statSync', function (file, ...rest) {
    if (file === f.file) throw Object.assign(Error('permission denied'), { code: 'EACCES' });
    return stat.call(fs, file, ...rest);
  });
  assert.equal(config.active().profile, 'unavailable');
  unseen.mock.restore();
  assert.equal(config.active().model, 'qa-embed-c');
});

test('reread: a damaged file refuses any next as badState, before the target is read', (t) => {
  const f = fixture(); t.after(f.cleanup);
  frontWrites(f.file, { active: target('qa-embed-a'), next: null, previous: null });
  const config = createEmbeddingConfig({ env: {}, stateFile: f.file, reread: true, log() {} });
  fs.writeFileSync(`${f.file}.bad`, '{damaged'); fs.renameSync(`${f.file}.bad`, f.file);
  assert.throws(() => config.setNext({ model: 'bad model' }), (e) => e.code === 'badState' && e.status === 409);
});

test('reread: the seeded-address guard does not say "in use" when a damaged file decides', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const { guardSeededAddresses } = require('./embedding-address.cjs');
  const config = createEmbeddingConfig({ env: { EMBEDDING_MODEL: 'qa-embed-a', EMBEDDING_BASE_URL: 'http://qa-embed.invalid' }, stateFile: f.file, reread: true, log() {} });
  const lines = [];
  let answer = { ok: false, transient: true, reason: 'qa not resolved yet' };
  let again = null;
  await guardSeededAddresses(config, { check: async () => answer, log: (l) => lines.push(l), sleep: async () => {}, schedule: (fn) => { again = fn; }, retryDelaysMs: [], recheckMs: 1 });
  assert.equal(config.active().profile, 'unavailable');
  fs.writeFileSync(`${f.file}.bad`, '{"version":2}'); fs.renameSync(`${f.file}.bad`, f.file);
  config.get();
  answer = { ok: true };
  await again();
  assert.equal(lines.some((l) => /in use/.test(l)), false, lines.join('\n'));
  assert.match(config.damaged, /cannot be read/);
});
