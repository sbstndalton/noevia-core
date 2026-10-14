'use strict';
// #1660 review: a re-index target is used only when its embeddings server really serves it.
// Matching rules, the migration layer (set-next, switch, start-up seeding) and rag.servedModels over
// HTTP against a stub server. Synthetic model names only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { servesModel, checkServed } = require('../../server/embedding-served.cjs');
const { createEmbeddingConfig } = require('../../server/embedding-config.cjs');
const { createEmbeddingMigration } = require('../../server/embedding-migration.cjs');

// ── matching ──────────────────────────────────────────────────────────────────────────────────

test('name and name:latest are the same model, case-insensitively', async () => {
  assert.equal(servesModel(['nomic-embed-text:latest'], 'nomic-embed-text'), true);
  assert.equal(servesModel(['nomic-embed-text'], 'Nomic-Embed-Text:latest'), true);
  assert.equal(servesModel(['nomic-embed-text:v1.5'], 'nomic-embed-text'), false, 'another tag is another model');
  assert.equal(servesModel(['nomic-embed-text-v1'], 'nomic-embed-text'), false, 'no prefix match');
  assert.deepEqual(await checkServed(async () => ['nomic-embed-text:latest'], { model: 'nomic-embed-text' }), { ok: true });
});

test('a server listing only a file path is refused with a message that says how to fix it', async () => {
  const r = await checkServed(async () => ['/models/embeddinggemma-2-Q8_0.gguf'], { model: 'embeddinggemma-2' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'modelNotServed');
  assert.match(r.error, /lists only a model file/);
  assert.match(r.error, /--alias embeddinggemma-2/);
  assert.equal(servesModel(['/models/nomic-embed-text.gguf'], 'nomic-embed-text'), false, 'file names are not model names');
});

test('a router listing many models including the target is accepted; unreadable is endpointUnverified', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `chat-model-${i}`).concat(['embeddinggemma-2', 'nomic-embed-text-v1']);
  assert.deepEqual(await checkServed(async () => many, { model: 'embeddinggemma-2' }), { ok: true });
  const notThere = await checkServed(async () => many, { model: 'bge-m3' });
  assert.equal(notThere.code, 'modelNotServed');
  assert.equal(notThere.served.length, 20, 'at most 20 ids are echoed');
  assert.equal((await checkServed(async () => { throw new Error('down'); }, { model: 'x' })).code, 'endpointUnverified');
  assert.equal((await checkServed(async () => ({ data: [] }), { model: 'x' })).code, 'endpointUnverified');
  assert.equal((await checkServed(null, { model: 'x' })).code, 'endpointUnverified', 'no way to ask: never assumed served');
});

// ── migration layer ───────────────────────────────────────────────────────────────────────────

function fakeRag(servedIds) {
  const filled = [];
  const rag = {
    served: servedIds,
    probes: [],
    listIndexes: () => [{ userId: 'u1', projectId: 'p1' }],
    indexCoverage: () => ({ chunks: 1, vectors: 1 }),
    fillMissing: async (_entry, target) => { filled.push(target.model); return { attempted: 0, embedded: 0, refused: [], remaining: 0 }; },
    dropIndexSlot: () => {},
    embed: async () => [[1, 0]],
    servedModels: async (t) => { rag.probes.push(t.baseUrl); if (rag.served instanceof Error) throw rag.served; return rag.served; },
  };
  return { rag, filled };
}

