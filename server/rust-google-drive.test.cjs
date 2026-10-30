'use strict';
// sbstndalton/noevia#2190 round 7: Google Drive's token authority and the off-site backup are the Rust
// front's. This covers what Node still does: refuse the front's routes before authentication, keep no
// refresh token and no writer of tool_policies, read the broker's state file for the sync `connected`,
// cache and retry access tokens correctly, and agree with the front on the sealed-file bytes and on whose
// Drive an account reaches (golden vectors and the shared cases file, both also run in noevia-rs).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const gdrive = require('./rust-google-drive.cjs');
const offsite = require('./rust-offsite-backup.cjs');
const { createDriveAccounts, ownsBackup, loopbackBase, MESSAGES } = require('./gdrive-broker.cjs');
const { sealer, checkTokenFile } = require('./gdrive-seal.cjs');
const { createSecretStore } = require('./secrets.cjs');
const { createToolPolicy } = require('./tool-policy.cjs');
const { createFingerprintedCache } = require('./toolboxes-permitted.cjs');
const { createRustAuthGuard, FRONT_TABLES } = require('./rust-auth.cjs');

const temps = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rgd-')); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

// ── the refusals ─────────────────────────────────────────────────────────────────────────────

const parseRequestUrl = (req, base) => { try { return new URL(req.url, base || 'http://h'); } catch { return null; } };
function refuse(refuser, method, url) {
  const res = {};
  const handled = refuser.refuseOwned({ method, url, headers: { host: 'h' } }, res, { parseRequestUrl, json: (r, status, body) => { r.status = status; r.body = body; } });
  return { handled, res };
}

test('Google Drive: exactly the four methods the front answers are refused, before anything else', () => {
  for (const [p, m] of Object.entries(gdrive.ROUTES)) {
    const r = refuse(gdrive, m, p);
    assert.equal(r.handled, true, `${m} ${p}`);
    assert.equal(r.res.status, 503);
    assert.deepEqual(r.res.body, { error: 'Google Drive is owned by the Rust front.', code: 'RUST_GOOGLE_DRIVE_OWNED' });
    assert.equal(gdrive.owned(m, p), true);
  }
  assert.deepEqual(Object.entries(gdrive.ROUTES).sort(), [
    ['/api/connectors/gdrive/backup-copy', 'PUT'], ['/api/connectors/gdrive/connect', 'POST'],
    ['/api/connectors/gdrive/disconnect', 'POST'], ['/api/connectors/gdrive/policy', 'PUT']]);
  // Everything else on those paths stays Node's (its 404), and so do the two routes that need the live MCP servers.
  for (const [m, p] of [['GET', '/api/connectors/gdrive/connect'], ['PUT', '/api/connectors/gdrive/connect'], ['POST', '/api/connectors/gdrive/policy'],
    ['GET', '/api/connectors'], ['PUT', '/api/connectors/nextcloud/policy'], ['POST', '/api/connectors/gdrive/connect/'], ['POST', '/api/connectors/gdrive/other'], ['POST', '/api/connectors/GDRIVE/connect']]) {
    assert.equal(refuse(gdrive, m, p).handled, false, `${m} ${p}`);
  }
  // A query string does not change the route; a WHATWG-normalised path is the same route.
  assert.equal(refuse(gdrive, 'POST', '/api/connectors/gdrive/connect?x=1').handled, true);
  assert.equal(refuse(gdrive, 'POST', '/api/connectors/gdrive/../gdrive/connect').handled, true);
});

test('the off-site backup: every method of the eight paths is refused, and no other path', () => {
  assert.equal(offsite.OWNED_PATHS.length, 8);
  assert.ok(offsite.OWNED_PATHS.includes('/api/admin/offsite-backup/new-store'), 'the new-store action is the front\'s too');
  for (const p of offsite.OWNED_PATHS) for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
    const r = refuse(offsite, m, p);
    assert.equal(r.handled, true, `${m} ${p}`);
    assert.deepEqual(r.res.body, { error: 'The off-site backup is owned by the Rust front.', code: 'RUST_OFFSITE_BACKUP_OWNED' });
  }
  for (const p of ['/api/admin/offsite-backup/', '/api/admin/offsite-backup/other', '/api/admin/offsite-backups', '/api/admin/offsite-backup/google', '/api/admin/users']) {
    assert.equal(refuse(offsite, 'GET', p).handled, false, p);
  }
});

