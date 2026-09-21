'use strict';
// The two account mounts over a fake auth service: what a signed-out browser may call and
// with which Origin rule, the session reply and its CSRF token, the profile and passkey
// routes' status codes, and the administrator gate on /api/admin/*. auth.cjs itself is
// auth.test.cjs and friends; the session and CSRF checks between the mounts are the router's.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createAuthRoutes } = require('./auth.cjs');

const publicAuthRoutes = new Set(['/api/setup/status', '/api/setup/complete', '/api/auth/login/password', '/api/auth/login/passkey/options', '/api/auth/login/passkey/verify', '/api/auth/invitations/accept', '/api/auth/recovery/complete']);

function fixture({ users = 1, originOk = true } = {}) {
  const sent = [], calls = [], headers = [];
  const authService = {
    origin: 'https://noevia.example', userCount: () => users, originValid: () => originOk,
    setup: async (_req, _res, body) => ({ status: 201, body: { ok: true, username: body.username } }),
    passwordLogin: async (_req, _res, body) => (body.password === 'right' ? { status: 200, body: { ok: true } } : { status: 401, body: { error: 'wrong' } }),
    authenticationOptions: async (username) => ({ challenge: 'c', username }),
    authenticationVerify: async () => { throw new Error('bad assertion'); },
    acceptInvite: async () => ({ status: 200, body: { ok: true } }),
    completeRecovery: async (body) => body.token === 'good',
    logout: () => ({ status: 200, body: { ok: true } }),
    getAppearance: () => ({ theme: 'soft' }), setAppearance: (_id, body) => { if (body.theme === 'bad') throw new Error('unknown theme'); return body; },
    listPasskeys: () => [{ id: 'pk1' }], listSessions: () => [{ id: 's1' }],
    appPasswords: { list: () => [], create: async (_id, body) => { if (!body.name) throw new Error('name required'); return { id: 'ap', name: body.name }; }, revoke: (_id, id) => id === 'a'.repeat(32) },
    updateProfile: (...args) => calls.push(['updateProfile', ...args]), setDiaryEnabled: (_id, on) => ({ diaryEnabled: on }), markOnboarded: () => ({ onboarded: true }),
    registrationOptions: async () => ({ challenge: 'r' }), registrationVerify: async () => { throw new Error('verify failed'); },
    deletePasskey: (_id, id) => id === 'pk1', renamePasskey: (_id, id) => id === 'pk1', revokeSession: (_id, id) => id === 's1',
    listUsers: () => [{ id: 'u1' }], createInvite: (_by, role) => ({ token: 't', role }),
    setDisabled: (_by, id) => id === 'u2', createRecovery: (_by, id) => (id === 'u2' ? { link: 'l' } : null),
    deleteUser: (_by, id, username) => { if (username !== 'two') throw new Error('username must match'); return id === 'u2'; },
  };
  const routes = createAuthRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    authResult: (res, result) => { sent.push({ status: result.status || 200, body: result.body ?? result }); },
    readJson: async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
    authService, publicAuthRoutes,
    davSettings: { get: (user) => ({ user: user.id, enabled: false }), save: (_u, body) => { if (body.bad) throw new Error('no'); return body; } },
    davConfig: { available: true },
    workspaceStore: { remove: (id) => calls.push(['workspace.remove', id]) },
    driveAccounts: { removeUser: async (id) => calls.push(['drive.removeUser', id]) },
    fetchJson: async (url, init) => { calls.push(['fetch', url, init.method, init.headers]); return { ok: true }; },
    DIARY_BASE: 'http://diary:8010', DIARY_TOKEN: 'sidecar-token', env: { PUBLIC_ORIGIN: 'https://env.example' },
  });
  const call = (mount, method, path, body, { role = 'member', legacy = false, cookie = '' } = {}) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, headers: { cookie } });
    const res = { setHeader: (k, v) => headers.push([k, v]) };
    return routes[mount](req, res, { path, authn: { user: { id: 'u1', role }, legacy } });
  };
  return { call, sent, calls, headers };
}

test('the open mount answers setup status, guards state changes on Origin, and signs in', async () => {
  const f = fixture();
  assert.equal(await f.call('open', 'GET', '/api/auth/session'), false, 'a signed-in route is not the open mount\'s');
  await f.call('open', 'GET', '/api/setup/status');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { configured: true, publicOrigin: 'https://noevia.example' } });
  await f.call('open', 'POST', '/api/auth/login/password', { password: 'wrong' });
  assert.deepEqual(f.sent.pop(), { status: 401, body: { error: 'wrong' } });
  await f.call('open', 'POST', '/api/setup/complete', { username: 'owner' });
  assert.deepEqual(f.sent.pop(), { status: 201, body: { ok: true, username: 'owner' } });
  await f.call('open', 'POST', '/api/auth/login/passkey/options', { username: 'owner' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { challenge: 'c', username: 'owner' } });
  await f.call('open', 'POST', '/api/auth/login/passkey/verify', {});
  assert.deepEqual(f.sent.pop(), { status: 401, body: { error: 'sign-in failed' } }, 'a failed assertion never leaks its reason');
  await f.call('open', 'POST', '/api/auth/recovery/complete', { token: 'stale' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'recovery link is invalid or expired' } });
  const crossOrigin = fixture({ originOk: false });
  await crossOrigin.call('open', 'POST', '/api/auth/login/password', { password: 'right' });
  assert.deepEqual(crossOrigin.sent.pop(), { status: 403, body: { error: 'origin not allowed' } });
  assert.equal(await crossOrigin.call('open', 'GET', '/api/setup/status'), true, 'a GET is never refused on Origin');
});

