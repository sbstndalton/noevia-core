'use strict';
// GET /api/providers/:id/models (#1009): a stored provider's model ids for the routing pickers,
// fetched server-side with the stored key, cached per account and refreshable. Synthetic rows and a
// stubbed fetch only; nothing here reaches a network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createProviderRoutes, modelIdsFrom, MODEL_LIST_TTL_MS, MODEL_REFRESH_GAP_MS } = require('./providers.cjs');

function fixture({ probe = async () => ({ ok: true, status: 200, body: { data: [{ id: 'syn-fast' }, { id: 'syn-smart' }] } }), chatgptOn = false } = {}) {
  const sent = [];
  const probes = [];
  let clock = 1_000_000;
  const providers = [
    { id: 'default', label: 'Local', baseUrl: 'http://engine', apiKey: 'local' },
    { id: 'mine', label: 'Mine', baseUrl: 'https://approved.example/v1', apiKey: 'sk-synthetic-1111' },
    { id: 'inside', label: 'Inside', baseUrl: 'http://10.0.0.9/v1', apiKey: 'sk-synthetic-2222' },
    { id: 'team', label: 'Team', baseUrl: 'http://10.0.0.8/v1', apiKey: 'sk-synthetic-3333', shared: true },
    { id: 'chatgpt-oauth', label: 'ChatGPT', baseUrl: 'https://chatgpt.example/codex', apiKey: '', kind: 'chatgpt-oauth', external: true },
  ];
  const routes = createProviderRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async () => '', readJson: async () => ({}),
    fetchJson: async (url, init, ms) => { probes.push({ url, init, ms }); return probe(url, init, ms); },
    endpointApproved: (authn, url) => authn.user.role === 'admin' || url.startsWith('https://approved.example'),
    PROVIDERS: providers, PROJECTS: [], DEFAULT_PROVIDER_ID: 'default', modelManager: { enabled: true },
    currentWorkspace: () => ({ removeProvider: () => false }), saveProjects: () => {},
    registry: { saveProviders() {}, saveSharedProviders() {}, maskKey: () => null },
    chatgptOAuth: { listModels: async (userId) => [`gpt-syn-${userId}`], status: () => ({ state: 'connected' }) },
    chatgptEnabled: () => chatgptOn,
    now: () => clock,
  });
  const call = async (p, { user = 'u1', role = 'member', method = 'GET' } = {}) => {
    const req = Readable.from([]); req.method = method;
    const url = new URL(`http://x${p}`);
    await routes(req, {}, { path: url.pathname, url, authn: { user: { id: user, role } } });
    return sent.pop();
  };
  return { call, probes, providers, tick: (ms) => { clock += ms; } };
}

test('lists a stored provider with its stored key, server-side, and never returns the key', async () => {
  const f = fixture();
  const r = await f.call('/api/providers/mine/models');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.models, ['syn-fast', 'syn-smart']);
  assert.equal(r.body.cached, false);
  assert.equal(f.probes[0].url, 'https://approved.example/v1/models');
  assert.equal(f.probes[0].init.headers.Authorization, 'Bearer sk-synthetic-1111');
  assert.equal(f.probes[0].init.redirect, 'error');
  assert.ok(!JSON.stringify(r.body).includes('sk-synthetic'));
});

test('caches per account until the TTL or a refresh; another account never reads the cache', async () => {
  const f = fixture();
  await f.call('/api/providers/mine/models');
  const again = await f.call('/api/providers/mine/models');
  assert.equal(again.body.cached, true);
  assert.equal(f.probes.length, 1);
  await f.call('/api/providers/mine/models', { user: 'u2' });
  assert.equal(f.probes.length, 2, 'u2 fetched its own list');
  f.tick(MODEL_REFRESH_GAP_MS);
  const refreshed = await f.call('/api/providers/mine/models?refresh=1');
  assert.equal(refreshed.body.cached, false);
  assert.equal(f.probes.length, 3);
  f.tick(MODEL_LIST_TTL_MS + 1);
  assert.equal((await f.call('/api/providers/mine/models')).body.cached, false);
  assert.equal(f.probes.length, 4);
  f.providers[1].apiKey = 'sk-synthetic-9999';
  assert.equal((await f.call('/api/providers/mine/models')).body.cached, false, 'a new key is a new list');
});

