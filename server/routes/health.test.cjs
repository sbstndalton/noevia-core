'use strict';
// The health route with a fake network: each probe settles on its own, the Diary probe is
// skipped (null) for an account without the add-on, and a probe that throws reads as down.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHealthRoutes } = require('./health.cjs');

function fixture({ diary = true, inference = async () => ({ ok: true }), sidecar = async () => ({ ok: true }), rag = true } = {}) {
  const sent = [], probed = [];
  const routes = createHealthRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    fetchJson: async (url, init) => { probed.push({ url, init }); return url.includes('diary') ? sidecar() : inference(); },
    getProvider: () => ({ baseUrl: 'http://engine:11434/v1/', apiKey: 'k' }),
    providerHeaders: () => ({ Authorization: 'Bearer k' }),
    DEFAULT_PROVIDER_ID: 'default', DIARY_BASE: 'http://diary:8010',
    diaryHeaders: () => ({ 'X-Cowork-User-ID': 'u1' }),
    authService: { diaryEnabled: () => diary },
    rag: { ragAvailable: () => rag },
  });
  const call = (path) => routes({ method: 'GET' }, {}, { path, authn: { user: { id: 'u1' } } });
  return { call, sent, probed };
}

test('both probes up', async () => {
  const f = fixture();
  assert.equal(await f.call('/api/healthz'), false);
  assert.equal(await f.call('/api/health'), true);
  assert.deepEqual(f.sent.pop(), { status: 200, body: { inferenceUp: true, lemonadeUp: true, diaryUp: true, ragAvailable: true } });
  assert.equal(f.probed[0].url, 'http://engine:11434/v1/models');
  assert.deepEqual(f.probed[0].init.headers, { Authorization: 'Bearer k' });
  assert.equal(f.probed[1].url, 'http://diary:8010/api/health');
  assert.deepEqual(f.probed[1].init.headers, { 'X-Cowork-User-ID': 'u1' });
});

test('without the Diary add-on the sidecar is not probed and reads null; a throwing probe reads down', async () => {
  const off = fixture({ diary: false, rag: false });
  await off.call('/api/health');
  assert.deepEqual(off.sent.pop(), { status: 200, body: { inferenceUp: true, lemonadeUp: true, diaryUp: null, ragAvailable: false } });
  assert.equal(off.probed.length, 1);
  const down = fixture({ inference: async () => { throw new Error('ECONNREFUSED'); }, sidecar: async () => ({ ok: false }) });
  await down.call('/api/health');
  assert.deepEqual(down.sent.pop(), { status: 200, body: { inferenceUp: false, lemonadeUp: false, diaryUp: false, ragAvailable: true } });
});
