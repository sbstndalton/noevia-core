'use strict';
const { saveStorageAsFront, frontRun } = require('../tests/server/storage-row-front.cjs');
// Secrets-key rotation (#111): the previous key still decrypts, rotate() re-encrypts every
// stored credential kind under the current key (and upgrades plaintext), is idempotent and
// counts bad rows instead of aborting; an unreadable token reports "needs re-auth"; the
// admin route is administrator-only. Synthetic values only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createSecretStore } = require('./secrets.cjs');
const { createAuth } = require('./auth.cjs');
const { createMcpOAuth } = require('./mcp-oauth.cjs');
const { createDirectoryMcp } = require('./directory-mcp.cjs');
const { runRotation } = require('./secrets-rotate.cjs');
const { createAuthRoutes } = require('./routes/auth.cjs');
// The accounts are the Rust front's (#1071): Node's connection refuses to write them, so the synthetic
// users are written through a separate connection, as the front would.
const Database = require('better-sqlite3');
function seedUsers(root, users) {
  const db = new Database(path.join(root, 'cowork.db'));
  try {
    for (const [id, name] of users) db.prepare(`INSERT INTO users(id,username,username_norm,display_name,role,password_hash,webauthn_user_id,created_at,updated_at)
      VALUES(?,?,?,?,'member','x',?,0,0)`).run(id, name, name, name, `w-${id}`);
  } finally { db.close(); }
}

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';

function tmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rotate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const retire = (root) => fs.renameSync(path.join(root, 'secrets.key'), path.join(root, 'secrets.key.previous'));
const noPrev = { env: {} };

test('decrypt falls back to the previous key from the file or SECRETS_KEY_PREVIOUS', (t) => {
  const root = tmp(t);
  const old = createSecretStore(root, noPrev);
  const v1 = old.encrypt('synthetic-a'); const v2 = old.encrypt('synthetic-b', U1);
  const oldKey = fs.readFileSync(old.keyFile);
  retire(root);
  const fresh = createSecretStore(root, noPrev);
  assert.equal(fresh.hasPreviousKey(), true);
  assert.equal(fresh.decrypt(v1), 'synthetic-a');
  assert.equal(fresh.decrypt(v2, U1), 'synthetic-b');
  assert.throws(() => fresh.decrypt(v2, U2), 'the AAD still binds under the previous key');
  fs.rmSync(path.join(root, 'secrets.key.previous'));
  assert.equal(createSecretStore(root, noPrev).canDecrypt(v1), false);
  for (const encoded of [oldKey.toString('base64'), oldKey.toString('hex')]) {
    const viaEnv = createSecretStore(root, { env: { SECRETS_KEY_PREVIOUS: encoded } });
    assert.equal(viaEnv.decrypt(v2, U1), 'synthetic-b');
  }
  assert.throws(() => createSecretStore(root, { env: { SECRETS_KEY_PREVIOUS: 'c2hvcnQ=' } }), /previous/);
});

