'use strict';
// #1636: the embedding profile (prompt framing), the one embedding configuration and its admin
// route. No database, no model: synthetic values only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { frame, profileNamed, DEFAULT_PROFILE } = require('./embedding-profile.cjs');
const { createEmbeddingConfig, seedFromEnv, normalizeTarget } = require('./embedding-config.cjs');
const { checkEmbeddingAddress, guardSeededAddresses, deniedAddress } = require('./embedding-address.cjs');
const { createEmbeddingRoutes } = require('./routes/embedding.cjs');

const SAMPLE = ['Plain text.', '  spaced  ', 'title: looks like a prefix | text: but is content', '', 'Zeilen\nUmbruch'];

test('default profile is nomic-v1 and sends every kind of text unchanged (the pre-#1636 wire)', () => {
  assert.equal(DEFAULT_PROFILE, 'nomic-v1');
  for (const kind of ['query', 'document', 'similarity']) {
    assert.deepEqual(frame('nomic-v1', SAMPLE, { kind, titles: SAMPLE.map(() => 'Some title') }), SAMPLE);
  }
  assert.deepEqual(seedFromEnv({}).active, { baseUrl: null, model: 'default', profile: 'nomic-v1' });
  assert.deepEqual(seedFromEnv({ EMBEDDING_MODEL: 'nomic-embed-text-v1', EMBEDDING_BASE_URL: 'http://embed:8080/v1' }).active,
    { baseUrl: 'http://embed:8080/v1', model: 'nomic-embed-text-v1', profile: 'nomic-v1' });
  assert.equal(seedFromEnv({ EMBED_MODEL: 'fallback-name' }).active.model, 'fallback-name', 'EMBED_MODEL stays the fallback name');
});

test('embeddinggemma-2 uses the model card prompts for query, document and similarity', () => {
  assert.deepEqual(frame('embeddinggemma-2', ['what causes rain'], { kind: 'query' }), ['task: search result | query: what causes rain']);
  assert.deepEqual(frame('embeddinggemma-2', ['Rain forms when…'], { kind: 'document' }), ['title: none | text: Rain forms when…']);
  assert.deepEqual(frame('embeddinggemma-2', ['Rain forms when…'], { kind: 'document', titles: ['Weather | notes\nv2'] }), ['title: Weather notes v2 | text: Rain forms when…']);
  assert.deepEqual(frame('embeddinggemma-2', ['a', 'b'], { kind: ['query', 'document'] }), ['task: search result | query: a', 'title: none | text: b']);
  assert.deepEqual(frame('embeddinggemma-2', ['x'], { kind: 'similarity' }), ['task: sentence similarity | query: x']);
});

test('an unknown profile or kind fails closed instead of guessing a framing', () => {
  assert.equal(profileNamed('nomic-v2'), null);
  assert.equal(profileNamed('constructor'), null);
  assert.throws(() => frame('nomic-v2', ['x']), /Unknown embedding profile/);
  assert.throws(() => frame('nomic-v1', ['x'], { kind: 'passage' }), /Unknown embedding kind/);
  assert.throws(() => normalizeTarget({ model: 'm', profile: 'typo' }), (e) => e.status === 400);
});

test('targets are validated: a model name, a known profile, a plain http(s) address', () => {
  assert.deepEqual(normalizeTarget({ model: ' embeddinggemma-2 ', profile: 'embeddinggemma-2', baseUrl: 'http://embed-next:8080/v1/' }),
    { model: 'embeddinggemma-2', profile: 'embeddinggemma-2', baseUrl: 'http://embed-next:8080/v1' });
  assert.equal(normalizeTarget({ model: 'm' }).baseUrl, null, 'no address: the inference engine');
  for (const bad of [{}, { model: 'two words' }, { model: 'm', baseUrl: 'ftp://x' }, { model: 'm', baseUrl: 'http://user:pw@x' }, { model: 'm', baseUrl: 'http://x/?k=1' }]) {
    assert.throws(() => normalizeTarget(bad), (e) => e.status === 400, JSON.stringify(bad));
  }
});

