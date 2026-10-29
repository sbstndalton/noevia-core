'use strict';
// #2190: the storage folder write, the connection test and the Nextcloud sign-in are the Rust
// front's (noevia-rs bins/noevia-server storage_integration_routes.rs, tested there through real
// HTTP with synthetic Nextcloud, WebDAV and S3 servers). Node refuses the five POSTs before
// authentication, reads a Rust-saved storage row (sealed the same way) on its next use, and ends a
// storage hold when the Rust front proves the saved login. Synthetic accounts and secrets only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const owned = require('./rust-storage-integrations.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });
const refuse = (method, url) => { const res = {}; return owned.refuseOwned({ url, method, headers: {}, on() { throw new Error('body listener'); } }, res, { parseRequestUrl, json }) ? res : null; };

// The golden vector shared with noevia-rs tests/storage_integrations.rs: key [7;32], nonce 0x01..0x0c,
// the app password sealed for account A (enc:v2, AAD noevia:user:<id>).
const KEY = Buffer.alloc(32, 7);
const NONCE = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GOLDEN = 'enc:v2:AQIDBAUGBwgJCgsMSgG3ElISmXU7G_CAvinHk8gFhuoCj5ZFhhNjbuWK0yGnliZfwC8';

test('the five POSTs are refused; other methods and shapes are not', () => {
  assert.deepEqual([...owned.OWNED_PATHS], [
    '/api/integrations/storage/folder', '/api/integrations/storage/test',
    '/api/integrations/storage/nextcloud/start', '/api/integrations/storage/nextcloud/poll', '/api/integrations/storage/nextcloud/cancel',
  ]);
  assert.ok(Object.isFrozen(owned.OWNED_PATHS));
  assert.equal(owned.ROUTE_REFUSAL.code, 'RUST_STORAGE_INTEGRATIONS_OWNED');
  for (const p of owned.OWNED_PATHS) {
    assert.deepEqual(refuse('POST', `${p}?x=1`), { status: 503, body: owned.ROUTE_REFUSAL }, p);
    assert.deepEqual(refuse('POST', p.replace('/storage/', '/./storage/')), { status: 503, body: owned.ROUTE_REFUSAL }, `${p} (dot segment)`);
    for (const m of ['GET', 'PUT', 'DELETE', 'HEAD']) assert.equal(refuse(m, p), null, `${m} ${p}`);
  }
  for (const url of ['/api/integrations/storage', '/api/integrations/storage/folder/', '/api/integrations/storage/nextcloud', '/api/integrations/storage/files', '/api/integrations/storage/file']) {
    assert.equal(refuse('POST', url), null, url);
  }
});

test('the Node sign-in, flow store and probe are gone', () => {
  assert.equal(fs.existsSync(path.join(__dirname, 'nextcloud-flows.cjs')), false);
  const routes = fs.readFileSync(path.join(__dirname, 'routes', 'storage.cjs'), 'utf8');
  for (const gone of ['login/v2', 'apppassword', 'createFolder', 'PROPFIND', 'signS3Request', 'flowStore']) assert.equal(routes.includes(gone), false, gone);
});

