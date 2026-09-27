'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { createAuth, digest } = require('./auth.cjs');
const { createAuthRoutes } = require('./routes/auth.cjs');

const ORIGIN = 'https://synthetic.example.test';
const CAPACITY = 4096;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-auth-challenges-'));
  fs.writeFileSync(path.join(root, 'first-run-setup-code'), 'synthetic\n');
  const auth = createAuth({ dataDir: root, publicOrigin: ORIGIN });
  t.after(() => { auth.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const routes = createAuthRoutes({
    json: (res, status, body) => { res.result = { status, body }; return true; },
    readJson: async (req) => { let body = ''; for await (const chunk of req) body += chunk; return JSON.parse(body); },
    authService: auth,
    publicAuthRoutes: new Set(['/api/auth/login/passkey/options']),
  });
  async function options(username) {
    const req = Readable.from([JSON.stringify({ username })]);
    Object.assign(req, { method: 'POST', headers: { origin: ORIGIN }, socket: { remoteAddress: '203.0.113.12' } });
    const res = {};
    await routes.open(req, res, { path: '/api/auth/login/passkey/options' });
    return res.result;
  }
  async function registration(userId) {
    const res = {};
    await routes.account({ method: 'POST' }, res, { path: '/api/auth/passkeys/register/options', authn: { user: { id: userId } } });
    return res.result;
  }
  const count = () => auth.db.prepare('SELECT count(*) AS n FROM challenges').get().n;
  return { auth, options, registration, count };
}

test('a public passkey-options request prunes expired unused challenges without invalidating live ones', async (t) => {
  const { auth, options, count } = fixture(t);
  const live = await options('ghost-live');
  assert.equal(live.status, 200);
  for (let i = 0; i < 25; i++) assert.equal((await options(`ghost-${i}`)).status, 200);
  assert.equal(count(), 26);
  auth.db.prepare('UPDATE challenges SET expires_at=0 WHERE id_hash<>?').run(digest(live.body.challengeToken));

  const next = await options('ghost-next');
  assert.equal(next.status, 200);
  assert.equal(count(), 2);
  assert.equal(auth.db.prepare('SELECT count(*) AS n FROM challenges WHERE id_hash=?').get(digest(live.body.challengeToken)).n, 1);
  assert.equal(auth.db.prepare('SELECT count(*) AS n FROM challenges WHERE expires_at=0').get().n, 0);
});

test('concurrent public issuance stops at capacity, preserves old ceremonies, and recovers after redemption or expiry', async (t) => {
  const { auth, options, registration, count } = fixture(t);
  const now = Date.now();
  auth.db.prepare(`INSERT INTO users(id,username,username_norm,display_name,role,password_hash,webauthn_user_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run('known-id', 'known', 'known', 'Known', 'member', 'synthetic-unused-hash', 'AQIDBA', now, now);
  const live = await options('ghost-live');
  assert.equal(live.status, 200);
  const seed = auth.db.prepare('INSERT INTO challenges(id_hash,user_id,kind,challenge,expires_at) VALUES(?,?,?,?,?)');
  const seedRows = auth.db.transaction(() => {
    for (let i = 0; i < CAPACITY - 3; i++) seed.run(`seed-${i}`, null, 'authenticate', `synthetic-${i}`, now + 60_000);
  });
  seedRows();
  assert.equal(count(), CAPACITY - 2);

  const results = await Promise.all(['known', 'ghost-a', 'known', 'ghost-b'].map(options));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 200, 503, 503]);
  assert.equal(count(), CAPACITY);
  assert.equal(auth.db.prepare('SELECT count(*) AS n FROM challenges WHERE id_hash=?').get(digest(live.body.challengeToken)).n, 1,
    'capacity must never evict an existing ceremony');
  const knownBlocked = await options('known');
  const unknownBlocked = await options('ghost-c');
  assert.deepEqual(knownBlocked, unknownBlocked, 'capacity errors must not reveal whether the username exists');
  assert.deepEqual(knownBlocked, { status: 503, body: { error: 'passkey sign-in is temporarily busy' } });
  assert.deepEqual(await registration('known-id'), { status: 503, body: { error: 'passkey setup is temporarily busy' } });
  assert.equal(count(), CAPACITY);

  await assert.rejects(auth.authenticationVerify({}, {}, { challengeToken: live.body.challengeToken, response: { id: 'no-key' } }),
    /authentication failed/);
  assert.equal(count(), CAPACITY - 1, 'a presented live token remains redeemable at capacity');
  assert.equal((await registration('known-id')).status, 200, 'one freed slot permits a new ceremony');
  assert.equal(count(), CAPACITY);

  auth.db.prepare("UPDATE challenges SET expires_at=0 WHERE id_hash LIKE 'seed-%'").run();
  assert.equal((await options('ghost-next')).status, 200);
  assert.equal(auth.db.prepare('SELECT count(*) AS n FROM challenges WHERE expires_at=0').get().n, 0);
  assert.equal(count(), 4, 'expired rows are pruned while live sign-in and registration challenges remain');
});
