'use strict';
// Rust port track R4: rag.cjs searchProject asks the paired front's native search (rust-retrieval.cjs) only when
// NOEVIA_RUST_RETRIEVAL says so: on, the front's answer unless it defers; shadow, this process's answer with the
// front asked beside it; off, never. Synthetic QA ids and text only; the front is a stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

delete process.env.RAG_DIR;
for (const k of ['EMBEDDING_BASE_URL', 'EMBEDDING_MODEL', 'EMBED_MODEL', 'EMBEDDING_PROFILE', 'EMBEDDING_NEXT_MODEL', 'EMBEDDING_NEXT_BASE_URL', 'EMBEDDING_NEXT_PROFILE', 'NOEVIA_FEATURE_RAG_RERANK', 'RERANK_BASE_URL', 'NOEVIA_RUST_RETRIEVAL']) delete process.env[k];
const { createEmbeddingConfig } = require('./embedding-config.cjs');
const retrieval = require('./rust-retrieval.cjs');

let depsOk = true;
try { require('better-sqlite3'); require('sqlite-vec'); } catch { depsOk = false; }
const dbTest = depsOk ? test : test.skip;

const USER = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'qa-store-secret-0123456789abcdef0123';
const SECTION = 'alpha bravo charlie delta. '.repeat(120);

const OTHER = '55555555-5555-4555-8555-555555555555';
function freshRag(dir, active = () => true) {
  delete require.cache[require.resolve('./rag.cjs')];
  const rag = require('./rag.cjs');
  const config = createEmbeddingConfig({ env: { EMBEDDING_BASE_URL: 'http://127.0.0.1:9', EMBEDDING_MODEL: 'qa-embed', EMBEDDING_PROFILE: 'embeddinggemma-2' }, stateFile: path.join(dir, 'embedding-config.json') });
  rag.init({ dataDir: dir, inferenceUrl: 'http://engine.invalid', embeddingConfig: config,
    userDataDirFn: (id) => path.join(dir, 'users', id), listUserIds: () => [USER, OTHER], userActive: (u) => active(u) });
  // Every text gets the same 4-wide vector: every chunk scores 1. `rag.embeds` counts the requests.
  rag.embeds = 0;
  rag._test.setRagFetch(async (_url, init) => { rag.embeds += 1; return new Response(JSON.stringify({ data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [1, 0, 0, 0] })) }), { status: 200 }); });
  return rag;
}

test('modes: off and unset never build a client; an unknown value is refused with a log line; a missing secret too', () => {
  const lines = [];
  const log = (l) => lines.push(l);
  assert.equal(retrieval.createClient({ env: {}, port: 9, token: TOKEN, log }), null);
  assert.equal(retrieval.createClient({ env: { NOEVIA_RUST_RETRIEVAL: ' off ' }, port: 9, token: TOKEN, log }), null);
  assert.equal(lines.length, 0);
  assert.equal(retrieval.createClient({ env: { NOEVIA_RUST_RETRIEVAL: '1' }, port: 9, token: TOKEN, log }), null);
  assert.equal(retrieval.createClient({ env: { NOEVIA_RUST_RETRIEVAL: 'on' }, port: 9, token: 'short', log }), null);
  assert.equal(retrieval.createClient({ env: { NOEVIA_RUST_RETRIEVAL: 'on' }, port: 0, token: TOKEN, log }), null);
  assert.equal(lines.length, 3);
  assert.equal(retrieval.createClient({ env: { NOEVIA_RUST_RETRIEVAL: 'shadow' }, port: 9, token: TOKEN, log }).mode, 'shadow');
  // Case does not count, as in the front.
  assert.equal(retrieval.createClient({ env: { NOEVIA_RUST_RETRIEVAL: ' On ' }, port: 9, token: TOKEN, log }).mode, 'on');
  assert.equal(retrieval.createClient({ env: { NOEVIA_RUST_RETRIEVAL: 'OFF' }, port: 9, token: TOKEN, log }), null);
  assert.equal(lines.length, 3);
});

test('a front that does not answer in time is a deferral; a refusal is logged once per status', async () => {
  const lines = [];
  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const slow = retrieval.createClient({ env: { NOEVIA_RUST_RETRIEVAL: 'on' }, port: 9, token: TOKEN, fetchImpl: hang, deadlineMs: 30, log: (l) => lines.push(l) });
  // AbortSignal.timeout does not keep the event loop alive by itself.
  const alive = setTimeout(() => {}, 5000);
  try { assert.equal(await slow.ask('qa-proj', 'q', USER, {}), null); } finally { clearTimeout(alive); }
  const refusing = retrieval.createClient({ env: { NOEVIA_RUST_RETRIEVAL: 'on' }, port: 9, token: TOKEN, fetchImpl: async () => new Response('{}', { status: 404 }), log: (l) => lines.push(l) });
  for (let i = 0; i < 3; i++) assert.equal(await refusing.ask('qa-proj', 'q', USER, {}), null);
  assert.deepEqual(lines, ['[rag] the front refused the native search (HTTP 404); this process searches.']);
});

