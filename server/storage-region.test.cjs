'use strict';
// S3 region end to end on the web side: saved with the connection (legacy rows
// default to us-east-1), returned by getStorage, forwarded in X-Cowork-Storage,
// and signed into every SigV4 scope. Plus account-bound storage secrets.
const test = require('node:test');
const { createStubStore } = require('../tests/server/project-store-stub.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createAuth } = require('./auth.cjs');
const { createSecretStore } = require('./secrets.cjs');
const { createDiary } = require('./diary.cjs');
const storageClient = require('./storage-client.cjs');
const { saveStorageAsFront, frontRun } = require('../tests/server/storage-row-front.cjs');

function authFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-region-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secrets = createSecretStore(root);
  const auth = createAuth({ dataDir: root, publicOrigin: 'https://noevia.example.test', secrets });
  // The accounts are the Rust front's (#1071): users are written through the front's own connection.
  const addUser = (id) => {
    const front = new (require('better-sqlite3'))(path.join(root, 'cowork.db'));
    try {
      front.prepare(`INSERT INTO users(id,username,username_norm,display_name,role,password_hash,webauthn_user_id,created_at,updated_at)
        VALUES(?,?,?,?,'member','x',?,0,0)`).run(id, id, id, id, `w-${id}`);
    } finally { front.close(); }
  };
  // The row is the Rust front's to write (sbstndalton/noevia#2190 round 4): saved as the front does.
  const save = (id, value) => { saveStorageAsFront(root, secrets, id, value); return auth.getStorage(id); };
  return { root, secrets, auth, addUser, save };
}

const S3 = { kind: 's3', baseUrl: 'https://s3.eu-west-1.example.test', bucket: 'synthetic', username: 'AKIDEXAMPLE', secret: 'synthetic-secret', corpusRoot: 'Diary' };

test('region is saved, returned, and defaults for legacy rows and bad input', (t) => {
  const { auth, addUser, save } = authFixture(t);
  addUser('u1'); addUser('u2');
  assert.equal(save('u1', { ...S3, region: 'eu-west-1' }).region, 'eu-west-1');
  assert.equal(auth.getStorage('u1', true).region, 'eu-west-1');
  assert.equal(save('u2', { ...S3 }).region, 'us-east-1');
  assert.equal(save('u2', { ...S3, region: 'EU WEST' }).region, 'us-east-1');
  assert.equal(auth.getStorage('nobody').region, 'us-east-1');
});

test('a pre-region database migrates with us-east-1 and keeps its secret', (t) => {
  const { root, auth, addUser, save } = authFixture(t);
  addUser('u1');
  save('u1', { ...S3 });
  auth.db.exec('ALTER TABLE storage_connections DROP COLUMN region');
  auth.db.close();
  const reopened = createAuth({ dataDir: root, publicOrigin: 'https://noevia.example.test', secrets: createSecretStore(root) });
  const row = reopened.getStorage('u1', true);
  assert.equal(row.region, 'us-east-1');
  assert.equal(row.secret, 'synthetic-secret');
});

test('X-Cowork-Storage carries the saved region to the Diary sidecar', (t) => {
  const { auth, addUser, root, save } = authFixture(t);
  addUser('u1');
  save('u1', { ...S3, region: 'ap-southeast-2' });
  const requestScope = new AsyncLocalStorage();
  const diary = createDiary({ fs, path, fetchJson: async () => ({}), DIARY_BASE: 'http://diary.invalid', DIARY_TOKEN: '', DIARY_SOURCE: 'sidecar',
    requestScope, authService: auth, endpointApproved: () => true, workspaceStore: { get: (id) => ({ userId: id, dir: path.join(root, id) }) } });
  const h = requestScope.run({ workspace: { userId: 'u1', dir: path.join(root, 'u1') }, authn: { user: { id: 'u1' } } }, () => diary.diaryHeaders());
  const forwarded = JSON.parse(Buffer.from(h['X-Cowork-Storage'], 'base64url').toString());
  assert.equal(forwarded.region, 'ap-southeast-2');
  assert.equal(forwarded.secret, 'synthetic-secret');
});

