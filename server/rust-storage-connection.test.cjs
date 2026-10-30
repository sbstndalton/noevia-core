'use strict';
// sbstndalton/noevia#2190 round 4: saving the storage connection (PUT /api/integrations/storage) is
// the Rust front's (noevia-rs storage_integration_routes.rs, tested there through real HTTP with a
// synthetic WebDAV server), and the front is the only writer of the storage_connections row. Node
// refuses the PUT before authentication, its database guard refuses every write of the table but
// the same-plaintext reseal (rust-auth.test.cjs, storage-region.test.cjs), and its legacy WebDAV
// setup asks the front's internal store. Synthetic accounts and secrets only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const owned = require('./rust-storage-connection.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });
const refuse = (method, url) => { const res = {}; return owned.refuseOwned({ url, method, headers: {}, on() { throw new Error('body listener'); } }, res, { parseRequestUrl, json }) ? res : null; };

// The golden vector shared with noevia-rs tests/storage_integrations.rs (round 3): the front seals the
// saved secret exactly as rust-storage-integrations.test.cjs proves Node opens it.
const A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GOLDEN = 'enc:v2:AQIDBAUGBwgJCgsMSgG3ElISmXU7G_CAvinHk8gFhuoCj5ZFhhNjbuWK0yGnliZfwC8';

test('only PUT on the exact path is refused, before the body is read', () => {
  assert.deepEqual(owned.ROUTE_REFUSAL, { error: 'The storage connection is owned by the Rust front.', code: 'RUST_STORAGE_CONNECTION_OWNED' });
  assert.ok(Object.isFrozen(owned.ROUTE_REFUSAL));
  for (const url of ['/api/integrations/storage', '/api/integrations/storage?x=1', '/api/integrations/./storage', '/api/integrations/x/../storage']) {
    assert.deepEqual(refuse('PUT', url), { status: 503, body: owned.ROUTE_REFUSAL }, url);
  }
  for (const m of ['GET', 'POST', 'DELETE', 'HEAD', 'OPTIONS', 'put']) assert.equal(refuse(m, '/api/integrations/storage'), null, m);
  for (const url of ['/api/integrations/storage/', '/api/integrations/storage/test', '/api/integrations/storage-other', '/api/integrations/%73torage']) {
    assert.equal(refuse('PUT', url), null, url);
  }
  assert.equal(owned.RESEAL_SQL, 'UPDATE storage_connections SET secret=? WHERE user_id=? AND secret=?');
});

test('index.cjs refuses the PUT before authentication and holds no save of its own', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  const refusal = index.indexOf("require('./rust-storage-connection.cjs').refuseOwned(req, res, { parseRequestUrl, json })");
  assert.ok(refusal > 0);
  assert.ok(refusal < index.indexOf('const preAuth = requestAuth.authenticate(req);'), 'refused before authentication');
  assert.doesNotMatch(index, /saveStorage\s*\(/);
  assert.match(index, /PROJECT_STORE\.storageLegacyWebdav\(preAuth\.user\.id,/);
  const auth = fs.readFileSync(path.join(__dirname, 'auth.cjs'), 'utf8');
  assert.doesNotMatch(auth, /saveStorage\s*\(/);
  const routes = fs.readFileSync(path.join(__dirname, 'routes', 'storage.cjs'), 'utf8');
  for (const gone of ['checkLogin', 'saveStorage', 'loginProven', 'S3_REGION_RE', 'readJson']) assert.equal(routes.includes(gone), false, gone);
});

test('the legacy WebDAV setup goes to the store and saves only an unconfigured account', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-storage-connection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { createSecretStore } = require('./secrets.cjs');
  const secrets = createSecretStore(root);
  const { createAuth } = require('./auth.cjs');
  const auth = createAuth({ dataDir: root, publicOrigin: 'https://noevia.example.test', secrets });
  t.after(() => auth.db.close());
  const { asFront } = require('../tests/server/storage-row-front.cjs');
  asFront(root, (db) => db.prepare(`INSERT INTO users(id,username,username_norm,display_name,role,password_hash,webauthn_user_id,created_at,updated_at)
    VALUES(?,?,?,?,'admin','x',?,0,0)`).run(A, 'a', 'a', 'A', 'w-a'));
  fs.mkdirSync(path.join(root, 'users', A), { recursive: true });
  const store = await require('../tests/server/project-store-server.cjs').startProjectStore(root);
  t.after(() => store.close());
  const { createClient } = require('./project-store-client.cjs');
  const client = createClient({ port: store.port, token: store.token });
  const legacy = { baseUrl: 'https://dav.example.test/remote/', username: 'legacy', secret: 'synthetic-legacy-secret', corpusRoot: 'Cowork/Diary' };
  assert.deepEqual(await client.storageLegacyWebdav(A, legacy), { saved: true });
  const saved = auth.getStorage(A, true);
  assert.deepEqual([saved.kind, saved.baseUrl, saved.username, saved.secret, saved.corpusRoot], ['webdav', 'https://dav.example.test/remote', 'legacy', 'synthetic-legacy-secret', 'Cowork/Diary']);
  assert.deepEqual(await client.storageLegacyWebdav(A, { ...legacy, username: 'other' }), { saved: false });
  assert.equal(auth.getStorage(A).username, 'legacy');
  // A store that refuses throws Node's failure shape; one without the op (an older front) too.
  const bad = createClient({ port: store.port, token: 'x'.repeat(64) });
  await assert.rejects(() => bad.storageLegacyWebdav(A, legacy), (e) => e.status === 500 && e.code === 'PROJECT_STORE_FAILED');
});

test('a row the front sealed with the golden vector reads on Node\'s next use', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-storage-connection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'secrets.key'), Buffer.alloc(32, 7), { mode: 0o600 });
  const { createSecretStore } = require('./secrets.cjs');
  const { createAuth } = require('./auth.cjs');
  const auth = createAuth({ dataDir: root, publicOrigin: 'https://noevia.example.test', secrets: createSecretStore(root, { env: {} }) });
  t.after(() => auth.db.close());
  const { asFront, frontRun } = require('../tests/server/storage-row-front.cjs');
  asFront(root, (db) => db.prepare(`INSERT INTO users(id,username,username_norm,display_name,role,password_hash,webauthn_user_id,created_at,updated_at)
    VALUES(?,?,?,?,'member','x',?,0,0)`).run(A, 'a', 'a', 'A', 'w-a'));
  frontRun(root, "INSERT INTO storage_connections(user_id,kind,base_url,bucket,region,username,secret,corpus_root,updated_at) VALUES(?,'webdav','https://dav.example.test','','us-east-1','alice',?,'Notes',1)", A, GOLDEN);
  const got = auth.getStorage(A, true);
  assert.equal(got.secret, 'synthetic-app-password');
  assert.equal(got.secretNeedsReauth, false);
  // A bound value is current: Node does not touch it.
  assert.equal(auth.db.prepare('SELECT secret FROM storage_connections WHERE user_id=?').get(A).secret, GOLDEN);
});
