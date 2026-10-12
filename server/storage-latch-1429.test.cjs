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
  latch.noteDiaryReply('u1', readOk, { mode: 'managed', backup: 'complete', storageContacted: true }, true);
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
  latch.noteDiaryReply('u1', read, { mode: 'managed', backup: 'complete', storageContacted: true }, true);
  assert.equal(latch.suspendedFor('u1', read), false);
  assert.equal(latch.status('u1', CONN), null, 'and the success cleared the hold');
});

test('#1609: an OK backup reply that never reached the storage server keeps the hold; one that did clears it', () => {
  const read = () => CONN;
  // What the Diary answers 200 without contacting storage: no destination (managed.status), an account kept in the
  // app (legacy mode, nothing to back up), not due / already complete / busy, and a run whose verification failed.
  const earlyReturns = [
    { mode: 'managed', backup: 'not_configured', lastBackedUp: null, retryAt: null, error: null },
    { mode: 'legacy' },
    { mode: 'managed', backup: 'complete', lastBackedUp: 1, retryAt: null, error: null },
    { mode: 'managed', backup: 'pending', lastBackedUp: null, retryAt: null, error: null },
    { mode: 'managed', backup: 'failed', lastBackedUp: null, retryAt: 5, error: 'Backup could not be verified.' },
    { mode: 'managed', backup: 'complete', storageContacted: 'yes' },
    {}, null, 'ok',
  ];
  for (const reply of earlyReturns) {
    const latch = createStorageLatch({ now: () => 0 });
    latch.noteDiaryReply('u1', read, { code: 'storageLoginRejected' }, false);
    latch.noteDiaryReply('u1', read, reply, true);
    assert.deepEqual(latch.blocked('u1', CONN), { kind: 'login' }, `the hold stays for ${JSON.stringify(reply)}`);
  }
  const latch = createStorageLatch({ now: () => 0 });
  latch.noteDiaryReply('u1', read, { code: 'storageLoginRejected' }, false);
  latch.noteDiaryReply('u1', read, { mode: 'managed', backup: 'complete', storageContacted: true }, false);
  assert.deepEqual(latch.blocked('u1', CONN), { kind: 'login' }, 'a reply that was not OK never clears');
  latch.noteDiaryReply('u1', read, { mode: 'managed', backup: 'complete', storageContacted: true }, true);
  assert.equal(latch.status('u1', CONN), null, 'a backup that reached the storage server clears the hold');
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

// #1607: a 429 on the probe of a still-refused login must not forget the login's strikes.
test('#1607: login, probe, throttled, throttle ends, login again: the wait is 30 min, not 15', () => {
  let now = 0;
  const latch = createStorageLatch({ now: () => now });
  latch.note('u1', CONN, { kind: 'login' });
  now = 15 * 60_000;
  assert.equal(latch.blocked('u1', CONN), null, 'the probe');
  latch.note('u1', CONN, { kind: 'throttled', retryAfter: 120 });
  assert.deepEqual(latch.blocked('u1', CONN), { kind: 'throttled', retryAfter: 120 }, 'held for the Retry-After');
  now += 120_000;
  assert.equal(latch.blocked('u1', CONN), null, 'the throttle has ended and the login is due: this call is the next probe, not a free pass');
  assert.deepEqual(latch.blocked('u1', CONN), { kind: 'login' }, 'and the other callers are held again');
  latch.note('u1', CONN, { kind: 'login' });
  assert.equal(latch.status('u1', CONN).nextAttemptAt - now, 30 * 60_000, 'the refused probe doubled the wait');
});

test('#1607: repeated throttled probes keep climbing to the 6 h cap; a throttle alone still just ends', () => {
  let now = 0;
  const latch = createStorageLatch({ now: () => now });
  latch.note('u1', CONN, { kind: 'login' });
  for (const expected of [30, 60, 120, 240, 360, 360]) {
    now += 7 * 60 * 60_000;
    assert.equal(latch.blocked('u1', CONN), null, 'probe');
    latch.note('u1', CONN, { kind: 'throttled', retryAfter: 60 });
    now += 61_000;
    assert.equal(latch.blocked('u1', CONN), null, 'probe after the throttle');
    latch.note('u1', CONN, { kind: 'login' });
    assert.equal(latch.status('u1', CONN).nextAttemptAt - now, expected * 60_000, `${expected} min`);
  }
  latch.clear('u1');
  latch.note('u1', CONN, { kind: 'throttled', retryAfter: 30 });
  now += 31_000;
  assert.equal(latch.status('u1', CONN), null, 'a throttle with no refused login behind it is simply dropped when it ends');
});

test('#1607: a throttle on an explicit press leaves the rest of the login hold; a 401 right after the throttle is the refused probe', () => {
  let now = 0;
  const latch = createStorageLatch({ now: () => now });
  latch.note('u1', CONN, { kind: 'login' }); // held until 15 min
  now = 5 * 60_000;
  latch.note('u1', CONN, { kind: 'throttled', retryAfter: 60 }); // an explicit press drew a 429
  now = 5 * 60_000 + 61_000;
  assert.deepEqual(latch.blocked('u1', CONN), { kind: 'login' }, 'the 15 min hold was not shortened by the throttle ending');
  now = 15 * 60_000;
  assert.equal(latch.blocked('u1', CONN), null, 'the probe');
  latch.note('u1', CONN, { kind: 'throttled', retryAfter: 10 });
  now += 11_000;
  latch.note('u1', CONN, { kind: 'login' }); // refused again with no blocked() call in between
  assert.equal(latch.status('u1', CONN).nextAttemptAt - now, 30 * 60_000);
});

test('#1607: the strikes belong to the credentials: a throttle never carries them to a changed password', () => {
  let now = 0;
  const latch = createStorageLatch({ now: () => now });
  const NEW = { ...CONN, secret: 'a-new-synthetic-app-pw' };
  latch.note('u1', CONN, { kind: 'login' });
  now = 15 * 60_000; latch.blocked('u1', CONN);
  latch.note('u1', CONN, { kind: 'throttled', retryAfter: 30 });
  assert.equal(latch.blocked('u1', NEW), null, 'new credentials are not held');
  latch.note('u1', NEW, { kind: 'login' });
  assert.equal(latch.status('u1', NEW).nextAttemptAt - now, 15 * 60_000, 'a fresh login starts at the base wait');
  assert.equal(latch.blocked('u2', CONN), null, 'another account has nothing');
});
