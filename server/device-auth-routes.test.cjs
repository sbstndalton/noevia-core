'use strict';

// Native-client sign-in (#555) through the real router (index.cjs handleRequest), with the
// nativeClientAuth feature switched on by its environment variable BEFORE the server loads.
// The device flow itself is the Rust front's (sbstndalton/noevia#1071; noevia-rs
// crates/server-account): the accounts, their sessions and the device grants are seeded the way it
// writes them, and these tests cover what Node still decides for a device token on the routes it
// answers. Synthetic accounts only; no inference, Diary or storage service is reached.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-device-auth-'));
process.env.UI_DATA_DIR = dataDir;
// #1071: Node saves projects.json / free-chats.json only through the Rust project store.
require('../tests/server/project-store-server.cjs').installProjectStore(dataDir);
process.env.PUBLIC_ORIGIN = 'http://localhost';
process.env.LEGACY_AUTH_COMPAT = 'false';
process.env.NOEVIA_FEATURE_NATIVE_CLIENT_AUTH = 'true';
// N3: the feature is unavailable without TRUST_PROXY, so every per-client limit has a real address.
// No X-Forwarded-For is sent here, so the address is the (synthetic) socket address.
process.env.TRUST_PROXY = 'true';

const originalWarn = console.warn;
console.warn = () => {};
const { handleRequest } = require('./index.cjs');
console.warn = originalWarn;

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const ORIGIN = 'http://localhost';

async function request(url, { method = 'GET', headers = {}, body, ip = '127.0.0.1' } = {}) {
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const req = Readable.from(payload ? [payload] : []);
  req.url = url;
  req.method = method;
  req.headers = { host: 'localhost', ...(payload && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}), ...headers };
  req.socket = { remoteAddress: ip };
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
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.statusCode, headers: out, text, json };
}

const { seedAccount, seedDeviceToken } = require('../tests/server/seed-account.cjs');

function session(seeded) {
  const { cookie, csrf } = seeded;
  return {
    cookie, csrf,
    read: (url) => request(url, { headers: { cookie } }),
    write: (url, body, method = 'POST') => request(url, { method, body, headers: { cookie, origin: ORIGIN, 'x-csrf-token': csrf } }),
  };
}

const bearer = (token) => ({ authorization: `Bearer ${token}` });
const asDevice = (token, url, opts = {}) => request(url, { ...opts, headers: { ...bearer(token), ...(opts.headers || {}) } });

let admin; let member; let adminId; let memberId;

test.before(async () => {
  const a = seedAccount(dataDir, { username: 'adminqa', displayName: 'Synthetic admin', publicOrigin: ORIGIN });
  const m = seedAccount(dataDir, { username: 'memberqa', displayName: 'Synthetic member', role: 'member' });
  admin = session(a); adminId = a.id;
  member = session(m); memberId = m.id;
  // Each account gets one free chat so a token's view of "its" workspace is observable. The free
  // chat list is the Rust front's (sbstndalton/noevia#1071), so it is seeded as the front's store
  // would leave it.
  for (const [id, chat] of [[adminId, 'admin-chat'], [memberId, 'member-chat']]) {
    fs.mkdirSync(path.join(dataDir, 'users', id), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'users', id, 'free-chats.json'), JSON.stringify([{ id: chat, title: chat }]));
  }
});

const deviceFor = (userId, clientName) => seedDeviceToken(dataDir, userId, { clientName });

