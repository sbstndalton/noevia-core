'use strict';
// Sign in with ChatGPT through the provider routes (#447): hidden and refused while the feature is
// off; with it on, a device-code sign-in adds a PRIVATE provider row to that account only, the
// listing shows a state (never a token), and disconnecting deletes tokens, row and project links.
// The real chatgpt-oauth.cjs runs against a fake OpenAI at *.fixture.invalid.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const Database = require('better-sqlite3');
const { createProviderRoutes } = require('./providers.cjs');
const { createSecretStore } = require('../secrets.cjs');
const chatgpt = require('../chatgpt-oauth.cjs');

const ISSUER = 'https://auth.fixture.invalid';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = `${b64({ alg: 'none' })}.${b64({ email: 'member@example.test', 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-synthetic', chatgpt_plan_type: 'plus' } })}.sig`;
const reply = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

function fixture(t, { flag = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-chatgpt-routes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { t: 1_800_000_000_000 };
  const flags = { on: flag };
  const gates = { exchange: null, entered: null };
  const fetchImpl = async (url, init) => {
    url = String(url);
    if (url.endsWith('/deviceauth/usercode')) return reply({ device_auth_id: 'DAID', user_code: 'WXYZ-9876', interval: '1' });
    if (url.endsWith('/deviceauth/token')) return reply({ authorization_code: 'CODE', code_challenge: 'C', code_verifier: 'V' });
    if (url.endsWith('/oauth/token') && gates.exchange) { gates.entered?.(); await gates.exchange; }
    if (url.endsWith('/oauth/token')) return reply({ access_token: 'AT-secret', refresh_token: 'RT-secret', id_token: idToken, expires_in: 3600 });
    if (url.includes('/models?')) return reply({ models: [{ slug: 'gpt-synthetic' }] });
    throw new Error('unexpected ' + url + (init ? '' : ''));
  };
  const oauth = chatgpt.createChatGptOAuth({ db: new Database(':memory:'), secrets: createSecretStore(dir, { env: {} }), fetchImpl, now: () => clock.t, config: { issuer: ISSUER } });
  // One route instance per account, as the request scope gives each account its own workspace view.
  const accounts = {};
  const routesFor = (userId) => {
    if (accounts[userId]) return accounts[userId];
    const providers = [{ id: 'default', label: 'Local', baseUrl: 'http://engine', apiKey: 'local', shared: true }];
    const projects = [{ id: `${userId}-p1` }];
    const saved = { private: 0, projects: 0 };
    const sent = [];
    const routes = createProviderRoutes({
      json: (res, status, body) => { sent.push({ status, body }); },
      readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
      readJson: async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
      fetchJson: async () => { throw new Error('no probe expected'); }, endpointApproved: (authn) => authn.user.role === 'admin',
      PROVIDERS: providers, PROJECTS: projects, DEFAULT_PROVIDER_ID: 'default', modelManager: { enabled: true },
      currentWorkspace: () => ({ removeProvider: (id) => { const i = providers.findIndex((p) => p.id === id); if (i < 0) return false; providers.splice(i, 1); return true; } }),
      saveProjects: () => { saved.projects += 1; },
      registry: { saveProviders: () => { saved.private += 1; }, saveSharedProviders: () => { throw new Error('a ChatGPT row is never shared'); }, maskKey: (k) => (k && k !== 'local' ? `…${k.slice(-4)}` : null) },
      chatgptOAuth: oauth, chatgptEnabled: () => flags.on,
    });
    const call = async (method, p, body, role = 'member') => {
      const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      req.method = method;
      const handled = await routes(req, {}, { path: p, authn: { user: { id: userId, role } } });
      return handled ? sent.pop() : null;
    };
    return (accounts[userId] = { call, providers, projects, saved });
  };
  return { routesFor, flags, clock, oauth, gates };
}
async function signIn(f, userId) {
  const a = f.routesFor(userId);
  const start = await a.call('POST', '/api/providers/chatgpt/device');
  assert.equal(start.status, 200);
  f.clock.t += 1000;
  const done = await a.call('POST', '/api/providers/chatgpt/device/poll', { loginId: start.body.loginId });
  assert.equal(done.body.state, 'connected');
  return { start, done };
}

test('flag off: every ChatGPT route answers 404, and an existing row is hidden from the listing', async (t) => {
  const f = fixture(t, { flag: false });
  const a = f.routesFor('user-a');
  for (const [method, p] of [['GET', '/api/providers/chatgpt'], ['POST', '/api/providers/chatgpt/device'], ['POST', '/api/providers/chatgpt/device/poll'],
    ['GET', '/api/providers/chatgpt/models'], ['DELETE', '/api/providers/chatgpt']]) {
    assert.deepEqual(await a.call(method, p, method === 'POST' ? {} : undefined), { status: 404, body: { error: 'Sign in with ChatGPT is turned off on this server.' } }, `${method} ${p}`);
  }
  a.providers.push(chatgpt.providerRow());
  const list = await a.call('GET', '/api/providers');
  assert.deepEqual(list.body.providers.map((p) => p.id), ['default']);
});

test('flag on: sign-in adds a private, external row for that account only; nothing token-like reaches the client', async (t) => {
  const f = fixture(t);
  const { start, done } = await signIn(f, 'user-a');
  assert.deepEqual(Object.keys(start.body).sort(), ['expiresAt', 'interval', 'loginId', 'userCode', 'verificationUrl']);
  assert.deepEqual(done.body, { state: 'connected', account: { email: 'm…@example.test', plan: 'plus' } });
  const a = f.routesFor('user-a');
  assert.deepEqual(a.providers.at(-1), chatgpt.providerRow());
  assert.equal(a.saved.private, 1, 'saved to the private provider file');
  const status = await a.call('GET', '/api/providers/chatgpt');
  assert.deepEqual(status.body, { state: 'connected', account: { email: 'm…@example.test', plan: 'plus' }, providerId: 'chatgpt-oauth', external: true });
  const list = await a.call('GET', '/api/providers');
  const row = list.body.providers.find((p) => p.id === 'chatgpt-oauth');
  assert.deepEqual(row, { id: 'chatgpt-oauth', label: 'ChatGPT', baseUrl: chatgpt.DEFAULTS.codexBaseUrl, apiKeyMasked: null, isDefault: false, managed: false, shared: false, defaultModel: undefined, kind: 'chatgpt-oauth', external: true, connection: 'connected' });
  for (const reply of [start, done, status, list]) assert.equal(/AT-secret|RT-secret|DAID|acct-synthetic/.test(JSON.stringify(reply.body)), false);
  assert.deepEqual((await a.call('GET', '/api/providers/chatgpt/models')).body, { models: ['gpt-synthetic'], cached: false, fetchedAt: f.clock.t });

  // user B: separate workspace, no row, not connected, cannot finish A's login.
  const b = f.routesFor('user-b');
  assert.equal((await b.call('GET', '/api/providers/chatgpt')).body.state, 'disconnected');
  assert.deepEqual((await b.call('GET', '/api/providers')).body.providers.map((p) => p.id), ['default']);
  const again = await a.call('POST', '/api/providers/chatgpt/device');
  const stolen = await b.call('POST', '/api/providers/chatgpt/device/poll', { loginId: again.body.loginId });
  assert.equal(stolen.status, 403);
  assert.equal((await b.call('GET', '/api/providers/chatgpt')).body.state, 'disconnected');
  const models = await b.call('GET', '/api/providers/chatgpt/models');
  assert.equal(models.status, 401);
  assert.match(models.body.error, /not connected/);
});

test('connecting twice keeps one row; disconnect deletes the tokens, the row and project links', async (t) => {
  const f = fixture(t);
  await signIn(f, 'user-a');
  await signIn(f, 'user-a');
  const a = f.routesFor('user-a');
  assert.equal(a.providers.filter((p) => p.id === 'chatgpt-oauth').length, 1);
  a.projects[0].provider = 'chatgpt-oauth';
  a.projects[0].model = 'gpt-synthetic';
  const out = await a.call('DELETE', '/api/providers/chatgpt');
  assert.deepEqual(out, { status: 200, body: { ok: true, state: 'disconnected' } });
  assert.equal(a.providers.some((p) => p.id === 'chatgpt-oauth'), false);
  assert.equal('provider' in a.projects[0], false, 'the project falls back to the default provider');
  assert.equal('model' in a.projects[0], false, 'the ChatGPT model cannot be sent to the default provider');
  assert.equal(f.oauth.status('user-a').state, 'disconnected');
  // Removing the row through the generic route is also a disconnect.
  await signIn(f, 'user-a');
  a.projects[0].provider = 'chatgpt-oauth';
  a.projects[0].model = 'gpt-synthetic';
  assert.equal((await a.call('DELETE', '/api/providers/chatgpt-oauth')).status, 200);
  assert.equal(f.oauth.status('user-a').state, 'disconnected');
  assert.equal('provider' in a.projects[0], false);
  assert.equal('model' in a.projects[0], false);
});

test('POST /api/providers cannot mint a ChatGPT or external row', async (t) => {
  const f = fixture(t);
  const a = f.routesFor('user-a');
  const r = await a.call('POST', '/api/providers', { label: 'x', baseUrl: 'https://chatgpt.com/backend-api/codex', kind: 'chatgpt-oauth', external: false, id: 'chatgpt-oauth' });
  assert.equal(r.status, 400, 'members still need an approved origin');
  // Even an administrator's generic row gets only the listed fields: no kind, no external mark, a fresh id.
  const admin = await a.call('POST', '/api/providers', { label: 'x', baseUrl: 'https://chatgpt.com/backend-api/codex', kind: 'chatgpt-oauth', external: true, id: 'chatgpt-oauth' }, 'admin');
  assert.equal(admin.status, 200);
  assert.match(admin.body.id, /^prov-/);
  const row = a.providers.at(-1);
  assert.equal(row.kind, undefined);
  assert.equal(row.external, undefined);
  assert.equal(chatgpt.isChatGptProvider(row), false);
});

test('#454: Disconnect while the sign-in is being exchanged wins, and the route does not add the row', async (t) => {
  const f = fixture(t);
  const a = f.routesFor('user-a');
  const start = await a.call('POST', '/api/providers/chatgpt/device');
  let release;
  f.gates.exchange = new Promise((r) => { release = r; });
  const entered = new Promise((r) => { f.gates.entered = r; });
  f.clock.t += 1000;
  const polling = a.call('POST', '/api/providers/chatgpt/device/poll', { loginId: start.body.loginId });
  await entered;
  assert.equal((await a.call('DELETE', '/api/providers/chatgpt')).status, 200);
  release();
  assert.deepEqual((await polling).body, { state: 'cancelled' });
  assert.equal(a.providers.some((p) => p.id === 'chatgpt-oauth'), false);
  assert.equal((await a.call('GET', '/api/providers/chatgpt')).body.state, 'disconnected');
});

test('review: too many sign-in starts answer 429 through the route', async (t) => {
  const f = fixture(t);
  const a = f.routesFor('user-a');
  for (let i = 0; i < 5; i++) assert.equal((await a.call('POST', '/api/providers/chatgpt/device')).status, 200);
  const sixth = await a.call('POST', '/api/providers/chatgpt/device');
  assert.equal(sixth.status, 429);
  assert.match(sixth.body.error, /Too many ChatGPT sign-in attempts/);
});

function nativeStatusFixture({ env, enabled = () => true } = {}) {
  const { rustChatgptStatusOwned } = require('../features.cjs');
  const calls = { status: 0, disconnect: 0, device: 0, poll: 0, cancel: 0, models: 0 };
  const sent = [];
  const oauth = {
    status: () => { calls.status++; return { state: 'disconnected' }; },
    disconnect: () => { calls.disconnect++; },
    startDeviceLogin: async () => { calls.device++; return { state: 'sentinel-device' }; },
    pollDeviceLogin: async () => { calls.poll++; return { state: 'pending' }; },
    cancelDeviceLogin: () => { calls.cancel++; return true; },
    listModels: async () => { calls.models++; return ['sentinel-model']; },
  };
  const routes = createProviderRoutes({
    json: (_res, status, body) => { sent.push({ status, body }); },
    readJson: async () => ({ loginId: 'synthetic' }), readBody: async () => '{}',
    fetchJson: async () => { throw new Error('unexpected network collaborator'); },
    endpointApproved: () => false, PROVIDERS: [], PROJECTS: [], DEFAULT_PROVIDER_ID: 'default',
    modelManager: { enabled: false }, currentWorkspace: () => ({ removeProvider: () => false }), saveProjects: () => {},
    registry: { saveProviders: () => {}, saveSharedProviders: () => {}, maskKey: () => null },
    chatgptOAuth: oauth, chatgptEnabled: enabled,
    chatgptStatusOwned: () => rustChatgptStatusOwned(env),
  });
  const call = async (method, target) => {
    const req = { method, url: target, headers: {} };
    const url = require('../http.cjs').parseRequestUrl(req);
    const handled = await routes(req, {}, { path: url.pathname, url, authn: { user: { id: 'synthetic-owner', role: 'member' } } });
    return handled ? sent.pop() : null;
  };
  return { call, calls };
}
const confirmedStatusEnv = () => ({ NOEVIA_FRONT: 'rust', NOEVIA_RUST_AUTH: '1', NOEVIA_RUST_AUTH_CONFIRMED: '1', NOEVIA_RUST_CHATGPT_STATUS: '1', NOEVIA_RUST_CHATGPT_STATUS_CONFIRMED: '1' });

test('native ChatGPT status: exact GET refuses before product and never falls back', async () => {
  const first = nativeStatusFixture({ env: confirmedStatusEnv(), enabled: () => false });
  assert.equal((await first.call('GET', '/api/providers/chatgpt')).status, 503, 'M6_STATUS_POLICY:owned_get');
  const refusal = { status: 503, body: { error: 'ChatGPT status is owned by the Rust front.', code: 'RUST_CHATGPT_STATUS_OWNED' } };
  for (const enabled of [() => false, () => true, () => { throw new Error('product must not run for owned GET'); }]) {
    const f = nativeStatusFixture({ env: confirmedStatusEnv(), enabled });
    for (const target of ['/api/providers/chatgpt', '/api/providers/chatgpt?query=synthetic', '/api/providers/x/../chatgpt', '/api/providers/%2e/chatgpt']) {
      assert.deepEqual(await f.call('GET', target), refusal);
    }
    assert.equal(f.calls.status, 0);
  }
  const owned = nativeStatusFixture({ env: confirmedStatusEnv() });
  for (const [method, target, status] of [
    ['get', '/api/providers/chatgpt', 405], ['HEAD', '/api/providers/chatgpt', 405], ['OPTIONS', '/api/providers/chatgpt', 405],
    ['POST', '/api/providers/chatgpt', 405], ['GET', '/api/providers/chatgpt/', 405], ['GET', '/api/providers/chatgpt/sibling', 405],
    ['GET', '/api/providers/chatgpt/models', 200], ['POST', '/api/providers/chatgpt/device', 200],
    ['POST', '/api/providers/chatgpt/device/poll', 200], ['POST', '/api/providers/chatgpt/device/cancel', 200],
    ['DELETE', '/api/providers/chatgpt', 200],
  ]) assert.equal((await owned.call(method, target)).status, status, `${method} ${target}`);
  assert.equal(await owned.call('GET', '/api/providers/chatgpt-sibling'), null);
  assert.deepEqual(owned.calls, { status: 0, disconnect: 1, device: 1, poll: 1, cancel: 1, models: 1 });
  for (const env of [{}, { ...confirmedStatusEnv(), NOEVIA_FRONT: 'node' }, { ...confirmedStatusEnv(), NOEVIA_RUST_CHATGPT_STATUS: '0' }, { ...confirmedStatusEnv(), NOEVIA_RUST_AUTH_CONFIRMED: '0' }, { ...confirmedStatusEnv(), NOEVIA_RUST_CHATGPT_STATUS_CONFIRMED: '0' }]) {
    const f = nativeStatusFixture({ env });
    assert.equal((await f.call('GET', '/api/providers/chatgpt')).status, 200);
    assert.equal(f.calls.status, 1, 'Node retains status only while the handoff is unconfirmed');
  }
});

test('native ChatGPT status: Node writes use current feature truth and device gate stays prior', async () => {
  const { createFeatures, REGISTRY } = require('../features.cjs');
  const rows = new Map([['feature:chatgptOAuth', 'true']]);
  const store = { get: key => rows.get(key), set: (key, value) => { rows.set(key, value); } };
  const features = createFeatures({ env: confirmedStatusEnv(), store, registry: { chatgptOAuth: REGISTRY.chatgptOAuth } });
  const f = nativeStatusFixture({ env: confirmedStatusEnv(), enabled: () => features.enabled('chatgptOAuth') });
  rows.set('feature:chatgptOAuth', 'false');
  assert.equal((await f.call('POST', '/api/providers/chatgpt/device')).status, 404);
  assert.equal(f.calls.device, 0);
  rows.set('feature:chatgptOAuth', 'true');
  assert.equal((await f.call('POST', '/api/providers/chatgpt/device')).status, 200);
  store.set = (key, value) => { rows.set(key, value); throw new Error('synthetic committed write then throw'); };
  assert.throws(() => features.set('chatgptOAuth', false, 'synthetic'), /committed write/);
  assert.equal((await f.call('POST', '/api/providers/chatgpt/device')).status, 404);
  assert.equal(f.calls.device, 1, 'a failed cache update cannot start a second Node sign-in');
  store.get = () => { throw new Error('synthetic read failure'); };
  await assert.rejects(() => f.call('POST', '/api/providers/chatgpt/device'), e => e.status === 503);
  assert.equal(f.calls.device, 1);
  assert.equal((await f.call('GET', '/api/providers/chatgpt')).status, 503, 'the native handoff precedes feature read failures');

  // Actual request-auth collaborator methods, without starting index.cjs or reimplementing its gate.
  const { createRequestAuth } = require('../device-auth.cjs');
  const device = { user: { id: 'synthetic-owner' }, device: { id: 'synthetic-device' } };
  const browser = { user: { id: 'synthetic-owner' }, session: { id: 'synthetic-session' } };
  const gate = createRequestAuth({ enabled: () => true, deviceAuth: { authenticate: () => device }, authService: { authenticate: () => browser, csrfValid: () => true } });
  assert.equal(gate.browserOnly(gate.authenticate({ headers: { authorization: 'Bearer nva_synthetic' } }), '/api/providers/chatgpt', 'GET'), true);
  assert.equal(gate.authenticate({ headers: { authorization: 'Bearer nva_synthetic', cookie: 'cowork_session=synthetic' } }), null);
  assert.equal(gate.browserOnly(gate.authenticate({ headers: {} }), '/api/providers/chatgpt', 'GET'), false);
});
