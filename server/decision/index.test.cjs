'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createDecisions } = require('./index.cjs');
const { embedBackend, llamaRerankBackend } = require('./backends.cjs');

const items = [{ id: 'a', label: 'apples', score: 0.2 }, { id: 'b', label: 'bananas', score: 0.9 }, { id: 'c', label: 'cherries', score: 0.5 }];
const fallback = { selected: ['b', 'c', 'a'], scores: { a: 0.2, b: 0.9, c: 0.5 }, confidence: null };
const req = (extra = {}) => ({ kind: 'rank', purpose: 'rag.rerank', question: 'q', items, fallback, constraints: { deadlineMs: 200 }, ...extra });
const fake = (decide, extra = {}) => ({ id: 'fake', locality: 'local', supports: () => true, decide, ...extra });

test('the first backend that answers wins, and its answer is tagged with where it came from', async () => {
  const d = createDecisions({ backends: { fake: fake(async () => ({ selected: ['a', 'c', 'b'], scores: { a: 3, b: 1, c: 2 } })) }, chains: { 'rag.rerank': ['fake'] } });
  const r = await d.decide(req());
  assert.deepEqual(r.selected, ['a', 'c', 'b']);
  assert.equal(r.source, 'fake');
});

test('a backend cannot answer outside what the caller allowed', async () => {
  for (const bad of [{ selected: ['a', 'z'], scores: { a: 1, z: 2 } }, { selected: ['a', 'a'], scores: { a: 1 } }, { selected: ['a'], scores: { a: NaN } }, null]) {
    const d = createDecisions({ backends: { fake: fake(async () => bad) }, chains: { 'rag.rerank': ['fake'] } });
    const r = await d.decide(req());
    assert.equal(r.source, 'fallback'); assert.deepEqual(r.selected, fallback.selected); assert.match(r.metadata.fellBack, /no-backend/);
  }
});

test('errors, missed deadlines and a missing chain all resolve to the fallback, never a throw', async () => {
  const slow = fake(() => new Promise((r) => setTimeout(() => r({ selected: ['a'], scores: { a: 1 } }), 500)));
  const boom = fake(async () => { throw Error('down'); });
  const logs = [];
  const d = createDecisions({ backends: { slow, boom }, chains: { 'rag.rerank': ['boom', 'slow'] }, log: (e) => logs.push(e) });
  const r = await d.decide(req({ constraints: { deadlineMs: 50 } }));
  assert.equal(r.source, 'fallback');
  assert.ok(logs.some((l) => l.failed === 'deadline') && logs.some((l) => l.failed === 'down'));
  assert.equal((await createDecisions({ backends: {} }).decide(req())).source, 'fallback');
});

test('a backend that keeps missing its deadline is benched instead of slowing every request', async () => {
  let calls = 0, t = 0;
  const slow = fake(() => { calls++; return new Promise(() => {}); });
  const d = createDecisions({ backends: { slow }, chains: { 'rag.rerank': ['slow'] }, now: () => t });
  for (let i = 0; i < 3; i++) await d.decide(req({ constraints: { deadlineMs: 5 } }));
  await d.decide(req({ constraints: { deadlineMs: 5 } }));
  assert.equal(calls, 3, 'benched after three misses');
  t = 61_000; await d.decide(req({ constraints: { deadlineMs: 5 } }));
  assert.equal(calls, 4, 'tried again after the bench period');
});

test('remote backends are skipped unless policy allowed cloud for this request', async () => {
  const remote = fake(async () => ({ selected: ['a', 'b', 'c'], scores: { a: 3, b: 2, c: 1 } }), { locality: 'remote' });
  const d = createDecisions({ backends: { remote }, chains: { 'rag.rerank': ['remote'] } });
  assert.equal((await d.decide(req())).source, 'fallback');
  assert.equal((await d.decide(req({ context: { cloud: 'allowed' } }))).source, 'remote');
});

test('malformed requests fall back instead of reaching a backend', async () => {
  let reached = false;
  const d = createDecisions({ backends: { fake: fake(async () => { reached = true; }) }, chains: { 'rag.rerank': ['fake'] } });
  const r = await d.decide({ ...req(), constraints: {} });
  assert.equal(r.source, 'fallback'); assert.equal(reached, false);
});

test('the embed backend is today\'s cosine order', async () => {
  const r = await embedBackend().decide(req());
  assert.deepEqual(r.selected, ['b', 'c', 'a']);
});

test('the llama rerank backend maps /v1/rerank indices back to item ids and refuses partial answers', async () => {
  let sent;
  const ok = llamaRerankBackend({ baseUrl: 'http://engine/v1', fetchImpl: async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return { ok: true, json: async () => ({ results: [{ index: 2, relevance_score: 5 }, { index: 0, relevance_score: 1 }, { index: 1, relevance_score: -2 }] }) }; } });
  const r = await ok.decide(req());
  assert.equal(sent.url, 'http://engine/v1/rerank');
  assert.deepEqual(sent.body.documents, ['apples', 'bananas', 'cherries']);
  assert.deepEqual(r.selected, ['c', 'a', 'b']);
  const partial = llamaRerankBackend({ baseUrl: 'http://engine', fetchImpl: async () => ({ ok: true, json: async () => ({ results: [{ index: 0, relevance_score: 1 }] }) }) });
  await assert.rejects(partial.decide(req()), /partial/);
});

test('a backend past its deadline is cancelled through its signal', async () => {
  let aborted = false;
  const slow = fake((_req, { signal }) => new Promise((resolve) => { signal.addEventListener('abort', () => { aborted = true; resolve(null); }); }));
  const d = createDecisions({ backends: { slow }, chains: { 'rag.rerank': ['slow'] } });
  const r = await d.decide(req({ constraints: { deadlineMs: 30 } }));
  assert.equal(r.source, 'fallback'); assert.equal(aborted, true);
});

