'use strict';
// sbstndalton/noevia#2190 round 4: the provider probe is the Rust front's (noevia-rs
// provider_test_routes.rs, tested there through real HTTP with a synthetic provider). Node refuses
// POST /api/providers/test before authentication and keeps the other methods on the path (its
// PUT|DELETE /api/providers/{id} handler reads `test` as an id). The front reads the stored rows
// from the files workspace.cjs writes, keys sealed enc:v1 as below. Synthetic values only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const owned = require('./rust-provider-test.cjs');
// Shared with noevia-rs tests/storage_integrations.rs (seal_v1): 'sk-stored', key [7;32], nonce [9;12].
const GOLDEN_V1 = 'enc:v1:CQkJCQkJCQkJCQkJmAG2pcdXYs1DpznJT63n0FTuqefKn7MExA';

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });
const refuse = (method, url) => { const res = {}; return owned.refuseOwned({ url, method, headers: {}, on() { throw new Error('body listener'); } }, res, { parseRequestUrl, json }) ? res : null; };

test('only POST on the exact path is refused, before the body is read', () => {
  assert.deepEqual(owned.ROUTE_REFUSAL, { error: 'The provider test is owned by the Rust front.', code: 'RUST_PROVIDER_TEST_OWNED' });
  assert.ok(Object.isFrozen(owned.ROUTE_REFUSAL));
  for (const url of ['/api/providers/test', '/api/providers/test?x=1', '/api/providers/./test', '/api/x/../providers/test']) {
    assert.deepEqual(refuse('POST', url), { status: 503, body: owned.ROUTE_REFUSAL }, url);
  }
  for (const m of ['GET', 'PUT', 'DELETE', 'HEAD', 'post']) assert.equal(refuse(m, '/api/providers/test'), null, m);
  for (const url of ['/api/providers', '/api/providers/test/', '/api/providers/tests', '/api/providers/x/models']) assert.equal(refuse('POST', url), null, url);
});

test('index.cjs refuses the probe before authentication; the Node probe is gone', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  const at = index.indexOf("require('./rust-provider-test.cjs').refuseOwned(req, res, { parseRequestUrl, json })");
  assert.ok(at > 0 && at < index.indexOf('const preAuth = requestAuth.authenticate(req);'));
  const routes = fs.readFileSync(path.join(__dirname, 'routes', 'providers.cjs'), 'utf8');
  assert.doesNotMatch(routes, /probeKey|valid baseUrl required/);
});

test('the stored key format the front opens: enc:v1, unbound, as workspace.cjs seals provider rows', (t) => {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-provider-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'secrets.key'), Buffer.alloc(32, 7), { mode: 0o600 });
  const secrets = require('./secrets.cjs').createSecretStore(root, { env: {} });
  const sealed = secrets.encrypt('sk-stored');
  assert.match(sealed, /^enc:v1:/);
  // The golden vector the Rust test seals with (key [7;32], nonce [9;12], no account).
  const crypto = require('node:crypto');
  const nonce = Buffer.alloc(12, 9);
  const gcm = crypto.createCipheriv('aes-256-gcm', Buffer.alloc(32, 7), nonce);
  const body = Buffer.concat([gcm.update('sk-stored', 'utf8'), gcm.final()]);
  const golden = `enc:v1:${Buffer.concat([nonce, gcm.getAuthTag(), body]).toString('base64url')}`;
  assert.equal(golden, GOLDEN_V1);
  assert.equal(secrets.decrypt(GOLDEN_V1), 'sk-stored');
});