test('the environment seeds the configuration; runtime changes are saved and win on the next start', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embcfg-'));
  const stateFile = path.join(dir, 'embedding-config.json');
  const env = { EMBEDDING_MODEL: 'nomic-embed-text-v1', EMBEDDING_BASE_URL: 'http://embed:8080/v1',
    EMBEDDING_NEXT_MODEL: 'embeddinggemma-2', EMBEDDING_NEXT_PROFILE: 'embeddinggemma-2', EMBEDDING_NEXT_BASE_URL: 'http://embed-next:8080/v1' };
  const c = createEmbeddingConfig({ env, stateFile });
  assert.equal(c.get().source, 'environment');
  assert.equal(c.next().model, 'embeddinggemma-2');
  assert.equal(fs.existsSync(stateFile), false, 'seeding writes nothing');
  const seen = [];
  c.onChange((s) => seen.push(s.active.model));
  c.switchToNext();
  assert.deepEqual([c.active().model, c.previous().model, c.next()], ['embeddinggemma-2', 'nomic-embed-text-v1', null]);
  assert.deepEqual(seen, ['embeddinggemma-2']);
  assert.equal((fs.statSync(stateFile).mode & 0o777), 0o600);
  const again = createEmbeddingConfig({ env: { EMBEDDING_MODEL: 'something-else' }, stateFile });
  assert.equal(again.active().model, 'embeddinggemma-2');
  assert.equal(again.get().source, 'saved');
  assert.deepEqual(again.modelNames().sort(), ['embeddinggemma-2', 'nomic-embed-text-v1']);
  again.rollback();
  assert.equal(again.active().model, 'nomic-embed-text-v1');
  again.finish();
  assert.equal(again.previous(), null);
  assert.throws(() => again.finish(), (e) => e.code === 'noPrevious');
  assert.throws(() => again.switchToNext(), (e) => e.code === 'noNext');
  assert.throws(() => again.setNext({ model: 'nomic-embed-text-v1', baseUrl: 'http://embed:8080/v1' }), (e) => e.code === 'alreadyActive');
});

test('a damaged saved configuration stops the embedding side instead of silently reverting to the environment', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embcfg-'));
  const stateFile = path.join(dir, 'embedding-config.json');
  fs.writeFileSync(stateFile, '{"version":1,"active":{"model":"x","profile":"nope"}}');
  assert.throws(() => createEmbeddingConfig({ env: {}, stateFile }), (e) => e.code === 'badState');
  // The server's loader keeps web up with embeddings off (fail closed) and the file untouched.
  const { loadEmbeddingConfig } = require('./embedding-config.cjs');
  const logs = [];
  const off = loadEmbeddingConfig({ env: { EMBEDDING_MODEL: 'nomic-embed-text-v1' }, stateFile, log: (l) => logs.push(l) });
  assert.match(logs[0], /cannot be read/);
  assert.throws(() => frame(off.active().profile, ['x']), /Unknown embedding profile/);
  assert.throws(() => off.setNext({ model: 'm' }), (e) => e.code === 'badState');
  assert.match(fs.readFileSync(stateFile, 'utf8'), /"nope"/);
});

test('the sidecar delete guard and the keep-alongside list follow the installed configuration', () => {
  const cfgMod = require('./embedding-config.cjs');
  const { sidecarModelNames } = require('./model-system.cjs');
  const { keepAlongside } = require('./llamacpp-manager.cjs');
  assert.deepEqual([...sidecarModelNames({ EMBEDDING_MODEL: 'a', EMBEDDING_NEXT_MODEL: 'b' })].sort(), ['a', 'b'], 'a re-index target is protected too');
  assert.deepEqual(keepAlongside({ EMBEDDING_MODEL: 'nomic' }), ['nomic'], 'without a configuration the environment decides');
  const c = cfgMod.install(createEmbeddingConfig({ env: { EMBEDDING_MODEL: 'on-engine' } }));
  c.setNext({ model: 'sidecar-model', profile: 'embeddinggemma-2', baseUrl: 'http://embed-next:8080/v1' });
  try {
    assert.deepEqual([...sidecarModelNames({})].sort(), ['on-engine', 'sidecar-model']);
    assert.deepEqual(keepAlongside({ EMBEDDING_MODEL: 'ignored', EMBEDDING_BASE_URL: 'http://embed:8080/v1' }), ['on-engine'], 'only targets served by the engine stay beside the chat model');
  } finally { cfgMod.install(null); }
});

// ── routes/embedding.cjs ──────────────────────────────────────────────────────────────────────

