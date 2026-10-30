'use strict';
// #2190, #2191 round 9: deleting an account is the Rust front's (noevia-rs bins/noevia-server
// admin_user_routes.rs and crates/server-account delete.rs: the typed username, the last active administrator,
// the cascade, the folder, the Drive, MCP and ChatGPT credentials and the Diary tenant, tested there against
// real stores and synthetic brokers). Node refuses the route before authentication, has no deleteUser, and
// follows the deletion through the folder: a workspace held for a folder that is gone is revoked, and none is
// made for a user the database no longer has.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned } = require('./rust-admin-users.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });

test('the owned list is exactly the account delete', () => {
  assert.deepEqual([...OWNED_ROUTES], ['DELETE /api/admin/users/{id}']);
  assert.ok(Object.isFrozen(OWNED_ROUTES));
  assert.equal(ROUTE_REFUSAL.code, 'RUST_ADMIN_USERS_OWNED');
  assert.equal(owned('DELETE', '/api/admin/users/u1'), true);
  assert.equal(owned('DELETE', '/api/admin/users/u%2F1'), true);
  for (const m of ['GET', 'PUT', 'PATCH', 'POST', 'HEAD']) assert.equal(owned(m, '/api/admin/users/u1'), false, m);
  for (const p of ['/api/admin/users', '/api/admin/users/', '/api/admin/users/u1/disabled', '/api/admin/users/u1/recovery', '/api/admin/users/a/b']) assert.equal(owned('DELETE', p), false, p);
});

test('an owned request is refused with a 503 before its body is read; the rest falls through', () => {
  const req = { url: '/api/admin/users/u1?x=1', method: 'DELETE', headers: { host: 'localhost' }, on() { throw new Error('body listener'); } };
  const res = {};
  assert.equal(refuseOwned(req, res, { parseRequestUrl, json }), true);
  assert.deepEqual(res, { status: 503, body: ROUTE_REFUSAL });
  for (const [method, url] of [['GET', '/api/admin/users/u1'], ['DELETE', '/api/admin/users'], ['PUT', '/api/admin/users/u1/disabled'], ['DELETE', '/api/admin/users/u1/recovery']]) {
    assert.equal(refuseOwned({ url, method, headers: {} }, {}, { parseRequestUrl, json }), false, `${method} ${url}`);
  }
  assert.equal(refuseOwned({ url: '//[', method: 'DELETE', headers: {} }, {}, { parseRequestUrl, json }), false);
});

test('Node has no way left to delete an account or to forget its credentials', () => {
  const routes = fs.readFileSync(path.join(__dirname, 'routes', 'auth.cjs'), 'utf8');
  assert.equal(routes.includes('deleteUser') || routes.includes('workspaceStore') || routes.includes('driveAccounts'), false);
  const auth = fs.readFileSync(path.join(__dirname, 'auth.cjs'), 'utf8');
  assert.equal(/deleteUser\s*\(/.test(auth.replace(/\/\/[^\n]*/g, '')), false, 'auth.cjs has no deleteUser');
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.ok(index.includes("require('./rust-admin-users.cjs').refuseOwned("), 'the marker the supervisor and the assembler pair with the capability');
  assert.ok(index.indexOf("require('./rust-admin-users.cjs').refuseOwned(") < index.indexOf('requestAuth.authenticate(req)', index.indexOf('async function handleRequestInner')));
});

// ── the workspace follows the folder ────────────────────────────────────────────

const { createWorkspaceStore } = require('./workspace.cjs');
const { createStubStore } = require('../tests/server/project-store-stub.cjs');
const USER = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const DEFAULT = { id: 'local', label: 'Local', baseUrl: '', apiKey: '' };
const store = (root, extra = {}) => createWorkspaceStore(root, DEFAULT, null, { projectStore: createStubStore(root), ...extra });
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

test('a workspace held for an account whose folder the front removed is revoked, and its writes refuse', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-admin-users-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = store(root);
  const held = ws.get(USER);
  assert.equal(held.revoked, false);
  assert.doesNotThrow(() => held.assertActive());
  // The Rust front deletes the account: the row, then the folder.
  fs.rmSync(path.join(root, 'users', USER), { recursive: true, force: true });
  sleepSync(300);
  assert.equal(held.revoked, true, 'seen within the folder check\'s 250 ms');
  assert.throws(() => held.assertActive(), (e) => e.status === 410 && /no longer exists/.test(e.message));
  assert.throws(() => held.savePreferences(), (e) => e.status === 410);
  assert.equal(fs.existsSync(path.join(root, 'users', USER)), false, 'nothing made the folder again');
  // An account the front did not delete is untouched.
  assert.equal(ws.get(OTHER).revoked, false);
  // A later get() reads the account again (a folder that went for another reason makes a new workspace).
  assert.notEqual(ws.get(USER), held);
});

test('a workspace is never made for a user the database no longer has', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-admin-users-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const known = new Set([USER]);
  const ws = store(root, { userExists: (id) => known.has(id) });
  ws.get(USER);
  assert.throws(() => ws.get(OTHER), (e) => e.status === 410 && /no longer exists/.test(e.message));
  assert.equal(fs.existsSync(path.join(root, 'users', OTHER)), false, 'no folder for a user the database lacks');
  assert.equal(ws.isRemoved(OTHER), true);
  // The front deletes the account that is held: the folder goes, and a later get() cannot bring it back.
  known.delete(USER);
  fs.rmSync(path.join(root, 'users', USER), { recursive: true, force: true });
  sleepSync(300);
  assert.throws(() => ws.get(USER), (e) => e.status === 410);
  assert.equal(fs.existsSync(path.join(root, 'users', USER)), false);
});

// ── through the real router ─────────────────────────────────────────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-admin-users-'));
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

test('through the router: the delete is refused signed out and signed in, and deletes nothing', async () => {
  const admin = seedAccount(dataDir, { username: 'delete-admin', displayName: 'Synthetic', role: 'admin', publicOrigin: 'http://localhost' });
  const member = seedAccount(dataDir, { username: 'delete-member', displayName: 'Synthetic', role: 'member', publicOrigin: 'http://localhost' });
  const as = (a) => ({ cookie: a.cookie, origin: 'http://localhost', 'x-csrf-token': a.csrf, 'content-type': 'application/json' });
  for (const headers of [{}, as(member), as(admin)]) {
    const r = await request(`/api/admin/users/${member.id}`, { method: 'DELETE', headers, body: { username: 'delete-member' } });
    assert.deepEqual([r.status, r.json], [503, ROUTE_REFUSAL]);
  }
  assert.equal((await request('/api/chats/search', { headers: { cookie: member.cookie } })).status, 200, 'the account is still there');
  // The other admin routes this mount answers are unchanged: a member is refused, an administrator\'s unknown path is 404.
  assert.equal((await request('/api/admin/nothing', { headers: as(member) })).status, 403);
  assert.equal((await request('/api/admin/nothing', { headers: as(admin) })).status, 404);
});
