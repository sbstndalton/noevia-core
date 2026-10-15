'use strict';
// #1306: the ChatGPT model catalogue must honour ?refresh=1. The real chatgpt-oauth.cjs runs
// against a fake upstream at *.fixture.invalid that counts catalogue fetches; no real account,
// token or network is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const Database = require('better-sqlite3');
const { createProviderRoutes, MODEL_REFRESH_GAP_MS } = require('./providers.cjs');
const { createSecretStore } = require('../secrets.cjs');
const chatgpt = require('../chatgpt-oauth.cjs');

const ISSUER = 'https://auth.fixture.invalid';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = `${b64({ alg: 'none' })}.${b64({ email: 'member@example.test', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-synthetic', chatgpt_plan_type: 'plus' } })}.sig`;
const reply = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-chatgpt-1306-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { t: 1_800_000_000_000 };
  const upstream = { fetches: 0, slugs: ['gpt-synthetic-a'], down: false, gate: null };
  const fetchImpl = async (url) => {
    url = String(url);
    if (url.endsWith('/deviceauth/usercode')) return reply({ device_auth_id: 'DAID', user_code: 'WXYZ-9876', interval: '1' });
    if (url.endsWith('/deviceauth/token')) return reply({ authorization_code: 'CODE', code_challenge: 'C', code_verifier: 'V' });
    if (url.endsWith('/oauth/token')) return reply({ access_token: 'AT-secret', refresh_token: 'RT-secret', id_token: idToken, expires_in: 3600 });
    if (url.includes('/models?')) {
      upstream.fetches += 1;
      const slugs = upstream.slugs.slice();
      if (upstream.gate) await upstream.gate;
      if (upstream.throws) throw new TypeError('fetch failed');
      if (upstream.down) return reply({ detail: 'down' }, 503);
      return reply({ models: slugs.map((slug) => ({ slug })) });
    }
    throw new Error('unexpected ' + url);
  };
  const oauth = chatgpt.createChatGptOAuth({ db: new Database(':memory:'), secrets: createSecretStore(dir, { env: {} }), fetchImpl, now: () => clock.t, config: { issuer: ISSUER } });
  const accounts = {};
  const routesFor = (userId) => {
    if (accounts[userId]) return accounts[userId];
    const providers = [{ id: 'default', label: 'Local', baseUrl: 'http://engine', apiKey: 'local', shared: true }, chatgpt.providerRow()];
    const sent = [];
    const routes = createProviderRoutes({
      json: (res, status, body) => { sent.push({ status, body }); },
      readBody: async () => '', readJson: async () => ({}),
      fetchJson: async () => { throw new Error('no probe expected'); }, endpointApproved: () => false,
      PROVIDERS: providers, PROJECTS: [], DEFAULT_PROVIDER_ID: 'default', modelManager: { enabled: true },
      currentWorkspace: () => ({ removeProvider: (id) => { const i = providers.findIndex((p) => p.id === id); if (i >= 0) providers.splice(i, 1); return i >= 0; } }),
      saveProjects: () => {}, registry: { saveProviders: () => {}, saveSharedProviders: () => {}, maskKey: () => null },
      chatgptOAuth: oauth, chatgptEnabled: () => true, now: () => clock.t,
    });
    const call = async (method, target) => {
      const url = new URL(target, 'http://noevia.fixture.invalid');
      const req = Readable.from([]);
      req.method = method;
      const handled = await routes(req, {}, { path: url.pathname, url, authn: { user: { id: userId, role: 'member' } } });
      return handled ? sent.pop() : null;
    };
    return (accounts[userId] = { call });
  };
  return { routesFor, clock, oauth, upstream };
}
async function signIn(f, userId) {
  const start = await f.oauth.startDeviceLogin(userId);
  f.clock.t += 1000;
  assert.equal((await f.oauth.pollDeviceLogin(userId, start.loginId)).state, 'connected');
}
const ids = (r) => r.body.models;

for (const route of ['/api/providers/chatgpt/models', `/api/providers/${chatgpt.PROVIDER_ID}/models`]) {
  test(`#1306 ${route}?refresh=1 twice fetches the catalogue twice and shows the changed list`, async (t) => {
    const f = fixture(t);
    await signIn(f, 'user-a');
    const a = f.routesFor('user-a');
    const first = await a.call('GET', `${route}?refresh=1`);
    assert.equal(first.status, 200);
    assert.deepEqual(ids(first), ['gpt-synthetic-a']);
    assert.equal(f.upstream.fetches, 1);
    f.upstream.slugs = ['gpt-synthetic-a', 'gpt-synthetic-b'];
    f.clock.t += MODEL_REFRESH_GAP_MS + 1;
    const second = await a.call('GET', `${route}?refresh=1`);
    assert.equal(f.upstream.fetches, 2, 'an explicit refresh goes upstream');
    assert.deepEqual(ids(second), ['gpt-synthetic-a', 'gpt-synthetic-b']);
    assert.equal(second.body.cached, false);
    assert.equal(second.body.fetchedAt, f.clock.t);
  });
}

test('#1306 a plain read is served from the cache and says so; a held-down refresh is throttled', async (t) => {
  const f = fixture(t);
  await signIn(f, 'user-a');
  const a = f.routesFor('user-a');
  const fetchedAt = f.clock.t;
  assert.equal((await a.call('GET', '/api/providers/chatgpt/models')).body.cached, false);
  f.clock.t += 1000;
  const plain = await a.call('GET', '/api/providers/chatgpt/models');
  assert.deepEqual(plain.body, { models: ['gpt-synthetic-a'], cached: true, fetchedAt });
  assert.equal(f.upstream.fetches, 1);
  assert.equal((await a.call('GET', '/api/providers/chatgpt/models?refresh=1')).body.cached, false);
  const held = await a.call('GET', '/api/providers/chatgpt/models?refresh=1');
  assert.equal(held.body.throttled, true);
  assert.equal(held.body.cached, true);
  assert.equal(f.upstream.fetches, 2, 'a refresh inside the gap does not go upstream');
});

