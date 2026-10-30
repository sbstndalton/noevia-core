'use strict';
// Sign in with ChatGPT through the provider routes (#447): hidden and refused while the feature is
// off; with it on, a finished sign-in adds a PRIVATE provider row to that account only, the listing
// shows a state (never a token), and disconnecting deletes tokens, row and project links.
// sbstndalton/noevia#2190 round 5: the device sign-in, the tokens and the model list are the Rust
// broker's (noevia-rs chatgpt_oauth_routes.rs, tests/chatgpt_oauth.rs); this mount refuses those
// routes, and a synthetic broker (tests/server/chatgpt-broker-fake.cjs) plays the front here.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const Database = require('better-sqlite3');
const { createProviderRoutes } = require('./providers.cjs');
const STATUS_REFUSAL = { status: 503, body: { error: 'ChatGPT status is owned by the Rust front.', code: 'RUST_CHATGPT_STATUS_OWNED' } };
const BROKER_REFUSAL = { status: 503, body: { error: 'Sign in with ChatGPT is owned by the Rust front.', code: 'RUST_CHATGPT_OAUTH_OWNED' } };
const chatgpt = require('../chatgpt-oauth.cjs');
const { createFakeBroker } = require('../../tests/server/chatgpt-broker-fake.cjs');

function fixture(t, { flag = true } = {}) {
  const clock = { t: 1_800_000_000_000 };
  const flags = { on: flag };
  const db = new Database(':memory:');
  const fake = createFakeBroker({ db, now: () => clock.t });
  const oauth = chatgpt.createChatGptOAuth({ db, broker: fake.broker, signal: fake.signal, now: () => clock.t, fetchImpl: async () => { throw new Error('no upstream in route tests'); } });
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
  return { routesFor, flags, clock, oauth, fake };
}
/** The front finished a device sign-in for `userId` (its broker saved the tokens). */
function signIn(f, userId) {
  f.fake.connect(userId, { accessToken: 'AT-secret', accountId: 'acct-synthetic' });
}

test('flag off: the routes Node keeps answer 404, the broker\'s are refused, and an existing row is hidden from the listing', async (t) => {
  const f = fixture(t, { flag: false });
  const a = f.routesFor('user-a');
  // The status GET is the Rust front's (#1071): refused whatever the flag says.
  assert.deepEqual(await a.call('GET', '/api/providers/chatgpt'), STATUS_REFUSAL);
  // The device sign-in and the model list are the broker's: refused whatever the flag says (#2190).
  for (const [method, p] of [['POST', '/api/providers/chatgpt/device'], ['POST', '/api/providers/chatgpt/device/poll'],
    ['POST', '/api/providers/chatgpt/device/cancel'], ['GET', '/api/providers/chatgpt/models']]) {
    assert.deepEqual(await a.call(method, p, method === 'POST' ? {} : undefined), BROKER_REFUSAL, `${method} ${p}`);
  }
  assert.deepEqual(await a.call('DELETE', '/api/providers/chatgpt'), { status: 404, body: { error: 'Sign in with ChatGPT is turned off on this server.' } });
  assert.deepEqual(await a.call('GET', '/api/providers/chatgpt/device'), { status: 404, body: { error: 'Sign in with ChatGPT is turned off on this server.' } }, 'other methods stay Node\'s');
  // A token row while the flag is off adds no row (the reconcile runs only with the flag on).
  signIn(f, 'user-a');
  assert.deepEqual((await a.call('GET', '/api/providers')).body.providers.map((p) => p.id), ['default']);
  assert.equal(a.saved.private, 0);
  a.providers.push(chatgpt.providerRow());
  const list = await a.call('GET', '/api/providers');
  assert.deepEqual(list.body.providers.map((p) => p.id), ['default']);
});

