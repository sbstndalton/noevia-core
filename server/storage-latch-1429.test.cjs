'use strict';
// #1429: the latch that holds automatic storage calls after a refused or throttled login (storage-latch.cjs),
// and the Diary backup worker honouring it (diary-backup-worker.cjs `suspended`). Synthetic accounts only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStorageLatch } = require('./storage-latch.cjs');
const { startDiaryBackupWorker } = require('./diary-backup-worker.cjs');

const CONN = { kind: 'nextcloud', baseUrl: 'https://cloud.example/remote.php/dav/files/ada', username: 'ada', secret: 'synthetic-app-pw' };

test('a refused login holds the account until its credentials change; other accounts are not held', () => {
  const latch = createStorageLatch({ now: () => 0 });
  latch.note('u1', CONN, { kind: 'login' });
  assert.deepEqual(latch.blocked('u1', CONN), { kind: 'login' });
  assert.equal(latch.blocked('u2', CONN), null, 'another account is not held by u1 (tenant isolation)');
  assert.equal(latch.blocked('u1', { ...CONN, secret: 'a-new-synthetic-app-pw' }), null, 'a changed app password clears it');
  assert.equal(latch.blocked('u1', CONN), null, 'and the old latch is gone for good');
});

test('a throttle holds the account for its Retry-After, then lets it through (default 60 s when none is given)', () => {
  let now = 0;
  const latch = createStorageLatch({ now: () => now });
  latch.note('u1', CONN, { kind: 'throttled', retryAfter: 30 });
  now = 29_000;
  assert.deepEqual(latch.blocked('u1', CONN), { kind: 'throttled', retryAfter: 1 });
  now = 30_000;
  assert.equal(latch.blocked('u1', CONN), null);
  latch.note('u1', CONN, { kind: 'throttled' });
  now = 30_000 + 59_000;
  assert.notEqual(latch.blocked('u1', CONN), null);
  now = 30_000 + 60_000;
  assert.equal(latch.blocked('u1', CONN), null);
});

test('a working call clears the latch, and a timeout or unreachable server never latches', () => {
  const latch = createStorageLatch({ now: () => 0 });
  latch.note('u1', CONN, { kind: 'timeout' });
  latch.note('u1', CONN, { kind: 'unreachable' });
  latch.note('u1', CONN, { kind: 'forbidden' });
  assert.equal(latch.blocked('u1', CONN), null, 'only a refused login or a throttle holds');
  latch.note('u1', CONN, { kind: 'login' });
  latch.clear('u1');
  assert.equal(latch.blocked('u1', CONN), null);
});

test('the Diary backup worker makes no call for a suspended account and leaves its backoff alone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = [];
  let suspended = true;
  const stop = startDiaryBackupWorker({
    users: () => [{ id: 'u1' }],
    enabled: () => true,
    suspended: () => suspended,
    interval: 3000,
    run: async () => { calls.push(1); return { backup: 'complete' }; },
  });
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };
  await t.mock.timers.tick(3000); await flush();
  await t.mock.timers.tick(3000); await flush();
  assert.equal(calls.length, 0, 'no automatic backup while the login is held');
  suspended = false;
  await t.mock.timers.tick(3000); await flush();
  assert.equal(calls.length, 1, 'the first call after the hold runs on the next tick, not after a doubled backoff');
  stop();
});

test('the Diary backup reply latches a refused login or a throttle; a success clears it; other failures do not latch', () => {
  let now = 0;
  const latch = createStorageLatch({ now: () => now });
  const readOk = () => CONN;
  latch.noteDiaryReply('u1', readOk, { code: 'storageLoginRejected', detail: 'refused' }, false);
  assert.equal(latch.suspendedFor('u1', readOk), true);
  latch.noteDiaryReply('u1', readOk, { code: 'storageLoginRejected' }, false);
  assert.equal(latch.suspendedFor('u1', () => ({ ...CONN, secret: 'changed-synthetic' })), false, 'a changed password resumes the backup');
  latch.noteDiaryReply('u1', readOk, { code: 'storageThrottled', retryAfter: 45 }, false);
  assert.deepEqual(latch.blocked('u1', CONN), { kind: 'throttled', retryAfter: 45 });
  now = 46_000;
  assert.equal(latch.suspendedFor('u1', readOk), false, 'the throttle has run its course');
  latch.noteDiaryReply('u1', readOk, { code: 'storageLoginRejected' }, false);
  latch.noteDiaryReply('u1', readOk, { mode: 'ok', backup: 'complete' }, true);
  assert.equal(latch.suspendedFor('u1', readOk), false, 'a successful backup clears the latch');
  latch.noteDiaryReply('u1', readOk, { detail: 'Diary is busy' }, false);
  assert.equal(latch.suspendedFor('u1', readOk), false, 'an unrelated failure does not latch');
  assert.equal(latch.suspendedFor('u2', () => { throw new Error('no storage'); }), false, 'an account with no readable storage is not held');
});

