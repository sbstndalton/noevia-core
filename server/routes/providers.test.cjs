'use strict';
// The provider registry is the Rust front's (sbstndalton/noevia#2190 round 6; noevia-rs
// provider_routes.rs, tested there through real HTTP: the listing, connecting, editing, removing,
// the ChatGPT disconnect and the project fallbacks). This mount refuses those methods as a last
// resort (index.cjs refuses them first, before authentication, with rust-providers.cjs), and keeps
// what is still Node's on the Sign in with ChatGPT paths. Synthetic values only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderRoutes } = require('./providers.cjs');
const owned = require('../rust-providers.cjs');
const REFUSAL = { status: 503, body: owned.ROUTE_REFUSAL };
const STATUS_REFUSAL = { status: 503, body: { error: 'ChatGPT status is owned by the Rust front.', code: 'RUST_CHATGPT_STATUS_OWNED' } };
const BROKER_REFUSAL = { status: 503, body: { error: 'Sign in with ChatGPT is owned by the Rust front.', code: 'RUST_CHATGPT_OAUTH_OWNED' } };

function fixture({ enabled = () => true, user = { id: 'synthetic-owner', role: 'member' } } = {}) {
  const sent = [];
  const calls = { read: 0 };
  const routes = createProviderRoutes({
    json: (_res, status, body) => { sent.push({ status, body }); },
    chatgptOAuth: { status: () => { calls.read++; return { state: 'disconnected' }; }, disconnect: async () => { calls.read++; } },
    chatgptEnabled: enabled,
  });
  const call = async (method, target, { signedIn = true } = {}) => {
    const req = {
      method, url: target, headers: {},
      on() { calls.read++; throw new Error('the body is never read'); },
      [Symbol.asyncIterator]() { calls.read++; throw new Error('the body is never read'); },
    };
    const url = require('../http.cjs').parseRequestUrl(req);
    const handled = await routes(req, {}, { path: url.pathname, url, authn: signedIn ? { user } : null });
    return handled ? sent.pop() : null;
  };
  return { call, calls };
}

test('every method the front owns is refused here, before anything is read', async () => {
  const f = fixture();
  for (const [method, target] of [
    ['GET', '/api/providers'], ['POST', '/api/providers'],
    ['PUT', '/api/providers/prov-1'], ['DELETE', '/api/providers/prov-1'],
    ['PUT', '/api/providers/test'], ['DELETE', '/api/providers/test'],
    ['DELETE', '/api/providers/chatgpt'], ['DELETE', '/api/providers/chatgpt-oauth'],
    ['PUT', '/api/providers/lemonade'], ['DELETE', '/api/providers/default'],
  ]) assert.deepEqual(await f.call(method, target), REFUSAL, `${method} ${target}`);
  // The probe, the model list and the broker's are refused as before.
  assert.equal((await f.call('POST', '/api/providers/test')).body.code, 'RUST_PROVIDER_TEST_OWNED');
  assert.equal((await f.call('GET', '/api/providers/prov-1/models')).body.code, 'RUST_PROVIDER_MODELS_OWNED');
  assert.equal(f.calls.read, 0, 'nothing was read, listed or disconnected');
});

test('the refusal is the same for every flag state and signed-out callers', async () => {
  for (const enabled of [() => false, () => true, () => { throw new Error('the flag must not be read for an owned route'); }]) {
    const f = fixture({ enabled });
    assert.deepEqual(await f.call('DELETE', '/api/providers/chatgpt'), REFUSAL);
    assert.deepEqual(await f.call('DELETE', '/api/providers/chatgpt', { signedIn: false }), REFUSAL);
    assert.deepEqual(await f.call('GET', '/api/providers', { signedIn: false }), REFUSAL);
  }
});

test('what stays Node\'s on the ChatGPT paths: 404 while the flag is off, 401 signed out, else 405', async () => {
  const off = fixture({ enabled: () => false });
  for (const [method, target] of [['PUT', '/api/providers/chatgpt'], ['POST', '/api/providers/chatgpt'], ['GET', '/api/providers/chatgpt/device'], ['GET', '/api/providers/chatgpt/sibling']]) {
    assert.deepEqual(await off.call(method, target), { status: 404, body: { error: 'Sign in with ChatGPT is turned off on this server.' } }, `${method} ${target}`);
  }
  const on = fixture();
  assert.deepEqual(await on.call('PUT', '/api/providers/chatgpt', { signedIn: false }), { status: 401, body: { error: 'Sign in to noevia first.' } });
  for (const [method, target] of [['PUT', '/api/providers/chatgpt'], ['POST', '/api/providers/chatgpt'], ['HEAD', '/api/providers/chatgpt'], ['GET', '/api/providers/chatgpt/device'], ['DELETE', '/api/providers/chatgpt/models'], ['GET', '/api/providers/chatgpt/']]) {
    assert.deepEqual(await on.call(method, target), { status: 405, body: { error: 'method not allowed' } }, `${method} ${target}`);
  }
  assert.equal(await on.call('GET', '/api/providers/chatgpt-sibling'), null, 'another id is not this mount\'s');
  assert.equal(await on.call('PATCH', '/api/providers'), null);
  assert.equal(await on.call('GET', '/api/providers/some-id'), null);
  assert.equal(on.calls.read, 0);
});

test('#1071: the status GET and the broker\'s routes are refused before the product flag, whatever the flag says', async () => {
  for (const enabled of [() => false, () => true, () => { throw new Error('product must not run for the owned GET'); }]) {
    const f = fixture({ enabled });
    for (const target of ['/api/providers/chatgpt', '/api/providers/chatgpt?query=synthetic', '/api/providers/x/../chatgpt', '/api/providers/%2e/chatgpt']) {
      assert.deepEqual(await f.call('GET', target), STATUS_REFUSAL, target);
    }
    for (const [method, target] of [['GET', '/api/providers/chatgpt/models'], ['POST', '/api/providers/chatgpt/device'], ['POST', '/api/providers/chatgpt/device/poll'], ['POST', '/api/providers/chatgpt/device/cancel']]) {
      assert.deepEqual(await f.call(method, target), BROKER_REFUSAL, `${method} ${target}`);
    }
    assert.equal(f.calls.read, 0);
  }
});

test('native ChatGPT status: the device gate stays prior to the routes', () => {
  const { createRequestAuth } = require('../device-auth.cjs');
  const device = { user: { id: 'synthetic-owner' }, device: { id: 'synthetic-device' } };
  const browser = { user: { id: 'synthetic-owner' }, session: { id: 'synthetic-session' } };
  const gate = createRequestAuth({ enabled: () => true, deviceAuth: { authenticate: () => device }, authService: { authenticate: () => browser, csrfValid: () => true } });
  assert.equal(gate.browserOnly(gate.authenticate({ headers: { authorization: 'Bearer nva_synthetic' } }), '/api/providers/chatgpt', 'GET'), true);
  assert.equal(gate.authenticate({ headers: { authorization: 'Bearer nva_synthetic', cookie: 'cowork_session=synthetic' } }), null);
  assert.equal(gate.browserOnly(gate.authenticate({ headers: {} }), '/api/providers/chatgpt', 'GET'), false);
});