function fakeRes() {
  return { status: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; } };
}
// Name resolution is the only thing faked: the address decision itself is the real one.
const DNS = {
  'embed-next': ['10.0.0.7'], embed: ['10.0.0.6'],
  'public.example': ['93.184.216.34'], 'public.example.': ['93.184.216.34'],
  'mixed.example': ['10.0.0.8', '93.184.216.34'], 'mixed6.example': ['::1', '2606:2800:220:1:248:1893:25c8:1946'],
  'xn--bcher-kva.example': ['93.184.216.34'], 'xn--mnchen-3ya.example': ['10.0.0.9'], 'private.example.': ['192.168.1.20'],
  'linklocal.example': ['169.254.169.254'], 'unspecified.example': ['0.0.0.0'], 'mapped.example': ['::ffff:8.8.8.8'],
};
const fakeLookup = async (host) => {
  if (!DNS[host]) throw Object.assign(Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
  return DNS[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};
function routes({ migration, fetchCalls = [], diaryReply = { ok: true, status: 200, body: { active: { model: 'nomic-embed-text-v1' } } }, served = async (t) => [t.model] } = {}) {
  const audits = [];
  const json = (res, status, body) => { res.status = status; res.body = body; return true; };
  const handler = createEmbeddingRoutes({
    json, readJson: async (req) => req.body, migration, authService: { audit: (...a) => audits.push(a) },
    fetchJson: async (url, init) => { fetchCalls.push({ url, init }); return diaryReply; },
    DIARY_BASE: 'http://diary:8010', diaryServiceHeaders: () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer service' }),
    checkAddress: (url) => checkEmbeddingAddress(url, { lookup: fakeLookup }),
    servedModels: served,
  });
  return { handler, audits, fetchCalls };
}
const admin = { user: { id: 'admin-1', role: 'admin' } };
const member = { user: { id: 'member-1', role: 'member' } };

test('/api/embedding is for administrators only and leaves other paths alone', async () => {
  const migration = { status: () => ({ active: { model: 'nomic' } }) };
  const { handler } = routes({ migration });
  const res = fakeRes();
  assert.equal(await handler({ method: 'GET' }, res, { path: '/api/other', authn: admin }), false);
  assert.equal(await handler({ method: 'GET' }, res, { path: '/api/embedding', authn: member }), true);
  assert.equal(res.status, 403);
  const r2 = fakeRes();
  await handler({ method: 'POST', body: { action: 'switch' } }, r2, { path: '/api/embedding', authn: null });
  assert.equal(r2.status, 401);
});

test('a switch goes to projects and to the Diary with the service token only, and is audited', async () => {
  const calls = [];
  const migration = {
    status: () => ({}),
    setNext: (t) => { calls.push(['setNext', t]); return { next: t }; },
    switchToNext: async ({ force }) => { calls.push(['switch', force]); return { active: { model: 'g' } }; },
  };
  const { handler, audits, fetchCalls } = routes({ migration });
  const res = fakeRes();
  await handler({ method: 'POST', body: { action: 'set-next', target: { model: 'embeddinggemma-2', profile: 'embeddinggemma-2', baseUrl: 'http://embed-next:8080/v1' } } }, res, { path: '/api/embedding', authn: admin });
  assert.equal(res.status, 200);
  assert.deepEqual(calls[0], ['setNext', { model: 'embeddinggemma-2', profile: 'embeddinggemma-2', baseUrl: 'http://embed-next:8080/v1' }]);
  assert.equal(fetchCalls[0].url, 'http://diary:8010/api/internal/embedding');
  assert.deepEqual(JSON.parse(fetchCalls[0].init.body), { action: 'set-next', target: { model: 'embeddinggemma-2', profile: 'embeddinggemma-2', base_url: 'http://embed-next:8080/v1' } });
  assert.equal(fetchCalls[0].init.headers.Authorization, 'Bearer service');
  assert.equal(fetchCalls[0].init.headers['X-Cowork-User-ID'], undefined, 'never a tenant header: the Diary acts on its own indexes');
  const r2 = fakeRes();
  await handler({ method: 'POST', body: { action: 'switch', scope: 'projects' } }, r2, { path: '/api/embedding', authn: admin });
  assert.deepEqual(calls[1], ['switch', false]);
  assert.equal(fetchCalls.length, 1, 'scope projects leaves the Diary alone');
  assert.deepEqual(audits.map((a) => a[0]), ['embedding.set-next', 'embedding.switch']);
});

test('a refused switch reports why, per side, without hiding the other side', async () => {
  const migration = { status: () => ({}), switchToNext: async () => { throw Object.assign(Error('not finished'), { status: 409, code: 'notReady', coverage: { chunks: 4, vectors: 1 } }); } };
  const { handler } = routes({ migration });
  const res = fakeRes();
  await handler({ method: 'POST', body: { action: 'switch' } }, res, { path: '/api/embedding', authn: admin });
  assert.equal(res.status, 207);
  assert.equal(res.body.projects.code, 'notReady');
  assert.deepEqual(res.body.projects.coverage, { chunks: 4, vectors: 1 });
  const bad = fakeRes();
  await handler({ method: 'POST', body: { action: 'drop-everything' } }, bad, { path: '/api/embedding', authn: admin });
  assert.equal(bad.status, 400);
});

test('a public embeddings address is refused before anything is sent (local-first)', async () => {
  const calls = [];
  const migration = { status: () => ({}), setNext: (t) => { calls.push(t); return {}; } };
  const { handler, fetchCalls } = routes({ migration });
  for (const target of [
    { model: 'm', baseUrl: 'https://public.example/v1' },
    { model: 'm', baseUrl: 'http://embed-next:8080/v1', diaryBaseUrl: 'https://public.example/v1' },
    // The old check asked "is it public" and let every one of these through:
    { model: 'm', baseUrl: 'http://public.example./v1' }, // trailing dot
    { model: 'm', baseUrl: 'http://xn--bcher-kva.example/v1' }, // internationalised name, public answer
    { model: 'm', baseUrl: 'http://mapped.example/v1' }, // an IPv4-mapped public answer
    { model: 'm', baseUrl: 'http://169.254.169.254/latest' }, // link-local (cloud metadata)
    { model: 'm', baseUrl: 'http://0.0.0.0:8080/v1' },
    { model: 'm', baseUrl: 'http://no-such-host.example/v1' }, // does not resolve
    { model: 'm', baseUrl: 'http://mixed.example/v1' }, // one private and one public answer
    { model: 'm', baseUrl: 'http://embed-next:8080/v1', diaryBaseUrl: 'http://mixed6.example/v1' },
    { model: 'm', baseUrl: 'http://[2606:2800:220:1:248:1893:25c8:1946]/v1' },
    { model: 'm', baseUrl: 'not a url' },
  ]) {
    const res = fakeRes();
    await handler({ method: 'POST', body: { action: 'set-next', target } }, res, { path: '/api/embedding', authn: admin });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'publicEndpoint');
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(fetchCalls, [], 'the Diary is not asked either');
});

test('an accepted embeddings address goes through the route to both halves', async () => {
  const calls = [];
  const migration = { status: () => ({}), setNext: (t) => { calls.push(t); return {}; } };
  const { handler, fetchCalls } = routes({ migration });
  const res = fakeRes();
  await handler({ method: 'POST', body: { action: 'set-next', target: { model: 'm', baseUrl: 'http://private.example./v1', diaryBaseUrl: 'http://127.0.0.1:8081/v1' } } }, res, { path: '/api/embedding', authn: admin });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(fetchCalls.length, 1);
});

// ── the address decision itself (embedding-address.cjs) ───────────────────────────────────────

test('the real resolver path: private literals, localhost and a compose name pass; public and unresolvable names are refused', async () => {
  // No injected lookup here: literals need none, `localhost` is the hosts file, `.invalid` never resolves.
  for (const ok of ['http://127.0.0.1:8080/v1', 'http://10.1.2.3/v1', 'http://192.168.0.5:8081', 'http://172.20.0.9/v1', 'http://[::1]:8080/v1', 'http://localhost:8080/v1', 'https://localhost/v1']) {
    assert.deepEqual(await checkEmbeddingAddress(ok), { ok: true }, ok);
  }
  for (const bad of ['http://8.8.8.8/v1', 'https://93.184.216.34:8443/v1', 'http://[2001:4860:4860::8888]/v1', 'http://[2606:4700:4700::1111]:8080/v1',
    'http://no-such-name.invalid/v1', 'http://no-such-name.invalid./v1', 'ftp://127.0.0.1/', 'http://user:pw@127.0.0.1/', 'file:///etc/passwd', 'http:///', '', 'embed-next:8080']) {
    const r = await checkEmbeddingAddress(bad);
    assert.equal(r.ok, false, bad);
    assert.ok(r.reason, bad);
  }
});

test('a name is accepted only when every answer is private, and the resolver gets the host exactly as written', async () => {
  const asked = [];
  const lookup = async (host, opts) => { asked.push([host, opts.all]); return fakeLookup(host); };
  assert.deepEqual(await checkEmbeddingAddress('http://embed-next:8080/v1', { lookup }), { ok: true });
  assert.deepEqual(await checkEmbeddingAddress('http://private.example./v1', { lookup }), { ok: true }, 'a trailing dot is a name like another');
  assert.equal((await checkEmbeddingAddress('http://public.example./v1', { lookup })).ok, false);
  assert.equal((await checkEmbeddingAddress('http://mixed.example/v1', { lookup })).ok, false);
  assert.equal((await checkEmbeddingAddress('http://mixed6.example/v1', { lookup })).ok, false);
  // An internationalised name reaches the resolver in its xn-- form and is judged by its answers like any other.
  assert.equal((await checkEmbeddingAddress('http://xn--bcher-kva.example/v1', { lookup })).ok, false, 'resolves to a public address');
  assert.deepEqual(await checkEmbeddingAddress('http://münchen.example/v1', { lookup }), { ok: true }, 'resolves to a private address');
  assert.equal(asked.at(-1)[0], 'xn--mnchen-3ya.example');
  assert.equal((await checkEmbeddingAddress('http://empty.example/v1', { lookup: async () => [] })).ok, false, 'no answer at all');
  assert.equal((await checkEmbeddingAddress('http://odd.example/v1', { lookup: async () => [{ address: 'not-an-address' }] })).ok, false);
  assert.equal((await checkEmbeddingAddress('http://slow.example/v1', { lookup: async () => { throw new Error('boom'); } })).ok, false);
  assert.deepEqual(asked.slice(0, 2), [['embed-next', true], ['private.example.', true]]);
  for (const bad of ['linklocal.example', 'unspecified.example', 'mapped.example']) assert.equal((await checkEmbeddingAddress(`http://${bad}/v1`, { lookup })).ok, false, bad);
});

test('addresses the environment seeded are checked at start-up: refused ones are logged and not used, nothing is saved', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embcfg-'));
  const stateFile = path.join(dir, 'embedding-config.json');
  const logs = [];
  const log = (line) => logs.push(line);
  const config = createEmbeddingConfig({ stateFile, log, env: { EMBEDDING_MODEL: 'nomic-embed-text-v1', EMBEDDING_BASE_URL: 'http://127.0.0.1:8080/v1',
    EMBEDDING_NEXT_MODEL: 'embeddinggemma-2', EMBEDDING_NEXT_PROFILE: 'embeddinggemma-2', EMBEDDING_NEXT_BASE_URL: 'http://8.8.8.8:8080/v1' } });
  assert.ok(config.next(), 'seeded first');
  await guardSeededAddresses(config, { log });
  assert.equal(config.next(), null, 'the public next is not used');
  assert.equal(config.active().profile, 'nomic-v1', 'a private active address is left alone');
  assert.equal(config.get().source, 'environment');
  assert.equal(fs.existsSync(stateFile), false);
  assert.match(logs.join('\n'), /EMBEDDING_NEXT_BASE_URL http:\/\/8\.8\.8\.8:8080\/v1 refused/);
  assert.equal(config.damaged, undefined);
  // The operator can still set a good next afterwards.
  config.setNext({ model: 'embeddinggemma-2', profile: 'embeddinggemma-2', baseUrl: 'http://127.0.0.1:8081/v1' });
  assert.equal(config.next().baseUrl, 'http://127.0.0.1:8081/v1');
});

test('a public EMBEDDING_BASE_URL turns embedding off instead of crashing or falling back to the engine', async () => {
  const logs = [];
  const log = (line) => logs.push(line);
  const config = createEmbeddingConfig({ log, env: { EMBEDDING_MODEL: 'nomic-embed-text-v1', EMBEDDING_BASE_URL: 'http://[2001:4860:4860::8888]/v1' } });
  await guardSeededAddresses(config, { log });
  assert.throws(() => frame(config.active().profile, ['x']), /Unknown embedding profile/, 'every embed call refuses');
  assert.match(config.damaged, /EMBEDDING_BASE_URL .* refused/);
  assert.throws(() => config.setNext({ model: 'm' }), (e) => e.code === 'badState');
  assert.match(logs.join('\n'), /must be on this network/);
  // A guard that cannot decide (its check throws) never crashes start-up.
  const other = createEmbeddingConfig({ log, env: { EMBEDDING_BASE_URL: 'http://127.0.0.1:8080/v1' } });
  await guardSeededAddresses(other, { log, check: async () => { throw new Error('boom'); } });
  assert.equal(other.active().profile, 'nomic-v1');
  // A saved configuration was checked when it was set: the guard leaves it alone.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embcfg-'));
  const stateFile = path.join(dir, 'embedding-config.json');
  fs.writeFileSync(stateFile, JSON.stringify({ version: 1, active: { model: 'm', profile: 'nomic-v1', baseUrl: 'http://8.8.8.8/v1' }, next: null, previous: null }));
  const savedConfig = createEmbeddingConfig({ stateFile, log, env: {} });
  await guardSeededAddresses(savedConfig, { log });
  assert.equal(savedConfig.active().profile, 'nomic-v1');
});

test('a forgotten EMBEDDING_NEXT_PROFILE is warned about, with no change of behaviour', () => {
  const logs = [];
  const seeded = seedFromEnv({ EMBEDDING_NEXT_MODEL: 'embeddinggemma-2' }, 'default', (line) => logs.push(line));
  assert.equal(seeded.next.profile, 'nomic-v1');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /EMBEDDING_NEXT_MODEL=embeddinggemma-2 is set without EMBEDDING_NEXT_PROFILE/);
  seedFromEnv({ EMBEDDING_NEXT_MODEL: 'embeddinggemma-2', EMBEDDING_NEXT_PROFILE: 'embeddinggemma-2' }, 'default', (line) => logs.push(line));
  seedFromEnv({}, 'default', (line) => logs.push(line));
  assert.equal(logs.length, 1, 'no warning when the profile is set or no next model is');
});

