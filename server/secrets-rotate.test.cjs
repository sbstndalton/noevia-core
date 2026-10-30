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

test('rotate re-encrypts every stored kind, upgrades plaintext, counts failures, and is idempotent', async (t) => {
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

  // The provider files are the Rust front's: it re-seals them (noevia-rs tests/providers.rs checks
  // the files); here a stand-in front answers with the counts it would, and the rotation must
  // leave both files exactly as they are.
  const providerBytes = () => [path.join(root, 'shared-providers.json'), path.join(root, 'users', U1, 'providers.json')].map((f) => fs.readFileSync(f, 'utf8'));
  const providersBefore = providerBytes();
  const front = (current = false) => async () => ({
    tables: {
      shared_providers: { current: current ? 2 : 0, rotated: current ? 0 : 1, upgraded: current ? 0 : 1, empty: 0, failed: 0 },
      [`user_providers:${U1}`]: { current: current ? 1 : 0, rotated: current ? 0 : 1, upgraded: 0, empty: 0, failed: 0 },
    },
    failures: [],
  });

  retire(root);
  const secrets = createSecretStore(root, noPrev);
  const audits = [];
  const report = await runRotation({ secrets, db, dataDir: root, actorId: U1, audit: (...a) => audits.push(a), resealProviders: front() });
  assert.deepEqual(report.totals, { current: 0, rotated: 7, upgraded: 2, empty: 0, failed: 1 });
  assert.equal(report.failures[0].table, 'mcp_oauth_tokens');
  assert.deepEqual(report.failures[0].ref, [U2, 'srv']);
  assert.equal(report.tables.directory_mcp_user_keys.rotated, 1);
  assert.deepEqual(report.tables.shared_providers, { current: 0, rotated: 1, upgraded: 1, empty: 0, failed: 0 });
  assert.equal(audits[0][0], 'secrets.rotate');
  assert.deepEqual(providerBytes(), providersBefore, 'this process wrote neither provider file');

  // The previous key is gone: everything this process rotated must open with the current key alone.
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

  const again = await runRotation({ secrets: only, db, dataDir: root, resealProviders: front(true) });
  assert.deepEqual(again.totals, { current: 9, rotated: 0, upgraded: 0, empty: 0, failed: 1 });
});

test('M1: the front re-seals the provider files first, awaited, and this process never writes them', async (t) => {
  const root = tmp(t);
  const old = createSecretStore(root, noPrev);
  const auth = createAuth({ dataDir: root, publicOrigin: 'https://noevia.example.test', secrets: old });
  seedUsers(root, [[U1, U1]]);
  saveStorageAsFront(root, null, U1, { kind: 'webdav', baseUrl: 'https://dav.example.test', username: 'a', secret: 'plain-old' });
  const A = old.encrypt('key-of-row-a'), B = old.encrypt('key-of-row-b');
  const file = path.join(root, 'users', U1, 'providers.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ providers: [{ id: 'a', apiKey: A }, { id: 'b', apiKey: B }] }));
  retire(root);
  const secrets = createSecretStore(root, noPrev);
  const row = () => auth.db.prepare('SELECT secret v FROM storage_connections WHERE user_id=?').get(U1).v;
  const calls = [];
  // The front deletes row a while the rotation runs (an interleaved Rust delete). A rotation that
  // wrote the file itself by row position would now put a's key on b, or resurrect a.
  const front = async () => {
    calls.push('front-start');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(row(), 'plain-old', 'the table pass has not started while the front\'s pass is awaited');
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ providers: doc.providers.filter((p) => p.id !== 'a') }));
    calls.push('front-done');
    return { tables: { [`user_providers:${U1}`]: { current: 0, rotated: 1, upgraded: 0, empty: 0, failed: 0 } }, failures: [] };
  };
  const report = await runRotation({ secrets, db: auth.db, dataDir: root, resealProviders: front, audit: () => calls.push('audit') });
  assert.deepEqual(calls, ['front-start', 'front-done', 'audit']);
  assert.match(row(), /^enc:v2:/, 'the table pass ran after it');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).providers, [{ id: 'b', apiKey: B }], 'row b is untouched and row a stays deleted');
  assert.equal(report.tables[`user_providers:${U1}`].rotated, 1);
  // The front's failures are in the report, with the row's position and no key.
  const failing = await runRotation({ secrets, db: auth.db, dataDir: root, resealProviders: async () => ({
    tables: { shared_providers: { current: 0, rotated: 0, upgraded: 0, empty: 0, failed: 1 } },
    failures: [{ table: 'shared_providers', ref: 3, error: 'no key opens it' }],
  }) });
  assert.deepEqual(failing.failures.at(-1), { table: 'shared_providers', ref: 3, error: 'no key opens it' });
  assert.equal(failing.totals.failed, 1);
  assert.equal(failing.tables.shared_providers.failed, 1);
});

