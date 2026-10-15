'use strict';
// #1665: the TEI rerank backend (gte-multilingual-reranker-base int8 sidecar). A fake TEI server on
// loopback speaks `POST /rerank {query, texts}` -> `[{index, score}]`. Synthetic chunks only.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const { rerankPool } = require('./rag.cjs');
const { rerankTarget } = require('./rerank-target.cjs');
const { teiRerankBackend } = require('./decision/backends.cjs');
const { modelAssignments } = require('./model-assignments.cjs');

const RERANK_KEYS = ['NOEVIA_FEATURE_RAG_RERANK', 'RERANK_BACKEND', 'RERANK_BASE_URL', 'RERANK_MODEL', 'RERANK_API_KEY', 'RERANK_SHARED_ENGINE', 'INFERENCE_BASE_URL', 'MODEL_MANAGER_BASE_URL', 'LEMONADE_BASE_URL', 'EMBEDDING_BASE_URL'];
// Loopback is "on this network"; everything else counts as public (the Rust address check is not loaded here).
const addressesPublic = (list) => list.some((a) => a !== '127.0.0.1');
const pool = Array.from({ length: 10 }, (_, i) => ({ file: 'synthetic.md', body: `synthetic chunk ${i}`, score: 1 - i / 20 }));
const cosineTop6 = pool.slice(0, 6).map((h) => h.body);

