'use strict';
// #770: a WebDAV/Nextcloud connection's login is checked before it is saved. A rejected login
// (401) keeps the old row; a 403 or an unreachable server saves with a warning; the secret never
// appears in a response, an error or a log line. Synthetic fixtures only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Readable } = require('node:stream');
const ts = require('typescript');
const { createStorageRoutes } = require('./routes/storage.cjs');
const storageClient = require('./storage-client.cjs');

const SECRET = 'synthetic-app-password-7f3a';
const OLD = { kind: 'webdav', baseUrl: 'https://dav.example.test/remote.php/dav/files/alice', username: 'alice', secret: 'old-synthetic-secret', corpusRoot: 'Diary' };
const NEW = { kind: 'nextcloud', baseUrl: 'https://dav.example.test/remote.php/dav/files/bob', username: 'bob', secret: SECRET, corpusRoot: 'Notes' };

function fixture(t, respond) {
  const { createAuth } = require('./auth.cjs'); // loaded here so the browser-side cases need no SQLite
  const { createSecretStore } = require('./secrets.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-770-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const auth = createAuth({ dataDir: root, publicOrigin: 'https://noevia.example.test', secrets: createSecretStore(root) });
  auth.db.prepare(`INSERT INTO users(id,username,username_norm,display_name,role,password_hash,webauthn_user_id,created_at,updated_at)
    VALUES('u1','u1','u1','u1','member','x','w-u1',0,0)`).run();
  auth.saveStorage('u1', OLD);
  const sent = [], requests = [], logs = [];
  for (const level of ['log', 'warn', 'error', 'info']) {
    const real = console[level];
    console[level] = (...a) => { logs.push(a.map(String).join(' ')); };
    t.after(() => { console[level] = real; });
  }
  const routes = createStorageRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readJson: async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
    authService: auth, storageClient, endpointApproved: () => true,
    fetch: async (url, init) => { requests.push({ url, init }); return respond(url, init); },
    crypto: { randomUUID: () => 'x' },
  });
  const put = async (body) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'PUT';
    await routes(req, {}, { path: '/api/integrations/storage', authn: { user: { id: 'u1', role: 'member' } } });
    return sent.at(-1);
  };
  const row = () => auth.db.prepare('SELECT kind,base_url,username,secret,corpus_root,updated_at FROM storage_connections WHERE user_id=?').get('u1');
  return { auth, put, row, requests, logs };
}

function noSecret(f, reply) {
  assert.ok(!JSON.stringify(reply).includes(SECRET), 'secret in response');
  assert.ok(!f.logs.join('\n').includes(SECRET), 'secret in a log line');
}

test('a 401 rejects the save, leaves the old row untouched and names the login', async (t) => {
  const f = fixture(t, () => new Response('', { status: 401 }));
  const before = f.row();
  const reply = await f.put(NEW);
  assert.equal(reply.status, 400);
  assert.equal(reply.body.code, 'storageLoginRejected');
  assert.match(reply.body.error, /The server rejected this username or app password/);
  assert.deepEqual(f.row(), before);
  assert.equal(f.auth.getStorage('u1', true).secret, OLD.secret);
  // One Depth-0 PROPFIND against the user's root, with the new credentials.
  assert.equal(f.requests.length, 1);
  const { url, init } = f.requests[0];
  assert.equal(url, `${NEW.baseUrl}/`);
  assert.equal(init.method, 'PROPFIND');
  assert.equal(init.headers.Depth, '0');
  assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, `Basic ${Buffer.from(`bob:${SECRET}`).toString('base64')}`);
  noSecret(f, reply);
});

test('a 403 saves with a warning: some layouts refuse an unreadable root to a valid login', async (t) => {
  const f = fixture(t, () => new Response('', { status: 403 }));
  const reply = await f.put({ ...NEW, kind: 'webdav' });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.warningCode, 'storageUnverified');
  assert.equal(reply.body.status, 403);
  assert.equal(f.row().username, 'bob');
  assert.equal(f.auth.getStorage('u1', true).secret, SECRET);
  noSecret(f, reply);
});

test('an accepted login saves the new connection without a warning', async (t) => {
  const f = fixture(t, () => new Response('<d:multistatus xmlns:d="DAV:"/>', { status: 207 }));
  const reply = await f.put(NEW);
  assert.equal(reply.status, 200);
  assert.equal(reply.body.warning, undefined);
  assert.equal(reply.body.username, 'bob');
  assert.equal(f.auth.getStorage('u1', true).secret, SECRET);
  assert.equal(f.row().base_url, NEW.baseUrl);
  noSecret(f, reply);
});