test('switching is only for the next that was checked', () => {
  const c = createEmbeddingConfig({ env: { EMBEDDING_MODEL: 'nomic-embed-text-v1' } });
  c.setNext({ model: 'embeddinggemma-2', profile: 'embeddinggemma-2' });
  const checked = c.next();
  c.setNext({ model: 'other-model', profile: 'embeddinggemma-2' });
  assert.throws(() => c.switchToNext(checked), (e) => e.code === 'nextChanged' && e.status === 409);
  assert.equal(c.active().model, 'nomic-embed-text-v1');
  assert.equal(c.next().model, 'other-model');
  c.switchToNext(c.next());
  assert.equal(c.active().model, 'other-model');
});

test('addresses that are not public but name no host on this network are refused: unspecified, link-local, multicast, reserved', async () => {
  for (const bad of ['http://0.0.0.0:8080/v1', 'http://0.1.2.3/v1', 'http://169.254.169.254/latest', 'http://224.0.0.1/', 'http://239.255.255.250/', 'http://240.0.0.1/', 'http://255.255.255.255/',
    'http://192.0.2.10/', 'http://203.0.113.5/', 'http://[::]/', 'http://[fe80::1]/', 'http://[febf::1]/', 'http://[ff02::1]/', 'http://[::ffff:0.0.0.0]/', 'http://[::ffff:169.254.1.1]/',
    'http://[::ffff:8.8.8.8]/', 'http://[::8.8.8.8]/', 'http://[::10.0.0.1]/', 'http://[64:ff9b::a00:1]/', 'http://[2001:db8::1]/']) {
    const r = await checkEmbeddingAddress(bad);
    assert.equal(r.ok, false, bad);
    assert.equal(r.transient, false, `${bad} is a permanent refusal`);
  }
  for (const ok of ['http://127.0.0.1/', 'http://127.255.0.1/', 'http://10.0.0.1/', 'http://172.16.0.1/', 'http://172.31.255.255/', 'http://192.168.255.255/', 'http://100.64.1.1/', 'http://[::1]/', 'http://[fd00::5]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:10.1.2.3]/']) {
    assert.deepEqual(await checkEmbeddingAddress(ok), { ok: true }, ok);
  }
  // The deny list on its own (no policy module involved).
  assert.equal(deniedAddress('127.0.0.1'), null);
  assert.equal(deniedAddress('::1'), null);
  assert.equal(deniedAddress('fd12:3456::1'), null);
  assert.match(deniedAddress('0.0.0.0'), /unspecified/);
  assert.match(deniedAddress('::ffff:0.0.0.0'), /unspecified/);
  assert.match(deniedAddress('fe80::abcd%eth0'), /link-local/);
  assert.match(deniedAddress('239.1.1.1'), /multicast/);
  assert.match(deniedAddress('ff00::1'), /multicast/);
  assert.match(deniedAddress('::'), /unspecified/);
});

