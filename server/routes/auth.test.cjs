'use strict';
// The account mount over a fake auth service: the administrator gate on
// /api/admin/* and the secrets rotation. Everything else that was here is the Rust front's (#1071), and
// since #2190/#2191 round 9 so is deleting an account (rust-admin-users.cjs). The session and CSRF checks before the mount are the router's.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createAuthRoutes } = require('./auth.cjs');

function fixture() {
  const sent = [], calls = [];
  const routes = createAuthRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readJson: async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
    rotateSecrets: (actorId) => { calls.push(['rotate', actorId]); return { rotated: 0 }; },
  });
  const call = (mount, method, path, body, { role = 'member', legacy = false, session } = {}) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, headers: {} });
    return routes[mount](req, {}, { path, authn: { user: { id: 'u1', role }, legacy, session } });
  };
  return { call, sent, calls, routes };
}

// sbstndalton/noevia#1071: sign-in, the session, sign-out, the profile, appearance, app passwords,
// the Diary preference, onboarding, passkeys, sessions, invitations, recovery and the user
// list/disable/recovery are the Rust front's (rust-auth.cjs OWNED_ROUTES refuses them before this
// module runs); the module has no handler for them any more.
test('only the account mount is left, and it does not answer the Rust front\'s routes', async () => {
  const f = fixture();
  assert.deepEqual(Object.keys(f.routes), ['account']);
  for (const [method, path] of [
    ['GET', '/api/auth/session'], ['POST', '/api/auth/logout'], ['GET', '/api/profile'], ['PATCH', '/api/profile'],
    ['PUT', '/api/profile/appearance'], ['GET', '/api/profile/app-passwords'], ['POST', '/api/profile/app-passwords'],
    ['PUT', '/api/profile/features'], ['POST', '/api/profile/onboarding'], ['POST', '/api/auth/passkeys/register/options'],
    ['DELETE', '/api/auth/passkeys/pk1'], ['DELETE', '/api/auth/sessions/s1'],
  ]) {
    assert.equal(await f.call('account', method, path, {}), false, `${method} ${path}`);
  }
  assert.deepEqual(f.sent, []);
  assert.equal(await f.call('account', 'GET', '/api/integrations/storage'), false, 'storage is another module');
});

test('Settings -> Sharing is the Rust front\'s (#1071): the mount passes it on', async () => {
  const f = fixture();
  for (const method of ['GET', 'PUT']) assert.equal(await f.call('account', method, '/api/profile/sharing', {}), false, method);
  assert.deepEqual(f.sent, []);
});

test('the admin routes Node still answers refuse members first', async () => {
  const f = fixture();
  for (const [method, path] of [['POST', '/api/admin/secrets/rotate'], ['DELETE', '/api/admin/users/u2'], ['GET', '/api/admin/nothing']]) {
    await f.call('account', method, path, { username: 'two' });
    assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'administrator required' } }, `${method} ${path}`);
  }
  assert.deepEqual(f.calls, []);
  await f.call('account', 'GET', '/api/admin/nothing', undefined, { role: 'admin' });
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'not found' } });
  await f.call('account', 'POST', '/api/admin/secrets/rotate', undefined, { role: 'admin' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { rotated: 0 } });
  assert.deepEqual(f.calls.pop(), ['rotate', 'u1']);
  // Deleting an account is the Rust front's (rust-admin-users.cjs refuses it first): this mount has no handler.
  await f.call('account', 'DELETE', '/api/admin/users/u2', { username: 'two' }, { role: 'admin' });
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'not found' } });
  assert.deepEqual(f.calls, []);
});