test('rotate re-encrypts every stored kind, upgrades plaintext, counts failures, and is idempotent', (t) => {
  const root = tmp(t);
  const old = createSecretStore(root, noPrev);
  const auth = createAuth({ dataDir: root, publicOrigin: 'https://noevia.example.test', secrets: old });
  const db = auth.db;
  seedUsers(root, [[U1, U1], [U2, U2]]);
  createMcpOAuth({ db, secrets: old, urlAllowed: async () => true, redirectUri: () => 'https://noevia.example.test/cb' });
  createDirectoryMcp({ db, secrets: old });
  const S3 = { kind: 's3', baseUrl: 'https://s3.example.test', bucket: 'b', username: 'AKID', corpusRoot: 'x' };
  // The storage row is the Rust front's to write (sbstndalton/noevia#2190 round 4); the rotation
  // below runs on the guarded connection, whose one allowed statement is the CAS reseal.
  saveStorageAsFront(root, old, U1, { ...S3, secret: 'storage-one' });
  saveStorageAsFront(root, old, U2, { ...S3, secret: 'x' });
  frontRun(root, 'UPDATE storage_connections SET secret=? WHERE user_id=?', 'plain-storage-two', U2); // legacy plaintext
  db.prepare('INSERT INTO mcp_oauth_tokens VALUES(?,?,?,?)').run(U1, 'srv', old.encrypt(JSON.stringify({ access_token: 'tok-1' }), U1), 0);
  db.prepare('INSERT INTO mcp_oauth_tokens VALUES(?,?,?,?)').run(U2, 'srv', 'enc:v2:garbage', 0);
  db.prepare('INSERT INTO mcp_oauth_clients VALUES(?,?,?)').run('srv', old.encrypt(JSON.stringify({ clientId: 'c' })), 0);
  db.prepare(`INSERT INTO directory_mcp_servers(id, registry_name, title, url, added_by, added_at, headers_enc) VALUES(?,?,?,?,?,?,?)`)
    .run('dir-x', 'x', 'X', 'https://mcp.example.test', U1, 0, old.encrypt(JSON.stringify({ Authorization: 'shared' })));
  db.prepare('INSERT INTO directory_mcp_user_keys VALUES(?,?,?,?)').run(U1, 'dir-x', old.encrypt(JSON.stringify({ Authorization: 'mine' })), 0); // v1 in a bound table
  fs.writeFileSync(path.join(root, 'shared-providers.json'), JSON.stringify({ providers: [{ id: 'p', apiKey: old.encrypt('shared-key') }, { id: 'q', apiKey: 'plain-shared' }] }));
  fs.mkdirSync(path.join(root, 'users', U1), { recursive: true });
  fs.writeFileSync(path.join(root, 'users', U1, 'providers.json'), JSON.stringify({ providers: [{ id: 'mine', apiKey: old.encrypt('private-key') }] }));

  retire(root);
  const secrets = createSecretStore(root, noPrev);
  const audits = [];
  const report = runRotation({ secrets, db, dataDir: root, actorId: U1, audit: (...a) => audits.push(a) });
  assert.deepEqual(report.totals, { current: 0, rotated: 7, upgraded: 2, empty: 0, failed: 1 });
  assert.equal(report.failures[0].table, 'mcp_oauth_tokens');
  assert.deepEqual(report.failures[0].ref, [U2, 'srv']);
  assert.equal(report.tables.directory_mcp_user_keys.rotated, 1);
  assert.equal(audits[0][0], 'secrets.rotate');

  // The previous key is gone: everything must open with the current key alone.
  fs.rmSync(path.join(root, 'secrets.key.previous'));
  const only = createSecretStore(root, noPrev);
  const val = (sql, ...a) => db.prepare(sql).get(...a).v;
  assert.equal(only.decrypt(val('SELECT secret v FROM storage_connections WHERE user_id=?', U1), U1), 'storage-one');
  assert.match(val('SELECT secret v FROM storage_connections WHERE user_id=?', U2), /^enc:v2:/);
  assert.equal(only.decrypt(val('SELECT secret v FROM storage_connections WHERE user_id=?', U2), U2), 'plain-storage-two');
  assert.equal(JSON.parse(only.decrypt(val('SELECT data_enc v FROM mcp_oauth_tokens WHERE user_id=?', U1), U1)).access_token, 'tok-1');
  assert.equal(JSON.parse(only.decrypt(val('SELECT data_enc v FROM mcp_oauth_clients WHERE server_id=?', 'srv'))).clientId, 'c');
  assert.equal(JSON.parse(only.decrypt(val('SELECT headers_enc v FROM directory_mcp_servers WHERE id=?', 'dir-x'))).Authorization, 'shared');
  const userKey = val('SELECT headers_enc v FROM directory_mcp_user_keys WHERE user_id=?', U1);
  assert.match(userKey, /^enc:v2:/, 'a v1 value in a bound table is upgraded to v2');
  assert.equal(JSON.parse(only.decrypt(userKey, U1)).Authorization, 'mine');
  const shared = JSON.parse(fs.readFileSync(path.join(root, 'shared-providers.json'), 'utf8')).providers;
  assert.deepEqual(shared.map((p) => only.decrypt(p.apiKey)), ['shared-key', 'plain-shared']);
  assert.match(shared[1].apiKey, /^enc:v1:/);
  const mine = JSON.parse(fs.readFileSync(path.join(root, 'users', U1, 'providers.json'), 'utf8')).providers;
  assert.equal(only.decrypt(mine[0].apiKey), 'private-key');

  const again = runRotation({ secrets: only, db, dataDir: root });
  assert.deepEqual(again.totals, { current: 9, rotated: 0, upgraded: 0, empty: 0, failed: 1 });
});

