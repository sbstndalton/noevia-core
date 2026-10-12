'use strict';
// #1428 / #1429: how a project's storage failures are classified and answered, and the automatic
// source refresh that must stop feeding a refused or throttled login. Storage is the real storage
// client over a faked fetch (no network); the project routes are the real sync handler over
// synthetic projects. Nothing here contacts a real Nextcloud.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { AsyncLocalStorage } = require('node:async_hooks');
const storageClient = require('./storage-client.cjs');
const { createStorageLatch } = require('./storage-latch.cjs');
const { createProjectRoutes } = require('./routes/projects.cjs');

const CONN = { kind: 'webdav', baseUrl: 'https://cloud.example.test/remote.php/dav/files/alice', username: 'alice', secret: 'synthetic-app-password', corpusRoot: 'Diary' };

// A fetch that answers every storage request with `reply(url)` and counts them.
function fakeStorage(t, reply) {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => { urls.push(String(url)); return reply(String(url)); });
  return urls;
}
const status = (code, headers = {}) => new Response('', { status: code, headers });

test('#1428: each storage failure is classified, and a 403 is never a refused login', async (t) => {
  const cases = [
    [() => status(401), { kind: 'login' }],
    [() => status(403), { kind: 'forbidden' }],
    [() => status(429, { 'Retry-After': '42' }), { kind: 'throttled', retryAfter: 42 }],
    [() => status(429), { kind: 'throttled' }],
    [() => status(404), null],
    [() => status(500), null],
  ];
  for (const [reply, want] of cases) {
    fakeStorage(t, reply);
    let err;
    try { await storageClient.listFiles(CONN, 'Folder'); } catch (e) { err = e; }
    assert.ok(err, `a ${reply().status} is an error`);
    assert.deepEqual(storageClient.storageFailure(err), want, `status ${reply().status}`);
    t.mock.restoreAll();
  }
});

test('#1428: a timed-out request and an unreachable server are their own failures, not a login', async (t) => {
  fakeStorage(t, () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); });
  const timeout = await storageClient.listFiles(CONN, 'Folder').catch((e) => e);
  assert.deepEqual(storageClient.storageFailure(timeout), { kind: 'timeout' });
  assert.equal(storageClient.refusedLogin(timeout), false);
  t.mock.restoreAll();

  fakeStorage(t, () => { throw new TypeError('fetch failed'); });
  const down = await storageClient.listFiles(CONN, 'Folder').catch((e) => e);
  assert.deepEqual(storageClient.storageFailure(down), { kind: 'unreachable' });
  assert.equal(storageClient.refusedLogin(down), false);
  t.mock.restoreAll();
});

test('#1428: the latch never stores the app password, and a changed password is a different connection', () => {
  const latch = createStorageLatch({ now: () => 0 });
  const a = latch.fingerprintOf(CONN);
  assert.equal(a.includes(CONN.secret), false);
  assert.notEqual(a, latch.fingerprintOf({ ...CONN, secret: 'other' }));
});

// ── The project routes: the source refresh over the real storage client ──

