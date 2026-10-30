'use strict';
// #2190: the re-reader Node uses for the stores the Rust front writes (shared-reread.cjs).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createReread, fileSignal } = require('./shared-reread.cjs');

test('reloads only when the signal changes, and serves the cached value otherwise', () => {
  let signal = 'a', stored = { n: 1 }, reads = 0;
  const r = createReread({ signal: () => signal, load: () => { reads++; return { ...stored }; }, fallback: () => 'fallback' });
  assert.deepEqual(r.current(), { n: 1 });
  assert.equal(r.current(), r.current(), 'the same object while the signal holds');
  assert.equal(reads, 1);
  stored = { n: 2 }; signal = 'b';
  assert.deepEqual(r.current(), { n: 2 }, 'a write elsewhere is seen on the next use, with no restart');
  assert.equal(r.loads, 2);
  r.invalidate();
  r.current();
  assert.equal(r.loads, 3);
});

test('a failed signal or load answers the fallback and is retried; the last good value is never served past it', () => {
  let fail = false, value = 1;
  const r = createReread({ signal: () => { if (fail) throw Error('synthetic store failure'); return String(value); }, load: () => value, fallback: (e) => `fallback:${e.message}` });
  assert.equal(r.current(), 1);
  fail = true;
  assert.equal(r.current(), 'fallback:synthetic store failure');
  fail = false;
  assert.equal(r.current(), 1, 'read again once the store answers, even under the old signal');
  assert.equal(r.loads, 2);
  let bad = true;
  const l = createReread({ signal: () => 'same', load: () => { if (bad) throw Error('synthetic parse failure'); return 'ok'; }, fallback: () => 'fb' });
  assert.equal(l.current(), 'fb');
  bad = false;
  assert.equal(l.current(), 'ok', 'a failed load is not cached under its signal');
  assert.throws(() => createReread({ signal: () => 1 }), TypeError);
});

test('fileSignal changes on an atomic replace and on an in-place write; missing is the empty signal', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-reread-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'synthetic.json');
  assert.equal(fileSignal(file), '');
  fs.writeFileSync(file, '{"v":1}');
  const first = fileSignal(file);
  assert.notEqual(first, '');
  assert.equal(fileSignal(file), first);
  // Same size, written by another process through write-then-rename: a new inode.
  fs.writeFileSync(`${file}.tmp`, '{"v":2}');
  fs.renameSync(`${file}.tmp`, file);
  const second = fileSignal(file);
  assert.notEqual(second, first);
  const reread = createReread({ signal: () => fileSignal(file), load: () => JSON.parse(fs.readFileSync(file, 'utf8')), fallback: () => null });
  assert.deepEqual(reread.current(), { v: 2 });
  fs.writeFileSync(`${file}.tmp`, '{"v":3}');
  fs.renameSync(`${file}.tmp`, file);
  assert.deepEqual(reread.current(), { v: 3 });
  fs.rmSync(file);
  assert.equal(reread.current(), null, 'a missing file is a change too: load fails, fallback answers');
  assert.throws(() => fileSignal(file, { statSync() { throw Object.assign(Error('synthetic'), { code: 'EACCES' }); } }), /synthetic/);
});
