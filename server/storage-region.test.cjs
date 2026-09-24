'use strict';
// S3 region end to end on the web side: saved with the connection (legacy rows
// default to us-east-1), returned by getStorage, forwarded in X-Cowork-Storage,
// and signed into every SigV4 scope. Plus account-bound storage secrets.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { AsyncLocalStorage } = require('node:async_hooks');
const { createAuth } = require('./auth.cjs');
const { createSecretStore } = require('./secrets.cjs');
const { createDiary } = require('./diary.cjs');
const { createStorageRoutes } = require('./routes/storage.cjs');
const storageClient = require('./storage-client.cjs');

function authFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-region-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const secrets = createSecretStore(root);
  const auth = createAuth({ dataDir: root, publicOrigin: 'https://noevia.example.test', secrets });
  const addUser = (id) => auth.db.prepare(`INSERT INTO users(id,username,username_norm,display_name,role,password_hash,webauthn_user_id,created_at,updated_at)
    VALUES(?,?,?,?,'member','x',?,0,0)`).run(id, id, id, id, `w-${id}`);
  return { root, secrets, auth, addUser };
}

const S3 = { kind: 's3', baseUrl: 'https://s3.eu-west-1.example.test', bucket: 'synthetic', username: 'AKIDEXAMPLE', secret: 'synthetic-secret', corpusRoot: 'Diary' };

test('region is saved, returned, and defaults for legacy rows and bad input', (t) => {
  const { auth, addUser } = authFixture(t);
  addUser('u1'); addUser('u2');
  assert.equal(auth.saveStorage('u1', { ...S3, region: 'eu-west-1' }).region, 'eu-west-1');
  assert.equal(auth.getStorage('u1', true).region, 'eu-west-1');
  assert.equal(auth.saveStorage('u2', { ...S3 }).region, 'us-east-1');
  assert.equal(auth.saveStorage('u2', { ...S3, region: 'EU WEST' }).region, 'us-east-1');
  assert.equal(auth.getStorage('nobody').region, 'us-east-1');
});

test('a pre-region database migrates with us-east-1 and keeps its secret', (t) => {
  const { root, auth, addUser } = authFixture(t);
  addUser('u1');
  auth.saveStorage('u1', { ...S3 });
  auth.db.exec('ALTER TABLE storage_connections DROP COLUMN region');
  auth.db.close();
  const reopened = createAuth({ dataDir: root, publicOrigin: 'https://noevia.example.test', secrets: createSecretStore(root) });
  const row = reopened.getStorage('u1', true);
  assert.equal(row.region, 'us-east-1');
  assert.equal(row.secret, 'synthetic-secret');
});

test('X-Cowork-Storage carries the saved region to the Diary sidecar', (t) => {
  const { auth, addUser, root } = authFixture(t);
  addUser('u1');
  auth.saveStorage('u1', { ...S3, region: 'ap-southeast-2' });
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

function routeFixture(storage) {
  const sent = [], saved = [], requests = [];
  const routes = createStorageRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readJson: async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
    authService: { getStorage: () => storage, saveStorage: (_id, body) => { saved.push(body); return body; } },
    storageClient: { isBrowsable: () => true },
    endpointApproved: () => true,
    fetch: async (url, init) => { requests.push({ url, init }); return { ok: true, status: 200, json: async () => ({}) }; },
    crypto: { randomUUID: () => 'x' },
  });
  const call = (method, p, body) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = method;
    return routes(req, {}, { path: p, authn: { user: { id: 'u1', role: 'member' } } });
  };
  return { call, sent, saved, requests };
}

test('the S3 probe signs with the region and an invalid region is refused on save', async () => {
  const f = routeFixture({ ...S3, region: 'eu-west-2' });
  await f.call('POST', '/api/integrations/storage/test', { ...S3, region: 'eu-north-1' });
  await f.call('POST', '/api/integrations/storage/test', { useSaved: true, kind: 's3' });
  assert.deepEqual(f.requests.map((r) => scopeRegion(r.init.headers)), ['eu-north-1', 'eu-west-2']);
  await f.call('PUT', '/api/integrations/storage', { ...S3, region: 'eu west/1' });
  assert.equal(f.sent.pop().status, 400);
  assert.equal(f.saved.length, 0);
  await f.call('PUT', '/api/integrations/storage', { ...S3, region: 'eu-west-1' });
  assert.equal(f.saved[0].region, 'eu-west-1');
});