function withEnv(t, values) {
  const saved = Object.fromEntries(RERANK_KEYS.map((k) => [k, process.env[k]]));
  for (const k of RERANK_KEYS) delete process.env[k];
  Object.assign(process.env, values);
  t.after(() => { for (const k of RERANK_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
}

function freshRag() { delete require.cache[require.resolve('./rag.cjs')]; return require('./rag.cjs'); }

// The fake TEI: scores rise with the passage index, so the reranked order is the reverse of cosine.
async function fakeTei(t, { delayMs = 0, reply = null } = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    seen.push({ method: req.method, url: req.url, body, auth: req.headers.authorization || null });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (res.destroyed) return;
    res.setHeader('Content-Type', 'application/json');
    if (req.url !== '/rerank') { res.statusCode = 404; return res.end('{"error":"not found"}'); }
    const rows = reply ? reply(body) : body.texts.map((_, index) => ({ index, score: index / 10 })).sort((a, b) => b.score - a.score);
    res.end(JSON.stringify(rows));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); });
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

function initRag(t, env) {
  withEnv(t, env);
  const rag = freshRag();
  rag._test.setRagFetch(rag._test.makeRagFetch({ addressesPublic }));
  rag.init({ dataDir: os.tmpdir(), embedModel: 'synthetic-embed', inferenceUrl: 'http://127.0.0.1:9/v1' });
  return rag;
}

async function rerankWith(rag, { deadlineMs } = {}) {
  const state = rag._test.rerankState();
  return rerankPool({ query: 'synthetic question', pool, decisions: state ? state.decisions : null, keep: 3, deadlineMs: deadlineMs ?? state?.deadlineMs ?? 1000 });
}

test('#1665: RERANK_BACKEND=tei sends POST /rerank {query, texts} and applies the returned order', async (t) => {
  const tei = await fakeTei(t);
  const rag = initRag(t, { NOEVIA_FEATURE_RAG_RERANK: 'true', RERANK_BACKEND: 'tei', RERANK_BASE_URL: `${tei.url}/v1`, RERANK_API_KEY: 'synthetic-rerank-key' });
  assert.equal(rag._test.rerankState().backend, 'tei');
  const hits = await rerankWith(rag);
  assert.deepEqual(hits.map((h) => h.body), ['synthetic chunk 9', 'synthetic chunk 8', 'synthetic chunk 7']);
  assert.equal(tei.seen.length, 1);
  assert.equal(tei.seen[0].method, 'POST');
  assert.equal(tei.seen[0].url, '/rerank', 'a trailing /v1 is stripped; TEI serves /rerank at the root');
  assert.equal(tei.seen[0].body.query, 'synthetic question');
  assert.deepEqual(tei.seen[0].body.texts, pool.map((h) => h.body));
  assert.equal(tei.seen[0].body.truncate, true);
  assert.equal(tei.seen[0].auth, 'Bearer synthetic-rerank-key', 'only the reranker\'s own key');
});

test('#1665: a TEI reranker slower than the deadline falls back to embedding order without an error', async (t) => {
  const tei = await fakeTei(t, { delayMs: 800 });
  const rag = initRag(t, { NOEVIA_FEATURE_RAG_RERANK: '1', RERANK_BACKEND: 'tei', RERANK_BASE_URL: tei.url });
  const started = Date.now();
  const hits = await rerankWith(rag, { deadlineMs: 150 });
  assert.deepEqual(hits.map((h) => h.body), cosineTop6);
  assert.ok(Date.now() - started < 700, `returned at the deadline, not after the reply (${Date.now() - started} ms)`);
});

test('#1665: a down, failing or partial TEI reranker falls back to embedding order', async (t) => {
  const cases = [
    ['refused', 'http://127.0.0.1:9'],
    ['partial', (await fakeTei(t, { reply: () => [{ index: 0, score: 1 }] })).url],
    ['duplicate index', (await fakeTei(t, { reply: (b) => b.texts.map(() => ({ index: 0, score: 1 })) })).url],
    ['not an array', (await fakeTei(t, { reply: () => ({ error: 'synthetic', error_type: 'Validation' }) })).url],
  ];
  for (const [name, url] of cases) {
    const rag = initRag(t, { NOEVIA_FEATURE_RAG_RERANK: 'true', RERANK_BACKEND: 'tei', RERANK_BASE_URL: url });
    const hits = await rerankWith(rag, { deadlineMs: 1000 });
    assert.deepEqual(hits.map((h) => h.body), cosineTop6, name);
  }
});

test('#1665: a TEI reranker on a public address is refused before any request; retrieval keeps embedding order', async (t) => {
  const rag = initRag(t, { NOEVIA_FEATURE_RAG_RERANK: 'true', RERANK_BACKEND: 'tei', RERANK_BASE_URL: 'http://93.184.216.34:8080' });
  const backend = rag._test.rerankBackend('http://93.184.216.34:8080', 'tei');
  await assert.rejects(backend.decide({ question: 'q', items: [{ id: '0', label: 'x' }] }), (e) => e.code === 'EPUBLICADDR');
  const hits = await rerankWith(rag, { deadlineMs: 1000 });
  assert.deepEqual(hits.map((h) => h.body), cosineTop6);
});

test('#1665: with the reranker flag off no rerank request is sent', async (t) => {
  const tei = await fakeTei(t);
  for (const flag of [undefined, 'false', '0']) {
    const env = { RERANK_BACKEND: 'tei', RERANK_BASE_URL: tei.url, ...(flag === undefined ? {} : { NOEVIA_FEATURE_RAG_RERANK: flag }) };
    const rag = initRag(t, env);
    assert.equal(rag._test.rerankState(), null, `flag ${flag}`);
    assert.deepEqual((await rerankWith(rag)).map((h) => h.body), cosineTop6);
  }
  assert.equal(tei.seen.length, 0);
});

test('#1665: backend selection, default address and unknown values', () => {
  assert.deepEqual(rerankTarget({ NOEVIA_FEATURE_RAG_RERANK: 'true', RERANK_BACKEND: 'tei' }),
    { enabled: true, backend: 'tei', baseUrl: 'http://rerank:8080', model: null, shared: false, reason: null }, 'tei defaults to the local sidecar');
  const remote = rerankTarget({ NOEVIA_FEATURE_RAG_RERANK: 'true', RERANK_BACKEND: 'TEI', RERANK_BASE_URL: 'http://rerank-board.lan:8080' });
  assert.equal(remote.baseUrl, 'http://rerank-board.lan:8080', 'the address is configurable (#1755)');
  assert.equal(remote.backend, 'tei');
  assert.equal(rerankTarget({ NOEVIA_FEATURE_RAG_RERANK: 'true', RERANK_BASE_URL: 'http://rerank:8080/v1' }).backend, 'llamacpp', 'unset keeps llama.cpp');
  assert.equal(rerankTarget({ NOEVIA_FEATURE_RAG_RERANK: 'true' }).enabled, false, 'llama.cpp has no default address');
  const unknown = rerankTarget({ NOEVIA_FEATURE_RAG_RERANK: 'true', RERANK_BACKEND: 'cohere', RERANK_BASE_URL: 'http://rerank:8080' });
  assert.equal(unknown.enabled, false);
  assert.match(unknown.reason, /RERANK_BACKEND must be tei or llamacpp/);
  const shared = rerankTarget({ NOEVIA_FEATURE_RAG_RERANK: 'true', RERANK_BACKEND: 'tei', RERANK_BASE_URL: 'http://llama:8080', INFERENCE_BASE_URL: 'http://llama:8080/v1' });
  assert.equal(shared.enabled, false, 'the shared-engine guard (#697) applies to TEI too');
});

test('#1665: the TEI backend refuses an out-of-range index', async () => {
  const backend = teiRerankBackend({ baseUrl: 'http://rerank:8080', fetchImpl: async () => ({ ok: true, json: async () => [{ index: 0, score: 1 }, { index: 5, score: 2 }] }) });
  await assert.rejects(backend.decide({ question: 'q', items: [{ id: 'a', label: 'x' }, { id: 'b', label: 'y' }] }), /invalid index/);
});

test('#1665: the Models page shows a TEI reranker as active or off, never missing from the GGUF list', () => {
  const installed = [{ name: 'synthetic-chat', labels: [] }, { name: 'qwen3-reranker-0.6b-q8_0', labels: ['reranking'] }];
  const row = (env) => modelAssignments({ installed, env, admin: true }).services.find((s) => s.id === 'reranker');
  assert.deepEqual(row({ NOEVIA_FEATURE_RAG_RERANK: 'true', RERANK_BACKEND: 'tei', RERANK_MODEL: 'gte-multilingual-reranker-base' }),
    { id: 'reranker', model: 'gte-multilingual-reranker-base', state: 'active', canChange: false, options: [] });
  assert.equal(row({ RERANK_BACKEND: 'tei', RERANK_MODEL: 'gte-multilingual-reranker-base' }).state, 'off');
  assert.equal(row({ NOEVIA_FEATURE_RAG_RERANK: 'true', RERANK_MODEL: 'gte-multilingual-reranker-base' }).state, 'missing', 'llama.cpp keeps the #1695 rule');
});

test('#1665 review: extra, repeated, out-of-range or non-integer indices are refused', async () => {
  const items = [{ id: 'a', label: 'x' }, { id: 'b', label: 'y' }];
  const replies = {
    'repeated extra row [0,1,1]': [0, 1, 1].map((index) => ({ index, score: 1 })),
    'out-of-range extra row [0,1,5]': [0, 1, 5].map((index) => ({ index, score: 1 })),
    'repeated [0,0]': [{ index: 0, score: 1 }, { index: 0, score: 2 }],
    'non-integer [0,1.5]': [{ index: 0, score: 1 }, { index: 1.5, score: 2 }],
    'negative [0,-1]': [{ index: 0, score: 1 }, { index: -1, score: 2 }],
  };
  for (const [name, reply] of Object.entries(replies)) {
    const backend = teiRerankBackend({ baseUrl: 'http://rerank:8080', fetchImpl: async () => ({ ok: true, json: async () => reply }) });
    await assert.rejects(backend.decide({ question: 'q', items }), /partial|invalid|repeated/, name);
  }
});

test('#1665 review: the deadline signal reaches the TEI request and aborts it', async (t) => {
  const tei = await fakeTei(t, { delayMs: 2000 });
  let aborted = false;
  const backend = teiRerankBackend({ baseUrl: tei.url, fetchImpl: (u, init) => { init.signal?.addEventListener('abort', () => { aborted = true; }); return fetch(u, init); } });
  const { createDecisions } = require('./decision/index.cjs');
  const d = createDecisions({ backends: { [backend.id]: backend }, chains: { 'rag.rerank': [backend.id] } });
  const started = Date.now();
  const hits = await rerankPool({ query: 'q', pool, decisions: d, keep: 3, deadlineMs: 150 });
  assert.deepEqual(hits.map((h) => h.body), cosineTop6);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(aborted, true, 'the timed-out request was aborted');
  assert.ok(Date.now() - started < 1500);
});
