'use strict';
// sbstndalton/noevia#2191 round 7 (review of rounds 4+5, #697): the large-document lock is held across
// processes, through UI_DATA_DIR/large-document.lock, which the Rust front takes too. Before, it was
// process-local, so a second process (the front) could hold a large document at the same time.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const LARGE = 25 * 1024 * 1024 + 1;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-large-lock-'));
process.env.UI_DATA_DIR = dir;
process.env.LARGE_DOCUMENT_ACQUIRE_WAIT_MS = '400';
const lock = require('./large-document-lock.cjs');
const fileLock = require('./large-document-file-lock.cjs');

// A second process holding the lock through the same module until its stdin closes.
function holder() {
  const child = spawn(process.execPath, ['-e', `
    process.env.UI_DATA_DIR = ${JSON.stringify(dir)};
    const lock = require(${JSON.stringify(path.join(__dirname, 'large-document-lock.cjs'))});
    lock.ifLarge(${LARGE}, () => new Promise((resolve) => {
      process.stdout.write('held\\n');
      process.stdin.on('end', resolve); process.stdin.resume();
    })).then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
  `], { stdio: ['pipe', 'pipe', 'inherit'] });
  const held = new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('held')) resolve(); });
    child.on('exit', (code) => reject(new Error(`holder exited ${code}`)));
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  return { child, held, exited };
}

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('another process holding the lock makes a large document wait, then busy; free once it lets go', async () => {
  const h = holder();
  await h.held;
  assert.ok(fs.existsSync(path.join(dir, fileLock.LOCK_FILE)));
  const started = Date.now();
  await assert.rejects(lock.ifLarge(LARGE, async () => 'ran'), (e) => e.status === 503 && e.code === 'large-document-busy');
  assert.ok(Date.now() - started >= 350, 'waited for the other process');
  // A small document never takes it.
  assert.equal(await lock.ifLarge(1024, async () => 'small'), 'small');
  h.child.stdin.end();
  assert.equal(await h.exited, 0);
  assert.equal(await lock.ifLarge(LARGE, async () => 'ran'), 'ran');
});

test('a holder that dies frees the lock', async () => {
  const h = holder();
  await h.held;
  h.child.kill('SIGKILL');
  await h.exited;
  assert.equal(await lock.ifLarge(LARGE, async () => 'after crash'), 'after crash');
});

test('the in-process turn is passed on when the host lock is busy', async () => {
  const h = holder();
  await h.held;
  await assert.rejects(lock.ifLarge(LARGE, async () => 'x'));
  h.child.stdin.end();
  await h.exited;
  // Not stuck behind the failed acquire.
  assert.equal(await lock.ifLarge(LARGE, async () => 'next'), 'next');
});

test('the lock file path follows UI_DATA_DIR', () => {
  assert.equal(fileLock.lockPath({ UI_DATA_DIR: '/data' }), path.join('/data', 'large-document.lock'));
});