test('index.cjs mounts both refusers before authentication, and names the markers the release check reads', () => {
  const src = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  for (const marker of ["require('./rust-google-drive.cjs')", "require('./rust-offsite-backup.cjs')"]) assert.ok(src.includes(marker), marker);
  const at = (needle) => src.indexOf(needle);
  assert.ok(at("require('./rust-google-drive.cjs').refuseOwned") > 0 && at("require('./rust-google-drive.cjs').refuseOwned") < at('const preAuth = requestAuth.authenticate(req);'));
  assert.ok(at("require('./rust-offsite-backup.cjs').refuseOwned") < at('const preAuth = requestAuth.authenticate(req);'));
});

// ── no secret, no writer left in Node ────────────────────────────────────────────────────────

function sources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f); } else if (/\.c?js$/.test(e.name) && !/\.test\.c?js$/.test(e.name)) out.push(f);
    }
  };
  walk(__dirname);
  return out;
}

test('no Node source writes tool_policies, holds the OAuth client secret or a refresh token, or runs the backup', () => {
  const offenders = [];
  for (const f of sources()) {
    const rel = path.relative(__dirname, f);
    if (rel === 'gdrive-broker-fixture.cjs') continue; // test-only stand-in for the front's broker
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\b(?:INSERT|REPLACE|UPDATE|DELETE)\b[^`'"\n]*\btool_policies\b[^`'"]*/gi)) offenders.push(`${rel}: ${m[0].slice(0, 60)}`);
    if (/GOOGLE_OAUTH_CLIENT_SECRET|oauth2\.googleapis\.com/.test(src)) offenders.push(`${rel}: Google OAuth`);
    if (/OFFSITE_BACKUP_|createOffsiteBackup|createOffsiteService|createGoogleDrive|createDirStore|createS3Store/.test(src) && !/rust-offsite-backup\.cjs$/.test(rel)) offenders.push(`${rel}: off-site backup`);
    if (/google-drive\.sealed/.test(src) && !/(gdrive-seal|rust-google-drive|secrets-rotate)\.cjs$/.test(rel)) offenders.push(`${rel}: sealed Google file`);
  }
  assert.deepEqual(offenders, []);
  for (const gone of ['gdrive.cjs', 'drive-accounts.cjs', 'offsite-service.cjs', 'offsite-backup.cjs', 'offsite-s3.cjs', 'offsite-dir.cjs', 'routes/offsite-backup.cjs']) {
    assert.equal(fs.existsSync(path.join(__dirname, gone)), false, `${gone} is deleted`);
  }
});

test('the database guard refuses every Node write of tool_policies, exempt or not', () => {
  assert.ok(Object.hasOwn(FRONT_TABLES, 'tool_policies'));
  assert.equal(FRONT_TABLES.tool_policies.code, gdrive.ROUTE_REFUSAL.code);
  const ran = [];
  const stmt = (sql) => { const s = { sql, run: () => { ran.push(sql); return { changes: 1 }; }, get() { ran.push(sql); }, all() { ran.push(sql); return []; }, iterate() { ran.push(sql); return [][Symbol.iterator](); }, bind() { return s; }, pluck() { return s; } }; return s; };
  const guard = createRustAuthGuard();
  const db = guard.install({ prepare: stmt, exec: (sql) => ran.push(sql) });
  const writes = [
    'INSERT INTO tool_policies VALUES(?,?,?,?) ON CONFLICT(user_id, tool) DO UPDATE SET mode=excluded.mode, updated_at=excluded.updated_at',
    'UPDATE tool_policies SET mode=? WHERE user_id=?', 'DELETE FROM tool_policies WHERE user_id=?', 'REPLACE INTO "tool_policies" VALUES(?,?,?,?)',
  ];
  const refused = (e) => e.status === 503 && e.code === 'RUST_GOOGLE_DRIVE_OWNED';
  for (const sql of writes) {
    assert.throws(() => db.prepare(sql).run('a'), refused, sql);
    assert.throws(() => guard.exempt(() => db.prepare(sql).run('a')), refused, `exempt: ${sql}`);
  }
  // Reads, and the migrator's CREATE TABLE, run.
  db.prepare('SELECT mode FROM tool_policies WHERE user_id=? AND tool=?').get('u', 't');
  db.exec('CREATE TABLE IF NOT EXISTS tool_policies(user_id TEXT NOT NULL, tool TEXT NOT NULL, mode TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id, tool))');
  assert.ok(!ran.some((sql) => writes.includes(sql)), 'no refused write reached the database');
});

// ── the shared bytes and the shared rule ─────────────────────────────────────────────────────

// The same constants as noevia-rs crates/google-token-seal and bins/noevia-server/tests/gdrive.rs: computed
// with Node's own crypto.hkdfSync / createCipheriv with the iv fixed to 0x01..0x0c.
const SECRETS_KEY = Buffer.alloc(32, 7);
const USER_KEY_HEX = 'd007234e22afa7f8461024aaad95649026139bf3eaff590a6ea0b40a71e012ab';
const USER_RECORD = { refreshToken: 'synthetic-refresh', email: 'ada@example.test', connectedAt: 1700000000000, owner: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
const USER_SEALED = 'AQIDBAUGBwgJCgsMgIgxgDi+UwWrjb2pgZHTVk5Oe2S+sxp0cQhofG56mOyqJu4MKObbx2YjiOIp95XFlLRpoFsgDgJ1/IeS38BvXz/+MZVPwozLiOOvRCG99kgyZhbaVBN47NmtMEBpqgbKbH3pg0zMV/11xgL0BXiHW9DA/DYPs9ifgguMcyvGCrLfU3M/fg5aQqY2xrOOpQtYrhaJqw43qj4B6g==';
const BACKUP_RECORD = { refreshToken: 'synthetic-refresh', email: null, connectedAt: 1700000000000 };
const BACKUP_SEALED = 'AQIDBAUGBwgJCgsMrHkYwn/pjtr/t8EoEy1obkSdr1QTL/KERkyb1Pd0H+oOAOmzf58OuFgPVcNTUJjp7N7a5B6V2Wd0lCMnWan7RJrvaJqdAS1LxTXMCRAte2oRr1UiimyzIqusKhhq';
const IV = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

test('golden vector: the Rust front opens what Node sealed and Node opens what the front seals', () => {
  const dir = temp();
  fs.writeFileSync(path.join(dir, 'secrets.key'), SECRETS_KEY);
  const key = createSecretStore(dir, { env: {} }).derive('google-drive-user');
  assert.equal(key.toString('hex'), USER_KEY_HEX, 'secrets.cjs derive is the key the front derives');
  assert.deepEqual(sealer(key).open(USER_SEALED), USER_RECORD, 'the bytes the front writes (its test seals this exact record)');
  assert.deepEqual(sealer(Buffer.alloc(32, 9)).open(BACKUP_SEALED), BACKUP_RECORD);
  // Re-sealing with the same iv gives the same bytes: the algorithm is the front's, byte for byte.
  const crypto = require('node:crypto');
  const real = crypto.randomBytes;
  crypto.randomBytes = (n) => (n === 12 ? Buffer.from(IV) : real(n));
  try {
    assert.equal(sealer(key).seal(USER_RECORD), USER_SEALED);
    assert.equal(sealer(Buffer.alloc(32, 9)).seal(BACKUP_RECORD), BACKUP_SEALED);
  } finally { crypto.randomBytes = real; }
  // The rotation's check is read-only: a file the front sealed opens under its key ('current'); under another it
  // does not, and Node does not rewrite it (the front re-seals; noevia-rs tests/gdrive.rs proves that half).
  const file = path.join(dir, 'u.sealed');
  fs.writeFileSync(file, USER_SEALED);
  assert.equal(checkTokenFile(file, key), 'current');
  assert.throws(() => checkTokenFile(file, Buffer.alloc(32, 5)), /not sealed under the current key/);
  assert.equal(fs.readFileSync(file, 'utf8'), USER_SEALED);
});

test('whose Drive an account reaches: the cases file the front tests too', () => {
  const { cases } = JSON.parse(fs.readFileSync(path.join(__dirname, 'gdrive-owns-backup.v1.json'), 'utf8'));
  assert.ok(cases.length >= 12);
  for (const c of cases) {
    assert.equal(ownsBackup({ admin: c.admin, userId: c.user, backup: c.backup, personalFile: c.personalFile }), c.owns, c.name);
  }
});

test('the English the Drive copy messages carry is the catalogue the file lists', () => {
  const { messages } = JSON.parse(fs.readFileSync(path.join(__dirname, 'gdrive-messages.v1.json'), 'utf8'));
  assert.deepEqual(messages.map((m) => m.id).sort(), ['differentStore', 'driveAnswered', 'fileDiffers', 'staleShare', 'storeEmpty', 'tooManyStale', 'waitingFirstBackup']);
  assert.equal(messages.find((m) => m.id === 'driveAnswered').english, 'Google Drive answered {status}.');
});

// ── the broker's client ──────────────────────────────────────────────────────────────────────

const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const publish = (dir, doc) => fs.writeFileSync(path.join(dir, gdrive.SIGNAL_FILE), JSON.stringify({ version: 1, at: Date.now(), nonce: Math.random().toString(16), backup: { usable: false, state: 'disconnected', owner: null, expiresAt: null }, personal: {}, ...doc }));

function harness({ answers = [], fetchAnswers = [] } = {}) {
  const dir = temp();
  const calls = { session: [], reject: [], forget: [], fetch: [] };
  const broker = {
    async gdriveSession(user, admin, rejected) {
      calls.session.push({ user, admin, rejected });
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return a || { ok: true, session: { accessToken: `tok-${calls.session.length}`, expiresAt: Date.now() + 3_000_000, generation: 'g'.repeat(64) } };
    },
    async gdriveReject(user, admin, generation) { calls.reject.push({ user, admin, generation }); return { ok: true, dropped: true }; },
    async gdriveForget(user) { calls.forget.push(user); return { ok: true }; },
    async gdriveView() { return { ok: false, status: 503 }; },
  };
  const fetchImpl = async (url, init) => {
    calls.fetch.push({ url, auth: init.headers.Authorization });
    const next = fetchAnswers.shift() ?? { status: 200, body: { ok: true } };
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
  };
  const warnings = [];
  const accounts = createDriveAccounts({ broker, dataDir: dir, fetchImpl, warn: (m) => warnings.push(m) });
  return { dir, calls, accounts, warnings };
}

test('connected(user) is read from the broker\'s state file, and follows it', () => {
  const { dir, accounts } = harness();
  const member = { id: B, role: 'member' };
  assert.equal(accounts.connected(member), false, 'no file yet: nobody is known to be connected');
  publish(dir, { personal: { [B]: 'connected' } });
  assert.equal(accounts.connected(member), true);
  assert.equal(accounts.forUser(member).drive.state().state, 'connected');
  assert.equal(accounts.forUser(member).backup, false);
  publish(dir, { personal: { [B]: 'error' } });
  assert.equal(accounts.connected(member), false);
  assert.equal(accounts.forUser(member).drive.state().state, 'error');
  fs.writeFileSync(path.join(dir, gdrive.SIGNAL_FILE), '{broken');
  assert.equal(accounts.connected(member), false, 'an unreadable file fails closed');
  // The backup slot is an administrator\'s Drive; a member\'s never.
  publish(dir, { backup: { usable: true, state: 'connected', owner: A, expiresAt: null } });
  assert.equal(accounts.connected({ id: A, role: 'admin' }), true);
  assert.equal(accounts.forUser({ id: A, role: 'admin' }).backup, true);
  assert.equal(accounts.connected({ id: B, role: 'admin' }), false);
  assert.equal(accounts.connected({ id: A, role: 'member' }), false);
  // A pending sign-in whose code has expired is not pending.
  publish(dir, { backup: { usable: true, state: 'pending', owner: A, expiresAt: Date.now() - 1 } });
  assert.equal(accounts.forUser({ id: A, role: 'admin' }).drive.state().state, 'disconnected');
  assert.throws(() => accounts.forUser(null), (e) => e.status === 401 && /Sign in/.test(e.message));
  assert.throws(() => accounts.forUser({ id: '../x', role: 'member' }), /unexpected user id/);
});

test('an access token is cached while the state file stands still, and for no longer than a minute', async () => {
  const { dir, calls, accounts } = harness();
  publish(dir, { personal: { [B]: 'connected' } });
  const { drive } = accounts.forUser({ id: B, role: 'member' });
  await drive.call('https://drive.test/files');
  await drive.call('https://drive.test/files');
  assert.equal(calls.session.length, 1, 'the second call used the cache');
  assert.deepEqual(calls.fetch.map((f) => f.auth), ['Bearer tok-1', 'Bearer tok-1']);
  assert.equal(calls.session[0].admin, false);
  publish(dir, { personal: { [B]: 'connected' } }); // any change of the file: the broker saw a change
  await drive.call('https://drive.test/files');
  assert.equal(calls.session.length, 2);
  assert.equal(calls.fetch.at(-1).auth, 'Bearer tok-2');
  // Never cached without a readable signal.
  fs.rmSync(path.join(dir, gdrive.SIGNAL_FILE));
  await drive.call('https://drive.test/files');
  await drive.call('https://drive.test/files');
  assert.equal(calls.session.length, 4);
});

test('a cached access token belongs to the role it was asked for: an account that stops being an administrator asks again', async () => {
  const { dir, calls, accounts } = harness();
  publish(dir, { personal: { [A]: 'connected' } });
  const asAdmin = accounts.forUser({ id: A, role: 'admin' }).drive;
  await asAdmin.call('https://drive.test/files');
  await asAdmin.call('https://drive.test/files');
  assert.equal(calls.session.length, 1);
  assert.equal(calls.session[0].admin, true);
  // The same account, the same state file, now a member: the token minted for the administrator (it may be the
  // backup slot's) is not reused.
  const asMember = accounts.forUser({ id: A, role: 'member' }).drive;
  await asMember.call('https://drive.test/files');
  assert.equal(calls.session.length, 2, 'a role change is a new session');
  assert.equal(calls.session[1].admin, false);
  await asMember.call('https://drive.test/files');
  assert.equal(calls.session.length, 2, 'and that one is cached in turn');
  await asAdmin.call('https://drive.test/files');
  assert.equal(calls.session.length, 3);
});

test('the Drive API base is a loopback address or the Google default, as the front\'s own', () => {
  const warned = [];
  const base = (u) => loopbackBase(u, 'DEFAULT', (m) => warned.push(m));
  assert.equal(base('http://127.0.0.1:9/drive/v3/'), 'http://127.0.0.1:9/drive/v3');
  assert.equal(base('http://localhost:8080'), 'http://localhost:8080');
  assert.equal(base('http://[::1]:5/x'), 'http://[::1]:5/x');
  assert.deepEqual(warned, []);
  for (const bad of ['https://evil.example/drive/v3', 'http://user:pw@127.0.0.1:9', 'ftp://127.0.0.1', 'not a url', 'http://127.0.0.1.evil.example/']) assert.equal(base(bad), 'DEFAULT', bad);
  assert.equal(warned.length, 5);
  assert.equal(base(''), 'DEFAULT');
  assert.equal(warned.length, 5, 'unset is not a warning');
  const { accounts } = harness();
  assert.equal(accounts.forUser({ id: B, role: 'member' }).drive.api, 'https://www.googleapis.com/drive/v3');
  const pointed = createDriveAccounts({ broker: {}, dataDir: temp(), apiBase: 'https://evil.example/drive', uploadBase: 'http://127.0.0.1:3/up', warn: () => {} });
  const d = pointed.forUser({ id: B, role: 'member' }).drive;
  assert.deepEqual([d.api, d.upload], ['https://www.googleapis.com/drive/v3', 'http://127.0.0.1:3/up']);
});

test('a 401 drops the cached token and asks again naming it; a second 401 rejects the sign-in', async () => {
  const { dir, calls, accounts } = harness({ fetchAnswers: [{ status: 401 }, { status: 200, body: { id: 'f' } }] });
  publish(dir, { personal: { [B]: 'connected' } });
  const { drive } = accounts.forUser({ id: B, role: 'member' });
  assert.deepEqual(await drive.call('https://drive.test/files'), { id: 'f' });
  assert.deepEqual(calls.session.map((s) => s.rejected), [null, 'tok-1']);
  assert.deepEqual(calls.fetch.map((f) => f.auth), ['Bearer tok-1', 'Bearer tok-2']);
  assert.equal(calls.reject.length, 0);
  // Google refuses the fresh token too: the broker is told which sign-in, and the tool gets Google's answer.
  const second = harness({ fetchAnswers: [{ status: 401 }, { status: 401 }] });
  publish(second.dir, { personal: { [A]: 'connected' } });
  await assert.rejects(() => second.accounts.forUser({ id: A, role: 'admin' }).drive.call('https://drive.test/files'), (e) => e.status === 502 && /answered 401/.test(e.message) && e.messageId === 'driveAnswered' && e.messageParams.status === 401);
  assert.deepEqual(second.calls.reject, [{ user: A, admin: true, generation: 'g'.repeat(64) }]);
  // A 404 is the file, not the connection.
  const missing = harness({ fetchAnswers: [{ status: 404 }] });
  publish(missing.dir, { personal: { [B]: 'connected' } });
  await assert.rejects(() => missing.accounts.forUser({ id: B, role: 'member' }).drive.call('https://drive.test/x'), (e) => e.status === 404 && /no such file/.test(e.message));
});

test('the broker\'s refusals reach the tool in people\'s words, and an unreachable broker is "try again", never "disconnected"', async () => {
  const cases = [
    [{ ok: false, status: 409, error: 'x', code: 'disconnected' }, 409, MESSAGES.disconnected, 'disconnected'],
    [{ ok: false, status: 409, error: 'x', code: 'reconnect' }, 409, MESSAGES.reconnect, 'reconnect'],
    [{ ok: false, status: 502, error: 'x', code: 'transient' }, 502, MESSAGES.transient, 'transient'],
    [{ ok: false, status: 503 }, 503, MESSAGES.unavailable, undefined],
    [new Error('ECONNREFUSED'), 503, MESSAGES.unavailable, undefined],
  ];
  for (const [answer, status, message, code] of cases) {
    const { dir, accounts } = harness({ answers: [answer] });
    publish(dir, { personal: { [B]: 'connected' } });
    await assert.rejects(() => accounts.forUser({ id: B, role: 'member' }).drive.call('https://drive.test/files'), (e) => e.status === status && e.publicMessage === message && e.code === code, JSON.stringify(answer));
  }
  assert.doesNotMatch(MESSAGES.unavailable, /not connected/i);
});

test('removing an account never throws, and the Google Drive half of the page degrades instead of failing', async () => {
  const { accounts, calls, warnings } = harness();
  await accounts.removeUser(B);
  assert.deepEqual(calls.forget, [B]);
  const refusing = createDriveAccounts({ broker: { gdriveForget: async () => ({ ok: false, status: 503 }), gdriveView: async () => { throw new Error('down'); } }, dataDir: temp(), warn: (m) => warnings.push(m) });
  await refusing.removeUser(B);
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0], new RegExp(B));
  const view = await refusing.view({ id: B, role: 'member' });
  assert.deepEqual([view.id, view.state, view.backup, view.tools], ['gdrive', 'error', null, []]);
  assert.equal(view.message, MESSAGES.unavailable);
});

