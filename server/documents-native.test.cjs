'use strict';
// The PDF reader's worker and its limits. Synthetic fixtures only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { readInWorker, readNativePages, createReader } = require('./documents-native.cjs');
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

test('memory outside the heap (decoded buffers) is stopped at the growth limit', async () => {
  // 24 x 64 MB of Uint8Arrays sailed past a 64 MB heap limit in review; the growth watch stops it.
  const buffers = script('buffers.cjs', 'const keep = []; for (let i = 0; i < 24; i++) keep.push(new Uint8Array(64 * 1024 * 1024).fill(1)); setInterval(() => {}, 1000);');
  const started = Date.now();
  await assert.rejects(readInWorker(fixture('text.pdf'), { ...caps, script: buffers, heapLimitMb: 64, growthLimitMb: 256, timeLimitMs: 30000 }),
    (e) => e.limit === 'memory');
  assert.ok(Date.now() - started < 20000);
});

test('readers run one at a time, so memory growth belongs to the one running', async () => {
  const slow = script('slow.cjs', "const start = Date.now(); setTimeout(() => require('node:worker_threads').parentPort.postMessage({ ok: true, result: { numPages: 1, pageTexts: [], start, end: Date.now() } }), 150);");
  const runs = await Promise.all(Array.from({ length: 3 }, () => readInWorker(fixture('text.pdf'), { ...caps, script: slow })));
  runs.sort((a, b) => a.start - b.start);
  for (let i = 1; i < runs.length; i++) assert.ok(runs[i].start >= runs[i - 1].end, `run ${i} started after run ${i - 1} ended`);
});

function controlledReader(limits) {
  const workers = [];
  let copies = 0;
  const read = createReader({ ...limits,
    copyBytes(bytes) { copies++; return new Uint8Array(bytes); },
    makeWorker(_script, options) {
      const worker = new EventEmitter();
      worker.terminate = async () => 0;
      workers.push({ worker, options });
      return worker;
    },
  });
  return { read, workers, copies: () => copies,
    finish(index) { workers[index].worker.emit('message', { ok: true, result: { index } }); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('pending readers are admitted before copying and excess count/bytes are refused promptly', async () => {
  const h = controlledReader({ maxPending: 2, maxPendingBytes: 3, queueWaitMs: 1000 });
  const first = h.read(Buffer.alloc(2));
  await tick();
  assert.equal(h.copies(), 1);
  const second = h.read(Buffer.alloc(2));
  assert.equal(h.copies(), 1, 'a waiting input has no transfer copy');
  await assert.rejects(h.read(Buffer.alloc(2)), e => e.limit === 'queue' && e.reason === 'full');
  const third = h.read(Buffer.alloc(1));
  await assert.rejects(h.read(Buffer.alloc(1)), e => e.limit === 'queue' && e.reason === 'full');
  assert.equal(h.copies(), 1);
  h.finish(0); await first; await tick();
  assert.equal(h.copies(), 2, 'the next transfer copy is made only after the first worker ends');
  assert.equal(h.workers.length, 2);
  h.finish(1); await second; await tick();
  h.finish(2); await third;
  assert.equal(h.copies(), 3);
});

test('a queued reader expires during the wait, releases capacity, and never gets copied', async () => {
  const h = controlledReader({ maxPending: 1, maxPendingBytes: 2, queueWaitMs: 25 });
  const first = h.read(Buffer.alloc(2)); await tick();
  const expired = h.read(Buffer.alloc(2));
  await assert.rejects(expired, e => e.limit === 'queue' && e.reason === 'wait');
  assert.equal(h.copies(), 1);
  const replacement = h.read(Buffer.alloc(2));
  h.finish(0); await first; await tick();
  assert.equal(h.copies(), 2);
  h.finish(1); await replacement;
});

test('queue pressure stays retryable at the document extraction boundary', async () => {
  const busy = async () => { throw Object.assign(new Error('The PDF reader is busy; retry.'), { limit: 'queue' }); };
  await assert.rejects(documents.extractDocumentText('a.pdf', fixture('text.pdf'), { doclingEnabled: false, readPages: busy }),
    e => e.status === 503 && e.retryable === true && /retry/.test(e.message));
});

test('the next reader starts and admission recovers after worker startup, error, exit, or timeout failure', async () => {
  for (const failure of ['startup', 'error', 'exit', 'timeout']) {
    let started = 0;
    const read = createReader({ maxPending: 1, maxPendingBytes: 2, queueWaitMs: 1000,
      makeWorker() {
        const index = ++started;
        if (index === 1 && failure === 'startup') throw Error('synthetic startup failure');
        const worker = new EventEmitter();
        worker.terminate = async () => 0;
        if (index === 1 && failure === 'error') setImmediate(() => worker.emit('error', Error('synthetic worker error')));
        else if (index === 1 && failure === 'exit') setImmediate(() => worker.emit('exit', 3));
        else if (index > 1) setImmediate(() => worker.emit('message', { ok: true, result: index }));
        return worker;
      },
    });
    const first = read(Buffer.alloc(2), { timeLimitMs: 20 });
    const waiting = read(Buffer.alloc(2));
    await assert.rejects(first, /failure|error|stopped|time limit/, failure);
    assert.equal(await waiting, 2, `${failure}: queued work continued`);
    assert.equal(await read(Buffer.alloc(2)), 3, `${failure}: admission capacity was released`);
  }
});
