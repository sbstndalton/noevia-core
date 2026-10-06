'use strict';
// #927: password sign-in limits behind a shared address (a tunnel with TRUST_PROXY off). Only failures
// count against an account and a success clears them; probing unknown usernames never refuses a
// correct username and password; the per-address ceiling and the account lock still hold.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAuth, createRateLimiter, trustProxyWarning } = require('./auth.cjs');

const ORIGIN = 'https://cowork.example.test';
const PASSWORD = 'synthetic limits password';
const TUNNEL = '172.18.0.2';
const request = (ip = TUNNEL) => ({ headers: { origin: ORIGIN, 'user-agent': 'test' }, socket: { remoteAddress: ip } });
const response = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; } });

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-login-limits-'));
  const auth = createAuth({ dataDir: root, publicOrigin: ORIGIN }); // TRUST_PROXY off, as behind the tunnel
  t.after(() => { auth.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await auth.setup(request('10.0.0.1'), response(), { setupCode: fs.readFileSync(path.join(root, 'first-run-setup-code'), 'utf8').trim(), publicOrigin: ORIGIN, username: 'realuser', password: PASSWORD });
  return auth;
}
const login = (auth, username, password, ip) => auth.passwordLogin(request(ip), response(), { username, password }).then((r) => r.status);

test('31 unknown-username failures from the shared address do not refuse a correct sign-in', async (t) => {
  const auth = await fixture(t);
  const probes = [];
  for (let i = 0; i < 31; i++) probes.push(await login(auth, `ghost${i}`, 'wrong synthetic password'));
  assert.deepEqual([...new Set(probes)], [401]);
  assert.equal(await login(auth, 'ghost-more', 'wrong synthetic password'), 429, 'further unknown-username failures are throttled');
  assert.equal(await login(auth, 'realuser', 'wrong synthetic password'), 429, 'a wrong password for a real user gets the same answer');
  assert.equal(await login(auth, 'realuser', PASSWORD), 200, 'the real user is locked out by strangers probing usernames');
});

test('failures on real usernames count toward the 429 switch exactly like unknown ones', async (t) => {
  const auth = await fixture(t);
  const owner = auth.listUsers()[0].id;
  for (let u = 0; u < 6; u++) await auth.acceptInvite(request(`10.9.0.${u}`), response(), { token: auth.createInvite(owner).token, username: `member${u}`, password: 'synthetic member password' });
  // 31 failures on real accounts only (at most 5 each, so no account lock), the same count that
  // switches unknown-username failures to 429.
  for (let u = 0; u < 6; u++) for (let i = 0; i < 5; i++) assert.equal(await login(auth, `member${u}`, 'wrong synthetic password'), 401);
  assert.equal(await login(auth, 'realuser', 'wrong synthetic password'), 401);
  assert.equal(await login(auth, 'ghost-after', 'wrong synthetic password'), 429, 'only unknown-username failures were counted');
  assert.equal(await login(auth, 'realuser', 'wrong synthetic password'), 429, 'a known name flips exactly like an unknown one');
  assert.equal(await login(auth, 'realuser', PASSWORD), 200);
});

test('before the switch, a known and an unknown name answer the same at every step', async (t) => {
  const auth = await fixture(t);
  const run = async (username, ip) => { const out = []; for (let i = 0; i < 7; i++) out.push(await login(auth, username, 'wrong synthetic password', ip)); return out; };
  const known = await run('realuser', '192.0.2.1');
  const unknown = await run('ghost-user', '192.0.2.2');
  assert.deepEqual(known, [401, 401, 401, 401, 401, 429, 429]);
  assert.deepEqual(unknown, known, 'the account lock reveals whether a username exists');
});

test('six consecutive correct sign-ins all succeed', async (t) => {
  const auth = await fixture(t);
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push(await login(auth, 'realuser', PASSWORD));
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200]);
});

