'use strict';

// #1071 data compatibility: the Rust-only envelope must read every credential value the live system
// wrote with the JS code. tests/fixtures/secret-envelope-release.v1.json holds such values, produced
// by the release code itself (noevia-core 36376b2 server/secret-envelope.cjs; see
// tools/gen-secret-release-fixtures.cjs) in the shapes its callers store: storage connection
// secrets, OAuth and MCP token JSON, provider keys, legacy v1 values, values under a rotated key,
// plain legacy rows. Synthetic keys and values only. Needs dav-parse.wasm (and better-sqlite3 for
// the account-store check).

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const envelope = require('../../server/secret-envelope.cjs');
const oracle = require('./oracle/secret-envelope.cjs');
const { createSecretStore } = require('../../server/secrets.cjs');
const davParseWasm = require('../../server/dav-parse-wasm.cjs');

const FIXTURE = path.join(__dirname, '../fixtures/secret-envelope-release.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-secret-release-fixtures.cjs');
const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const KEYS = { current: Buffer.from(fixture.keys.current, 'hex'), previous: Buffer.from(fixture.keys.previous, 'hex') };
const plainOf = (c) => Buffer.from(c.expect.plain16, 'hex').toString('utf16le');
const userOf = (c) => (c.openUser === null ? undefined : c.openUser);

const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
// Resolved from server/ (it has its own dependencies), as auth.cjs resolves it.
const serverRequire = require('node:module').createRequire(path.join(__dirname, '../../server/package.json'));
let haveSqlite = true;
try { serverRequire.resolve('better-sqlite3'); } catch { haveSqlite = false; }

function storeWithKeys(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-compat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'secrets.key'), KEYS.current, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'secrets.key.previous'), KEYS.previous, { mode: 0o600 });
  return { dir, store: createSecretStore(dir, { env: {} }) };
}

test('the fixture covers what the live system stores', () => {
  assert.equal(fixture.version, 1);
  assert.match(fixture.producedBy, /36376b2/);
  assert.ok(fixture.cases.length >= 40, `${fixture.cases.length} cases`);
  const kinds = new Set(fixture.cases.map((c) => `${c.value.slice(0, 7)}|${c.expect.keyUsed}`));
  for (const k of ['enc:v2:|current', 'enc:v1:|current', 'enc:v2:|previous', 'enc:v1:|previous']) assert.ok(kinds.has(k), k);
  assert.ok(fixture.cases.some((c) => c.expect.keyUsed === 'none' && c.value !== ''), 'a plain legacy row');
  assert.ok(fixture.cases.some((c) => c.value === ''), 'an empty secret');
});

test('the oracle is the release code: it reproduces the committed fixture byte for byte', { skip: !fs.existsSync(GENERATOR) && 'no tools/ here (no generator)' }, () => {
  const r = spawnSync(process.execPath, [GENERATOR], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout === fs.readFileSync(FIXTURE, 'utf8'), 'node tools/gen-secret-release-fixtures.cjs prints the committed fixture');
});

test('Rust opens every value the release code wrote, to the same plaintext with the same key', { skip: skipWasm }, () => {
  for (const c of fixture.cases) {
    const got = envelope.open(KEYS.current, KEYS.previous, c.value, userOf(c));
    assert.deepEqual({ keyUsed: got.keyUsed, plain: got.plain }, { keyUsed: c.expect.keyUsed, plain: plainOf(c) }, c.name);
    assert.deepEqual(got, oracle.openJs(KEYS.current, KEYS.previous, c.value, userOf(c)), c.name);
  }
  console.log(`# secret-envelope release compatibility: ${fixture.cases.length}/${fixture.cases.length} stored values open identically`);
});