test('the request goes to the loopback store listener with the secret; only a well-formed hits answer counts', async () => {
  const seen = [];
  let answer = { status: 200, body: { hits: [{ file: 'qa-a.md', body: 'qa text', score: 0.5 }] } };
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return new Response(JSON.stringify(answer.body), { status: answer.status }); };
  const client = retrieval.createClient({ env: { NOEVIA_RUST_RETRIEVAL: 'on' }, port: 4567, token: TOKEN, fetchImpl });
  assert.deepEqual(await client.ask('qa-proj', 'qa question', USER, { 'qa-a.md': null }), [{ file: 'qa-a.md', body: 'qa text', score: 0.5 }]);
  assert.equal(seen[0].url, 'http://127.0.0.1:4567/v1/retrieval/search');
  assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].init.headers['x-noevia-store-token'], TOKEN);
  assert.deepEqual(JSON.parse(seen[0].init.body), { user: USER, projectId: 'qa-proj', query: 'qa question', versions: { 'qa-a.md': null } });
  for (const [status, body] of [[200, { defer: 'reranker on' }], [404, { error: 'Not found' }], [401, {}], [200, { hits: [{ file: 'a', body: 'b', score: 'x' }] }], [200, { hits: [{ file: 'a', score: 1 }] }], [200, null]]) {
    answer = { status, body };
    assert.equal(await client.ask('qa-proj', 'q', USER, {}), null, JSON.stringify(body));
  }
  const failing = retrieval.createClient({ env: { NOEVIA_RUST_RETRIEVAL: 'on' }, port: 4567, token: TOKEN, fetchImpl: async () => { throw new Error('refused'); } });
  assert.equal(await failing.ask('qa-proj', 'q', USER, {}), null);
});

test('the shadow line compares counts and the first differing hit, no text', () => {
  const a = { file: 'qa-a.md', body: 'x', score: 1 }, b = { file: 'qa-b.md', body: 'y', score: 0.5 };
  assert.equal(retrieval.compare([a, b], [a, b]), 'match (2 hits)');
  assert.equal(retrieval.compare([a, b], [b, a]), 'differs (node 2 hits, native 2 hits, first difference at 0)');
  assert.equal(retrieval.compare([a], [a, b]), 'differs (node 1 hits, native 2 hits, first difference at 1)');
  assert.equal(retrieval.compare([a], [{ ...a, score: 0.999 }]), 'differs (node 1 hits, native 1 hits, first difference at 0)');
});

dbTest('on: the front answers and this process does not search; a deferral falls back to this process', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-r4-native-'));
  const rag = freshRag(dir);
  await rag.indexProjectFile('qa-proj', 'qa-long.md', SECTION, USER);
  const local = await rag.searchProject('qa-proj', 'alpha', USER);
  assert.ok(local.length > 0 && local.every((h) => h.file === 'qa-long.md'));
  const asked = [];
  const front = [{ file: 'qa-front.md', body: 'qa front text', score: 0.9 }];
  rag.configureNativeSearch({ mode: 'on', ask: async (...a) => { asked.push(a); return front; } });
  const before = rag.embeds;
  assert.deepEqual(await rag.searchProject('qa-proj', 'alpha', USER), front);
  assert.equal(rag.embeds, before, 'this process embedded nothing');
  assert.deepEqual(asked[0], ['qa-proj', 'alpha', USER, {}]);
  rag.configureNativeSearch({ mode: 'on', ask: async () => null });
  assert.deepEqual(await rag.searchProject('qa-proj', 'alpha', USER), local);
  assert.equal(rag.embeds, before + 1, 'a deferral searches here');
  // A project the front deleted (its outbox tombstone) and a removed account: no hits, nothing asked.
  asked.length = 0;
  rag.configureNativeSearch({ mode: 'on', ask: async (...a) => { asked.push(a); return front; } });
  rag.setLifecycleGuard({ generation: () => 0, deletedSince: (p) => p === 'qa-proj' });
  assert.deepEqual(await rag.searchProject('qa-proj', 'alpha', USER), []);
  rag.setLifecycleGuard(null);
  assert.equal(asked.length, 0);
  // No index file: nothing is asked and nothing is created (#1776).
  asked.length = 0;
  rag.configureNativeSearch({ mode: 'on', ask: async (...a) => { asked.push(a); return front; } });
  assert.deepEqual(await rag.searchProject('qa-proj-none', 'alpha', USER), []);
  assert.equal(asked.length, 0);
  rag.configureNativeSearch(null);
});