test('the device flow is the Rust front\'s: Node refuses every device endpoint, signed in or not', async () => {
  const tokens = deviceFor(adminId, 'Refused Mac');
  for (const [method, url, body] of [
    ['POST', '/api/auth/device/code', { client_name: 'x' }],
    ['POST', '/api/auth/device/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh }],
    ['POST', '/api/auth/device/lookup', { user_code: 'BCDF-GHJK' }],
    ['POST', '/api/auth/device/approve', { user_code: 'BCDF-GHJK', approve: true }],
    ['GET', '/api/auth/devices'],
    ['DELETE', `/api/auth/devices/${tokens.grantId}`],
  ]) {
    for (const headers of [{}, { cookie: admin.cookie, origin: ORIGIN, 'x-csrf-token': admin.csrf }, bearer(tokens.access)]) {
      const r = await request(url, { method, body, headers });
      assert.equal(r.status, 503, `${method} ${url} -> ${r.status}`);
      assert.equal(r.json.code, 'RUST_AUTH_OWNED');
    }
  }
  // Nothing was written: the grant is still there and still works.
  assert.equal((await asDevice(tokens.access, '/api/chats/search')).status, 200);
});

test('a device token acts as its own account, as a member, and reads without writing', async () => {
  const tokens = deviceFor(adminId, 'Workspace Mac');
  // "Its" workspace is observable through the chat export, which reads only the caller's own lists
  // (GET /api/workspace, which showed the lists, is the Rust front's since the #2191 close-out).
  const exportStatus = async (token, chat) => (await asDevice(token, `/api/chats/${chat}/export`)).status;
  assert.equal(await exportStatus(tokens.access, 'admin-chat'), 200);
  assert.equal(await exportStatus(tokens.access, 'member-chat'), 404);
  const memberTokens = deviceFor(memberId, 'Member phone');
  assert.equal(await exportStatus(memberTokens.access, 'member-chat'), 200);
  assert.equal(await exportStatus(memberTokens.access, 'admin-chat'), 404);
  // Role-gated routes outside /api/admin see a member.
  assert.equal((await asDevice(tokens.access, '/api/models/unload', { method: 'POST', body: { name: 'synthetic' } })).status, 403);
  // The gate is read-only here: the front moves last_used_at before it proxies (server-auth upkeep).
  const db = new (require('better-sqlite3'))(path.join(dataDir, 'cowork.db'), { readonly: true });
  try {
    const before = db.prepare('SELECT last_used_at FROM device_grants WHERE id=?').get(tokens.grantId).last_used_at;
    await asDevice(tokens.access, '/api/chats/search');
    assert.equal(db.prepare('SELECT last_used_at FROM device_grants WHERE id=?').get(tokens.grantId).last_used_at, before);
  } finally { db.close(); }
});

test('scope limits: a device token never reaches administration or account security on Node\'s routes', async () => {
  const tokens = deviceFor(adminId, 'Scoped Mac');
  // Feature administration is the Rust front's: Node refuses it before authentication for every
  // credential, so a device token gets that refusal and never a Node-side answer or write.
  for (const [method, url, body] of [['GET', '/api/admin/features'], ['PUT', '/api/admin/features/nativeClientAuth', { enabled: false }]]) {
    const r = await asDevice(tokens.access, url, { method, body });
    assert.equal(r.status, 503, `${method} ${url} -> ${r.status}`);
    assert.equal(r.json.code, 'RUST_FEATURES_OWNED', `${method} ${url}`);
  }
  // Decision settings are the Rust front's too (#2190): refused before authentication.
  const decision = await asDevice(tokens.access, '/api/admin/decision-settings', { method: 'GET' });
  assert.equal(decision.status, 503);
  assert.equal(decision.json.code, 'RUST_DECISION_SETTINGS_OWNED');
  // The Nextcloud sign-in is the Rust front's too (#2190; its gate refuses device tokens the same way).
  for (const url of ['/api/integrations/storage/nextcloud/start', '/api/integrations/storage/nextcloud/cancel']) {
    const r = await asDevice(tokens.access, url, { method: 'POST', body: {} });
    assert.equal(r.status, 503, `POST ${url} -> ${r.status}`);
    assert.equal(r.json.code, 'RUST_STORAGE_INTEGRATIONS_OWNED', url);
  }
  // Saving the storage connection too (#2190 round 4; the front's gate refuses device tokens on it).
  const save = await asDevice(tokens.access, '/api/integrations/storage', { method: 'PUT', body: { kind: 'local' } });
  assert.equal(save.status, 503);
  assert.equal(save.json.code, 'RUST_STORAGE_CONNECTION_OWNED');
  // The off-site backup is the Rust front's too (#2190 round 7; its gate refuses device tokens on /api/admin).
  const backup = await asDevice(tokens.access, '/api/admin/offsite-backup', { method: 'GET' });
  assert.equal(backup.status, 503);
  assert.equal(backup.json.code, 'RUST_OFFSITE_BACKUP_OWNED');
  // The Diary connector credentials are the Rust front's too (#2206; its gate refuses device tokens there).
  const connectors = await asDevice(tokens.access, '/api/profile/diary-connectors', { method: 'POST', body: {} });
  assert.equal(connectors.status, 503);
  assert.equal(connectors.json.code, 'RUST_DIARY_ROUTES_OWNED');
  const refused = [
    ['DELETE', `/api/admin/users/${memberId}`, { username: 'memberqa' }],
  ];
  for (const [method, url, body] of refused) {
    const r = await asDevice(tokens.access, url, { method, body });
    assert.equal(r.status, 403, `${method} ${url} -> ${r.status}`);
    assert.equal(r.json.code, 'browser_session_required', `${method} ${url}`);
  }
  // The admin's own browser session still reads the administration routes Node answers, so the
  // refusals above are the device token's scope, not a closed route.
  assert.equal((await admin.read('/api/admin/offsite-backup')).status, 503, 'the admin session reaches the refusal, not a closed route');
  // The admin's own browser session no longer reads feature administration from Node either.
  const own = await admin.read('/api/admin/features');
  assert.equal(own.status, 503);
  assert.equal(own.json.code, 'RUST_FEATURES_OWNED');
});

test('bearer tokens cannot carry cookies, and a cookie session cannot borrow a bearer', async () => {
  const tokens = deviceFor(adminId, 'Mixed credentials');
  const both = await request('/api/chats/search', { headers: { ...bearer(tokens.access), cookie: admin.cookie } });
  assert.equal(both.status, 400);
  assert.equal(both.json.code, 'ambiguous_credentials');
  // A cookie-authenticated write with a bearer attached is refused before any route runs, so a
  // bearer can never stand in for the CSRF header.
  const smuggled = await request('/api/workspace/model', { method: 'PUT', body: {}, headers: { ...bearer(tokens.access), cookie: admin.cookie, origin: ORIGIN } });
  assert.equal(smuggled.status, 400);
  // A csrf cookie alone alongside a bearer is refused too.
  assert.equal((await request('/api/chats/search', { headers: { ...bearer(tokens.access), cookie: `cowork_csrf=${admin.csrf}` } })).status, 400);
  // Unknown, malformed and query-string tokens are 401.
  assert.equal((await asDevice('nva_not-a-real-token', '/api/chats/search')).status, 401);
  assert.equal((await asDevice(tokens.refresh, '/api/chats/search')).status, 401, 'a refresh token is not an access token');
  assert.equal((await request(`/api/chats/search?access_token=${tokens.access}`)).status, 401);
  // The approval page is the Rust front's (#2190): Node refuses it, feature on or off.
  const page = await request('/device');
  assert.equal(page.status, 503);
  assert.equal(page.json.code, 'RUST_PUBLIC_PAGES_OWNED');
});

test('F2: a device token cannot link connectors or change their tool policy', async () => {
  const tokens = deviceFor(adminId, 'Connector Mac');
  // The connector writes are the Rust front's (the Google Drive ones since #2190 round 7, the Nextcloud permissions since
  // #2202 round 2): Node refuses them before authentication, and the front's gate refuses a device token on them (noevia-rs
  // tests/offsite.rs and tests/toolboxes_connectors.rs check its browser-only list). The list is the front's too.
  for (const [method, url, body, code] of [
    ['PUT', '/api/connectors/nextcloud/policy', { tools: [], mode: 'allow' }, 'RUST_CONNECTORS_OWNED'],
    ['POST', '/api/connectors/gdrive/connect', {}, 'RUST_GOOGLE_DRIVE_OWNED'], ['POST', '/api/connectors/gdrive/disconnect', {}, 'RUST_GOOGLE_DRIVE_OWNED'],
    ['PUT', '/api/connectors/gdrive/policy', { tools: ['drive_write'], mode: 'allow' }, 'RUST_GOOGLE_DRIVE_OWNED'], ['PUT', '/api/connectors/gdrive/backup-copy', { enabled: true }, 'RUST_GOOGLE_DRIVE_OWNED'],
  ]) {
    const r = await asDevice(tokens.access, url, { method, body });
    assert.equal(r.status, 503, `${method} ${url} -> ${r.status}`);
    assert.equal(r.json.code, code);
  }
  assert.equal((await asDevice(tokens.access, '/api/connectors')).json.code, 'RUST_CONNECTORS_OWNED', 'the list is the front\'s, which lets a device token read it');
});