test('the session reply carries the CSRF token from the cookie, and not for a legacy token', async () => {
  const f = fixture();
  await f.call('account', 'GET', '/api/auth/session', undefined, { cookie: 'a=b; cowork_csrf=tok%20en' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { user: { id: 'u1', role: 'member' }, csrfToken: 'tok en', legacy: false } });
  await f.call('account', 'GET', '/api/auth/session', undefined, { legacy: true });
  assert.equal(f.sent.pop().body.csrfToken, null);
  await f.call('account', 'POST', '/api/auth/logout');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
});

test('profile, appearance, sharing, app passwords and preferences keep their codes', async () => {
  const f = fixture();
  await f.call('account', 'GET', '/api/profile');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { user: { id: 'u1', role: 'member' }, passkeys: [{ id: 'pk1' }], sessions: [{ id: 's1' }] } });
  await f.call('account', 'PUT', '/api/profile/appearance', { theme: 'bad' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'unknown theme' } });
  await f.call('account', 'DELETE', '/api/profile/appearance');
  assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'method not allowed' } });
  await f.call('account', 'PUT', '/api/profile/sharing', { bad: true });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'no' } });
  await f.call('account', 'GET', '/api/profile/app-passwords');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { appPasswords: [], sharingAvailable: true } });
  assert.ok(f.headers.some(([k, v]) => k === 'Cache-Control' && v === 'no-store'));
  await f.call('account', 'POST', '/api/profile/app-passwords', { name: 'Phone' });
  assert.deepEqual(f.sent.pop(), { status: 201, body: { id: 'ap', name: 'Phone' } });
  await f.call('account', 'DELETE', `/api/profile/app-passwords/${'b'.repeat(32)}`);
  assert.deepEqual(f.sent.pop(), { status: 404, body: { ok: true } });
  await f.call('account', 'PATCH', '/api/profile', { displayName: 'S' });
  assert.deepEqual(f.calls.pop(), ['updateProfile', 'u1', 'S']);
  await f.call('account', 'PUT', '/api/profile/features', { diaryEnabled: 'yes' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { diaryEnabled: true } });
  await f.call('account', 'POST', '/api/profile/onboarding');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { onboarded: true } });
  assert.equal(await f.call('account', 'GET', '/api/integrations/storage'), false, 'storage is another module');
});

test('passkeys and sessions answer 404 for an unknown id and the admin routes refuse members', async () => {
  const f = fixture();
  await f.call('account', 'POST', '/api/auth/passkeys/register/verify', {});
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'verify failed' } });
  await f.call('account', 'DELETE', '/api/auth/passkeys/pk9');
  assert.deepEqual(f.sent.pop(), { status: 404, body: { ok: true } });
  await f.call('account', 'PATCH', '/api/auth/passkeys/pk1', { name: 'Laptop' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  await f.call('account', 'DELETE', '/api/auth/sessions/s1');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  await f.call('account', 'GET', '/api/admin/users');
  assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'administrator required' } });
  await f.call('account', 'GET', '/api/admin/users', undefined, { role: 'admin' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { users: [{ id: 'u1' }] } });
  await f.call('account', 'GET', '/api/admin/nothing', undefined, { role: 'admin' });
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'not found' } });
  await f.call('account', 'POST', '/api/admin/users/u9/recovery', undefined, { role: 'admin' });
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'no such user' } });
});

test('deleting an account also removes its workspace, its Drive and its Diary tenant', async () => {
  const f = fixture();
  await f.call('account', 'DELETE', '/api/admin/users/u2', { username: 'one' }, { role: 'admin' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'username must match' } });
  assert.equal(f.calls.length, 0);
  await f.call('account', 'DELETE', '/api/admin/users/u2', { username: 'two' }, { role: 'admin' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  assert.deepEqual(f.calls.map((c) => c[0]), ['workspace.remove', 'drive.removeUser', 'fetch']);
  assert.deepEqual(f.calls[2].slice(1), ['http://diary:8010/api/internal/tenant', 'DELETE', { 'X-Cowork-User-ID': 'u2', Authorization: 'Bearer sidecar-token' }]);
});