function scopeRegion(headers) {
  return /Credential=[^/]+\/\d{8}\/([^/]+)\/s3\/aws4_request/.exec(headers.Authorization || headers.authorization)[1];
}

test('storage-client signs list, read and binary reads with the connection region', async (t) => {
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push(scopeRegion(init.headers)); return new Response('<ListBucketResult></ListBucketResult>', { status: 200 }); };
  t.after(() => { globalThis.fetch = real; });
  const conn = { ...S3, region: 'eu-central-1' };
  await storageClient.listFiles(conn, '');
  await storageClient.readTextFile(conn, 'a.md');
  await storageClient.readBinaryFile(conn, 'a.pdf');
  await storageClient.listFiles({ ...S3 }, '');
  assert.deepEqual(seen, ['eu-central-1', 'eu-central-1', 'eu-central-1', 'us-east-1']);
});

// The S3 probe (POST /test) and the save's region rule are the Rust front's since
// sbstndalton/noevia#2190 (noevia-rs tests/storage_integrations.rs).

test('storage secrets are bound to the account and never stored verbatim', (t) => {
  const { auth, secrets, addUser, root, save } = authFixture(t);
  addUser('victim'); addUser('attacker');
  save('victim', { ...S3 });
  const victimCipher = auth.db.prepare('SELECT secret FROM storage_connections WHERE user_id=?').get('victim').secret;
  assert.match(victimCipher, /^enc:v2:/);
  // Replaying the victim's ciphertext as a "secret" stores it as plaintext, not as a ciphertext.
  save('attacker', { ...S3, secret: victimCipher });
  assert.equal(auth.getStorage('attacker', true).secret, victimCipher);
  // Even a row forged to hold the victim's ciphertext does not decrypt for another account.
  frontRun(root, 'UPDATE storage_connections SET secret=? WHERE user_id=?', victimCipher, 'attacker');
  assert.equal(auth.getStorage('attacker', true).secret, '');
  assert.equal(auth.getStorage('attacker').secretConfigured, false);
  // A legacy v1 row still decrypts and is upgraded to v2 on read (the guard's one allowed reseal).
  frontRun(root, 'UPDATE storage_connections SET secret=? WHERE user_id=?', secrets.encrypt('legacy-secret'), 'victim');
  assert.equal(auth.getStorage('victim', true).secret, 'legacy-secret');
  assert.match(auth.db.prepare('SELECT secret FROM storage_connections WHERE user_id=?').get('victim').secret, /^enc:v2:/);
  assert.equal(auth.getStorage('victim', true).secret, 'legacy-secret');
});

test('getStorage warns with the user id, never the secret, when decryption fails', (t) => {
  const { auth, addUser, save, root } = authFixture(t);
  addUser('u1');
  save('u1', { ...S3 });
  frontRun(root, "UPDATE storage_connections SET secret='enc:v2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE user_id='u1'");
  const warned = [];
  t.mock.method(console, 'warn', (...a) => warned.push(a.join(' ')));
  assert.equal(auth.getStorage('u1', true).secret, '');
  assert.equal(warned.length, 1);
  assert.match(warned[0], /u1/);
  assert.doesNotMatch(warned[0], /synthetic-secret|enc:v2/);
});

