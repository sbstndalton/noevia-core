'use strict';
// The cadence and per-user backoff around Diary's /api/storage-backup: a legacy or
// idle reply, or an error, must not keep the worker hammering that user every tick;
// a real (non-idle) reply restores the base interval. See diary-backup-worker.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startDiaryBackupWorker } = require('./diary-backup-worker.cjs');

function fixture({ interval = 3000, replies = [] } = {}) {
  const calls = [];
  const errors = [];
  let i = 0;
  const stop = startDiaryBackupWorker({
    users: () => [{ id: 'u1' }],
    enabled: () => true,
    interval,
    run: async (user) => {
      calls.push(Date.now());
      const step = replies[Math.min(i, replies.length - 1)];
      i += 1;
      if (step?.throw) throw new Error('boom');
      return step?.reply;
    },
    onError: (id) => errors.push(id),
  });
  return { calls, errors, stop };
}

test('a legacy reply delays the next call for that user beyond the base interval', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture({ interval: 3000, replies: [{ reply: { mode: 'legacy' } }, { reply: { mode: 'legacy' } }, { reply: { backup: 'complete' } }] });
  await t.mock.timers.tick(3000); // first tick: legacy
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.equal(f.calls.length, 1);
  await t.mock.timers.tick(3000); // still inside the doubled backoff (6000ms), no call yet
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.equal(f.calls.length, 1, 'a legacy reply is not retried on the base cadence');
  await t.mock.timers.tick(3000); // now past the 6000ms backoff
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.equal(f.calls.length, 2);
  f.stop();
  t.mock.timers.reset();
});

test('an error backs off exponentially and logs at most once per backoff window', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture({ interval: 1000, replies: [{ throw: true }, { throw: true }, { throw: true }, { throw: true }] });
  await t.mock.timers.tick(1000); // attempt 1: error, backoff -> 2000
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.equal(f.calls.length, 1);
  assert.equal(f.errors.length, 1, 'the first failure in a backoff window logs once');
  await t.mock.timers.tick(1000); // still inside the 2000ms window
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.equal(f.calls.length, 1);
  assert.equal(f.errors.length, 1, 'no duplicate log while still backing off');
  await t.mock.timers.tick(1000); // past 2000ms: attempt 2, backoff -> 4000, logs again
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.equal(f.calls.length, 2);
  assert.equal(f.errors.length, 2);
  f.stop();
  t.mock.timers.reset();
});

test('a successful non-idle reply restores the base interval', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture({ interval: 1000, replies: [{ reply: { mode: 'legacy' } }, { reply: { backup: 'complete', mode: 'managed' } }, { reply: { backup: 'complete', mode: 'managed' } }] });
  await t.mock.timers.tick(1000); // legacy: backoff -> 2000
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.equal(f.calls.length, 1);
  await t.mock.timers.tick(2000); // past the 2000ms backoff: real reply, resets to base 1000
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.equal(f.calls.length, 2);
  await t.mock.timers.tick(1000); // base interval restored: called again after just 1000ms
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.equal(f.calls.length, 3);
  f.stop();
  t.mock.timers.reset();
});

test('a not_configured status reply is treated as idle the same as legacy', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture({ interval: 1000, replies: [{ reply: { mode: 'managed', backup: 'not_configured' } }] });
  await t.mock.timers.tick(1000);
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.equal(f.calls.length, 1);
  await t.mock.timers.tick(1000); // still inside the doubled backoff (2000ms)
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  assert.equal(f.calls.length, 1);
  f.stop();
  t.mock.timers.reset();
});