test('a trap in the address policy refuses; it does not call the address private', async () => {
  const r = await checkEmbeddingAddress('http://10.0.0.1/v1', { addressesPublic: () => { throw new Error('wasm trap'); } });
  assert.equal(r.ok, false);
  assert.equal(r.transient, false);
  assert.match(r.reason, /could not decide/);
  assert.deepEqual(await checkEmbeddingAddress('http://10.0.0.1/v1', { addressesPublic: () => false }), { ok: true });
});

test('an unresolvable name is not the same as a public one: only a public answer is a permanent refusal', async () => {
  const down = async () => { throw Object.assign(new Error('getaddrinfo EAI_AGAIN embed'), { code: 'EAI_AGAIN' }); };
  const r = await checkEmbeddingAddress('http://embed:8080/v1', { lookup: down });
  assert.deepEqual([r.ok, r.transient], [false, true]);
  assert.equal((await checkEmbeddingAddress('http://embed:8080/v1', { lookup: async () => [] })).transient, true);
  assert.equal((await checkEmbeddingAddress('http://public.example/v1', { lookup: fakeLookup })).transient, false);
  assert.equal((await checkEmbeddingAddress('http://mixed.example/v1', { lookup: fakeLookup })).transient, false);
  assert.equal((await checkEmbeddingAddress('nonsense')).transient, false);
});