function syncFixture(t, { latch = createStorageLatch(), folders = ['Alpha', 'Beta'] } = {}) {
  const sent = [];
  const project = { id: 'p1', name: 'P', projectFolder: 'noevia projects/P', sourceFolders: folders, files: [], assets: [] };
  const projects = [project];
  const store = {
    getProject: (id) => projects.find((p) => p.id === id) || null, saveProjects() {}, pruneDocuments() {},
    withSourceLock: (_p, op) => op(), indexSource() {}, ownsFile: () => false, loadChats: () => [], saveChats() {}, deleteChat: () => false,
    ensureProjectFolder: async () => null,
  };
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'noevia-1428-'));
  t.after(() => require('node:fs').rmSync(dir, { recursive: true, force: true }));
  const routes = createProjectRoutes({
    json: (res, code, body, headers) => { sent.push({ status: code, body, headers }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    readJson: require('./http.cjs').readJson,
    requestScope: new AsyncLocalStorage(), dispatch: async () => {},
    currentWorkspace: () => ({ dir, userId: 'u1', assertActive() {}, ragDir: () => require('node:path').join(dir, 'rag'), assetDir: () => require('node:path').join(dir, 'assets') }),
    authService: { diaryEnabled: () => true, getStorage: () => CONN },
    storageClient, documents: { isDocument: () => false }, documentSources: {}, rag: { deleteProjectFile() {}, indexProjectFile: async () => ({}) },
    fs: require('node:fs'), path: require('node:path'), reasoningEffort: {}, projectAppearance: () => ({}),
    diaryExtras: { PROJECT_ID: 'diary-extras', chatProjectId: (id) => id, newProject: () => ({}) },
    PROJECTS: projects, DEFAULT_TOOLBOXES: ['core'], sanitizeToolboxes: (b) => b, getProvider: () => ({}), ensureRolesLoaded() {},
    servedCatalogue: async () => null, DEFAULT_PROVIDER_ID: 'default', store, storageLatch: latch,
  });
  const sync = ({ retry = false } = {}) => {
    const path = `/api/projects/${project.id}/sources/sync`;
    const req = Readable.from([Buffer.alloc(0)]);
    Object.assign(req, { method: 'POST', url: path, headers: retry ? { 'x-cowork-storage-retry': '1' } : {}, socket: {} });
    return routes(req, {}, { path, authn: { user: { id: 'u1', role: 'member' } }, url: new URL(`http://localhost${path}`) });
  };
  return { sync, sent, project };
}

test('#1428: a throttled folder says so with its own code and Retry-After, and the other folders are not called', async (t) => {
  const urls = fakeStorage(t, (url) => (url.includes('Alpha') ? status(429, { 'Retry-After': '90' }) : status(207)));
  const f = syncFixture(t);
  await f.sync();
  const body = f.sent.at(-1).body;
  assert.equal(f.sent.at(-1).status, 200, 'a refresh with a skipped folder still answers 200');
  assert.equal(body.skipped[0].code, 'storageThrottled');
  assert.match(body.skipped[0].reason, /limiting logins/);
  assert.equal(body.skipped.length, 2, 'the second folder is skipped too, not called');
  assert.equal(body.skipped[1].code, 'storageThrottled');
  assert.equal(urls.filter((u) => u.includes('Beta')).length, 0, 'no call to the second folder after a throttle (#1429)');
});

test('#1428: a timed-out folder is reported as a timeout, not a rejected login', async (t) => {
  fakeStorage(t, () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); });
  const f = syncFixture(t, { folders: ['Alpha'] });
  await f.sync();
  assert.equal(f.sent.at(-1).body.skipped[0].code, 'storageTimeout');
  assert.doesNotMatch(f.sent.at(-1).body.skipped[0].reason, /login/i);
});

test('#1429: a refused login stops automatic refreshes until the credentials change or the person presses Retry', async (t) => {
  let answer = status(401);
  const urls = fakeStorage(t, () => answer);
  const latch = createStorageLatch();
  const f = syncFixture(t, { latch });

  // The first (automatic) refresh is refused: one call, then the login is latched.
  await f.sync();
  assert.equal(urls.length, 1, 'one call to storage for the refused folder');
  assert.equal(f.sent.at(-1).body.skipped[0].code, 'storageLoginRejected');
  assert.equal(f.sent.at(-1).body.skipped.length, 2, 'the second folder is not tried');

  // Automatic refreshes after that: no storage call at all, and a clear answer.
  for (let i = 0; i < 3; i++) await f.sync();
  assert.equal(urls.length, 1, 'no further automatic calls while the login is refused');
  assert.equal(f.sent.at(-1).status, 502);
  assert.equal(f.sent.at(-1).body.code, 'storageLoginRejected');

  // An explicit Retry press runs; the server still refuses it, and the latch holds again.
  await f.sync({ retry: true });
  assert.equal(urls.length, 2, 'Retry reaches storage');
  await f.sync();
  assert.equal(urls.length, 2, 'and the automatic refreshes stay held');

  // Fixed credentials: the next automatic refresh runs and succeeds, which clears the latch.
  answer = status(207);
  const changed = { ...CONN, secret: 'a-new-synthetic-app-password' };
  assert.equal(latch.blocked('u1', changed), null, 'new credentials are not held by the old latch');
  await f.sync({ retry: true });
  await f.sync();
  assert.ok(urls.length >= 4, 'automatic refreshes run again once a call succeeds');
});

test('#1429: a throttle holds automatic refreshes for its Retry-After and then lets them through', async (t) => {
  let now = 1_000_000;
  const latch = createStorageLatch({ now: () => now });
  const urls = fakeStorage(t, () => status(429, { 'Retry-After': '30' }));
  const f = syncFixture(t, { latch, folders: ['Alpha'] });
  await f.sync();
  assert.equal(urls.length, 1);
  now += 10_000;
  await f.sync();
  assert.equal(urls.length, 1, 'held inside the Retry-After window');
  assert.equal(f.sent.at(-1).body.code, 'storageThrottled');
  now += 25_000;
  await f.sync();
  assert.equal(urls.length, 2, 'after the window the automatic refresh runs');
});
