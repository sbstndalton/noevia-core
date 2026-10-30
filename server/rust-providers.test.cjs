'use strict';
// sbstndalton/noevia#2190 round 6: the provider registry is the Rust front's (noevia-rs
// provider_routes.rs, tested there through real HTTP: the merged view, the validation order, the
// keys sealed enc:v1, the shared rule, the ChatGPT disconnect, the project fallbacks, and a client
// that leaves mid-request). Node refuses exactly the methods it used to answer, before
// authentication, and is no longer a writer of either provider file. Synthetic values only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const owned = require('./rust-providers.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });
const refuse = (method, url) => { const res = {}; return owned.refuseOwned({ url, method, headers: {}, on() { throw new Error('body listener'); } }, res, { parseRequestUrl, json }) ? res : null; };

test('the registry\'s methods are refused before the body is read; everything else on the paths stays Node\'s', () => {
  assert.deepEqual(owned.ROUTE_REFUSAL, { error: 'The provider registry is owned by the Rust front.', code: 'RUST_PROVIDERS_OWNED' });
  assert.ok(Object.isFrozen(owned.ROUTE_REFUSAL));
  for (const [method, url] of [
    ['GET', '/api/providers'], ['POST', '/api/providers'], ['GET', '/api/providers?x=1'],
    ['PUT', '/api/providers/prov-1'], ['DELETE', '/api/providers/prov-1'], ['DELETE', '/api/providers/%E0%A4'],
    ['PUT', '/api/providers/test'], ['DELETE', '/api/providers/test'], ['PUT', '/api/providers/chatgpt-oauth'], ['DELETE', '/api/providers/chatgpt-oauth'],
    ['DELETE', '/api/providers/chatgpt'], ['GET', '/api/x/../providers'], ['PUT', '/api/providers/lemonade'],
  ]) assert.deepEqual(refuse(method, url), { status: 503, body: owned.ROUTE_REFUSAL }, `${method} ${url}`);
  for (const [method, url] of [
    ['PUT', '/api/providers'], ['DELETE', '/api/providers'], ['PATCH', '/api/providers'], ['HEAD', '/api/providers'],
    ['PUT', '/api/providers/chatgpt'], ['POST', '/api/providers/chatgpt'], ['GET', '/api/providers/prov-1'], ['POST', '/api/providers/prov-1'],
    ['POST', '/api/providers/test'], ['DELETE', '/api/providers/'], ['GET', '/api/providers/'], ['PUT', '/api/providers//x'],
    ['DELETE', '/api/providers/prov-1/models'], ['DELETE', '/api/providers/chatgpt/models'], ['PUT', '/api/providers/chatgpt/device'],
    ['GET', '/api/providers-x'],
  ]) assert.equal(refuse(method, url), null, `${method} ${url}`);
});

test('a request that reaches the routes mount is refused for every registry method, and the other methods keep their Node answers', async () => {
  const { createProviderRoutes } = require('./routes/providers.cjs');
  const sent = [];
  const mount = (chatgptOn) => createProviderRoutes({ json: (_res, status, body) => { sent.push({ status, body }); }, chatgptOAuth: chatgptOn ? {} : null, chatgptEnabled: () => chatgptOn });
  const ask = async (routes, method, p, authn = { user: { id: 'u', role: 'admin' } }) => { sent.length = 0; const handled = await routes({ method }, {}, { path: p, authn }); return { handled, sent: sent.slice() }; };
  const off = mount(false), on = mount(true);
  for (const [method, p] of [['GET', '/api/providers'], ['POST', '/api/providers'], ['PUT', '/api/providers/prov-1'], ['DELETE', '/api/providers/prov-1'], ['DELETE', '/api/providers/chatgpt'], ['PUT', '/api/providers/test'], ['DELETE', '/api/providers/test']]) {
    for (const routes of [off, on]) assert.deepEqual(await ask(routes, method, p), { handled: true, sent: [{ status: 503, body: owned.ROUTE_REFUSAL }] }, `${method} ${p}`);
  }
  // What stays Node's on the sign-in paths: 404 while the feature is off, 401 signed out, else 405.
  assert.deepEqual((await ask(off, 'PUT', '/api/providers/chatgpt')).sent, [{ status: 404, body: { error: 'Sign in with ChatGPT is turned off on this server.' } }]);
  assert.deepEqual((await ask(on, 'PUT', '/api/providers/chatgpt', {})).sent, [{ status: 401, body: { error: 'Sign in to noevia first.' } }]);
  assert.deepEqual((await ask(on, 'PUT', '/api/providers/chatgpt')).sent, [{ status: 405, body: { error: 'method not allowed' } }]);
  // A path the mount does not own is passed on, not answered.
  assert.deepEqual(await ask(on, 'GET', '/api/providers/prov-1'), { handled: false, sent: [] });
});

