'use strict';
// #2191 round 8: the storage latch is a file both processes use (UI_DATA_DIR/storage-latch.db), not Node's
// memory: the Rust front's project source sync (noevia-rs crates/server-projects storage_latch.rs) and this
// process's Diary backup worker share one hold per account. Two handles over one file stand for the two
// processes; the rows are the ones the front writes (same table, same columns). Synthetic accounts only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createStorageLatch, fingerprintOf } = require('./storage-latch.cjs');

const CONN = { kind: 'nextcloud', baseUrl: 'https://cloud.example/remote.php/dav/files/ada', username: 'ada', secret: 'synthetic-app-pw' };
const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'latch-')), 'storage-latch.db');
const openRaw = (f) => { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(f); };

test('a hold one handle sets holds the other; a changed password clears it for both', () => {
  const f = file();
  let now = 0;
  const diary = createStorageLatch({ now: () => now, file: f }), sync = createStorageLatch({ now: () => now, file: f });
  diary.note('u1', CONN, { kind: 'login' });
  assert.deepEqual(sync.blocked('u1', CONN), { kind: 'login' }, 'the refused login of the Diary backup holds the project refresh');
  sync.note('u2', CONN, { kind: 'throttled', retryAfter: 30 });
  now = 10_000;
  assert.deepEqual(diary.blocked('u2', CONN), { kind: 'throttled', retryAfter: 20 });
  assert.equal(diary.blocked('u1', { ...CONN, secret: 'new-synthetic-pw' }), null);
  assert.equal(sync.blocked('u1', CONN), null, 'dropped for good');
  sync.clear('u2');
  assert.equal(diary.blocked('u2', CONN), null);
});

test('a probe is let through once across both handles, and the strikes go on climbing', () => {
  const f = file();
  let now = 0;
  const a = createStorageLatch({ now: () => now, file: f }), b = createStorageLatch({ now: () => now, file: f });
  a.note('u1', CONN, { kind: 'login' });
  now = 15 * 60_000;
  assert.equal(a.blocked('u1', CONN), null, 'the first caller is the probe');
  assert.deepEqual(b.blocked('u1', CONN), { kind: 'login' }, 'the other is held for a minute');
  b.note('u1', CONN, { kind: 'login' });
  now += 29 * 60_000;
  assert.notEqual(a.blocked('u1', CONN), null, 'a refused probe doubled the wait to 30 minutes');
});

test('the row is the front\'s: the same table and columns, in either direction', () => {
  const f = file();
  const node = createStorageLatch({ now: () => 5000, file: f });
  node.note('u1', CONN, { kind: 'login' });
  const raw = openRaw(f);
  const row = raw.prepare('SELECT * FROM latch WHERE user_id = ?').get('u1');
  assert.deepEqual({ ...row }, {
    user_id: 'u1', fingerprint: fingerprintOf(CONN), kind: 'login', until: 5000 + 15 * 60_000, strikes: 1, probing: 0, since: 5000, login_strikes: null, login_until: null,
  });
  // A row as the front writes a throttle over a refused login, read by this side.
  raw.prepare('INSERT OR REPLACE INTO latch VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('u2', fingerprintOf(CONN), 'throttled', 70_000, 0, 0, 1000, 2, 0);
  let now = 20_000;
  const reader = createStorageLatch({ now: () => now, file: f });
  assert.deepEqual(reader.blocked('u2', CONN), { kind: 'throttled', retryAfter: 50 });
  now = 70_000;
  assert.equal(reader.blocked('u2', CONN), null, 'the throttle ended, the login was due: this call is the probe');
  const after = raw.prepare('SELECT kind, strikes, probing FROM latch WHERE user_id = ?').get('u2');
  assert.deepEqual({ ...after }, { kind: 'login', strikes: 2, probing: 1 });
  raw.close();
});

test('another process changing the file is seen at once, and a proof the front wrote ends a hold set before it', () => {
  const f = file();
  const latch = createStorageLatch({ now: () => 100, file: f, proofOf: (id) => (id === 'u1' ? 100 : null) });
  latch.note('u1', CONN, { kind: 'login' });
  assert.equal(latch.blocked('u1', CONN), null, 'a proof at or after the hold ends it');
  const child = spawnSync(process.execPath, ['-e', `
    const { createStorageLatch } = require(${JSON.stringify(path.join(__dirname, 'storage-latch.cjs'))});
    createStorageLatch({ now: () => 7, file: ${JSON.stringify(f)} }).note('u3', ${JSON.stringify(CONN)}, { kind: 'login' });`], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const other = createStorageLatch({ now: () => 8, file: f });
  assert.deepEqual(other.blocked('u3', CONN), { kind: 'login' }, 'a hold set by another process holds here');
});
