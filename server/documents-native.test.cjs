'use strict';
// The PDF reader's worker and its limits. Synthetic fixtures only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { readInWorker, readNativePages } = require('./documents-native.cjs');
const documents = require('./documents.cjs');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures/documents', name));
const caps = { pageCap: documents.PAGE_CAP, pageTextCap: 200_000, totalTextCap: documents.TOTAL_TEXT_CAP };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-pdf-worker-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
/** A stand-in for the reader that misbehaves the way a hostile PDF would make pdf.js misbehave. */
const script = (name, body) => { const file = path.join(dir, name); fs.writeFileSync(file, body); return file; };

test('the worker reads exactly what the in-process walk reads', async () => {
  for (const name of ['text.pdf', 'mixed-pages.pdf', 'long.pdf']) {
    assert.deepEqual(await readInWorker(fixture(name), caps), await readNativePages(fixture(name), caps), name);
  }
});

test('a reader that never finishes is stopped at the time limit, and the server thread keeps running', async () => {
  const spin = script('spin.cjs', 'for (;;) {}');
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  const started = Date.now();
  await assert.rejects(readInWorker(fixture('text.pdf'), { ...caps, script: spin, timeLimitMs: 400 }), (e) => e.limit === 'time');
  clearInterval(timer);
  assert.ok(Date.now() - started < 3000, 'stopped promptly');
  assert.ok(ticks >= 10, `the main thread kept serving while the reader spun (${ticks} ticks)`);
});

test('a reader that allocates without bound is stopped at its own heap limit', async () => {
  const hog = script('hog.cjs', 'const keep = []; for (;;) keep.push(new Array(1e5).fill(Math.random()));');
  await assert.rejects(readInWorker(fixture('text.pdf'), { ...caps, script: hog, heapLimitMb: 32, timeLimitMs: 30000 }), (e) => e.limit === 'memory');
});

test('a reader that dies or answers nonsense is a failure, not a hang', async () => {
  await assert.rejects(readInWorker(fixture('text.pdf'), { ...caps, script: script('exit.cjs', 'process.exit(3)'), timeLimitMs: 5000 }), /stopped/);
  await assert.rejects(readInWorker(fixture('text.pdf'), { ...caps, script: script('odd.cjs', "require('node:worker_threads').parentPort.postMessage({ ok: false })"), timeLimitMs: 5000 }), /failed/);
});

test('the reader inherits none of the server environment', async () => {
  process.env.NOEVIA_TEST_SECRET = 'must-not-cross';
  try {
    const probe = script('env.cjs', "require('node:worker_threads').parentPort.postMessage({ ok: true, result: { numPages: 0, pageTexts: [], env: process.env.NOEVIA_TEST_SECRET || null } })");
    assert.equal((await readInWorker(fixture('text.pdf'), { ...caps, script: probe })).env, null);
  } finally { delete process.env.NOEVIA_TEST_SECRET; }
});

test('a limit reaches the caller as an unreadable document, with the reason', async () => {
  const limited = (limit) => async () => { throw Object.assign(Error('x'), { limit }); };
  await assert.rejects(documents.extractDocumentText('a.pdf', fixture('text.pdf'), { doclingEnabled: false, readPages: limited('time') }),
    (e) => e.status === 422 && /took too long/.test(e.message));
  await assert.rejects(documents.extractDocumentText('a.pdf', fixture('text.pdf'), { doclingEnabled: false, readPages: limited('memory') }),
    (e) => e.status === 422 && /too much memory/.test(e.message));
});