test('refusals: default, unknown, unapproved member origin, wrong method, failing upstream', async () => {
  const f = fixture({ probe: async () => ({ ok: false, status: 401, body: {} }) });
  assert.equal((await f.call('/api/providers/default/models')).status, 400);
  assert.equal((await f.call('/api/providers/ghost/models')).status, 404);
  const inside = await f.call('/api/providers/inside/models');
  assert.equal(inside.status, 400);
  assert.equal(f.probes.length, 0, 'an unapproved origin is never contacted');
  assert.equal((await f.call('/api/providers/mine/models', { method: 'POST' })).status, 405);
  const failed = await f.call('/api/providers/mine/models');
  assert.deepEqual(failed, { status: 502, body: { error: 'provider returned 401' } });
  assert.equal((await f.call('/api/providers/team/models')).status, 502, 'a shared row is used as it is');
});

test('a thrown fetch answers 502 without echoing internals', async () => {
  const f = fixture({ probe: async () => { throw new Error('connect ECONNREFUSED 10.0.0.1 sk-synthetic-1111'); } });
  assert.deepEqual(await f.call('/api/providers/mine/models'), { status: 502, body: { error: 'The provider could not be reached.' } });
});

test('a ChatGPT connection lists through its own sign-in, only while the flag is on', async () => {
  assert.equal((await fixture().call('/api/providers/chatgpt-oauth/models')).status, 404);
  const r = await fixture({ chatgptOn: true }).call('/api/providers/chatgpt-oauth/models');
  assert.deepEqual(r, { status: 200, body: { models: ['gpt-syn-u1'], cached: false } });
});

test('modelIdsFrom keeps distinct, bounded string ids from untrusted JSON', () => {
  assert.deepEqual(modelIdsFrom(null), []);
  assert.deepEqual(modelIdsFrom({ data: 'x' }), []);
  assert.deepEqual(modelIdsFrom({ data: [{ id: ' a ' }, { id: 'a' }, { id: 7 }, null, { id: 'b\u0000c' }, { id: 'x'.repeat(201) }, { id: 'ok/m:1' }] }), ['a', 'ok/m:1']);
  assert.equal(modelIdsFrom({ data: Array.from({ length: 300 }, (_, i) => ({ id: `m${i}` })) }).length, 200);
  assert.equal(modelIdsFrom({ data: Array.from({ length: 300 }, (_, i) => ({ id: `m${i}` })) }, 100).length, 100);
});

test('refreshes closer than the minimum gap are served from the cache', async () => {
  const f = fixture();
  await f.call('/api/providers/mine/models');
  f.tick(MODEL_REFRESH_GAP_MS);
  assert.equal((await f.call('/api/providers/mine/models?refresh=1')).body.cached, false);
  f.tick(1000);
  const again = await f.call('/api/providers/mine/models?refresh=1');
  assert.equal(again.body.cached, true);
  assert.equal(again.body.throttled, true);
  assert.equal(f.probes.length, 2, 'the second refresh did not reach the provider');
  f.tick(MODEL_REFRESH_GAP_MS);
  assert.equal((await f.call('/api/providers/mine/models?refresh=1')).body.cached, false);
  assert.equal(f.probes.length, 3);
});

test('concurrent requests for one list share a single upstream fetch', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = fixture({ probe: async () => { await gate; return { ok: true, status: 200, body: { data: [{ id: 'syn-a' }] } }; } });
  const both = Promise.all([f.call('/api/providers/mine/models'), f.call('/api/providers/mine/models')]);
  await new Promise((r) => setImmediate(r));
  release();
  const [a, b] = await both;
  assert.equal(f.probes.length, 1);
  assert.deepEqual(a.body.models, ['syn-a']);
  assert.deepEqual(b.body.models, ['syn-a']);
});
