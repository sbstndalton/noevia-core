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