test('flag on: a finished sign-in adds a private, external row for that account only; nothing token-like reaches the client', async (t) => {
  const f = fixture(t);
  const a = f.routesFor('user-a');
  signIn(f, 'user-a');
  // The status itself is the Rust front's GET (#1071); Node only refuses it.
  assert.deepEqual(await a.call('GET', '/api/providers/chatgpt'), STATUS_REFUSAL);
  assert.deepEqual(f.oauth.status('user-a'), { state: 'connected' });
  const list = await a.call('GET', '/api/providers');
  assert.deepEqual(a.providers.at(-1), chatgpt.providerRow(), 'the listing adds the row the broker\'s sign-in implies');
  assert.equal(a.saved.private, 1, 'saved to the private provider file');
  const row = list.body.providers.find((p) => p.id === 'chatgpt-oauth');
  assert.deepEqual(row, { id: 'chatgpt-oauth', label: 'ChatGPT', baseUrl: chatgpt.DEFAULTS.codexBaseUrl, apiKeyMasked: null, isDefault: false, managed: false, shared: false, defaultModel: undefined, kind: 'chatgpt-oauth', external: true, connection: 'connected' });
  assert.equal(/AT-secret|acct-synthetic|enc:v2/.test(JSON.stringify(list.body)), false);
  await a.call('GET', '/api/providers');
  assert.equal(a.saved.private, 1, 'listed again: still one row, no second save');
  // The row's model list is the broker's catalogue.
  assert.deepEqual((await a.call('GET', '/api/providers/chatgpt-oauth/models')).body, { models: ['gpt-synthetic', 'gpt-thinker', 'gpt-plain', 'gpt-quiet'], cached: false, fetchedAt: f.clock.t });
  assert.deepEqual(f.fake.calls.filter((c) => c.op === 'models').map((c) => [c.user, c.refresh]), [['user-a', false]]);

  // user B: separate workspace, no row, not connected.
  const b = f.routesFor('user-b');
  assert.equal(f.oauth.status('user-b').state, 'disconnected');
  assert.deepEqual((await b.call('GET', '/api/providers')).body.providers.map((p) => p.id), ['default']);
  b.providers.push(chatgpt.providerRow());
  const models = await b.call('GET', '/api/providers/chatgpt-oauth/models');
  assert.equal(models.status, 401);
  assert.match(models.body.error, /not connected/);
});

