'use strict';
// #2191 round 2: the stamped re-reader (rust-generation.cjs) for files the Rust front writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createStampedReader } = require('./rust-generation.cjs');

function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-generation-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }

test('a write on the other side is seen on the next use, never through a boot cache', (t) => {
  const file = path.join(tmp(t), 'state.json');
  let loads = 0;
  const reader = createStampedReader({ files: [file], fallback: 'none', load: () => { loads += 1; return fs.readFileSync(file, 'utf8'); } });
  assert.equal(reader.get(), 'none', 'absent file');
  loads = 0;
  fs.writeFileSync(file, 'one');
  assert.equal(reader.changed(), true);
  assert.equal(reader.get(), 'one');
  assert.equal(reader.get(), 'one');
  assert.equal(loads, 1, 'unchanged stamp: no reload');
  fs.writeFileSync(file, 'two!');
  assert.equal(reader.get(), 'two!');
  assert.equal(loads, 2);
});

test('a replaced file (rename) reloads and the old handle is dropped; a deleted file drops it too', (t) => {
  const dir = tmp(t);
  const file = path.join(dir, 'state.db');
  fs.writeFileSync(file, 'a');
  const opened = [], closed = [];
  const reader = createStampedReader({ files: [file, `${file}-wal`], load: () => { const h = { text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null }; opened.push(h); return h; }, onDrop: (h) => closed.push(h) });
  const first = reader.get();
  assert.equal(first.text, 'a');
  fs.writeFileSync(path.join(dir, 'next'), 'a'); // same size and content, a new inode
  fs.renameSync(path.join(dir, 'next'), file);
  const second = reader.get();
  assert.notEqual(second, first);
  assert.deepEqual(closed, [first]);
  fs.writeFileSync(`${file}-wal`, 'w'); // a WAL write alone moves the stamp
  assert.notEqual(reader.get(), second);
  fs.rmSync(file); fs.rmSync(`${file}-wal`);
  const gone = reader.get();
  assert.equal(closed.length, 3, 'every superseded handle closed');
  assert.equal(gone.text, null, 'load decides what an absent file reads as');
});

test('a failing load is not cached', (t) => {
  const file = path.join(tmp(t), 'x');
  fs.writeFileSync(file, 'x');
  let fail = true;
  const reader = createStampedReader({ files: [file], fallback: 0, load: () => { if (fail) throw new Error('busy'); return 1; } });
  assert.equal(reader.get(), 0);
  fail = false;
  assert.equal(reader.get(), 1, 'retried on the next use');
  assert.throws(() => createStampedReader({ files: [], load: () => 0 }), TypeError);
});
