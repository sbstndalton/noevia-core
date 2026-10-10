'use strict';
// noevia#1254: the address setup picks must be the one the server trusts both now and after a
// restart, also when PUBLIC_ORIGIN names another one. Synthetic origins and users only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAuth } = require('./auth.cjs');

const P = 'https://env.example.test';
const S = 'https://setup.example.test';
const request = () => ({ headers: { origin: P, 'user-agent': 'test' }, socket: { remoteAddress: '127.0.0.1' } });
const response = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; } });
const at = (origin) => ({ headers: { origin } });

async function setUp(t, { env, chosen }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-setup-origin-'));
  const handles = [];
  const boot = () => { const a = createAuth({ dataDir: dir, publicOrigin: env }); handles.push(a); return a; };
  t.after(() => { for (const a of handles) { try { a.db.close(); } catch {} } fs.rmSync(dir, { recursive: true, force: true }); });
  const auth = boot();
  const setupCode = fs.readFileSync(path.join(dir, 'first-run-setup-code'), 'utf8').trim();
  const r = await auth.setup(request(), response(), { setupCode, publicOrigin: chosen, username: 'owner', password: 'synthetic setup origin password' });
  assert.equal(r.status, 201);
  return { auth, restart: () => { auth.db.close(); return boot(); } };
}

const state = (a) => ({ origin: a.origin, rp: a.rpId, valid: [P, S].map((o) => a.originValid(at(o))) });

test('setup with an address other than PUBLIC_ORIGIN keeps that address after a restart', async (t) => {
  const { auth, restart } = await setUp(t, { env: P, chosen: `${S}/` });
  const live = state(auth);
  assert.equal(live.origin, S);
  assert.equal(auth.originSource, 'settings');
  assert.deepEqual(live.valid, [false, true]);
  assert.equal(auth.db.prepare("SELECT value FROM settings WHERE key='public_origin_admin'").get().value, S);
  const again = restart();
  assert.deepEqual(state(again), live, 'booting after setup agrees with the server that ran setup');
  assert.equal(again.originSource, 'settings');
});

test('setup with PUBLIC_ORIGIN itself writes no administrator override', async (t) => {
  const { auth, restart } = await setUp(t, { env: P, chosen: P });
  assert.equal(auth.db.prepare("SELECT value FROM settings WHERE key='public_origin_admin'").get(), undefined);
  assert.equal(auth.originSource, 'environment');
  const live = state(auth);
  assert.equal(live.origin, P);
  assert.deepEqual(state(restart()), live);
});

test('setup without PUBLIC_ORIGIN keeps the setup address as before', async (t) => {
  const { auth, restart } = await setUp(t, { env: '', chosen: S });
  assert.equal(auth.db.prepare("SELECT value FROM settings WHERE key='public_origin_admin'").get(), undefined);
  const live = state(auth);
  assert.equal(live.origin, S);
  const again = restart();
  assert.deepEqual(state(again), live);
  assert.equal(again.originSource, 'setup');
});
