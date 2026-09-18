'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createAuth } = require('./auth.cjs');
const { createWebAddressRoutes } = require('./routes/web-address.cjs');

const temps = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-addr-')); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

const req = (origin) => ({ headers: { origin } });

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

test('a rename keeps existing passkeys usable: same passkey name, new address as a related origin', () => {
  const dir = temp();
  const auth = createAuth({ dataDir: dir, publicOrigin: 'https://cowork.example.test' });
  const now = Date.now();
  auth.db.prepare("INSERT INTO users(id,username,username_norm,display_name,role,password_hash,webauthn_user_id,created_at,updated_at) VALUES('u','u','u','u','admin','x','w',?,?)").run(now, now);
  const cols = auth.db.prepare('PRAGMA table_info(passkeys)').all();
  const row = Object.fromEntries(cols.filter((c) => c.notnull && c.dflt_value === null && !c.pk).map((c) => [c.name, /INT/i.test(c.type) ? 1 : c.type === 'BLOB' ? Buffer.from('k') : 'x']));
  row.id = 'cred'; row.user_id = 'u';
  auth.db.prepare(`INSERT INTO passkeys(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  assert.equal(auth.changeOrigin('https://noevia.example.test', 'u'), null);
  assert.equal(auth.rpId, 'cowork.example.test', 'passkeys keep the name they were made under');
  assert.deepEqual(auth.relatedOrigins(), ['https://noevia.example.test', 'https://cowork.example.test']);
  auth.db.close();
  const again = createAuth({ dataDir: dir, publicOrigin: 'https://cowork.example.test' });
  assert.equal(again.rpId, 'cowork.example.test', 'and after a restart');
  const out = {};
  createWebAddressRoutes({ auth: again, json: (res, status, body) => Object.assign(out, { status, body }), readBody: async () => ({}) })({ method: 'GET' }, {}, { path: '/.well-known/webauthn', authn: null });
  assert.deepEqual(out.body, { origins: ['https://noevia.example.test', 'https://cowork.example.test'] });
  again.db.close();
});