// ── tool permissions: read here, re-read by fingerprint ──────────────────────────────────────

test('the permitted-tools cache empties itself when the front writes a permission', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('u1');");
  const policy = createToolPolicy({ db });
  const cache = createFingerprintedCache({ ttlMs: 60_000, fingerprint: () => policy.fingerprint() });
  assert.equal(cache.get('warm-up'), undefined);
  cache.set('u1', { tools: ['drive_search_files'] });
  assert.deepEqual(cache.get('u1'), { tools: ['drive_search_files'] }, 'cached while nothing changed');
  // The front\'s upsert, from another process (here another statement).
  db.prepare('INSERT INTO tool_policies VALUES(?,?,?,?) ON CONFLICT(user_id, tool) DO UPDATE SET mode=excluded.mode, updated_at=excluded.updated_at').run('u1', 'drive_search_files', 'block', 5);
  assert.equal(cache.get('u1'), undefined, 'the change emptied it before the lookup');
  cache.set('u1', { tools: [] });
  assert.deepEqual(cache.get('u1'), { tools: [] });
  // A failing fingerprint empties the cache and is retried; it never serves what was cached before.
  let fail = true;
  const flaky = createFingerprintedCache({ ttlMs: 60_000, fingerprint: () => { if (fail) throw new Error('db busy'); return 'x'; } });
  flaky.set('k', 1);
  assert.equal(flaky.get('k'), undefined);
  fail = false;
  assert.equal(flaky.get('warm-up'), undefined);
  flaky.set('k', 2);
  assert.equal(flaky.get('k'), 2);
  assert.equal(flaky.get('k'), 2);
});