test('next seeded from EMBEDDING_NEXT_MODEL that the server does not serve: not indexed, switch refused (even forced), logged once', async () => {
  const env = { EMBEDDING_MODEL: 'nomic-embed-text-v1', EMBEDDING_BASE_URL: 'http://embed:8080/v1',
    EMBEDDING_NEXT_MODEL: 'embeddinggemma-2', EMBEDDING_NEXT_PROFILE: 'embeddinggemma-2', EMBEDDING_NEXT_BASE_URL: 'http://embed:8080/v1' };
  const config = createEmbeddingConfig({ env, log: () => {} });
  const { rag, filled } = fakeRag(['nomic-embed-text-v1']); // the compose sidecar serves nomic only
  const logs = [];
  const m = createEmbeddingMigration({ config, rag, env: { EMBEDDING_REINDEX_MIN_PAUSE_MS: '0' }, sleep: async () => {}, log: (l) => logs.push(l) });
  try {
    await m.kick();
    await m.kick();
    assert.deepEqual([...new Set(filled)], ['nomic-embed-text-v1'], 'no index is started for the unserved next');
    assert.equal(logs.filter((l) => /not started/.test(l)).length, 1, 'logged once');
    const st = m.status();
    assert.equal(st.nextServed, false);
    assert.equal(st.nextHeld.code, 'modelNotServed');
    assert.equal(config.next().model, 'embeddinggemma-2', 'left pending, not dropped');
    await assert.rejects(m.switchToNext({ force: true }), (e) => e.status === 409 && e.code === 'modelNotServed');
    await assert.rejects(m.switchToNext(), (e) => e.code === 'modelNotServed');
    assert.equal(config.active().model, 'nomic-embed-text-v1', 'nothing switched');
    // The sidecar is restarted with the model: the next pass starts the re-index.
    rag.served = ['nomic-embed-text-v1', 'embeddinggemma-2'];
    filled.length = 0;
    await m.kick();
    assert.ok(filled.includes('embeddinggemma-2'));
    assert.equal(m.status().nextServed, true);
    assert.ok(logs.some((l) => /served now/.test(l)));
  } finally { m.stop(); }
});

test('a next saved before this check existed cannot be force-switched to while the server does not serve it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'served-1660-'));
  const stateFile = path.join(dir, 'embedding-config.json');
  try {
    fs.writeFileSync(stateFile, JSON.stringify({ version: 1, active: { baseUrl: null, model: 'nomic-embed-text-v1', profile: 'nomic-v1' },
      next: { baseUrl: null, model: 'embeddinggemma-2', profile: 'embeddinggemma-2' }, previous: null }));
    const config = createEmbeddingConfig({ env: {}, stateFile, log: () => {} });
    const { rag } = fakeRag(['nomic-embed-text-v1']);
    const m = createEmbeddingMigration({ config, rag, env: {}, sleep: async () => {}, log: () => {} });
    await assert.rejects(m.switchToNext({ force: true }), (e) => e.code === 'modelNotServed');
    rag.served = new Error('ECONNREFUSED');
    await assert.rejects(m.switchToNext({ force: true }), (e) => e.code === 'endpointUnverified');
    assert.equal(config.active().model, 'nomic-embed-text-v1');
    m.stop();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('setNext checks the target\'s own address before saving anything; :latest matches', async () => {
  const config = createEmbeddingConfig({ env: { EMBEDDING_MODEL: 'nomic-embed-text-v1' }, log: () => {} });
  const { rag } = fakeRag(['nomic-embed-text-v1']);
  const m = createEmbeddingMigration({ config, rag, env: {}, sleep: async () => {}, log: () => {} });
  try {
    await assert.rejects(m.setNext({ model: 'embeddinggemma-2', profile: 'embeddinggemma-2', baseUrl: 'http://embed-next:8080/v1' }),
      (e) => e.status === 409 && e.code === 'modelNotServed' && Array.isArray(e.served));
    assert.equal(config.next(), null, 'nothing saved');
    assert.deepEqual(rag.probes, ['http://embed-next:8080/v1']);
    rag.served = ['embeddinggemma-2:latest'];
    await m.setNext({ model: 'embeddinggemma-2', profile: 'embeddinggemma-2', baseUrl: 'http://embed-next:8080/v1' });
    assert.equal(config.next().model, 'embeddinggemma-2');
    await m.kick();
    assert.equal(m.status().nextServed, true);
  } finally { m.stop(); }
});

test('a migration given no way to ask the server refuses (never assumes served)', async () => {
  const config = createEmbeddingConfig({ env: { EMBEDDING_MODEL: 'a' }, log: () => {} });
  const { rag } = fakeRag([]);
  delete rag.servedModels;
  const m = createEmbeddingMigration({ config, rag, env: {}, sleep: async () => {}, log: () => {} });
  await assert.rejects(m.setNext({ model: 'b' }), (e) => e.code === 'endpointUnverified');
  m.stop();
});

// ── rag.servedModels over HTTP ────────────────────────────────────────────────────────────────

function stub(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => { seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || null }); handler(req, res); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ seen, url: `http://127.0.0.1:${srv.address().port}`, close: () => { srv.closeAllConnections?.(); srv.close(); } })));
}
const sendJson = (body) => (req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };

