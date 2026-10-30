'use strict';
// #1428 / #1429: how a project's storage failures are classified and answered, and the automatic
// source refresh that must stop feeding a refused or throttled login. Storage is the real storage
// client over a faked fetch (no network); the project routes are the real sync handler over
// synthetic projects. Nothing here contacts a real Nextcloud.
const test = require('node:test');
const assert = require('node:assert/strict');
const storageClient = require('./storage-client.cjs');
const { createStorageLatch } = require('./storage-latch.cjs');

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