test('storage secrets are bound to the account and never stored verbatim', (t) => {
  const { auth, secrets, addUser } = authFixture(t);
  addUser('victim'); addUser('attacker');
  auth.saveStorage('victim', { ...S3 });
  const victimCipher = auth.db.prepare('SELECT secret FROM storage_connections WHERE user_id=?').get('victim').secret;
  assert.match(victimCipher, /^enc:v2:/);
  // Replaying the victim's ciphertext as a "secret" stores it as plaintext, not as a ciphertext.
  auth.saveStorage('attacker', { ...S3, secret: victimCipher });
  assert.equal(auth.getStorage('attacker', true).secret, victimCipher);
  // Even a row forged to hold the victim's ciphertext does not decrypt for another account.
  auth.db.prepare('UPDATE storage_connections SET secret=? WHERE user_id=?').run(victimCipher, 'attacker');
  assert.equal(auth.getStorage('attacker', true).secret, '');
  assert.equal(auth.getStorage('attacker').secretConfigured, false);
  // A legacy v1 row still decrypts and is upgraded to v2 on read.
  auth.db.prepare('UPDATE storage_connections SET secret=? WHERE user_id=?').run(secrets.encrypt('legacy-secret'), 'victim');
  assert.equal(auth.getStorage('victim', true).secret, 'legacy-secret');
  assert.match(auth.db.prepare('SELECT secret FROM storage_connections WHERE user_id=?').get('victim').secret, /^enc:v2:/);
  assert.equal(auth.getStorage('victim', true).secret, 'legacy-secret');
});

test('getStorage warns with the user id, never the secret, when decryption fails', (t) => {
  const { auth, addUser } = authFixture(t);
  addUser('u1');
  auth.saveStorage('u1', { ...S3 });
  auth.db.prepare("UPDATE storage_connections SET secret='enc:v2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE user_id='u1'").run();
  const warned = [];
  t.mock.method(console, 'warn', (...a) => warned.push(a.join(' ')));
  assert.equal(auth.getStorage('u1', true).secret, '');
  assert.equal(warned.length, 1);
  assert.match(warned[0], /u1/);
  assert.doesNotMatch(warned[0], /synthetic-secret|enc:v2/);
});

test('encrypt callers re-save plaintext, so repeated saves never double-encrypt', (t) => {
  const { root, secrets, auth, addUser } = authFixture(t);
  const { createWorkspaceStore } = require('./workspace.cjs');
  const WS_USER = '0b6c2d7e-1f4a-4c3b-9e8d-7a6b5c4d3e2f';
  const def = { id: 'default', label: 'Default', baseUrl: 'http://localhost', apiKey: '', shared: true };
  const ws = createWorkspaceStore(root, def, secrets).get(WS_USER);
  ws.providers.push({ id: 'p1', label: 'P', baseUrl: 'https://llm.example.test', apiKey: 'synthetic-key' });
  ws.saveProviders(); ws.saveProviders();
  const reloaded = createWorkspaceStore(root, def, secrets).get(WS_USER);
  assert.equal(reloaded.providers.find((p) => p.id === 'p1').apiKey, 'synthetic-key');
  reloaded.saveProviders();
  assert.equal(createWorkspaceStore(root, def, secrets).get(WS_USER).providers.find((p) => p.id === 'p1').apiKey, 'synthetic-key');
  addUser('u2');
  auth.saveStorage('u2', { ...S3 });
  auth.getStorage('u2', true);
  auth.saveStorage('u2', { ...auth.getStorage('u2', true), bucket: 'renamed' });
  assert.equal(auth.getStorage('u2', true).secret, 'synthetic-secret');
});