function startupGuard({ env = { EMBEDDING_MODEL: 'nomic-embed-text-v1', EMBEDDING_BASE_URL: 'http://embed:8080/v1' }, failures = 0 } = {}) {
  const logs = [], slept = [], scheduled = [];
  const dns = { failing: failures, answers: { embed: ['10.0.0.6'], 'embed-next': ['10.0.0.7'] } };
  const lookup = async (host) => {
    if (dns.failing > 0 || !dns.answers[host]) { dns.failing -= 1; throw Object.assign(new Error(`getaddrinfo EAI_AGAIN ${host}`), { code: 'EAI_AGAIN' }); }
    return dns.answers[host].map((address) => ({ address }));
  };
  const config = createEmbeddingConfig({ env, log: () => {} });
  const options = { log: (line) => logs.push(line), check: (url) => checkEmbeddingAddress(url, { lookup }),
    sleep: async (ms) => { slept.push(ms); }, schedule: (fn, ms) => scheduled.push({ fn, ms }) };
  return { config, dns, logs, slept, scheduled, run: () => guardSeededAddresses(config, options) };
}

test('a resolver that is not up yet at start-up is retried; the seeded address is used once it answers', async () => {
  const g = startupGuard({ failures: 2 });
  await g.run();
  assert.deepEqual(g.slept, [1000, 2000], 'backed off, then the third lookup answered');
  assert.equal(g.config.active().profile, 'nomic-v1');
  assert.equal(g.config.active().baseUrl, 'http://embed:8080/v1');
  assert.equal(g.config.damaged, undefined);
  assert.deepEqual(g.scheduled, []);
  assert.deepEqual(g.logs, []);
});