test('through the secret store: decrypt, canDecrypt, then a rotation that the release code can still read', { skip: skipWasm }, (t) => {
  const { dir, store } = storeWithKeys(t);
  for (const c of fixture.cases) {
    assert.equal(store.decrypt(c.value, userOf(c)), plainOf(c), c.name);
    assert.equal(store.canDecrypt(c.value, userOf(c)), true, c.name);
  }
  // A bound value never opens for another account, and never without one.
  for (const c of fixture.cases.filter((x) => x.value.startsWith('enc:v2:'))) {
    assert.equal(store.canDecrypt(c.value, 'someone-else'), false, c.name);
    assert.throws(() => store.decrypt(c.value), /bound to an account/, c.name);
  }
  const rows = fixture.cases.map((c, i) => ({ ref: i, value: c.value, userId: userOf(c) }))
    // A v2 row cannot be resealed without its owner (rotation leaves it, reporting a failure).
    .filter((r) => !(r.value.startsWith('enc:v2:') && r.userId === undefined));
  const written = new Map();
  const report = store.rotate({ tables: [{ name: 'compat', rows: () => rows, write: (ref, value) => written.set(ref, value) }] });
  assert.equal(report.totals.failed, 0, JSON.stringify(report.failures));
  const previousCount = fixture.cases.filter((c) => c.expect.keyUsed === 'previous').length;
  assert.equal(report.totals.rotated, previousCount);
  // Then the previous key goes, as an operator finishes a rotation.
  fs.rmSync(path.join(dir, 'secrets.key.previous'));
  const after = createSecretStore(dir, { env: {} });
  for (const r of rows) {
    const value = written.has(r.ref) ? written.get(r.ref) : r.value;
    const c = fixture.cases[r.ref];
    assert.equal(after.decrypt(value, r.userId), plainOf(c), c.name);
    // The release code (the oracle) reads what Rust resealed: a rollback to the previous core keeps working.
    assert.equal(oracle.openJs(KEYS.current, null, value, r.userId).plain, plainOf(c), `${c.name} (rollback)`);
  }
});

test('the account store reads, upgrades and keeps release-written storage secrets (auth.cjs getStorage)', { skip: (skipWasm || (!haveSqlite && 'better-sqlite3 not installed')) }, (t) => {
  const { dir, store } = storeWithKeys(t);
  const { createAuth } = require('../../server/auth.cjs');
  const realWarn = console.warn;
  console.warn = () => {};
  let auth;
  try { auth = createAuth({ dataDir: dir, publicOrigin: 'http://localhost', secrets: store }); } finally { console.warn = realWarn; }
  t.after(() => { try { auth.db.close(); } catch { /* closed */ } });
  const storageCases = fixture.cases.filter((c) => /^auth\.cjs getStorage|^auth\.cjs saveStorage\/getStorage/.test(c.caller));
  assert.ok(storageCases.length >= 3);
  const now = Date.now();
  let n = 0;
  for (const c of storageCases) {
    const id = c.openUser;
    if (!auth.db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) {
      n += 1;
      auth.db.prepare('INSERT INTO users(id,username,username_norm,display_name,role,password_hash,webauthn_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, `synthetic-${n}`, `synthetic-${n}`, 'Synthetic', 'member', 'synthetic-hash', `synthetic-webauthn-${n}`, now, now);
    }
    auth.db.prepare('INSERT OR REPLACE INTO storage_connections(user_id,kind,base_url,username,secret,corpus_root,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, 'webdav', 'https://storage.invalid/dav', 'synthetic', c.value, 'root', 1);
    const got = auth.getStorage(id, true);
    assert.equal(got.secret, plainOf(c), c.name);
    assert.equal(got.secretNeedsReauth, false, c.name);
    const row = auth.db.prepare('SELECT secret FROM storage_connections WHERE user_id=?').get(id).secret;
    if (c.value.startsWith('enc:v2:')) assert.equal(row, c.value, `${c.name}: a current bound value is left as it is`);
    else {
      // A v1 or plain row is upgraded to the account-bound format, readable by the release code too.
      assert.ok(row.startsWith('enc:v2:'), c.name);
      assert.equal(oracle.openJs(KEYS.current, null, row, id).plain, plainOf(c), `${c.name} (rollback)`);
    }
  }
});