test('connecting twice keeps one row; disconnect deletes the tokens, the row and project links', async (t) => {
  const f = fixture(t);
  const a = f.routesFor('user-a');
  signIn(f, 'user-a');
  await a.call('GET', '/api/providers');
  signIn(f, 'user-a');
  await a.call('GET', '/api/providers');
  assert.equal(a.providers.filter((p) => p.id === 'chatgpt-oauth').length, 1);
  a.projects[0].provider = 'chatgpt-oauth';
  a.projects[0].model = 'gpt-synthetic';
  const out = await a.call('DELETE', '/api/providers/chatgpt');
  assert.deepEqual(out, { status: 200, body: { ok: true, state: 'disconnected' } });
  assert.equal(a.providers.some((p) => p.id === 'chatgpt-oauth'), false);
  assert.equal('provider' in a.projects[0], false, 'the project falls back to the default provider');
  assert.equal('model' in a.projects[0], false, 'the ChatGPT model cannot be sent to the default provider');
  assert.equal(f.oauth.status('user-a').state, 'disconnected');
  assert.deepEqual(f.fake.calls.filter((c) => c.op === 'disconnect').map((c) => c.user), ['user-a'], 'the broker deleted the tokens');
  // Removing the row through the generic route is also a disconnect.
  signIn(f, 'user-a');
  await a.call('GET', '/api/providers');
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

test('#2190: the broker unreachable keeps the row: a disconnect that could not delete the tokens says so', async (t) => {
  const f = fixture(t);
  const a = f.routesFor('user-a');
  signIn(f, 'user-a');
  await a.call('GET', '/api/providers');
  a.projects[0].provider = 'chatgpt-oauth';
  f.fake.state.down = true;
  for (const p of ['/api/providers/chatgpt', '/api/providers/chatgpt-oauth']) {
    const out = await a.call('DELETE', p);
    assert.equal(out.status, 503, p);
    assert.match(out.body.error, /busy/);
    assert.equal(a.providers.some((x) => x.id === 'chatgpt-oauth'), true, 'no row without its tokens gone');
    assert.equal(a.projects[0].provider, 'chatgpt-oauth');
  }
  f.fake.state.down = false;
  assert.equal((await a.call('DELETE', '/api/providers/chatgpt-oauth')).status, 200);
  assert.equal(f.oauth.status('user-a').state, 'disconnected');
});

// `env` is ignored by the routes since #1071; callers pass leftover switch values to prove it.
function nativeStatusFixture({ env: _env, enabled = () => true } = {}) {
  const calls = { status: 0, disconnect: 0, models: 0 };
  const sent = [];
  const oauth = {
    status: () => { calls.status++; return { state: 'disconnected' }; },
    disconnect: async () => { calls.disconnect++; },
    modelList: async () => { calls.models++; return { models: ['sentinel-model'] }; },
  };
  const routes = createProviderRoutes({
    json: (_res, status, body) => { sent.push({ status, body }); },
    readJson: async () => ({ loginId: 'synthetic' }), readBody: async () => '{}',
    fetchJson: async () => { throw new Error('unexpected network collaborator'); },
    endpointApproved: () => false, PROVIDERS: [], PROJECTS: [], DEFAULT_PROVIDER_ID: 'default',
    modelManager: { enabled: false }, currentWorkspace: () => ({ removeProvider: () => false }), saveProjects: () => {},
    registry: { saveProviders: () => {}, saveSharedProviders: () => {}, maskKey: () => null },
    chatgptOAuth: oauth, chatgptEnabled: enabled,
  });
  const call = async (method, target) => {
    const req = { method, url: target, headers: {} };
    const url = require('../http.cjs').parseRequestUrl(req);
    const handled = await routes(req, {}, { path: url.pathname, url, authn: { user: { id: 'synthetic-owner', role: 'member' } } });
    return handled ? sent.pop() : null;
  };
  return { call, calls };
}
// Leftover values of the retired switch, which must change nothing (#1071).
const leftoverEnvs = () => [{}, { NOEVIA_RUST_CHATGPT_STATUS: '0' }, { NOEVIA_FRONT: 'rust', NOEVIA_RUST_AUTH: '1', NOEVIA_RUST_AUTH_CONFIRMED: '1', NOEVIA_RUST_CHATGPT_STATUS: '1', NOEVIA_RUST_CHATGPT_STATUS_CONFIRMED: '1' }];

test('#1071: the status GET is the Rust front\'s, so Node always refuses it before the product flag and never reads it', async () => {
  for (const env of leftoverEnvs()) {
    for (const enabled of [() => false, () => true, () => { throw new Error('product must not run for the owned GET'); }]) {
      const f = nativeStatusFixture({ env, enabled });
      for (const target of ['/api/providers/chatgpt', '/api/providers/chatgpt?query=synthetic', '/api/providers/x/../chatgpt', '/api/providers/%2e/chatgpt']) {
        assert.deepEqual(await f.call('GET', target), STATUS_REFUSAL, `${JSON.stringify(env)} ${target}`);
      }
      assert.equal(f.calls.status, 0);
    }
  }
  const owned = nativeStatusFixture({ env: {} });
  for (const [method, target, status] of [
    ['get', '/api/providers/chatgpt', 405], ['HEAD', '/api/providers/chatgpt', 405], ['OPTIONS', '/api/providers/chatgpt', 405],
    ['POST', '/api/providers/chatgpt', 405], ['GET', '/api/providers/chatgpt/', 405], ['GET', '/api/providers/chatgpt/sibling', 405],
    // sbstndalton/noevia#2190 round 5: the broker's, refused here.
    ['GET', '/api/providers/chatgpt/models', 503], ['POST', '/api/providers/chatgpt/device', 503],
    ['POST', '/api/providers/chatgpt/device/poll', 503], ['POST', '/api/providers/chatgpt/device/cancel', 503],
    ['GET', '/api/providers/chatgpt/device', 405], ['DELETE', '/api/providers/chatgpt/models', 405],
    ['DELETE', '/api/providers/chatgpt', 200],
  ]) assert.equal((await owned.call(method, target)).status, status, `${method} ${target}`);
  assert.equal(await owned.call('GET', '/api/providers/chatgpt-sibling'), null);
  assert.deepEqual(owned.calls, { status: 0, disconnect: 1, models: 0 });
});

test('native ChatGPT status: Node writes use current feature truth and device gate stays prior', async () => {
  const { createFeatures, REGISTRY } = require('../../tests/server/oracles/features-legacy.cjs');
  const rows = new Map([['feature:chatgptOAuth', 'true']]);
  const store = { get: key => rows.get(key), set: (key, value) => { rows.set(key, value); } };
  const features = createFeatures({ env: {}, store, registry: { chatgptOAuth: REGISTRY.chatgptOAuth } });
  const f = nativeStatusFixture({ env: {}, enabled: () => features.enabled('chatgptOAuth') });
  rows.set('feature:chatgptOAuth', 'false');
  assert.equal((await f.call('DELETE', '/api/providers/chatgpt')).status, 404);
  assert.equal(f.calls.disconnect, 0);
  rows.set('feature:chatgptOAuth', 'true');
  assert.equal((await f.call('DELETE', '/api/providers/chatgpt')).status, 200);
  store.set = (key, value) => { rows.set(key, value); throw new Error('synthetic committed write then throw'); };
  assert.throws(() => features.set('chatgptOAuth', false, 'synthetic'), /committed write/);
  assert.equal((await f.call('DELETE', '/api/providers/chatgpt')).status, 404);
  assert.equal(f.calls.disconnect, 1, 'a failed cache update cannot run a second Node disconnect');
  store.get = () => { throw new Error('synthetic read failure'); };
  await assert.rejects(() => f.call('DELETE', '/api/providers/chatgpt'), e => e.status === 503);
  assert.equal(f.calls.disconnect, 1);
  assert.equal((await f.call('POST', '/api/providers/chatgpt/device')).status, 503, 'the broker\'s routes are refused before feature reads');
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