test('an undecryptable token or storage secret reports needs re-auth, not connected', (t) => {
  const root = tmp(t);
  const secrets = createSecretStore(root, noPrev);
  const auth = createAuth({ dataDir: root, publicOrigin: 'https://noevia.example.test', secrets });
  seedUsers(root, [[U1, 'u']]);
  const oauth = createMcpOAuth({ db: auth.db, secrets, urlAllowed: async () => true, redirectUri: () => 'https://noevia.example.test/cb' });
  const foreign = createSecretStore(tmp(t), noPrev);
  auth.db.prepare('INSERT INTO mcp_oauth_tokens VALUES(?,?,?,?)').run(U1, 'lost', foreign.encrypt('{"access_token":"t"}', U1), 0);
  auth.db.prepare('INSERT INTO mcp_oauth_tokens VALUES(?,?,?,?)').run(U1, 'ok', secrets.encrypt('{"access_token":"t"}', U1), 0);
  assert.equal(oauth.status(U1, 'lost'), 'needs-reauth');
  assert.equal(oauth.connected(U1, 'lost'), false);
  assert.equal(oauth.status(U1, 'ok'), 'connected');
  assert.equal(oauth.status(U1, 'none'), 'disconnected');

  saveStorageAsFront(root, secrets, U1, { kind: 's3', baseUrl: 'https://s3.example.test', username: 'a', secret: 'x' });
  frontRun(root, 'UPDATE storage_connections SET secret=? WHERE user_id=?', foreign.encrypt('x', U1), U1);
  const st = auth.getStorage(U1);
  assert.equal(st.secretConfigured, false);
  assert.equal(st.secretNeedsReauth, true);
  // A plaintext secret is upgraded to v2 on the next read.
  frontRun(root, 'UPDATE storage_connections SET secret=? WHERE user_id=?', 'plain', U1);
  assert.equal(auth.getStorage(U1, true).secret, 'plain');
  assert.match(auth.db.prepare('SELECT secret FROM storage_connections WHERE user_id=?').get(U1).secret, /^enc:v2:/);
});

test('POST /api/admin/secrets/rotate is administrator-only and runs the rotation', async () => {
  const sent = []; const ran = [];
  const routes = createAuthRoutes({
    json: (_res, status, body) => sent.push({ status, body }), readJson: async () => ({}),
    authService: {}, workspaceStore: {}, driveAccounts: {},
    fetchJson: async () => ({}), DIARY_BASE: '', DIARY_TOKEN: '',
    rotateSecrets: (actor) => { ran.push(actor); return { totals: { rotated: 1 } }; },
  });
  const call = (role, method = 'POST') => {
    const req = Readable.from([]); Object.assign(req, { method, headers: {} });
    return routes.account(req, {}, { path: '/api/admin/secrets/rotate', authn: { user: { id: 'u-' + role, role } } });
  };
  await call('member');
  assert.equal(sent.at(-1).status, 403);
  assert.deepEqual(ran, []);
  await call('admin');
  assert.equal(sent.at(-1).status, 200);
  assert.deepEqual(ran, ['u-admin']);
  await call('admin', 'GET');
  assert.equal(sent.at(-1).status, 404);
});

test('sbstndalton/noevia#2190 round 4: a rotation never overwrites a value saved after it read the row', (t) => {
  const root = tmp(t);
  const secrets = createSecretStore(root, noPrev);
  const auth = createAuth({ dataDir: root, publicOrigin: 'https://noevia.example.test', secrets });
  seedUsers(root, [[U1, U1]]);
  saveStorageAsFront(root, null, U1, { kind: 'webdav', baseUrl: 'https://dav.example.test', username: 'a', secret: 'plain-old' });
  const { rotationTables } = require('./secrets-rotate.cjs');
  const table = rotationTables({ db: auth.db, dataDir: root }).find((x) => x.name === 'storage_connections');
  const [row] = table.rows();
  assert.equal(row.value, 'plain-old');
  // The front saves a new connection between the rotation's read and its write.
  saveStorageAsFront(root, secrets, U1, { kind: 'webdav', baseUrl: 'https://dav.example.test', username: 'a', secret: 'newer' });
  assert.throws(() => table.write(row.ref, secrets.encrypt('plain-old', U1), row.value), /changed while rotating/);
  assert.equal(auth.getStorage(U1, true).secret, 'newer');
  // With the value unchanged the reseal lands, on the guarded connection.
  const [now] = table.rows();
  table.write(now.ref, secrets.encrypt('newer', U1), now.value);
  assert.equal(auth.getStorage(U1, true).secret, 'newer');
});
