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
  assert.deepEqual((await a.call('GET', '/api/providers/chatgpt/models')).body, { models: ['gpt-synthetic'] });

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
  const out = await a.call('DELETE', '/api/providers/chatgpt');
  assert.deepEqual(out, { status: 200, body: { ok: true, state: 'disconnected' } });
  assert.equal(a.providers.some((p) => p.id === 'chatgpt-oauth'), false);
  assert.equal('provider' in a.projects[0], false, 'the project falls back to the default provider');
  assert.equal(f.oauth.status('user-a').state, 'disconnected');
  // Removing the row through the generic route is also a disconnect.
  await signIn(f, 'user-a');
  assert.equal((await a.call('DELETE', '/api/providers/chatgpt-oauth')).status, 200);
  assert.equal(f.oauth.status('user-a').state, 'disconnected');
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
