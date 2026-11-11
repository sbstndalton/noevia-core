'use strict';
// #2190 round 3: Node refuses the mirror preferences the Rust front owns. The nudge a save raises is the
// front's own (rust-chat-mirror-v1; no file, no poller here). Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PATH, ROUTE_REFUSAL, refuseOwned } = require('./rust-vault-mirror-preferences.cjs');

const parseRequestUrl = (req, base) => { try { return new URL(req.url, base || 'http://localhost'); } catch { return null; } };
const call = (method, url) => { const out = {}; const handled = refuseOwned({ method, url, headers: {} }, out, { parseRequestUrl, json: (res, status, body) => { res.status = status; res.body = body; } }); return { handled, ...out }; };

test('every method on the exact path is refused with the stable code; other paths fall through', () => {
  for (const method of ['GET', 'PUT', 'POST', 'DELETE', 'OPTIONS']) {
    const r = call(method, PATH);
    assert.equal(r.handled, true, method); assert.equal(r.status, 503); assert.deepEqual(r.body, ROUTE_REFUSAL);
  }
  assert.equal(ROUTE_REFUSAL.code, 'RUST_VAULT_MIRROR_PREFERENCES_OWNED');
  assert.equal(call('GET', `${PATH}?x=1`).handled, true, 'the query is not part of the path');
  for (const other of ['/api/chat-vault-mirror/preferences/', '/api/chat-vault-mirror', '/api/chat-framing/preferences']) assert.equal(call('GET', other).handled, false, other);
});

test('index.cjs refuses before authentication and no longer mounts the Node route', () => {
  const src = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  const refusal = src.indexOf("require('./rust-vault-mirror-preferences.cjs').refuseOwned(");
  assert.ok(refusal > 0);
  assert.ok(refusal > src.indexOf("require('./rust-storage-integrations.cjs').refuseOwned("));
  assert.ok(refusal < src.indexOf('const preAuth = requestAuth.authenticate(req);'));
  assert.ok(!src.includes('routes/chat-vault-mirror.cjs'));
  // The nudge is the front's now: no file poller and no nudge file in this process.
  assert.ok(!src.includes('startNudges') && !src.includes('chat-vault-mirror-nudges'));
  assert.ok(!require('./rust-vault-mirror-preferences.cjs').startNudges && !require('./rust-vault-mirror-preferences.cjs').NUDGES_FILE);
  assert.ok(!fs.existsSync(path.join(__dirname, 'routes', 'chat-vault-mirror.cjs')));
});