test('a network error or timeout saves with a warning', async (t) => {
  for (const fail of [() => { throw new TypeError('fetch failed'); }, () => { throw Object.assign(new Error('timed out ' + SECRET), { name: 'TimeoutError' }); }]) {
    const f = fixture(t, fail);
    const reply = await f.put(NEW);
    assert.equal(reply.status, 200);
    assert.equal(reply.body.warningCode, 'storageUnverified');
    assert.match(reply.body.warning, /could not be reached/);
    assert.equal(f.row().username, 'bob');
    noSecret(f, reply);
  }
});

test('#773: a server that answers with a non-401 status was reached, so the warning names the status', async (t) => {
  for (const status of [403, 500]) {
    const f = fixture(t, () => new Response('', { status }));
    const reply = await f.put(NEW);
    assert.equal(reply.status, 200);
    assert.equal(reply.body.warningCode, 'storageUnverified');
    assert.equal(reply.body.status, status);
    assert.doesNotMatch(reply.body.warning, /could not be reached/);
    assert.match(reply.body.warning, new RegExp(`login could not be checked \\(the storage server answered ${status}\\)`));
    assert.equal(f.row().username, 'bob');
    noSecret(f, reply);
  }
});

test('S3 and server storage are not tested with WebDAV credentials', async (t) => {
  const f = fixture(t, () => new Response('', { status: 401 }));
  assert.equal((await f.put({ kind: 's3', baseUrl: 'https://s3.example.test', bucket: 'b', username: 'AKID', secret: SECRET, corpusRoot: '' })).status, 200);
  assert.equal((await f.put({ kind: 'local' })).status, 200);
  assert.equal(f.requests.length, 0);
});

test('checkLogin never throws and classifies statuses', async () => {
  const conn = { baseUrl: 'https://dav.example.test/x', username: 'u', secret: SECRET };
  const at = (status) => storageClient.checkLogin(conn, { fetchImpl: async () => new Response('', { status }) });
  assert.deepEqual(await at(207), { ok: true });
  assert.deepEqual(await at(401), { ok: false, rejected: true, status: 401 });
  assert.deepEqual(await at(403), { ok: false, unverified: 'status', status: 403 });
  assert.deepEqual(await at(500), { ok: false, unverified: 'status', status: 500 });
  const failed = await storageClient.checkLogin(conn, { fetchImpl: async () => { throw new Error(SECRET); } });
  assert.deepEqual(failed, { ok: false, unverified: 'network' });
  assert.equal(storageClient.isLoginRejected, undefined);
});

// The refresh side: the browser turns "storage returned 401" into a message that says the login
// was rejected and where to fix it, in the toast and in the source-state text.
function sourceStatus() {
  const exportsObject = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/source-status.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText, { exports: exportsObject });
  return exportsObject;
}

test('a refresh 401/403 says the storage login was rejected and keeps the retained note', () => {
  const s = sourceStatus();
  const entries = s.sourceRefreshEntries([{ folder: 'Finance', reason: 'storage returned 401', retained: true }, { folder: 'Other', reason: 'storage returned 404' }]);
  assert.equal(entries[0], 'Finance: Storage login rejected. Check your storage credentials in Settings → Diary & storage. Previous readable text retained.');
  assert.equal(entries[1], 'Other: storage returned 404');
  const t = (key) => `[${key}]`;
  assert.equal(s.sourceRefreshIssues([{ folder: 'F', reason: 'storage returned 403' }], t), 'F: [storage.refreshLoginRejected]');
  const toast = s.resolveSkippedToast({ signature: '', message: '' }, [{ folder: 'F', reason: 'storage returned 401', retained: true }], null, t);
  assert.ok(s.mentionsStorageLogin(toast.show, t));
  assert.ok(!s.mentionsStorageLogin('F: storage returned 404', t));
  assert.equal(s.sourceRefreshFailure(new Error('storage returned 401'), t), 'Sources could not be refreshed — [storage.refreshLoginRejected]');
  assert.equal(s.sourceRefreshFailure(new Error('storage returned 500')), 'Sources could not be refreshed — storage returned 500.');
  assert.match(s.sourceStatus({ document: { state: 'failed', stale: true, error: 'storage returned 401' } }), /Storage login rejected/);
});
