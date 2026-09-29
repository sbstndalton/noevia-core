'use strict';

// device-auth.cjs with a controllable clock: expiry, polling speed, rotation races and the
// browser-only path rules. Synthetic accounts in a throwaway auth database.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAuth, createRateLimiter } = require('./auth.cjs');
const device = require('./device-auth.cjs');

const ORIGIN = 'https://noevia.example.test';
const req = (ip = '10.1.0.1', extra = {}) => ({ headers: { origin: ORIGIN, 'user-agent': 'NoeviaKit/0.1 (macOS)', ...extra }, socket: { remoteAddress: ip } });
const res = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; } });

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-device-unit-'));
  const warn = console.warn;
  console.warn = () => {}; // the first-run setup code is synthetic; keep it out of the output
  let auth;
  try { auth = createAuth({ dataDir: root, publicOrigin: ORIGIN }); } finally { console.warn = warn; }
  t.after(() => { auth.db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const setup = await auth.setup(req(), res(), { setupCode: fs.readFileSync(path.join(root, 'first-run-setup-code'), 'utf8').trim(), publicOrigin: ORIGIN, username: 'owner', password: 'synthetic unit password' });
  const clock = { t: 1_000_000 };
  const audits = [];
  const deviceAuth = device.createDeviceAuth({
    db: auth.db, publicUser: auth.publicUser, rate: createRateLimiter(), clientAddress: (r) => r.socket.remoteAddress,
    audit: (...a) => { audits.push(a); auth.audit(...a); }, origin: () => ORIGIN, now: () => clock.t, addressesTrusted: true,
  });
  return { auth, deviceAuth, clock, audits, userId: setup.body.user.id };
}

async function approved(f, name = 'Unit Mac') {
  const started = f.deviceAuth.start(req(), { client_name: name }).body;
  assert.equal(f.deviceAuth.decide(f.userId, started.user_code, true).status, 200);
  const tokens = f.deviceAuth.token(req(), { grant_type: device.DEVICE_GRANT_TYPE, device_code: started.device_code });
  assert.equal(tokens.status, 200);
  return tokens.body;
}

const bearerReq = (token) => ({ headers: { authorization: `Bearer ${token}` } });

test('an unapproved device code expires after ten minutes and cannot be approved late', async (t) => {
  const f = await fixture(t);
  const started = f.deviceAuth.start(req(), { client_name: 'Slow Mac' }).body;
  f.clock.t += device.DEVICE_CODE_TTL_MS;
  assert.equal(f.deviceAuth.lookup(f.userId, started.user_code).status, 404);
  assert.equal(f.deviceAuth.decide(f.userId, started.user_code, true).status, 404);
  assert.equal(f.deviceAuth.token(req(), { grant_type: device.DEVICE_GRANT_TYPE, device_code: started.device_code }).body.error, 'expired_token');
});

test('polling faster than the interval earns slow_down and a longer interval', async (t) => {
  const f = await fixture(t);
  const started = f.deviceAuth.start(req(), { client_name: 'Eager Mac' }).body;
  const poll = () => f.deviceAuth.token(req(), { grant_type: device.DEVICE_GRANT_TYPE, device_code: started.device_code }).body.error;
  assert.equal(poll(), 'authorization_pending');
  f.clock.t += 1000;
  assert.equal(poll(), 'slow_down');
  f.clock.t += device.POLL_INTERVAL_MS; // the interval is now 10 s, so 5 s later is still too fast
  assert.equal(poll(), 'slow_down');
  f.clock.t += 20_000;
  assert.equal(poll(), 'authorization_pending');
});

test('an access token expires after an hour; the refresh token still rotates', async (t) => {
  const f = await fixture(t);
  const tokens = await approved(f);
  assert.ok(f.deviceAuth.authenticate(bearerReq(tokens.access_token)));
  f.clock.t += device.ACCESS_TTL_MS;
  assert.equal(f.deviceAuth.authenticate(bearerReq(tokens.access_token)), null);
  const next = f.deviceAuth.token(req(), { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  assert.equal(next.status, 200);
  assert.ok(f.deviceAuth.authenticate(bearerReq(next.body.access_token)));
});

test('a grant idle for seven days, or older than thirty, needs a new approval', async (t) => {
  const f = await fixture(t);
  const idle = await approved(f, 'Idle Mac');
  f.clock.t += device.REFRESH_IDLE_MS;
  assert.equal(f.deviceAuth.token(req(), { grant_type: 'refresh_token', refresh_token: idle.refresh_token }).body.error, 'invalid_grant');

  let tokens = await approved(f, 'Busy Mac');
  // Refreshing every six days keeps it alive, but only until the 30-day absolute limit.
  for (let day = 6; day < 30; day += 6) {
    f.clock.t += 6 * 24 * 60 * 60 * 1000;
    const r = f.deviceAuth.token(req(), { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
    assert.equal(r.status, 200, `day ${day}`);
    tokens = r.body;
  }
  f.clock.t += 6 * 24 * 60 * 60 * 1000;
  assert.equal(f.deviceAuth.authenticate(bearerReq(tokens.access_token)), null);
  assert.equal(f.deviceAuth.token(req(), { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).body.error, 'invalid_grant');
  assert.equal(f.deviceAuth.list(f.userId).length, 0);
});

test('reuse detection revokes the chain and is audited with the account as target', async (t) => {
  const f = await fixture(t);
  const tokens = await approved(f);
  const rotated = f.deviceAuth.token(req(), { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).body;
  f.clock.t += device.REFRESH_GRACE_MS + 1; // past the retry grace window
  assert.equal(f.deviceAuth.token(req(), { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).body.error, 'invalid_grant');
  assert.equal(f.deviceAuth.authenticate(bearerReq(rotated.access_token)), null);
  assert.ok(f.audits.some(([action, , target]) => action === 'device.refresh_reuse' && target === f.userId));
});

test('F3: the previous refresh token works for 60 s while its successor is unused, then is reuse', async (t) => {
  const f = await fixture(t);
  const tokens = await approved(f);
  const refresh = (token) => f.deviceAuth.token(req(), { grant_type: 'refresh_token', refresh_token: token });
  assert.equal(refresh(tokens.refresh_token).status, 200); // answer lost in transit
  f.clock.t += device.REFRESH_GRACE_MS - 1000;
  const retry = refresh(tokens.refresh_token);
  assert.equal(retry.status, 200, 'retried inside the window');
  assert.ok(f.deviceAuth.authenticate(bearerReq(retry.body.access_token)));
  // The window is measured from the first use, not extended by retries.
  f.clock.t += 2000;
  assert.equal(refresh(tokens.refresh_token).body.error, 'invalid_grant');
  assert.equal(f.deviceAuth.authenticate(bearerReq(retry.body.access_token)), null, 'outside the window it is reuse');
  assert.equal(f.audits.filter(([a]) => a === 'device.refresh_reuse').length, 1);
});

test('F3: a used successor makes the previous refresh token reuse even inside the window', async (t) => {
  const f = await fixture(t);
  const tokens = await approved(f);
  const refresh = (token) => f.deviceAuth.token(req(), { grant_type: 'refresh_token', refresh_token: token });
  const second = refresh(tokens.refresh_token).body;
  const third = refresh(second.refresh_token).body;
  assert.equal(refresh(tokens.refresh_token).body.error, 'invalid_grant');
  assert.equal(f.deviceAuth.authenticate(bearerReq(third.access_token)), null);
});

test('F4: revokeAll deletes every grant and audits each account once', async (t) => {
  const f = await fixture(t);
  const a = await approved(f, 'One');
  const b = await approved(f, 'Two');
  assert.equal(f.deviceAuth.revokeAll('admin-actor', 'feature-off'), 2);
  assert.equal(f.deviceAuth.authenticate(bearerReq(a.access_token)), null);
  assert.equal(f.deviceAuth.authenticate(bearerReq(b.access_token)), null);
  assert.equal(f.auth.db.prepare('SELECT count(*) AS n FROM device_tokens').get().n, 0);
  const revokes = f.audits.filter(([action]) => action === 'device.revoke_all');
  assert.deepEqual(revokes.map(([, actor, target, detail]) => [actor, target, detail.count, detail.reason]), [['admin-actor', f.userId, 2, 'feature-off']]);
  assert.equal(f.deviceAuth.revokeAll('admin-actor', 'feature-off'), 0);
});

const refreshRows = (f) => f.auth.db.prepare("SELECT token_hash, used_at, replaced_by FROM device_tokens WHERE kind='refresh'").all();

test('R1: used refresh rows are pruned past the grace window, keeping only the latest link', async (t) => {
  const f = await fixture(t);
  let tokens = await approved(f);
  for (let i = 0; i < 20; i++) {
    f.clock.t += 2 * 60 * 1000; // two minutes apart: each previous link is past the window
    tokens = f.deviceAuth.token(req(), { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).body;
    assert.ok(tokens.refresh_token, `refresh ${i}`);
  }
  const rows = refreshRows(f);
  assert.equal(rows.filter((r) => r.used_at === null).length, 1, 'one live refresh token');
  assert.equal(rows.filter((r) => r.used_at !== null).length, 1, 'only the latest used link survives');
  // That latest link is still what reuse detection needs.
  const previous = rows.find((r) => r.used_at !== null);
  const live = rows.find((r) => r.used_at === null);
  assert.equal(previous.replaced_by, live.token_hash);
});

test('R1: pruning keeps N2 detection: a discarded successor still revokes the grant', async (t) => {
  const f = await fixture(t);
  const refresh = (token) => f.deviceAuth.token(req(), { grant_type: 'refresh_token', refresh_token: token });
  const t0 = await approved(f);
  const t1 = refresh(t0.refresh_token).body; // the real client holds T1
  const t2 = refresh(t0.refresh_token).body; // a thief replays T0 inside the window
  assert.ok(t2.refresh_token);
  // The thief keeps refreshing for a while, long past the window, so pruning runs many times.
  let thief = t2;
  for (let i = 0; i < 10; i++) {
    f.clock.t += 5 * 60 * 1000;
    thief = refresh(thief.refresh_token).body;
    assert.ok(thief.access_token, `thief refresh ${i}`);
  }
  // Much later the real client presents T1: still reuse, the grant (and the thief) is revoked.
  const caught = refresh(t1.refresh_token);
  assert.equal(caught.body.error, 'invalid_grant');
  assert.equal(f.deviceAuth.authenticate(bearerReq(thief.access_token)), null);
  assert.ok(f.audits.some(([a]) => a === 'device.refresh_reuse'));
});

test('R1: the per-grant refresh budget is checked before rotating', async (t) => {
  const f = await fixture(t);
  let tokens = await approved(f);
  for (let i = 0; i < device.LIMITS.tokenGrant.limit; i++) {
    tokens = f.deviceAuth.token(req(), { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).body;
  }
  const refused = f.deviceAuth.token(req(), { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  assert.equal(refused.status, 429);
  assert.ok(f.deviceAuth.authenticate(bearerReq(tokens.access_token)), 'refused, not rotated: the current pair still works');
  assert.equal(refreshRows(f).filter((r) => r.used_at === null).length, 1);
});

test('N3: native-app sign-in cannot be enabled without TRUST_PROXY', () => {
  const { createFeatures } = require('./features.cjs');
  const store = () => { const m = new Map(); return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) }; };
  const off = createFeatures({ env: { NOEVIA_FEATURE_NATIVE_CLIENT_AUTH: 'true' }, store: store() });
  assert.equal(off.enabled('nativeClientAuth'), false, 'even the env var cannot switch it on');
  assert.equal(off.flags().nativeClientAuth, false);
  assert.match(off.describe().find((f) => f.name === 'nativeClientAuth').unavailable, /Needs TRUST_PROXY on so sign-in limits can tell clients apart/);
  const admin = createFeatures({ env: {}, store: store() });
  assert.throws(() => admin.set('nativeClientAuth', true, 'admin'), (e) => e.status === 409 && /TRUST_PROXY/.test(e.message));
  assert.equal(createFeatures({ env: { NOEVIA_FEATURE_NATIVE_CLIENT_AUTH: 'true', TRUST_PROXY: 'true' }, store: store() }).enabled('nativeClientAuth'), true);
});

test('revokeAll also clears pending and approved sign-in requests', async (t) => {
  const f = await fixture(t);
  const pending = f.deviceAuth.start(req(), { client_name: 'Pending' }).body;
  const approvedCode = f.deviceAuth.start(req(), { client_name: 'Approved' }).body;
  f.deviceAuth.decide(f.userId, approvedCode.user_code, true);
  f.deviceAuth.revokeAll('admin-actor', 'feature-off');
  assert.equal(f.auth.db.prepare('SELECT count(*) AS n FROM device_authorizations').get().n, 0);
  assert.equal(f.deviceAuth.token(req(), { grant_type: device.DEVICE_GRANT_TYPE, device_code: approvedCode.device_code }).body.error, 'invalid_grant', 'an approved code cannot be redeemed after the switch-off');
  assert.equal(f.deviceAuth.lookup(f.userId, pending.user_code).status, 404);
});

test('F1: lookups and the device list hide the socket address unless it is trusted', async (t) => {
  const f = await fixture(t);
  const started = f.deviceAuth.start(req('10.9.9.9'), { client_name: 'Hidden' }).body;
  assert.equal(f.deviceAuth.lookup(f.userId, started.user_code).body.ip, '10.9.9.9', 'the unit fixture trusts addresses');
  const hidden = device.createDeviceAuth({ db: f.auth.db, publicUser: f.auth.publicUser, rate: createRateLimiter(), clientAddress: (r) => r.socket.remoteAddress,
    audit: () => {}, origin: () => ORIGIN, now: () => f.clock.t, addressesTrusted: false });
  assert.equal(hidden.lookup(f.userId, started.user_code).body.ip, null);
  await approved(f, 'Listed');
  assert.ok(hidden.list(f.userId).every((d) => d.ip === null));
});

test('F1: token limits key on the credential; unknown credentials share one bounded bucket', async (t) => {
  const f = await fixture(t);
  const tokens = await approved(f);
  let limited = 0;
  for (let i = 0; i < device.LIMITS.tokenUnknown.limit + 5; i++) {
    const r = f.deviceAuth.token(req(), { grant_type: 'refresh_token', refresh_token: `nvr_unknown${i}` });
    if (r.status === 429) limited++;
  }
  assert.equal(limited, 5);
  // Malformed requests are refused before any bucket is charged.
  for (let i = 0; i < 50; i++) assert.equal(f.deviceAuth.token(req(), { grant_type: 'nope' }).status, 400);
  assert.equal(f.deviceAuth.token(req(), { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }).status, 200);
});

test('a password reset revokes every device, like every session', async (t) => {
  const f = await fixture(t);
  const tokens = await approved(f);
  const recovery = f.auth.createRecovery(f.userId, f.userId);
  assert.equal(await f.auth.completeRecovery({ token: recovery.token, password: 'another synthetic password' }), true);
  assert.equal(f.deviceAuth.authenticate(bearerReq(tokens.access_token)), null);
});

test('user codes are unambiguous, normalised and hashed; client names are single-line and bounded', async (t) => {
  const f = await fixture(t);
  const started = f.deviceAuth.start(req(), { client_name: 'Name‮ with\ncontrols' + 'x'.repeat(100) }).body;
  assert.match(started.user_code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  const stored = f.auth.db.prepare('SELECT * FROM device_authorizations').get();
  assert.ok(!JSON.stringify(stored).includes(started.user_code.replace('-', '')));
  assert.ok(!JSON.stringify(stored).includes(started.device_code));
  assert.equal(stored.client_name.length, 60);
  assert.doesNotMatch(stored.client_name, /[‮\n]/);
  assert.equal(device.normalizeUserCode(' bcdf-ghjk '), 'BCDFGHJK');
  assert.equal(device.normalizeUserCode('BCDF-GHJA'), '', 'vowels are never part of a code');
  assert.equal(device.normalizeUserCode('BCDFGHJKL'), '');
});

test('browser-only paths match on segment boundaries, not on look-alike prefixes', () => {
  assert.equal(device.browserOnly('/api/admin'), true);
  assert.equal(device.browserOnly('/api/admin/users/x/disabled', 'PUT'), true);
  assert.equal(device.browserOnly('/api/administrator'), false);
  assert.equal(device.browserOnly('/api/profile'), true);
  assert.equal(device.browserOnly('/api/profile/appearance'), false);
  assert.equal(device.browserOnly('/api/integrations/storage', 'GET'), false);
  assert.equal(device.browserOnly('/api/integrations/storage', 'PUT'), true);
  assert.equal(device.browserOnly('/api/integrations/storage/files/a.md', 'GET'), false);
  assert.equal(device.browserOnly('/api/workspace'), false);
  assert.equal(device.browserOnly('/api/chat', 'POST'), false);
  assert.equal(device.browserOnly('/api/tool-approvals/abc', 'POST'), false, 'a device answers its own write approvals');
});

test('the request authenticator is exactly auth.cjs while the feature is off', async (t) => {
  const f = await fixture(t);
  const tokens = await approved(f);
  let on = false;
  const calls = [];
  const fakeAuth = { authenticate: (r) => { calls.push(r); return null; }, csrfValid: () => false };
  const gate = device.createRequestAuth({ enabled: () => on, deviceAuth: f.deviceAuth, authService: fakeAuth });
  assert.equal(gate.authenticate(bearerReq(tokens.access_token)), null);
  assert.equal(calls.length, 1, 'with the flag off, the bearer goes to auth.cjs untouched');
  on = true;
  const authn = gate.authenticate(bearerReq(tokens.access_token));
  assert.equal(authn.device.clientName, 'Unit Mac');
  assert.equal(calls.length, 1);
  assert.equal(gate.csrfValid(bearerReq(tokens.access_token), authn), true);
  assert.equal(gate.csrfValid({ headers: { ...bearerReq(tokens.access_token).headers, cookie: 'cowork_session=x' } }, authn), false);
  assert.equal(gate.authenticate({ headers: { ...bearerReq(tokens.access_token).headers, cookie: 'cowork_session=x' } }), null);
  assert.equal(gate.browserOnly(authn, '/api/admin/users', 'GET'), true);
  assert.equal(gate.browserOnly({ user: {}, session: {} }, '/api/admin/users', 'GET'), false);
  // Turning the feature off stops every device token at once.
  on = false;
  assert.equal(gate.authenticate(bearerReq(tokens.access_token)), null);
});
