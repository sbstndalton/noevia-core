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

test('index.cjs refuses the routes before authentication; the Node writers and the listing are gone', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  const at = index.indexOf("require('./rust-providers.cjs').refuseOwned(req, res, { parseRequestUrl, json })");
  assert.ok(at > 0 && at < index.indexOf('const preAuth = requestAuth.authenticate(req);'));
  const routes = fs.readFileSync(path.join(__dirname, 'routes', 'providers.cjs'), 'utf8');
  assert.doesNotMatch(routes, /saveProviders|saveSharedProviders|removeProvider|PROVIDERS\.push|apiKeyMasked|listRow|maskKey|parseContextTokens/);
  const workspace = fs.readFileSync(path.join(__dirname, 'workspace.cjs'), 'utf8');
  assert.doesNotMatch(workspace, /saveProviders\(\) \{|saveShared\(id\)|removeProvider\(id\)|atomicJson\(providerFile|atomicJson\(sharedFile/);
  const registry = fs.readFileSync(path.join(__dirname, 'providers.cjs'), 'utf8');
  assert.doesNotMatch(registry, /saveProviders|saveSharedProviders|maskKey/);
});