test('a name that stays unresolvable for ~30 s is held back, re-checked, and used again when it resolves', async () => {
  const g = startupGuard({ failures: 1000, env: { EMBEDDING_MODEL: 'nomic-embed-text-v1', EMBEDDING_BASE_URL: 'http://embed:8080/v1',
    EMBEDDING_NEXT_MODEL: 'embeddinggemma-2', EMBEDDING_NEXT_PROFILE: 'embeddinggemma-2', EMBEDDING_NEXT_BASE_URL: 'http://embed-next:8080/v1' } });
  await g.run();
  assert.equal(g.slept.reduce((a, b) => a + b, 0), 2 * 30000, 'about half a minute of back-off for each of the two addresses before they are held back');
  assert.equal(g.config.active().profile, 'unavailable', 'held back, not trusted unchecked');
  assert.equal(g.config.next(), null);
  assert.match(g.config.damaged, /not used yet/);
  assert.equal(g.scheduled.length, 2);
  assert.ok(g.scheduled.every((s) => s.ms === 60000));
  assert.throws(() => g.config.setNext({ model: 'm' }), (e) => e.code === 'badState');
  // The network comes up: the next round of checks gives the seeded values back.
  g.dns.failing = 0;
  await Promise.all(g.scheduled.splice(0).map((s) => s.fn()));
  assert.equal(g.config.active().profile, 'nomic-v1');
  assert.equal(g.config.next().baseUrl, 'http://embed-next:8080/v1');
  assert.equal(g.config.damaged, undefined);
  assert.deepEqual(g.scheduled, [], 'no further rounds once both are back');
  assert.equal(g.config.get().source, 'environment', 'nothing was saved on the way');
  assert.match(g.logs.join('\n'), /resolves to this network now; in use/);
  g.config.setNext({ model: 'other', profile: 'nomic-v1' }); // changes work again
});