test('golden vector: Node seals and opens exactly as the Rust front', () => {
  const envelope = require('./secret-envelope.cjs');
  const davParseWasm = require('./dav-parse-wasm.cjs');
  assert.equal(davParseWasm.secretSeal(KEY, NONCE, Buffer.from('synthetic-app-password'), A), GOLDEN);
  // Node's own AES-GCM, independent of the shared port.
  const crypto = require('node:crypto');
  const gcm = crypto.createCipheriv('aes-256-gcm', KEY, NONCE);
  gcm.setAAD(Buffer.from(`noevia:user:${A}`));
  const body = Buffer.concat([gcm.update('synthetic-app-password', 'utf8'), gcm.final()]);
  assert.equal(`enc:v2:${Buffer.concat([NONCE, gcm.getAuthTag(), body]).toString('base64url')}`, GOLDEN);
  assert.equal(envelope.open(KEY, null, GOLDEN, A).plain, 'synthetic-app-password');
  assert.throws(() => envelope.open(KEY, null, GOLDEN, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'));
});

test('the proof reader re-reads the file when it changes and falls back to none when it cannot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-proofs-'));
  try {
    const proofOf = owned.createProofReader(dir);
    assert.equal(proofOf(A), null);
    const file = path.join(dir, owned.PROOFS_FILE);
    const write = (doc) => { fs.writeFileSync(`${file}.tmp`, typeof doc === 'string' ? doc : JSON.stringify(doc)); fs.renameSync(`${file}.tmp`, file); };
    write({ version: 1, proofs: { [A]: 1000 } });
    assert.equal(proofOf(A), 1000);
    assert.equal(proofOf('other'), null);
    write({ version: 1, proofs: { [A]: 2000, other: 'x' } });
    assert.equal(proofOf(A), 2000, 'a new write is seen on the next use');
    assert.equal(proofOf('other'), null, 'a non-number is no proof');
    write('{not json');
    assert.equal(proofOf(A), null, 'an unreadable file proves nothing (never the last good value)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the storage latch ends a hold set before a proof, never one set after it', () => {
  const { createStorageLatch } = require('./storage-latch.cjs');
  const CONN = { kind: 'nextcloud', baseUrl: 'https://cloud.example/remote.php/dav/files/ada', username: 'ada', secret: 'synthetic-app-pw' };
  let clock = 100; let proof = null;
  const latch = createStorageLatch({ now: () => clock, proofOf: (userId) => (userId === 'u1' ? proof : null) });
  latch.note('u1', CONN, { kind: 'login' });
  latch.note('u2', CONN, { kind: 'login' });
  assert.deepEqual(latch.blocked('u1', CONN), { kind: 'login' });
  proof = 99;
  assert.deepEqual(latch.blocked('u1', CONN), { kind: 'login' }, 'an older proof does not end a newer hold');
  proof = 150;
  assert.equal(latch.blocked('u1', CONN), null, 'the proof ends the hold');
  assert.deepEqual(latch.blocked('u2', CONN), { kind: 'login' }, 'another account keeps its hold (tenant isolation)');
  clock = 200;
  latch.note('u1', CONN, { kind: 'throttled', retryAfter: 30 });
  assert.deepEqual(latch.blocked('u1', CONN), { kind: 'throttled', retryAfter: 30 }, 'a hold after the proof stays');
  const broken = createStorageLatch({ now: () => 0, proofOf: () => { throw new Error('unreadable'); } });
  broken.note('u1', CONN, { kind: 'login' });
  assert.deepEqual(broken.blocked('u1', CONN), { kind: 'login' }, 'a proof that cannot be read changes nothing');
});

// ── through the real router and database ──────────────────────────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-storage-'));
process.env.UI_DATA_DIR = dataDir;
require('../tests/server/project-store-server.cjs').installProjectStore(dataDir);
process.env.PUBLIC_ORIGIN = 'http://localhost';
process.env.LEGACY_AUTH_COMPAT = 'false';
const originalWarn = console.warn;
console.warn = () => {};
const index = require('./index.cjs');
console.warn = originalWarn;
const { seedAccount } = require('../tests/server/seed-account.cjs');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

async function request(url, { method = 'GET', headers = {}, body } = {}) {
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const req = Readable.from(payload ? [payload] : []);
  Object.assign(req, { url, method, headers: { host: 'localhost', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  const chunks = [];
  const res = new Writable({ write(chunk, _e, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  res.statusCode = 200;
  res.headersSent = false;
  res.setHeader = () => {};
  res.writeHead = (status) => { res.statusCode = status; res.headersSent = true; return res; };
  const done = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
  await index.handleRequest(req, res);
  await done;
  const text = Buffer.concat(chunks).toString('utf8');
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.statusCode, text, json: parsed };
}

test('through the router: refused signed out and signed in, before the body is read', async () => {
  const admin = seedAccount(dataDir, { username: 'storage-admin', displayName: 'Synthetic', role: 'admin', publicOrigin: 'http://localhost' });
  const as = { cookie: admin.cookie, origin: 'http://localhost', 'x-csrf-token': admin.csrf, 'content-type': 'application/json' };
  for (const url of owned.OWNED_PATHS) {
    for (const headers of [{}, as]) {
      const r = await request(url, { method: 'POST', headers, body: '{"baseUrl":"https://cloud.invalid","kind":"local","path":"x","flowId":"f"}' });
      assert.equal(r.status, 503, url);
      assert.deepEqual(r.json, owned.ROUTE_REFUSAL);
    }
  }
  assert.equal(fs.existsSync(path.join(dataDir, 'nextcloud-login-flows.json')), false, 'Node never opens the flow file');
  assert.equal((await request('/api/integrations/storage/folder', { headers: { cookie: admin.cookie } })).status, 404, 'a GET still falls through to Node as before');
});

test('through the real database: the row the Rust front saved (its golden bytes) is read on Node\'s next use', (t) => {
  const Database = require('better-sqlite3');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-storage-row-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'secrets.key'), KEY, { mode: 0o600 });
  const secrets = require('./secrets.cjs').createSecretStore(root);
  const auth = require('./auth.cjs').createAuth({ dataDir: root, publicOrigin: 'https://noevia.example.test', secrets });
  const rust = new Database(path.join(root, 'cowork.db'));
  try {
    rust.prepare(`INSERT INTO users(id,username,username_norm,display_name,role,password_hash,webauthn_user_id,created_at,updated_at)
      VALUES(?,?,?,?,'member','x',?,0,0)`).run(A, 'ada', 'ada', 'Ada', 'w-ada');
    assert.equal(auth.getStorage(A).kind, 'local');
    // The Rust front's exact statement (server-store save_storage_connection) and audit row.
    rust.prepare(`INSERT INTO storage_connections(user_id,kind,base_url,bucket,region,username,secret,corpus_root,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET kind=excluded.kind,base_url=excluded.base_url,
        bucket=excluded.bucket,region=excluded.region,username=excluded.username,secret=excluded.secret,corpus_root=excluded.corpus_root,updated_at=excluded.updated_at`)
      .run(A, 'nextcloud', 'https://cloud.invalid/remote.php/dav/files/ada', '', 'us-east-1', 'ada@example.test', GOLDEN, 'Cowork/Diary', Date.now());
    const storage = auth.getStorage(A, true);
    assert.deepEqual({ ...storage }, {
      kind: 'nextcloud', baseUrl: 'https://cloud.invalid/remote.php/dav/files/ada', bucket: '', region: 'us-east-1', username: 'ada@example.test',
      corpusRoot: 'Cowork/Diary', secret: 'synthetic-app-password', secretConfigured: true, secretNeedsReauth: false,
    });
    // Already the current bound format: Node does not rewrite it.
    assert.equal(rust.prepare('SELECT secret FROM storage_connections WHERE user_id=?').get(A).secret, GOLDEN);
  } finally { rust.close(); }
});