function freshRag(engineUrl) {
  delete require.cache[require.resolve('../../server/rag.cjs')];
  const rag = require('../../server/rag.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'served-rag-1660-'));
  rag.init({ dataDir: dir, inferenceUrl: engineUrl, headersFn: () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer engine-secret' }),
    embeddingConfig: createEmbeddingConfig({ env: { EMBEDDING_MODEL: 'nomic-embed-text-v1' }, log: () => {} }) });
  return rag;
}

test('servedModels reads data[].id, aliases and models[].name / model', async () => {
  const s = await stub(sendJson({ data: [{ id: '/models/nomic.gguf', aliases: ['nomic-embed-text-v1'] }, { id: 'embeddinggemma-2' }, { id: 7 }],
    models: [{ name: 'bge-m3:latest' }, { model: 'qwen3-embedding' }] }));
  try {
    const rag = freshRag('http://engine.invalid');
    const ids = await rag.servedModels({ baseUrl: `${s.url}/v1` });
    assert.deepEqual(ids.sort(), ['/models/nomic.gguf', 'bge-m3:latest', 'embeddinggemma-2', 'nomic-embed-text-v1', 'qwen3-embedding']);
    assert.deepEqual(s.seen.map((x) => `${x.method} ${x.url}`), ['GET /v1/models']);
  } finally { s.close(); }
});

test('servedModels: an explicit address gets no credentials; the engine gets its own headers', async () => {
  const s = await stub(sendJson({ data: [{ id: 'm' }] }));
  try {
    const rag = freshRag(s.url);
    await rag.servedModels({ baseUrl: s.url });
    await rag.servedModels({ baseUrl: null });
    assert.deepEqual(s.seen.map((x) => x.auth), [null, 'Bearer engine-secret']);
  } finally { s.close(); }
});

test('servedModels throws on a non-JSON body, an oversized body, an error status and a timeout', async () => {
  const bad = await stub(sendJson('<html>not json</html>'));
  const big = await stub(sendJson({ data: [{ id: 'x'.repeat(1024 * 1024 + 10) }] }));
  const err = await stub((req, res) => { res.statusCode = 503; res.end('{}'); });
  const slow = await stub(() => { /* never answers */ });
  try {
    const rag = freshRag('http://engine.invalid');
    await assert.rejects(rag.servedModels({ baseUrl: bad.url }));
    await assert.rejects(rag.servedModels({ baseUrl: big.url }), 'an oversized listing is not read');
    await assert.rejects(rag.servedModels({ baseUrl: err.url }), /503/);
    const t0 = Date.now();
    await assert.rejects(rag.servedModels({ baseUrl: slow.url }, { timeoutMs: 150 }));
    assert.ok(Date.now() - t0 < 2000);
  } finally { bad.close(); big.close(); err.close(); slow.close(); }
});

test('servedModelsCached: one request in flight per address, then cached; a failure reads null (unknown)', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = await stub(async (req, res) => { await gate; sendJson({ data: [{ id: 'm' }] })(req, res); });
  try {
    const rag = freshRag('http://engine.invalid');
    const a = rag.servedModelsCached({ baseUrl: s.url });
    const b = rag.servedModelsCached({ baseUrl: s.url });
    release();
    assert.deepEqual(await a, ['m']);
    assert.deepEqual(await b, ['m']);
    assert.deepEqual(await rag.servedModelsCached({ baseUrl: s.url }), ['m']);
    assert.equal(s.seen.length, 1, 'shared and cached');
    assert.equal(await rag.servedModelsCached({ baseUrl: 'http://127.0.0.1:1' }), null, 'unreachable: unknown, never throws');
  } finally { s.close(); }
});

test('servedModelsCached gives up after about 2 s', async () => {
  const slow = await stub(() => { /* never answers */ });
  try {
    const rag = freshRag('http://engine.invalid');
    const t0 = Date.now();
    assert.equal(await rag.servedModelsCached({ baseUrl: slow.url }), null);
    const took = Date.now() - t0;
    assert.ok(took >= 1500 && took < 4000, `took ${took} ms`);
  } finally { slow.close(); }
});