test('#831/#845: a Drive sign-in completing or disconnecting empties the permitted-tools cache, whoever caused it', () => {
  // The front finishes the sign-in on Google\'s page without telling this process; the broker\'s state file
  // moving is what tells it (index.cjs composes this with the permission fingerprint).
  const { dir, accounts } = harness();
  publish(dir, { personal: {} });
  const cache = createFingerprintedCache({ ttlMs: 60_000, fingerprint: () => accounts.fingerprint() });
  assert.equal(cache.get('warm-up'), undefined);
  cache.set(B, { boxes: [] });
  assert.deepEqual(cache.get(B), { boxes: [] });
  publish(dir, { personal: { [B]: 'connected' } }); // the sign-in completed
  assert.equal(cache.get(B), undefined, 'the view that lacked the Drive box is gone');
  cache.set(B, { boxes: ['gdrive'] });
  assert.deepEqual(cache.get(B), { boxes: ['gdrive'] });
  publish(dir, { personal: {} }); // disconnected
  assert.equal(cache.get(B), undefined);
});

// ── the internal store client ────────────────────────────────────────────────────────────────

test('the store client speaks the broker\'s operations and maps its answers', async () => {
  const http = require('node:http');
  const seen = [];
  let reply = { status: 200, body: {} };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { seen.push({ url: req.url, token: req.headers['x-noevia-store-token'], body: JSON.parse(raw) }); res.writeHead(reply.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(reply.body)); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const client = require('./project-store-client.cjs').createClient({ port: server.address().port, token: 'synthetic-store-token-0123456789abcdef' });
    reply = { status: 200, body: { accessToken: 'tok', expiresAt: 5, generation: 'g' } };
    assert.deepEqual(await client.gdriveSession(B, false), { ok: true, session: { accessToken: 'tok', expiresAt: 5, generation: 'g' } });
    await client.gdriveSession(A, true, 'old-token');
    assert.deepEqual(seen.map((s) => [s.url, s.body]), [['/v1/gdrive/session', { user: B, admin: false }], ['/v1/gdrive/session', { user: A, admin: true, rejected: 'old-token' }]]);
    assert.ok(seen.every((s) => s.token === 'synthetic-store-token-0123456789abcdef'));
    reply = { status: 409, body: { error: 'Google Drive is not connected.', code: 'disconnected', status: 409 } };
    assert.deepEqual(await client.gdriveSession(B, false), { ok: false, status: 409, error: 'Google Drive is not connected.', code: 'disconnected' });
    // The store\'s own failures (wrong secret, an older front without the op) are "try again", never their raw text.
    reply = { status: 404, body: { error: 'not found' } };
    assert.deepEqual(await client.gdriveSession(B, false), { ok: false, status: 503 });
    reply = { status: 200, body: { dropped: true } };
    assert.deepEqual(await client.gdriveReject(B, false, 'gen'), { ok: true, dropped: true });
    reply = { status: 200, body: { ok: true, state: 'disconnected' } };
    assert.deepEqual(await client.gdriveDisconnect(B, false), { ok: true });
    assert.deepEqual(await client.gdriveForget(B), { ok: true });
    reply = { status: 200, body: { id: 'gdrive', name: 'Google Drive' } };
    assert.deepEqual(await client.gdriveView(B, false), { ok: true, view: { id: 'gdrive', name: 'Google Drive' } });
    reply = { status: 200, body: { current: 1, rotated: 2, empty: 0, failed: 0 } };
    assert.deepEqual(await client.gdriveReseal(), { ok: true, counts: { current: 1, rotated: 2, empty: 0, failed: 0 } });
    assert.deepEqual(seen.at(-1), { url: '/v1/gdrive/reseal', token: 'synthetic-store-token-0123456789abcdef', body: {} });
    for (const bad of [{ status: 200, body: { rotated: 1 } }, { status: 200, body: { current: -1, rotated: 0, empty: 0, failed: 0 } }, { status: 404, body: { error: 'not found' } }]) {
      reply = bad;
      assert.equal((await client.gdriveReseal()).ok, false, JSON.stringify(bad));
    }
    reply = { status: 200, body: { ok: true } };
    assert.deepEqual(await client.toolPolicySet(B, ['nc_a', 'nc_b'], [false, true], 'ask'), { ok: true });
    assert.deepEqual(seen.at(-1).body, { user: B, tools: ['nc_a', 'nc_b'], writes: [false, true], mode: 'ask' });
    reply = { status: 400, body: { error: 'Choose a tool.', status: 400 } };
    assert.deepEqual(await client.toolPolicySet(B, [], [], 'ask'), { ok: false, status: 400, error: 'Choose a tool.' });
    // A store that is not there at all: the client throws the store's usual busy error, the callers turn it into "try again".
    server.close();
    await assert.rejects(() => client.gdriveSession(B, false), (e) => e.status === 503);
  } finally { server.close(); }
});