test('#1589: a refused login holds automatic calls for a backoff, then lets one probe through and holds the rest', () => {
  let now = 0;
  const latch = createStorageLatch({ now: () => now });
  latch.note('u1', CONN, { kind: 'login' });
  now = 14 * 60_000;
  assert.deepEqual(latch.blocked('u1', CONN), { kind: 'login' }, 'still held inside the backoff');
  now = 15 * 60_000;
  assert.equal(latch.blocked('u1', CONN), null, 'the backoff has passed: this one call is the probe');
  assert.deepEqual(latch.blocked('u1', CONN), { kind: 'login' }, 'others are held while the probe runs');
  now = 15 * 60_000 + 61_000;
  assert.equal(latch.blocked('u1', CONN), null, 'a probe that recorded nothing is not held forever');
});

test('#1589: a probe that works clears the hold; one that is refused again waits twice as long, up to a cap', () => {
  let now = 0;
  const latch = createStorageLatch({ now: () => now });
  latch.note('u1', CONN, { kind: 'login' });
  now = 15 * 60_000; assert.equal(latch.blocked('u1', CONN), null);
  latch.clear('u1');
  assert.equal(latch.blocked('u1', CONN), null);
  latch.note('u1', CONN, { kind: 'login' });
  for (const expected of [30, 60, 120, 240, 360, 360]) {
    now += 15 * 60_000 * 64; // well past any backoff
    assert.equal(latch.blocked('u1', CONN), null, 'probe');
    latch.note('u1', CONN, { kind: 'login' });
    assert.equal(latch.status('u1', CONN).nextAttemptAt - now, expected * 60_000, `${expected} min`);
  }
  // An explicit press that is refused renews the wait without making it longer.
  const before = latch.status('u1', CONN).nextAttemptAt - now;
  latch.note('u1', CONN, { kind: 'login' });
  assert.equal(latch.status('u1', CONN).nextAttemptAt - now, before);
});

test('#1589: the Diary backup worker resumes on its own after one transient refusal', async () => {
  let now = 0;
  const latch = createStorageLatch({ now: () => now });
  const read = () => CONN;
  latch.noteDiaryReply('u1', read, { code: 'storageLoginRejected' }, false);
  assert.equal(latch.suspendedFor('u1', read), true);
  now = 15 * 60_000;
  assert.equal(latch.suspendedFor('u1', read), false, 'the backup is allowed one probing run');
  latch.noteDiaryReply('u1', read, { mode: 'ok', backup: 'complete' }, true);
  assert.equal(latch.suspendedFor('u1', read), false);
  assert.equal(latch.status('u1', CONN), null, 'and the success cleared the hold');
});

test('#1589: status reports the kind and the next attempt, and never changes the hold', () => {
  let now = 5;
  const latch = createStorageLatch({ now: () => now });
  assert.equal(latch.status('u1', CONN), null);
  latch.note('u1', CONN, { kind: 'throttled', retryAfter: 30 });
  assert.deepEqual(latch.status('u1', CONN), { kind: 'throttled', nextAttemptAt: 5 + 30_000 });
  latch.clear('u1');
  latch.note('u1', CONN, { kind: 'login' });
  now = 10 * 60 * 60_000;
  assert.equal(latch.status('u1', CONN).kind, 'login');
  assert.deepEqual(latch.blocked('u1', CONN), null, 'blocked() is what lets the probe through');
  assert.equal(latch.status('u1', { ...CONN, secret: 'changed-pw' }), null);
});