dbTest('on: a removed account is not asked; the shared index (no account) is this process\'s', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-r4-removed-'));
  let active = true;
  const rag = freshRag(dir, () => active);
  await rag.indexProjectFile('qa-proj', 'qa-long.md', SECTION, USER);
  await rag.indexProjectFile('qa-shared', 'qa-long.md', SECTION, null);
  const asked = [];
  rag.configureNativeSearch({ mode: 'on', ask: async (...a) => { asked.push(a); return [{ file: 'x', body: 'y', score: 1 }]; } });
  try {
    active = false;
    assert.deepEqual(await rag.searchProject('qa-proj', 'alpha', USER), []);
    active = true;
    const shared = await rag.searchProject('qa-shared', 'alpha', null);
    assert.ok(shared.length > 0 && shared.every((h) => h.file === 'qa-long.md'));
    assert.equal(asked.length, 0);
  } finally { rag.configureNativeSearch(null); }
});

dbTest('shadow: this process answers, the front is asked with the wanted versions of the project\'s files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-r4-shadow-'));
  const rag = freshRag(dir);
  await rag.indexProjectFile('qa-proj', 'qa-long.md', SECTION, USER);
  await rag.indexProjectFile('qa-other', 'qa-long.md', SECTION, USER);
  const local = await rag.searchProject('qa-proj', 'alpha', USER);
  const asked = [];
  const lines = [];
  const warn = console.warn;
  console.warn = (l) => lines.push(String(l));
  try {
    rag.configureNativeSearch({ mode: 'shadow', ask: async (...a) => { asked.push(a); return []; } });
    const hits = await rag.searchProject('qa-proj', 'alpha', USER);
    assert.deepEqual(hits, local, 'shadow returns this process\'s hits');
    await new Promise((r) => setImmediate(r));
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0][3], {}, 'nothing is pending for this project');
    assert.ok(lines.some((l) => l === `[rag] native search shadow: differs (node ${local.length} hits, native 0 hits, first difference at 0)`), lines.join('\n'));
    rag.configureNativeSearch({ mode: 'shadow', ask: async () => null });
    await rag.searchProject('qa-proj', 'alpha', USER);
    await new Promise((r) => setImmediate(r));
    assert.ok(lines.includes('[rag] native search shadow: native deferred'));
    // A front that never answers does not hold the answer back.
    rag.configureNativeSearch({ mode: 'shadow', ask: () => new Promise(() => {}) });
    const started = Date.now();
    assert.deepEqual(await rag.searchProject('qa-proj', 'alpha', USER), local);
    assert.ok(Date.now() - started < 2000);
  } finally { console.warn = warn; rag.configureNativeSearch(null); }
});

dbTest('the wanted versions are this account\'s and this project\'s only', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-r4-versions-'));
  const rag = freshRag(dir);
  await rag.indexProjectFile('qa-proj', 'qa-long.md', SECTION, USER);
  // A re-index this process has requested but not run yet: the file's wanted version is the new text's.
  let release;
  const gate = new Promise((r) => { release = r; });
  rag._test.setRagFetch(async (_url, init) => { await gate; return new Response(JSON.stringify({ data: JSON.parse(init.body).input.map((_, index) => ({ index, embedding: [1, 0, 0, 0] })) }), { status: 200 }); });
  const pending = rag.indexProjectFile('qa-proj', 'qa-long.md', SECTION + ' foxtrot.', USER);
  const other = rag.indexProjectFile('qa-other', 'qa-x.md', SECTION + ' golf.', USER);
  // The same project id and file name of another account: not this account's wanted version.
  const otherAccount = rag.indexProjectFile('qa-proj', 'qa-long.md', SECTION + ' hotel.', OTHER);
  const asked = [];
  rag.configureNativeSearch({ mode: 'on', ask: async (...a) => { asked.push(a); return []; } });
  try {
    await rag.searchProject('qa-proj', 'alpha', USER);
    const want = require('node:crypto').createHash('sha256').update(SECTION + ' foxtrot.').digest('hex');
    assert.deepEqual(asked[0][3], { 'qa-long.md': want });
  } finally {
    release();
    await Promise.all([pending, other, otherAccount]);
    rag.configureNativeSearch(null);
  }
});