test('#1306 concurrent refreshes share one upstream fetch', async (t) => {
  const f = fixture(t);
  await signIn(f, 'user-a');
  const a = f.routesFor('user-a');
  let release;
  f.upstream.gate = new Promise((r) => { release = r; });
  const both = Promise.all([a.call('GET', '/api/providers/chatgpt/models?refresh=1'), a.call('GET', '/api/providers/chatgpt/models?refresh=1')]);
  await new Promise((r) => setImmediate(r));
  release();
  const [x, y] = await both;
  assert.deepEqual(ids(x), ['gpt-synthetic-a']);
  assert.deepEqual(ids(y), ['gpt-synthetic-a']);
  assert.equal(f.upstream.fetches, 1);
});

test('#1306 a refresh recovers from a remembered failure; the failure is not reported as cached data', async (t) => {
  const f = fixture(t);
  await signIn(f, 'user-a');
  const a = f.routesFor('user-a');
  f.upstream.down = true;
  assert.equal((await a.call('GET', '/api/providers/chatgpt/models')).status, 502);
  assert.equal((await a.call('GET', '/api/providers/chatgpt/models')).status, 502);
  assert.equal(f.upstream.fetches, 1, 'the failure is remembered for plain reads');
  f.upstream.down = false;
  const recovered = await a.call('GET', '/api/providers/chatgpt/models?refresh=1');
  assert.equal(recovered.status, 200);
  assert.deepEqual(ids(recovered), ['gpt-synthetic-a']);
  assert.equal(f.upstream.fetches, 2);
});

test('#1306 accounts are isolated, and a disconnect during a refresh leaves no catalogue behind', async (t) => {
  const f = fixture(t);
  await signIn(f, 'user-a');
  await signIn(f, 'user-b');
  const a = f.routesFor('user-a');
  const b = f.routesFor('user-b');
  await a.call('GET', '/api/providers/chatgpt/models?refresh=1');
  await b.call('GET', '/api/providers/chatgpt/models?refresh=1');
  assert.equal(f.upstream.fetches, 2, 'one account\'s refresh never throttles or serves another');
  f.clock.t += MODEL_REFRESH_GAP_MS + 1;
  let release;
  f.upstream.gate = new Promise((r) => { release = r; });
  f.upstream.slugs = ['gpt-stale-after-disconnect'];
  const pending = a.call('GET', '/api/providers/chatgpt/models?refresh=1');
  await new Promise((r) => setImmediate(r));
  f.oauth.disconnect('user-a');
  release();
  await pending;
  f.upstream.gate = null;
  const after = await a.call('GET', '/api/providers/chatgpt/models');
  assert.equal(after.status, 401, 'disconnected: no cached list survives');
  const other = await b.call('GET', '/api/providers/chatgpt/models');
  assert.deepEqual(ids(other), ['gpt-synthetic-a']);
  assert.equal(other.body.cached, true);
});

test('#1306 review: failing refreshes are throttled too (provider error and network error)', async (t) => {
  const f = fixture(t);
  await signIn(f, 'user-a');
  const a = f.routesFor('user-a');
  f.upstream.down = true;
  assert.equal((await a.call('GET', '/api/providers/chatgpt/models?refresh=1')).status, 502);
  for (let i = 0; i < 5; i++) assert.equal((await a.call('GET', '/api/providers/chatgpt/models?refresh=1')).status, 502, 'remembered failure, no new fetch');
  assert.equal(f.upstream.fetches, 1);
  f.upstream.down = false; f.upstream.throws = true;
  f.clock.t += 61_000; // past the remembered failure: nothing cached at all
  assert.equal((await a.call('GET', '/api/providers/chatgpt/models?refresh=1')).status, 502);
  assert.equal(f.upstream.fetches, 2);
  for (let i = 0; i < 5; i++) {
    const r = await a.call('GET', '/api/providers/chatgpt/models?refresh=1');
    assert.notEqual(r.status, 200);
  }
  assert.equal(f.upstream.fetches, 2, 'a network failure is not remembered, but the 10 s gap still holds');
  f.upstream.throws = false;
  f.clock.t += MODEL_REFRESH_GAP_MS + 1;
  assert.equal((await a.call('GET', '/api/providers/chatgpt/models?refresh=1')).status, 200);
  assert.equal(f.upstream.fetches, 3);
});

test('#1306 review: a failed refresh keeps the last good list for plain reads; only the refresh sees the error', async (t) => {
  const f = fixture(t);
  await signIn(f, 'user-a');
  const a = f.routesFor('user-a');
  const fetchedAt = f.clock.t;
  assert.deepEqual(ids(await a.call('GET', '/api/providers/chatgpt/models')), ['gpt-synthetic-a']);
  for (const mode of ['down', 'throws']) {
    f.upstream.down = mode === 'down'; f.upstream.throws = mode === 'throws';
    f.clock.t += MODEL_REFRESH_GAP_MS + 1;
    assert.equal((await a.call('GET', '/api/providers/chatgpt/models?refresh=1')).status, 502, `${mode}: the refresh fails`);
    const plain = await a.call('GET', '/api/providers/chatgpt/models');
    assert.equal(plain.status, 200, `${mode}: plain read still served`);
    assert.deepEqual(plain.body, { models: ['gpt-synthetic-a'], cached: true, fetchedAt });
  }
});