test('six failed attempts on a user still lock it, even with the right password', async (t) => {
  const auth = await fixture(t);
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push(await login(auth, 'realuser', 'wrong synthetic password'));
  statuses.push(await login(auth, 'realuser', 'wrong synthetic password'));
  assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
  assert.equal(await login(auth, 'realuser', PASSWORD), 429, 'a lock that lets the right password through is a guessing oracle');
  assert.equal(await login(auth, 'realuser', PASSWORD, '10.0.0.77'), 200, 'another address is locked separately');
});

test('a successful sign-in clears the failure count', async (t) => {
  const auth = await fixture(t);
  for (let i = 0; i < 4; i++) assert.equal(await login(auth, 'realuser', 'wrong synthetic password'), 401);
  assert.equal(await login(auth, 'realuser', PASSWORD), 200);
  for (let i = 0; i < 5; i++) assert.equal(await login(auth, 'realuser', 'wrong synthetic password'), 401, `failure ${i + 1} after a success`);
  assert.equal(await login(auth, 'realuser', PASSWORD), 429);
});

test('concurrent wrong passwords cannot slip past the account lock', async (t) => {
  const auth = await fixture(t);
  const statuses = await Promise.all(Array.from({ length: 12 }, () => login(auth, 'realuser', 'wrong synthetic password')));
  assert.equal(statuses.filter((s) => s === 401).length, 5, 'more than five guesses were verified');
  assert.equal(statuses.filter((s) => s === 429).length, 7);
});

test('200 failures from one address refuse every password sign-in from it', async (t) => {
  const auth = await fixture(t);
  // Unknown usernames each have their own account bucket, so only the address ceiling stops them.
  for (let i = 0; i < 200; i++) await login(auth, `spray${i}`, 'wrong synthetic password', '198.51.100.7');
  assert.equal(await login(auth, 'realuser', PASSWORD, '198.51.100.7'), 429);
  assert.equal(await login(auth, 'realuser', PASSWORD, '198.51.100.8'), 200, 'another address is unaffected');
});

test('rate limiter clear and release give counts back', () => {
  const limiter = createRateLimiter();
  let last;
  for (let i = 0; i < 5; i++) last = limiter.charge('k', 5, 60_000);
  limiter.release('k', last.window);
  assert.equal(limiter.rateLimited('k', 5, 60_000), false);
  assert.equal(limiter.rateLimited('k', 5, 60_000), true);
  limiter.clear('k');
  assert.equal(limiter.blocked('k', 0), false);
  limiter.release('missing', last.window);
  assert.equal(limiter.size(), 0);
});

test('a call counted in one window is not refunded from the next', () => {
  let now = 1_000;
  const limiter = createRateLimiter({ now: () => now });
  const early = limiter.charge('k', 2, 100); // window [1000, 1100)
  now = 1_150; // the window rolls over while the request is in flight
  for (let i = 0; i < 3; i++) limiter.charge('k', 2, 100);
  assert.equal(limiter.blocked('k', 2), true);
  limiter.release('k', early.window);
  assert.equal(limiter.blocked('k', 2), true, 'a stale refund lifted the new window below its limit');
  const current = limiter.charge('k', 2, 100);
  limiter.release('k', current.window);
  assert.equal(limiter.blocked('k', 2), true);
  now = 1_300;
  assert.equal(limiter.blocked('k', 2), false, 'windows still expire on the injected clock');
});

test('startup warns when a public https address runs with TRUST_PROXY off', (t) => {
  assert.match(trustProxyWarning(ORIGIN, false), /TRUST_PROXY is off/);
  assert.equal(trustProxyWarning(ORIGIN, true), '');
  assert.equal(trustProxyWarning('http://192.168.1.20:8021', false), '');
  assert.equal(trustProxyWarning('', false), '');
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  for (const trustProxy of [false, true]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-proxy-warn-'));
    try { createAuth({ dataDir: root, publicOrigin: 'https://secret-host.example.test', trustProxy }).db.close(); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
  const proxy = warnings.filter((w) => /TRUST_PROXY/.test(w));
  assert.equal(proxy.length, 1, 'warned once, only with TRUST_PROXY off');
  assert.doesNotMatch(proxy[0], /secret-host/, 'configuration values are not logged');
});