test('the provider registry module has no writer left (the workspace\'s is in workspace-shared.test.cjs)', () => {
  const providers = require('./providers.cjs');
  assert.deepEqual(Object.keys(providers.createProviderRegistry({ PROVIDERS: [], DEFAULT_PROVIDER_ID: 'default' })).sort(), ['getProvider', 'providerHeaders']);
  for (const name of Object.keys(providers)) assert.doesNotMatch(name, /^(save|remove|mask|parseContext)/, name);
});

// ── through the real router ─────────────────────────────────────────────────────

const os = require('node:os');
const { Readable, Writable } = require('node:stream');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-providers-'));
process.env.UI_DATA_DIR = dataDir;
require('../tests/server/project-store-server.cjs').installProjectStore(dataDir);
process.env.PUBLIC_ORIGIN = 'http://localhost';
process.env.LEGACY_AUTH_COMPAT = 'false';
const originalWarn = console.warn;
console.warn = () => {};
const { handleRequest } = require('./index.cjs');
console.warn = originalWarn;
const { seedAccount } = require('../tests/server/seed-account.cjs');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

async function request(url, { method = 'GET', headers = {}, body } = {}) {
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const req = Readable.from(payload ? [payload] : []);
  Object.assign(req, { url, method, headers: { host: 'localhost', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  const chunks = [];
  const out = {};
  const res = new Writable({ write(chunk, _e, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  res.statusCode = 200;
  res.headersSent = false;
  res.setHeader = (k, v) => { out[k.toLowerCase()] = v; };
  res.writeHead = (status, h = {}) => { res.statusCode = status; res.headersSent = true; for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v; return res; };
  const done = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
  await handleRequest(req, res);
  await done;
  const text = Buffer.concat(chunks).toString('utf8');
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.statusCode, headers: out, text, json: parsed };
}

test('through the router: the registry\'s methods are refused before authentication, signed out and in, and write nothing', async () => {
  const admin = seedAccount(dataDir, { username: 'prov-admin', displayName: 'Synthetic', role: 'admin', publicOrigin: 'http://localhost' });
  const member = seedAccount(dataDir, { username: 'prov-member', displayName: 'Synthetic', role: 'member' });
  const as = (a) => ({ cookie: a.cookie, origin: 'http://localhost', 'x-csrf-token': a.csrf });
  const files = () => fs.readdirSync(dataDir, { recursive: true }).filter((f) => /providers\.json/.test(f));
  const before = files();
  for (const [method, url, body] of [
    ['GET', '/api/providers'], ['POST', '/api/providers', { label: 'X', baseUrl: 'https://x.test/v1' }], ['PUT', '/api/providers/prov-1', { label: 'Y' }],
    ['DELETE', '/api/providers/prov-1'], ['DELETE', '/api/providers/chatgpt'], ['PUT', '/api/providers/test', {}], ['DELETE', '/api/providers/%E0%A4'],
  ]) {
    for (const headers of [{}, as(member), as(admin)]) {
      const r = await request(url, { method, headers, body });
      assert.equal(r.status, 503, `${method} ${url}`);
      assert.deepEqual(r.json, owned.ROUTE_REFUSAL, `${method} ${url}`);
      assert.equal(r.headers['x-noevia-api'], '1');
    }
  }
  assert.deepEqual(files(), before, 'no provider file was created or written');
  // Positive controls: what is not the registry's still meets the session gate first.
  assert.equal((await request('/api/providers/prov-1')).status, 401);
  assert.equal((await request('/api/providers/prov-1', { method: 'PATCH', body: '{}' })).status, 401);
});