test('settings 7 x 6: resealProviders, then gdriveReseal, both awaited, before secrets.rotate; a provider failure stops everything', async (t) => {
  const root = tmp(t);
  const old = createSecretStore(root, noPrev);
  const auth = createAuth({ dataDir: root, publicOrigin: 'https://noevia.example.test', secrets: old });
  retire(root);
  const secrets = createSecretStore(root, noPrev);
  const calls = [];
  const realRotate = secrets.rotate.bind(secrets);
  secrets.rotate = (...a) => { calls.push('rotate'); return realRotate(...a); };
  const slow = async (name, value) => { calls.push(`${name}-start`); await new Promise((r) => setTimeout(r, 15)); calls.push(`${name}-done`); return value; };
  await runRotation({
    secrets, db: auth.db, dataDir: root, audit: () => calls.push('audit'),
    resealProviders: () => slow('providers', { tables: {}, failures: [] }),
    gdriveReseal: () => slow('gdrive', { ok: true, counts: { current: 0, rotated: 0, empty: 0, failed: 0 } }),
  });
  assert.deepEqual(calls, ['providers-start', 'providers-done', 'gdrive-start', 'gdrive-done', 'rotate', 'audit']);

  // A provider failure throws before the Drive re-seal is asked for, and before anything is rotated.
  const after = [];
  secrets.rotate = (...a) => { after.push('rotate'); return realRotate(...a); };
  await assert.rejects(runRotation({
    secrets, db: auth.db, dataDir: root,
    resealProviders: async () => { after.push('providers'); throw new Error('credential store unavailable'); },
    gdriveReseal: async () => { after.push('gdrive'); return { ok: true, counts: { current: 0, rotated: 0, empty: 0, failed: 0 } }; },
  }), /credential store unavailable/);
  assert.deepEqual(after, ['providers']);

  // A Drive failure is soft: the rotation goes on and secrets.rotate still runs.
  after.length = 0;
  const soft = await runRotation({
    secrets, db: auth.db, dataDir: root,
    resealProviders: async () => ({ tables: {}, failures: [] }),
    gdriveReseal: async () => { after.push('gdrive'); throw new Error('unreachable'); },
  });
  assert.deepEqual(after, ['gdrive', 'rotate']);
  assert.equal(soft.totals.failed, 0);
});

test('M1: a rotation the front cannot take part in changes nothing else, and says so', async (t) => {
  const root = tmp(t);
  const old = createSecretStore(root, noPrev);
  const auth = createAuth({ dataDir: root, publicOrigin: 'https://noevia.example.test', secrets: old });
  seedUsers(root, [[U1, U1]]);
  saveStorageAsFront(root, null, U1, { kind: 'webdav', baseUrl: 'https://dav.example.test', username: 'a', secret: 'plain-old' });
  const secrets = createSecretStore(root, noPrev);
  const audits = [];
  await assert.rejects(runRotation({ secrets, db: auth.db, dataDir: root, audit: (...a) => audits.push(a), resealProviders: async () => { throw new Error('project store answered 503: credential store unavailable'); } }), /credential store unavailable/);
  await assert.rejects(runRotation({ secrets, db: auth.db, dataDir: root, audit: (...a) => audits.push(a) }), /needs resealProviders/);
  assert.equal(auth.db.prepare('SELECT secret v FROM storage_connections WHERE user_id=?').get(U1).v, 'plain-old', 'no table was touched');
  assert.deepEqual(audits, []);
  // The client side: a front without the op, or one that answers something else, is a refusal.
  const { resealProviderKeys } = require('./rust-providers-reseal.cjs');
  await assert.rejects(resealProviderKeys({}), /not available/);
  await assert.rejects(resealProviderKeys({ providersReseal: async () => ({ ok: true, tables: { x: { current: 1 } }, failures: [] }) }), /unexpected/);
  await assert.rejects(resealProviderKeys({ providersReseal: async () => ({ ok: false }) }), /unexpected/);
  const ok = await resealProviderKeys({ providersReseal: async (scope) => ({ ok: true, scope, tables: { shared_providers: { current: 1, rotated: 2, upgraded: 3, empty: 0, failed: 4, extra: 9 } }, failures: [{ table: 'shared_providers', ref: 0, error: 'x'.repeat(500), key: 'sk-secret' }] }) });
  assert.deepEqual(ok.tables.shared_providers, { current: 1, rotated: 2, upgraded: 3, empty: 0, failed: 4 });
  assert.equal(ok.failures[0].error.length, 200);
  assert.deepEqual(Object.keys(ok.failures[0]), ['table', 'ref', 'error']);
});

