'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createAuth } = require('./auth.cjs');
const { createWebAddressRoutes } = require('./routes/web-address.cjs');

const temps = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-addr-')); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

const req = (origin) => ({ headers: { origin } });
// The account tables are the Rust front's (#1071): this process's connection refuses to write them, so
// the synthetic users and passkeys are written through a separate connection, as the front would.
const Database = require('better-sqlite3');
const asFront = (dir, fn) => { const db = new Database(path.join(dir, 'cowork.db')); try { return fn(db); } finally { db.close(); } };

test('an admin-chosen address wins over PUBLIC_ORIGIN, survives a restart, and keeps the old one for sign-in', () => {
  const dir = temp();
  const auth = createAuth({ dataDir: dir, publicOrigin: 'https://cowork.example.test' });
  assert.equal(auth.origin, 'https://cowork.example.test');
  assert.equal(auth.originSource, 'environment');
  assert.equal(auth.changeOrigin('https://noevia.example.test/', 'u1'), null);
  assert.equal(auth.origin, 'https://noevia.example.test');
  assert.equal(auth.rpId, 'noevia.example.test', 'passkeys follow the new name');
  assert.ok(auth.originValid(req('https://noevia.example.test')));
  assert.ok(auth.originValid(req('https://cowork.example.test')), 'the old address still signs in');
  assert.equal(auth.originValid(req('https://evil.example.test')), false);
  auth.db.close();
  const again = createAuth({ dataDir: dir, publicOrigin: 'https://cowork.example.test' });
  assert.equal(again.origin, 'https://noevia.example.test', 'the setting outlives the environment default');
  assert.equal(again.originSource, 'settings');
  assert.deepEqual(again.previousOrigins, ['https://cowork.example.test']);
  assert.ok(again.originValid(req('https://cowork.example.test')));
  again.db.close();
});

test('bad addresses are refused with a plain reason', () => {
  const auth = createAuth({ dataDir: temp(), publicOrigin: 'https://cowork.example.test' });
  assert.match(auth.changeOrigin('noevia', 'u'), /full address/);
  assert.match(auth.changeOrigin('https://noevia.example.test/app', 'u'), /without a path/);
  assert.match(auth.changeOrigin('http://noevia.example.test', 'u'), /https/);
  assert.equal(auth.origin, 'https://cowork.example.test');
  auth.db.close();
});

test('the route saves only when the new address reaches this same server', async () => {
  const auth = createAuth({ dataDir: temp(), publicOrigin: 'https://cowork.example.test' });
  let answer = { ok: true, status: 200, json: async () => ({ id: 'someone-else' }) };
  const out = {};
  const json = (res, status, body) => { out.status = status; out.body = body; };
  const route = (body) => createWebAddressRoutes({ auth, json, readBody: async () => body, fetchImpl: async (url) => { out.fetched = url; if (answer instanceof Error) throw answer; return answer; } });
  const admin = { user: { id: 'a', role: 'admin' } };

  await route({})({ method: 'GET' }, {}, { path: '/api/instance', authn: null });
  assert.deepEqual(out.body, { id: auth.instanceId }, 'the instance id is public');

  await route({ origin: 'https://noevia.example.test' })({ method: 'POST' }, {}, { path: '/api/admin/web-address', authn: { user: { id: 'm', role: 'member' } } });
  assert.equal(out.status, 403);

  await route({ origin: 'https://noevia.example.test' })({ method: 'POST' }, {}, { path: '/api/admin/web-address', authn: admin });
  assert.equal(out.fetched, 'https://noevia.example.test/api/instance');
  assert.equal(out.status, 409); assert.match(out.body.error, /different server/);
  assert.equal(auth.origin, 'https://cowork.example.test');

  answer = new Error('ENOTFOUND');
  await route({ origin: 'https://noevia.example.test' })({ method: 'POST' }, {}, { path: '/api/admin/web-address', authn: admin });
  assert.equal(out.status, 409); assert.equal(out.body.unreachable, true);

  answer = { ok: true, status: 200, json: async () => ({ id: auth.instanceId }) };
  await route({ origin: 'https://noevia.example.test' })({ method: 'POST' }, {}, { path: '/api/admin/web-address', authn: admin });
  assert.equal(out.status, 200);
  assert.equal(out.body.origin, 'https://noevia.example.test');
  assert.deepEqual(out.body.previous, ['https://cowork.example.test']);

  // "Save anyway" skips the check, for a route that will only work after the change.
  answer = new Error('ENOTFOUND');
  await route({ origin: 'https://later.example.test', force: true })({ method: 'POST' }, {}, { path: '/api/admin/web-address', authn: admin });
  assert.equal(out.status, 200);
  auth.db.close();
});

