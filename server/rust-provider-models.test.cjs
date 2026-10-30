'use strict';
// sbstndalton/noevia#2190 round 5: a stored provider's model list is the Rust front's (noevia-rs
// provider_models_routes.rs, tested there through real HTTP with synthetic providers: the stored
// key, the cache and its refresh throttle, the shared fetch, the refusals and the ChatGPT row through
// the token broker). Node refuses every method on the exact path before authentication and keeps no
// list cache. Synthetic values only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const owned = require('./rust-provider-models.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });
const refuse = (method, url) => { const res = {}; return owned.refuseOwned({ url, method, headers: {}, on() { throw new Error('body listener'); } }, res, { parseRequestUrl, json }) ? res : null; };

test('every method on the exact path is refused, before the body is read; chatgpt and longer paths stay Node\'s', () => {
  assert.deepEqual(owned.ROUTE_REFUSAL, { error: 'The provider model list is owned by the Rust front.', code: 'RUST_PROVIDER_MODELS_OWNED' });
  assert.ok(Object.isFrozen(owned.ROUTE_REFUSAL));
  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'HEAD']) {
    for (const url of ['/api/providers/mine/models', '/api/providers/mine/models?refresh=1', '/api/providers/chatgpt-oauth/models', '/api/providers/%E0%A4/models', '/api/x/../providers/mine/models']) {
      assert.deepEqual(refuse(method, url), { status: 503, body: owned.ROUTE_REFUSAL }, `${method} ${url}`);
    }
  }
  for (const url of ['/api/providers/chatgpt/models', '/api/providers/mine/models/', '/api/providers/mine/models/x', '/api/providers/models', '/api/providers//models', '/api/providers/mine']) {
    assert.equal(refuse('GET', url), null, url);
  }
});

test('index.cjs refuses the route before authentication; the Node list and its cache are gone', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  const at = index.indexOf("require('./rust-provider-models.cjs').refuseOwned(req, res, { parseRequestUrl, json })");
  assert.ok(at > 0 && at < index.indexOf('const preAuth = requestAuth.authenticate(req);'));
  const routes = fs.readFileSync(path.join(__dirname, 'routes', 'providers.cjs'), 'utf8');
  assert.doesNotMatch(routes, /modelLists|lastRefresh|providerModels|modelIdsFrom|\/v1\/models/);
  const { createProviderRoutes } = require('./routes/providers.cjs');
  const sent = [];
  const routesFn = createProviderRoutes({
    json: (_res, status, body) => { sent.push({ status, body }); }, readBody: async () => '', readJson: async () => ({}),
    endpointApproved: () => true, PROVIDERS: [{ id: 'mine', baseUrl: 'https://x.invalid', apiKey: 'sk-synthetic' }], PROJECTS: [], DEFAULT_PROVIDER_ID: 'default',
    modelManager: { enabled: false }, currentWorkspace: () => ({ removeProvider: () => false }), saveProjects: () => {},
    registry: { saveProviders() {}, saveSharedProviders() {}, maskKey: () => null },
  });
  return routesFn({ method: 'GET' }, {}, { path: '/api/providers/mine/models', authn: { user: { id: 'u', role: 'admin' } } }).then((handled) => {
    assert.equal(handled, true);
    assert.deepEqual(sent.pop(), { status: 503, body: owned.ROUTE_REFUSAL }, 'a bypass is refused, never fetched');
  });
});