test('M1: the store client asks POST /v1/providers/reseal with the secret and the scope, and maps the answers', async () => {
  const { createClient } = require('./project-store-client.cjs');
  const seen = [];
  const answer = (status, body) => async (url, init) => { seen.push({ url, method: init.method, token: init.headers['x-noevia-store-token'], body: JSON.parse(init.body) }); return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); };
  const token = 'synthetic-store-token-'.padEnd(40, 'x');
  const ok = await createClient({ port: 4321, token, fetchImpl: answer(200, { ok: true, tables: {}, failures: [] }) }).providersReseal('shared');
  assert.deepEqual(ok, { ok: true, tables: {}, failures: [] });
  assert.deepEqual(seen, [{ url: 'http://127.0.0.1:4321/v1/providers/reseal', method: 'POST', token, body: { scope: 'shared' } }]);
  await assert.rejects(createClient({ port: 4321, token, fetchImpl: answer(503, { error: 'credential store unavailable' }) }).providersReseal(), /503: credential store unavailable/);
  await assert.rejects(createClient({ port: 4321, token, fetchImpl: answer(404, { error: 'not found' }) }).providersReseal(), /404/);
  await assert.rejects(createClient({ port: 4321, token, fetchImpl: answer(503, { error: 'busy', code: 'PROJECTS_BUSY' }) }).providersReseal(), (e) => e.code === 'PROJECTS_BUSY');
});

test('M1: the shell form refuses without the front\'s internal store, before it changes anything', (t) => {
  const root = tmp(t);
  const env = { ...process.env, UI_DATA_DIR: root };
  delete env.NOEVIA_PROJECT_STORE_PORT; delete env.NOEVIA_PROJECT_STORE_TOKEN;
  const r = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, 'secrets-rotate.cjs')], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /nothing was changed/);
  assert.match(r.stderr, /POST \/api\/admin\/secrets\/rotate/);
  assert.equal(fs.existsSync(path.join(root, 'secrets.key')), false, 'it did not even create a key');
  assert.equal(r.stdout, '');
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

test('POST /api/admin/secrets/rotate waits for the rotation, and answers a refused one as an error', async () => {
  const sent = [];
  const make = (rotateSecrets) => createAuthRoutes({
    json: (_res, status, body) => sent.push({ status, body }), readJson: async () => ({}),
    authService: {}, workspaceStore: {}, driveAccounts: {}, fetchJson: async () => ({}), DIARY_BASE: '', DIARY_TOKEN: '', rotateSecrets,
  });
  const post = (routes) => { const req = Readable.from([]); Object.assign(req, { method: 'POST', headers: {} }); return routes.account(req, {}, { path: '/api/admin/secrets/rotate', authn: { user: { id: 'u-admin', role: 'admin' } } }); };
  await post(make(async () => { await new Promise((resolve) => setImmediate(resolve)); return { totals: { rotated: 2 } }; }));
  assert.deepEqual(sent.pop(), { status: 200, body: { totals: { rotated: 2 } } }, 'the report, not a promise');
  await post(make(async () => { throw new Error('project store answered 503: credential store unavailable'); }));
  assert.deepEqual(sent.pop(), { status: 500, body: { error: 'project store answered 503: credential store unavailable' } });
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
