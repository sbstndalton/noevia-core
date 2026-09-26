'use strict';
// The health route with a fake network: each probe settles on its own, the Diary probe is
// skipped (null) for an account without the add-on, and a probe that throws reads as down.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHealthRoutes, createReadyRoutes } = require('./health.cjs');

function fixture({
  diary = true,
  inference = async () => ({ ok: true }),
  sidecar = async () => ({ ok: true }),
  rag = true,
  retrievalStatus = async () => 'available',
} = {}) {
  const sent = [], probed = [];
  const routes = createHealthRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    fetchJson: async (url, init) => { probed.push({ url, init }); return url.includes('diary') ? sidecar() : inference(); },
    getProvider: () => ({ baseUrl: 'http://engine:11434/v1/', apiKey: 'k' }),
    providerHeaders: () => ({ Authorization: 'Bearer k' }),
    DEFAULT_PROVIDER_ID: 'default', DIARY_BASE: 'http://diary:8010',
    diaryHeaders: () => ({ 'X-Cowork-User-ID': 'u1' }),
    authService: { diaryEnabled: () => diary },
    rag: { ragAvailable: () => rag, retrievalStatus },
  });
  const call = (path) => routes({ method: 'GET' }, {}, { path, authn: { user: { id: 'u1' } } });
  return { call, sent, probed };
}

test('both probes up', async () => {
  const f = fixture();
  assert.equal(await f.call('/api/healthz'), false);
  assert.equal(await f.call('/api/health'), true);
  assert.deepEqual(f.sent.pop(), { status: 200, body: { inferenceUp: true, lemonadeUp: true, diaryUp: true, ragAvailable: true, retrieval: 'available' } });
  assert.equal(f.probed[0].url, 'http://engine:11434/v1/models');
  assert.deepEqual(f.probed[0].init.headers, { Authorization: 'Bearer k' });
  assert.equal(f.probed[1].url, 'http://diary:8010/api/health');
  assert.deepEqual(f.probed[1].init.headers, { 'X-Cowork-User-ID': 'u1' });
});

test('without the Diary add-on the sidecar is not probed and reads null; a throwing probe reads down', async () => {
  const off = fixture({ diary: false, rag: false, retrievalStatus: async () => 'unavailable' });
  await off.call('/api/health');
  assert.deepEqual(off.sent.pop(), { status: 200, body: { inferenceUp: true, lemonadeUp: true, diaryUp: null, ragAvailable: false, retrieval: 'unavailable' } });
  assert.equal(off.probed.length, 1);
  const down = fixture({ inference: async () => { throw new Error('ECONNREFUSED'); }, sidecar: async () => ({ ok: false }) });
  await down.call('/api/health');
  assert.deepEqual(down.sent.pop(), { status: 200, body: { inferenceUp: false, lemonadeUp: false, diaryUp: false, ragAvailable: true, retrieval: 'available' } });
});

// #340: the index can be installed while the embedding endpoint it depends on is unreachable —
// ragAvailable() alone (native deps only) reported "available" in that case. retrieval must say so.
test('#340 an unreachable embedder reads degraded even though ragAvailable (native deps) is true', async () => {
  const f = fixture({ rag: true, retrievalStatus: async () => 'degraded' });
  await f.call('/api/health');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { inferenceUp: true, lemonadeUp: true, diaryUp: true, ragAvailable: true, retrieval: 'degraded' } });
});

// A probe that never settles must not delay the other fields, and a probe that rejects (rather
// than resolving 'degraded' itself) must still read as a truthful, non-throwing status.
test('#340 a hung or rejecting retrieval probe never blocks inference/diary and reads unavailable', async () => {
  const f = fixture({
    retrievalStatus: () => new Promise((_, reject) => setTimeout(() => reject(new Error('probe timed out')), 20)),
  });
  const started = Date.now();
  await f.call('/api/health');
  assert.ok(Date.now() - started < 5000, 'the route did not wait on the slow/rejecting probe past its own bound');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { inferenceUp: true, lemonadeUp: true, diaryUp: true, ragAvailable: true, retrieval: 'unavailable' } });
});

// #297: unauthenticated, no tenant/upstream detail, just whether startup wiring has finished.
test('/api/ready is unauthenticated and reports only {ready, version}', async () => {
  const sent = [];
  let readyFlag = false;
  const routes = createReadyRoutes({ json: (res, status, body) => { sent.push({ status, body }); }, isReady: () => readyFlag, version: '1.2.3' });
  assert.equal(await routes({ method: 'GET' }, {}, { path: '/api/other' }), false, 'unmatched paths pass through');
  assert.equal(await routes({ method: 'GET' }, {}, { path: '/api/ready' }), true);
  assert.deepEqual(sent.pop(), { status: 200, body: { ready: false, version: '1.2.3' } });
  readyFlag = true;
  await routes({ method: 'GET' }, {}, { path: '/api/ready' });
  assert.deepEqual(sent.pop(), { status: 200, body: { ready: true, version: '1.2.3' } });
});

test('/api/ready ignores non-GET methods and never needs an authn context', async () => {
  const sent = [];
  const routes = createReadyRoutes({ json: (res, status, body) => { sent.push({ status, body }); }, isReady: () => true, version: 'v' });
  assert.equal(await routes({ method: 'POST' }, {}, { path: '/api/ready' }), false);
  assert.equal(sent.length, 0);
});