test('a name that later resolves to a public address is a permanent refusal', async () => {
  const g = startupGuard({ failures: 1000 });
  await g.run();
  assert.equal(g.config.active().profile, 'unavailable');
  g.dns.failing = 0;
  g.dns.answers.embed = ['93.184.216.34'];
  await g.scheduled.splice(0)[0].fn();
  assert.equal(g.config.active().profile, 'unavailable');
  assert.match(g.config.damaged, /refused: embed is not on this network/);
  assert.deepEqual(g.scheduled, [], 'not re-checked again');
  g.config.releaseSeeded('active');
  assert.equal(g.config.active().profile, 'unavailable', 'a permanent refusal cannot be released');
});

test('an administrator choosing a next model while the seeded one is held back keeps their choice', async () => {
  const g = startupGuard({ failures: 1000, env: { EMBEDDING_MODEL: 'nomic-embed-text-v1', EMBEDDING_NEXT_MODEL: 'embeddinggemma-2',
    EMBEDDING_NEXT_PROFILE: 'embeddinggemma-2', EMBEDDING_NEXT_BASE_URL: 'http://embed-next:8080/v1' } });
  await g.run();
  assert.equal(g.config.next(), null);
  g.config.setNext({ model: 'chosen', profile: 'nomic-v1', baseUrl: 'http://127.0.0.1:9000/v1' });
  g.dns.failing = 0;
  await g.scheduled.splice(0)[0].fn();
  assert.equal(g.config.next().model, 'chosen');
});

// ── #1660 review: set-next only for a model the embeddings server really serves ──────────────

test('set-next is refused when the embeddings server does not serve the target (single-model sidecar)', async () => {
  const calls = [];
  const migration = { status: () => ({}), setNext: (t) => { calls.push(t); return {}; } };
  const { handler, fetchCalls } = routes({ migration, served: async () => ['nomic-embed-text-v1'] });
  const res = fakeRes();
  await handler({ method: 'POST', body: { action: 'set-next', target: { model: 'embeddinggemma-2', profile: 'embeddinggemma-2', baseUrl: '' } } }, res, { path: '/api/embedding', authn: admin });
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'modelNotServed');
  assert.deepEqual(res.body.served, ['nomic-embed-text-v1']);
  assert.deepEqual(calls, [], 'no re-index started');
  assert.deepEqual(fetchCalls, [], 'the Diary is not asked either');
});

test('set-next is refused when the served models cannot be read, and allowed when the target is listed', async () => {
  const calls = [];
  const migration = { status: () => ({}), setNext: (t) => { calls.push(t); return {}; } };
  const down = routes({ migration, served: async () => { throw new Error('ECONNREFUSED'); } });
  const r1 = fakeRes();
  await down.handler({ method: 'POST', body: { action: 'set-next', target: { model: 'embeddinggemma-2', baseUrl: '' } } }, r1, { path: '/api/embedding', authn: admin });
  assert.equal(r1.status, 409);
  assert.equal(r1.body.code, 'endpointUnverified');
  const up = routes({ migration, served: async (t) => { assert.equal(t.baseUrl, null, 'empty address = the inference engine'); return ['nomic-embed-text-v1', 'embeddinggemma-2']; } });
  const r2 = fakeRes();
  await up.handler({ method: 'POST', body: { action: 'set-next', target: { model: 'embeddinggemma-2', baseUrl: '' } } }, r2, { path: '/api/embedding', authn: admin });
  assert.equal(r2.status, 200);
  assert.equal(calls.length, 1);
});