test('encrypt callers re-save plaintext, so repeated saves never double-encrypt', (t) => {
  const { root, secrets, auth, addUser, save } = authFixture(t);
  const { createWorkspaceStore } = require('./workspace.cjs');
  const WS_USER = '0b6c2d7e-1f4a-4c3b-9e8d-7a6b5c4d3e2f';
  const def = { id: 'default', label: 'Default', baseUrl: 'http://localhost', apiKey: '', shared: true };
  const ws = createWorkspaceStore(root, def, secrets, { projectStore: createStubStore(root) }).get(WS_USER);
  ws.providers.push({ id: 'p1', label: 'P', baseUrl: 'https://llm.example.test', apiKey: 'synthetic-key' });
  ws.saveProviders(); ws.saveProviders();
  const reloaded = createWorkspaceStore(root, def, secrets, { projectStore: createStubStore(root) }).get(WS_USER);
  assert.equal(reloaded.providers.find((p) => p.id === 'p1').apiKey, 'synthetic-key');
  reloaded.saveProviders();
  assert.equal(createWorkspaceStore(root, def, secrets, { projectStore: createStubStore(root) }).get(WS_USER).providers.find((p) => p.id === 'p1').apiKey, 'synthetic-key');
  addUser('u2');
  save('u2', { ...S3 });
  auth.getStorage('u2', true);
  save('u2', { ...auth.getStorage('u2', true), bucket: 'renamed' });
  assert.equal(auth.getStorage('u2', true).secret, 'synthetic-secret');
});

test('sbstndalton/noevia#2190 round 4: Node cannot write the storage row, but for the same-plaintext reseal', (t) => {
  const { auth, secrets, addUser, root, save } = authFixture(t);
  addUser('u1');
  assert.equal(auth.saveStorage, undefined, 'saveStorage is gone');
  save('u1', { ...S3 });
  const refused = (e) => e.code === 'RUST_STORAGE_CONNECTION_OWNED' && e.status === 503;
  for (const [sql, args] of [
    ["INSERT INTO storage_connections(user_id,kind,base_url,bucket,region,username,secret,corpus_root,updated_at) VALUES('u1','local','','','us-east-1','','','',1)", []],
    ['INSERT OR REPLACE INTO storage_connections(user_id,kind,base_url,bucket,region,username,secret,corpus_root,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', ['u1', 'local', '', '', 'us-east-1', '', '', '', 1]],
    ['UPDATE storage_connections SET secret=? WHERE user_id=?', ['x', 'u1']],
    ['UPDATE storage_connections SET base_url=? WHERE user_id=? AND secret=?', ['x', 'u1', 'y']],
    ['DELETE FROM storage_connections WHERE user_id=?', ['u1']],
    ['UPDATE main."storage_connections" SET kind=? WHERE user_id=?', ['local', 'u1']],
  ]) {
    assert.throws(() => auth.db.prepare(sql).run(...args), refused, sql);
  }
  assert.throws(() => auth.db.prepare('DELETE FROM storage_connections').run(), refused);
  assert.throws(() => auth.db.exec("UPDATE storage_connections SET kind='local'"), refused);
  assert.equal(auth.getStorage('u1').kind, 's3');
  // The reseal runs, and only replaces the value it read (compare-and-swap).
  const { RESEAL_SQL } = require('./rust-storage-connection.cjs');
  const before = auth.db.prepare('SELECT secret FROM storage_connections WHERE user_id=?').get('u1').secret;
  assert.equal(auth.db.prepare(RESEAL_SQL).run(secrets.encrypt('synthetic-secret', 'u1'), 'u1', 'not-the-value').changes, 0);
  assert.equal(auth.db.prepare('SELECT secret FROM storage_connections WHERE user_id=?').get('u1').secret, before);
  // Reads are untouched.
  assert.equal(auth.getStorage('u1', true).secret, 'synthetic-secret');
  // A legacy row upgraded by getStorage keeps a front save that landed in between.
  frontRun(root, 'UPDATE storage_connections SET secret=? WHERE user_id=?', secrets.encrypt('legacy-secret'), 'u1');
  assert.equal(auth.getStorage('u1', true).secret, 'legacy-secret');
  assert.match(auth.db.prepare('SELECT secret FROM storage_connections WHERE user_id=?').get('u1').secret, /^enc:v2:/);
});
