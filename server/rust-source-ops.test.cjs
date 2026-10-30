'use strict';
// #2191 round 8: core as a re-reader of the file operations the Rust front runs (noevia-rs crates/
// server-projects source_ops.rs writes users/<id>/source-file-ops.json). A chat turn sent right after an
// upload was accepted waits for that file (#1441); a sync or a folder import in flight holds back the
// source-text collector (#1815). Synthetic files only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ops = require('./rust-source-ops.cjs');

const workspace = () => ({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'source-ops-')) });
const write = (ws, list) => {
  const file = path.join(ws.dir, ops.FILE);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, ops: list }));
  fs.renameSync(`${file}.tmp`, file); // the front's atomic write: a new inode, which the re-reader's signal sees
};
const op = (over) => ({ id: String(Math.random()), project: 'p1', kind: 'upload', name: 'a.md', state: 'running', at: Date.now(), ...over });

test('a turn waits for a running file operation and names one that failed or is still running (#1441)', async () => {
  const ws = workspace();
  const ok = op({ name: 'dir/a.md' }), bad = op({ name: 'b.md' }), stuck = op({ name: 'c.md', project: 'p2' }), sync = op({ kind: 'sync', name: '' });
  write(ws, [ok, bad, stuck, sync]);
  setTimeout(() => write(ws, [{ ...ok, state: 'ready' }, { ...bad, state: 'failed' }, stuck, sync]), 60);
  const settled = await ops.settle(ws, 'p1', { timeoutMs: 3000, pollMs: 10 });
  assert.deepEqual(settled, { notReady: [{ name: 'b.md', reason: 'failed' }], aborted: false });
  // Nothing of p1 runs now: no wait.
  assert.deepEqual(await ops.settle(ws, 'p1', { pollMs: 10 }), { notReady: [], aborted: false });
  // p2's file does not finish within the wait: not ready, and the next turn does not wait the full bound again.
  const timedOut = await ops.settle(ws, 'p2', { timeoutMs: 40, pollMs: 10 });
  assert.deepEqual(timedOut, { notReady: [{ name: 'c.md', reason: 'timeout' }], aborted: false });
  const started = Date.now();
  assert.deepEqual(await ops.settle(ws, 'p2', { timeoutMs: 5000, pollMs: 10 }), { notReady: [{ name: 'c.md', reason: 'timeout' }], aborted: false });
  assert.ok(Date.now() - started < 1000, 'an operation that outlasted one wait is not waited for in full again');
});

test('an aborted wait, a missing file, an unreadable file and a stale entry wait for nothing', async () => {
  const ws = workspace();
  assert.deepEqual(await ops.settle(ws, 'p1'), { notReady: [], aborted: false });
  fs.writeFileSync(path.join(ws.dir, ops.FILE), '{not json');
  assert.deepEqual(await ops.settle(ws, 'p1'), { notReady: [], aborted: false });
  write(ws, [op({ name: 'old.md', at: Date.now() - ops.STALE_MS - 1000 })]);
  assert.deepEqual(await ops.settle(ws, 'p1'), { notReady: [], aborted: false });
  write(ws, [op({ name: 'gone.md' })]);
  const abort = new AbortController(); abort.abort();
  assert.deepEqual(await ops.settle(ws, 'p1', { signal: abort.signal, timeoutMs: 5000 }), { notReady: [], aborted: true });
});

test('the collector fails closed: a list that cannot be read counts as an operation in flight, a missing one as none (#2191 round 8 review)', () => {
  const ws = workspace();
  assert.equal(ops.inFlight(ws.dir), false, 'no file: nothing runs');
  fs.writeFileSync(path.join(ws.dir, ops.FILE), '{not json');
  assert.equal(ops.inFlight(ws.dir), true, 'a torn list');
  assert.equal(require('./source-text.cjs').sourceWorkInFlight(ws.dir), true);
  write(ws, [op({ kind: 'sync' })]);
  assert.equal(ops.inFlight(ws.dir), true);
  write(ws, []);
  assert.equal(ops.inFlight(ws.dir), false, 'the list reads again: nothing runs');
  const dir = workspace();
  fs.mkdirSync(path.join(dir.dir, ops.FILE));
  assert.equal(ops.inFlight(dir.dir), true, 'a list that is not a file (EISDIR)');
  // A chat still waits for nothing it cannot read.
  return ops.settle(dir, 'p1', { timeoutMs: 50, pollMs: 10 }).then((settled) => assert.deepEqual(settled, { notReady: [], aborted: false }));
});

test('a sync or a folder import in flight is seen; a plain upload or a finished one is not (#1815)', () => {
  const ws = workspace();
  assert.equal(ops.inFlight(ws.dir), false);
  write(ws, [op({ kind: 'upload' }), op({ kind: 'sync', state: 'ready' })]);
  assert.equal(ops.inFlight(ws.dir), false);
  write(ws, [op({ kind: 'import', name: 'x.md' })]);
  assert.equal(ops.inFlight(ws.dir), true);
  assert.equal(require('./source-text.cjs').sourceWorkInFlight(ws.dir), true);
  assert.equal(ops.inFlight(undefined), false);
});
