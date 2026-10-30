'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const Database = require('better-sqlite3');
const { createAuth } = require('./auth.cjs');
const { createWebAddressRoutes } = require('./routes/web-address.cjs');

const temps = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-addr-')); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });
const asFront = (dir, fn) => { const db = new Database(path.join(dir, 'cowork.db')); try { return fn(db); } finally { db.close(); } };
const req = (origin) => ({ headers: { origin } });

test('Node removes its web-address writers and refuses their settings even in an exemption', () => {
  const dir = temp();
  const auth = createAuth({ dataDir: dir, publicOrigin: 'https://old.example.test' });
  assert.equal(auth.changeOrigin, undefined);
  assert.equal(auth.removeEarlierOrigin, undefined);
  for (const key of ['public_origin_admin', 'previous_origins']) {
    for (const exempt of [false, true]) {
      const write = () => auth.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, '[]');
      assert.throws(exempt ? () => auth.rustAuth.exempt(write) : write, e => e.status === 503 && e.code === 'RUST_WEB_ADDRESS_WRITE_OWNED');
    }
  }
  auth.db.close();
});

test('Node live origin/CSRF and related-origin readers follow Rust writes without restart', () => {
  const dir = temp();
  const auth = createAuth({ dataDir: dir, publicOrigin: 'https://old.example.test', rpId: 'old.example.test' });
  asFront(dir, db => {
    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('public_origin_admin',?)").run('https://new.example.test');
    db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('previous_origins',?)").run(JSON.stringify(['https://old.example.test']));
  });
  assert.equal(auth.origin, 'https://new.example.test');
  assert.equal(auth.originSource, 'settings');
  assert.equal(auth.rpId, 'new.example.test');
  assert.deepEqual(auth.previousOrigins, ['https://old.example.test']);
  assert.deepEqual(auth.relatedOrigins(), ['https://new.example.test', 'https://old.example.test']);
  assert.ok(auth.originValid(req('https://old.example.test')));
  asFront(dir, db => db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('previous_origins','[]')").run());
  assert.equal(auth.originValid(req('https://old.example.test')), false);
  assert.deepEqual(auth.relatedOrigins(), ['https://new.example.test']);
  auth.db.close();
});

test('the remaining Node route factory serves GET oracle and HEAD fallback only', async () => {
  const out = [];
  const route = createWebAddressRoutes({
    auth: { instanceId: 'id', origin: 'https://one.test', originSource: 'settings', previousOrigins: [], rpId: 'one.test', relatedOrigins: () => ['https://one.test'] },
    json: (_res, status, body) => out.push({ status, body }),
  });
  const admin = { user: { id: 'u', role: 'admin' } };
  assert.equal(await route({ method: 'GET' }, {}, { path: '/api/instance', authn: null }), true);
  assert.deepEqual(out.pop(), { status: 200, body: { id: 'id' } });
  assert.equal(await route({ method: 'GET' }, {}, { path: '/.well-known/webauthn', authn: null }), true);
  assert.deepEqual(out.pop(), { status: 200, body: { origins: ['https://one.test'] } });
  assert.equal(await route({ method: 'GET' }, {}, { path: '/api/admin/web-address', authn: admin }), true);
  assert.deepEqual(out.pop(), { status: 200, body: { origin: 'https://one.test', source: 'settings', previous: [], rpId: 'one.test' } });
  assert.equal(await route({ method: 'HEAD' }, {}, { path: '/api/admin/web-address', authn: admin }), true);
  assert.equal(out.pop().status, 405);
  assert.equal(await route({ method: 'HEAD' }, {}, { path: '/api/admin/web-address/remove', authn: admin }), true);
  assert.deepEqual(out.pop(), { status: 405, body: { error: 'method not allowed' } });
  assert.equal(await route({ method: 'GET' }, {}, { path: '/api/admin/web-address/remove', authn: { user: { role: 'member' } } }), true);
  assert.deepEqual(out.pop(), { status: 403, body: { error: 'Administrator required' } });
  assert.equal(await route({ method: 'POST' }, {}, { path: '/api/admin/web-address/remove', authn: admin }), false);
});

// The public registration pages (/about, /privacy) are the Rust front's (#2190, noevia-rs
// bins/noevia-server public_pages.rs, which keeps the drive.file wording); rust-settings-singles.test.cjs.