test('about and privacy pages exist for Google’s app registration and name the Drive scope', () => {
  const { publicPage } = require('./routes/public-pages.cjs');
  assert.match(publicPage('/privacy'), /drive\.file/);
  assert.match(publicPage('/privacy'), /Limited Use/);
  assert.match(publicPage('/about'), /noevia/);
  assert.equal(publicPage('/admin'), null);
});

test('a rename: new passkeys use the new address, old ones keep their name and the new address is a related origin', () => {
  const dir = temp();
  const auth = createAuth({ dataDir: dir, publicOrigin: 'https://cowork.example.test' });
  const now = Date.now();
  const cols = auth.db.prepare('PRAGMA table_info(passkeys)').all();
  const row = Object.fromEntries(cols.filter((c) => c.notnull && c.dflt_value === null && !c.pk).map((c) => [c.name, /INT/i.test(c.type) ? 1 : c.type === 'BLOB' ? Buffer.from('k') : 'x']));
  row.id = 'cred'; row.user_id = 'u';
  asFront(dir, (db) => {
    db.prepare("INSERT INTO users(id,username,username_norm,display_name,role,password_hash,webauthn_user_id,created_at,updated_at) VALUES('u','u','u','u','admin','x','w',?,?)").run(now, now);
    db.prepare(`INSERT INTO passkeys(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  });
  assert.equal(auth.changeOrigin('https://noevia.example.test', 'u'), null);
  assert.equal(auth.rpId, 'noevia.example.test', 'new passkeys are made for the new address');
  assert.equal(auth.db.prepare("SELECT rp_id FROM passkeys WHERE id='cred'").get().rp_id, 'cowork.example.test', 'the old one keeps its name');
  assert.deepEqual(auth.relatedOrigins(), ['https://noevia.example.test', 'https://cowork.example.test']);
  auth.db.close();
  const again = createAuth({ dataDir: dir, publicOrigin: 'https://cowork.example.test' });
  assert.equal(again.rpId, 'noevia.example.test', 'and after a restart');
  assert.equal(again.db.prepare("SELECT rp_id FROM passkeys WHERE id='cred'").get().rp_id, 'cowork.example.test');
  const out = {};
  createWebAddressRoutes({ auth: again, json: (res, status, body) => Object.assign(out, { status, body }), readBody: async () => ({}) })({ method: 'GET' }, {}, { path: '/.well-known/webauthn', authn: null });
  assert.deepEqual(out.body, { origins: ['https://noevia.example.test', 'https://cowork.example.test'] });
  again.db.close();
});

// Passkey sign-in and registration options are the Rust front's (#1071; noevia-rs crates/server-account).

test('a pinned WEBAUTHN_RP_ID stops applying once the address moves to a name it does not cover', () => {
  const dir = temp();
  const auth = createAuth({ dataDir: dir, publicOrigin: 'https://cowork.example.test', rpId: 'cowork.example.test' });
  assert.equal(auth.rpId, 'cowork.example.test');
  auth.changeOrigin('https://noevia.example.test', 'u');
  assert.equal(auth.rpId, 'noevia.example.test', 'new passkeys must be made for the name the browser is on');
  auth.db.close();
  const again = createAuth({ dataDir: dir, publicOrigin: 'https://cowork.example.test', rpId: 'cowork.example.test' });
  assert.equal(again.rpId, 'noevia.example.test', 'also after a restart with the old env');
  again.db.close();
  const parent = createAuth({ dataDir: temp(), publicOrigin: 'https://app.example.test', rpId: 'example.test' });
  assert.equal(parent.rpId, 'example.test', 'a parent-domain pin that fits still applies');
  parent.db.close();
});

test('#796: a JSON body that is not an object is a 400, never a TypeError', async () => {
  const auth = createAuth({ dataDir: temp(), publicOrigin: 'https://cowork.example.test' });
  const out = {};
  const json = (res, status, body) => { out.status = status; out.body = body; };
  const admin = { user: { id: 'a', role: 'admin' } };
  for (const body of [null, 7, 'text', [1]]) {
    out.status = undefined;
    const handled = await createWebAddressRoutes({ auth, json, readBody: async () => body, fetchImpl: async () => { throw Error('must not probe'); } })({ method: 'POST' }, {}, { path: '/api/admin/web-address', authn: admin });
    assert.equal(handled, true);
    assert.equal(out.status, 400, JSON.stringify(body));
    assert.match(out.body.error, /full address/);
  }
  assert.equal(auth.origin, 'https://cowork.example.test', 'nothing was saved');
});

// #1460: an earlier address that no longer resolves can be removed by an admin, and only that.
test('an admin removes an earlier address: sign-in, related origins and the saved list drop it, and it stays removed after a restart', () => {
  const dir = temp();
  const auth = createAuth({ dataDir: dir, publicOrigin: 'https://cowork.example.test' });
  assert.equal(auth.changeOrigin('https://noevia.example.test', 'u1'), null);
  assert.deepEqual(auth.previousOrigins, ['https://cowork.example.test']);
  const now = Date.now();
  asFront(dir, (db) => {
    db.prepare("INSERT INTO users(id,username,username_norm,display_name,role,password_hash,webauthn_user_id,created_at,updated_at) VALUES('u1','u1','u1','u1','admin','x','w',?,?)").run(now, now);
    db.prepare("INSERT INTO passkeys(id,user_id,name,public_key,webauthn_user_id,counter,device_type,backed_up,transports,created_at,rp_id) VALUES('old-key','u1','k',?,'w',0,'singleDevice',0,'[]',?,'cowork.example.test')").run(Buffer.from('k'), now);
  });

  assert.equal(auth.removeEarlierOrigin('https://cowork.example.test/', 'u1').error, null, 'trailing slash is tolerated');
  const removed = auth.removeEarlierOrigin('https://cowork.example.test', 'u1');
  assert.equal(removed.error, 'That address is not one of the earlier addresses.', 'removing it twice is a 404-class refusal');
  assert.equal(removed.status, 404);
  assert.deepEqual(auth.previousOrigins, []);
  assert.equal(auth.originValid(req('https://cowork.example.test')), false, 'it no longer signs in');
  assert.ok(auth.originValid(req('https://noevia.example.test')), 'the current address still does');
  assert.deepEqual(auth.relatedOrigins(), ['https://noevia.example.test']);
  assert.equal(auth.db.prepare("SELECT rp_id FROM passkeys WHERE id='old-key'").get().rp_id, 'cowork.example.test', 'the old passkey row is kept, not deleted');
  const audit = auth.db.prepare("SELECT detail FROM audit_events WHERE action='settings.public_origin.earlier_removed'").get();
  assert.deepEqual(JSON.parse(audit.detail), { origin: 'https://cowork.example.test', passkeysAffected: 1 });
  auth.db.close();
  const again = createAuth({ dataDir: dir, publicOrigin: 'https://cowork.example.test' });
  assert.deepEqual(again.previousOrigins, [], 'still removed after a restart');
  assert.equal(again.originValid(req('https://cowork.example.test')), false);
  again.db.close();
});

test('the current address and unknown addresses cannot be removed, and the route is admin only', async () => {
  const auth = createAuth({ dataDir: temp(), publicOrigin: 'https://cowork.example.test' });
  auth.changeOrigin('https://noevia.example.test', 'u');
  const current = auth.removeEarlierOrigin('https://noevia.example.test', 'u');
  assert.equal(current.status, 400);
  assert.match(current.error, /current address/);
  assert.equal(auth.removeEarlierOrigin('https://evil.example.test', 'u').status, 404);
  assert.equal(auth.removeEarlierOrigin('', 'u').status, 404);
  assert.deepEqual(auth.previousOrigins, ['https://cowork.example.test'], 'nothing else was changed');

  const out = {};
  const json = (res, status, body) => { out.status = status; out.body = body; };
  const route = (method, body, authn) => createWebAddressRoutes({ auth, json, readBody: async () => body, fetchImpl: async () => { throw Error('must not probe'); } })({ method }, {}, { path: '/api/admin/web-address/remove', authn });
  const admin = { user: { id: 'a', role: 'admin' } };
  assert.equal(await route('POST', { origin: 'https://cowork.example.test' }, { user: { id: 'm', role: 'member' } }), true);
  assert.equal(out.status, 403);
  assert.equal(await route('POST', { origin: 'https://cowork.example.test' }, null), true);
  assert.equal(out.status, 403, 'signed out');
  await route('GET', {}, admin);
  assert.equal(out.status, 405);
  for (const body of [null, 7, [1], {}, { origin: 3 }]) {
    await route('POST', body, admin);
    assert.equal(out.status, 400, JSON.stringify(body));
  }
  await route('POST', { origin: 'https://cowork.example.test' }, admin);
  assert.equal(out.status, 200);
  assert.equal(out.body.removed, 'https://cowork.example.test');
  assert.equal(out.body.passkeysAffected, 0);
  assert.deepEqual(out.body.previous, []);
  assert.equal(out.body.origin, 'https://noevia.example.test');
  auth.db.close();
});
