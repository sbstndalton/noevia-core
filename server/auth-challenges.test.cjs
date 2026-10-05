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

function fixture(t, { trustProxy = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-auth-challenges-'));
  fs.writeFileSync(path.join(root, 'first-run-setup-code'), 'synthetic\n');
  const auth = createAuth({ dataDir: root, publicOrigin: ORIGIN, trustProxy });
  t.after(() => { auth.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const routes = createAuthRoutes({
    json: (res, status, body) => { res.result = { status, body }; return true; },
    readJson: async (req) => { let body = ''; for await (const chunk of req) body += chunk; return JSON.parse(body); },
    authService: auth,
    publicAuthRoutes: new Set(['/api/auth/login/passkey/options']),
  });
  async function options(username, address = '203.0.113.12') {
    const req = Readable.from([JSON.stringify({ username })]);
    Object.assign(req, { method: 'POST', headers: { origin: ORIGIN }, socket: { remoteAddress: address } });
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

test('#783: sign-in at capacity evicts the oldest anonymous challenge, never a known user\'s, and recovers after expiry', async (t) => {
  const { auth, options, registration, count } = fixture(t);
  const now = Date.now();
  auth.db.prepare(`INSERT INTO users(id,username,username_norm,display_name,role,password_hash,webauthn_user_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run('known-id', 'known', 'known', 'Known', 'member', 'synthetic-unused-hash', 'AQIDBA', now, now);
  const live = await options('known');
  assert.equal(live.status, 200);
  const has = (idHash) => auth.db.prepare('SELECT count(*) AS n FROM challenges WHERE id_hash=?').get(idHash).n === 1;
  const seed = auth.db.prepare('INSERT INTO challenges(id_hash,user_id,kind,challenge,expires_at) VALUES(?,?,?,?,?)');
  auth.db.transaction(() => {
    // A known user's ceremony that is OLDER than every anonymous row, the oldest anonymous row,
    // and the rest of the table filled with anonymous rows.
    seed.run('known-old', 'known-id', 'authenticate', 'synthetic-known', now + 1_000);
    seed.run('anon-oldest', null, 'authenticate', 'synthetic-oldest', now + 2_000);
    for (let i = 0; i < CAPACITY - 4; i++) seed.run(`seed-${i}`, null, 'authenticate', `synthetic-${i}`, now + 60_000 + i);
  })();
  assert.equal(count(), CAPACITY - 1);

  assert.equal((await options('ghost-a')).status, 200, 'the last free slot is used without eviction');
  assert.equal(count(), CAPACITY);
  assert.ok(has('anon-oldest'));

  assert.equal((await options('ghost-b')).status, 200, 'a full table still issues a challenge');
  assert.equal(count(), CAPACITY, 'capacity stays bounded');
  assert.equal(has('anon-oldest'), false, 'the oldest anonymous challenge was evicted');
  assert.ok(has('known-old'), 'an older known-user challenge survives: anonymous rows go first');
  assert.ok(has(digest(live.body.challengeToken)), 'a newer known-user challenge survives');

  const results = await Promise.all(['known', 'ghost-c', 'known', 'ghost-d'].map((u) => options(u)));
  assert.deepEqual(results.map((r) => r.status), [200, 200, 200, 200], 'concurrent sign-in at capacity is never refused');
  assert.equal(count(), CAPACITY);
  assert.ok(has('known-old') && has(digest(live.body.challengeToken)));
  assert.equal((await registration('known-id')).status, 200, 'registration has its own budget');
  assert.equal(count(), CAPACITY + 1);

  await assert.rejects(auth.authenticationVerify({}, {}, { challengeToken: live.body.challengeToken, response: { id: 'no-key' } }),
    /authentication failed/);
  assert.equal(has(digest(live.body.challengeToken)), false, 'a presented live token is redeemed (consumed) at capacity');

  auth.db.prepare("UPDATE challenges SET expires_at=0 WHERE id_hash LIKE 'seed-%' OR id_hash='known-old'").run();
  assert.equal((await options('ghost-next')).status, 200);
  assert.equal(auth.db.prepare('SELECT count(*) AS n FROM challenges WHERE expires_at=0').get().n, 0, 'expired rows are pruned');
  // Left: ghost-a, ghost-b, the four concurrent ones, the registration and ghost-next.
  assert.equal(count(), 8);
});

test('#783: with only known-user sign-in challenges at capacity, the oldest of them is evicted', async (t) => {
  const { auth, options, count } = fixture(t);
  const now = Date.now();
  auth.db.prepare(`INSERT INTO users(id,username,username_norm,display_name,role,password_hash,webauthn_user_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run('known-id', 'known', 'known', 'Known', 'member', 'synthetic-unused-hash', 'AQIDBA', now, now);
  const seed = auth.db.prepare('INSERT INTO challenges(id_hash,user_id,kind,challenge,expires_at) VALUES(?,?,?,?,?)');
  auth.db.transaction(() => { for (let i = 0; i < CAPACITY; i++) seed.run(`known-${i}`, 'known-id', 'authenticate', `synthetic-${i}`, now + 10_000 + i); })();
  assert.equal((await options('ghost')).status, 200);
  assert.equal(count(), CAPACITY);
  assert.equal(auth.db.prepare("SELECT count(*) AS n FROM challenges WHERE id_hash='known-0'").get().n, 0);
  assert.equal(auth.db.prepare("SELECT count(*) AS n FROM challenges WHERE id_hash='known-1'").get().n, 1);
});

test('#783: with trustProxy on, anonymous passkey options are rate limited per address before any challenge is stored', async (t) => {
  const { options, count } = fixture(t, { trustProxy: true });
  for (let i = 0; i < 30; i++) assert.equal((await options(`ghost-${i}`)).status, 200, `request ${i + 1} is within the budget`);
  assert.equal(count(), 30);
  const limited = await options('ghost-30');
  assert.deepEqual(limited, { status: 429, body: { error: 'too many sign-in attempts; try again later' } });
  assert.equal(count(), 30, 'a limited request stores no challenge');
  assert.equal((await options('ghost-31', '198.51.100.7')).status, 200, 'another address keeps its own budget');
});

test('#783: with trustProxy off (every browser behind the proxy shares one address), no per-address limit applies', async (t) => {
  const { options, count } = fixture(t);
  for (let i = 0; i < 31; i++) assert.equal((await options(`ghost-${i}`)).status, 200, `request ${i + 1}`);
  assert.equal((await options('ghost-32')).status, 200, 'the shared proxy address is never locked out');
  assert.equal(count(), 32);
});

test('#783: the registration budget is separate and bounded on its own', async (t) => {
  const { auth, options, registration, count } = fixture(t);
  const now = Date.now();
  auth.db.prepare(`INSERT INTO users(id,username,username_norm,display_name,role,password_hash,webauthn_user_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run('known-id', 'known', 'known', 'Known', 'member', 'synthetic-unused-hash', 'AQIDBA', now, now);
  const seed = auth.db.prepare('INSERT INTO challenges(id_hash,user_id,kind,challenge,expires_at) VALUES(?,?,?,?,?)');
  auth.db.transaction(() => { for (let i = 0; i < 256; i++) seed.run(`reg-${i}`, 'known-id', 'register', `synthetic-${i}`, now + 60_000); })();
  assert.deepEqual(await registration('known-id'), { status: 503, body: { error: 'passkey setup is temporarily busy' } });
  assert.equal((await options('known')).status, 200, 'a full registration budget leaves sign-in unaffected');
  assert.equal(count(), 257);
});
