'use strict';
// #1872: bounded wait and hold warning for the large-document lock, the lock decided from the response's
// own Content-Length rather than the listing, and the shared-buffer copy-out. Synthetic bytes only.
const test = require('node:test');
const assert = require('node:assert/strict');
const lock = require('./large-document-lock.cjs');
const storage = require('./storage-client.cjs');

const MiB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const conn = { kind: 'webdav', baseUrl: 'http://fixture.invalid/dav', corpusRoot: '', username: '', secret: '' };

function withEnv(vars, fn) {
  const before = {};
  for (const k of Object.keys(vars)) { before[k] = process.env[k]; process.env[k] = vars[k]; }
  const restore = () => { for (const k of Object.keys(vars)) { if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; } };
  return Promise.resolve().then(fn).finally(restore);
}

/** Serve `bytes` bytes of zeros in 1 MiB pieces, declaring `declared` (null: no Content-Length). */
function serve(bytes, declared) {
  const piece = new Uint8Array(MiB);
  global.fetch = async () => {
    let sent = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (sent >= bytes) { controller.close(); return; }
        const n = Math.min(MiB, bytes - sent);
        controller.enqueue(n === MiB ? piece : piece.subarray(0, n));
        sent += n;
      },
    });
    return new Response(body, declared === null ? {} : { headers: { 'content-length': String(declared) } });
  };
}
const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

test('#1872: a read that cannot get the lock within the wait fails as busy and the queue behind it still moves', () => withEnv({ LARGE_DOCUMENT_ACQUIRE_WAIT_MS: '60' }, async () => {
  let letGo;
  const holder = lock.withLargeDocument(() => new Promise((r) => { letGo = r; }));
  await sleep(5);
  const started = Date.now();
  await assert.rejects(lock.withLargeDocument(async () => 'never'), (e) => e.status === 503 && /busy/i.test(e.message));
  assert.ok(Date.now() - started >= 50, 'it waited the bound');
  // The same shape the extraction workers use, so every caller already treats it as a passing failure.
  await assert.rejects(lock.withLargeDocument(async () => 'never'), (e) => e.status === 503);
  letGo();
  await holder;
  // A later read gets the lock: the timed-out waiters did not wedge the queue.
  assert.equal(await lock.withLargeDocument(async () => 'ok'), 'ok');
}));

test('#1872: a waiter that is within its wait gets the lock when the holder lets go', () => withEnv({ LARGE_DOCUMENT_ACQUIRE_WAIT_MS: '2000' }, async () => {
  const order = [];
  const first = lock.withLargeDocument(async () => { await sleep(40); order.push('first'); });
  const second = lock.withLargeDocument(async () => { order.push('second'); });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'second']);
}));

test('#1872: the lock is released when the holder throws', async () => {
  await assert.rejects(lock.withLargeDocument(async () => { throw new Error('extraction failed'); }), /extraction failed/);
  assert.equal(await lock.withLargeDocument(async () => 'next'), 'next');
  assert.equal(lock.held(), false);
});

test('#1872: a hold past the limit logs one line without document content, and is not force-released', () => withEnv({ LARGE_DOCUMENT_HOLD_WARN_MS: '40', LARGE_DOCUMENT_ACQUIRE_WAIT_MS: '5000' }, async () => {
  const lines = [];
  const warn = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    let overlap = 0, most = 0;
    const slow = lock.withLargeDocument(async () => { overlap++; most = Math.max(most, overlap); await sleep(150); overlap--; return 'SECRET-BODY-TEXT'; });
    const next = lock.withLargeDocument(async () => { overlap++; most = Math.max(most, overlap); overlap--; });
    assert.equal(await slow, 'SECRET-BODY-TEXT');
    await next;
    assert.equal(most, 1, 'the holder past the warning kept the lock');
  } finally { console.warn = warn; }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /large-document-lock/);
  assert.doesNotMatch(lines[0], /SECRET/);
}));

test('#1872: a quick hold logs nothing', () => withEnv({ LARGE_DOCUMENT_HOLD_WARN_MS: '500' }, async () => {
  const lines = [];
  const warn = console.warn;
  console.warn = (...a) => lines.push(a.join(' '));
  try { await lock.withLargeDocument(async () => sleep(10)); await sleep(20); } finally { console.warn = warn; }
  assert.deepEqual(lines, []);
}));

test('#1872: work started inside a holder inherits it unless run through detached()', async () => {
  await lock.withLargeDocument(async () => {
    assert.equal(lock.held(), true);
    const inherited = await new Promise((r) => setTimeout(() => r(lock.held()), 1));
    assert.equal(inherited, true, 'a timer started in the holder carries its context (the rule being documented)');
    const apart = await new Promise((r) => lock.detached(() => setTimeout(() => r(lock.held()), 1)));
    assert.equal(apart, false, 'detached work is outside the holder');
  });
});



test('#1872: bytes much smaller than the declared size are copied out of the oversized shared buffer', async () => {
  serve(1 * MiB, 30 * MiB);
  const bytes = await storage.readBinaryFile(conn, 'short.pdf', { cap: 96 * MiB });
  assert.equal(bytes.length, 1 * MiB);
  assert.ok(!(bytes.buffer instanceof SharedArrayBuffer), 'not a view into the shared allocation');
  assert.ok(bytes.buffer.byteLength < 4 * MiB, 'the 30 MiB buffer is not kept alive');
  // Nearly all of what was declared arrives: the buffer is kept as it is.
  serve(29 * MiB, 30 * MiB);
  const most = await storage.readBinaryFile(conn, 'nearly.pdf', { cap: 96 * MiB });
  assert.equal(most.length, 29 * MiB);
  assert.equal(most.buffer.byteLength, 30 * MiB);
});

// #1878: a wait and a deferral each leave one content-free line (hash, counts), never a name or text.
test('#1878: an acquire that had to wait logs one line with the wait and a hash, and no name', async () => {
  const lines = [];
  const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
  try {
    const first = await lock.acquire('synthetic-doc-id-1');
    const second = lock.acquire('QA-SYNTH-secret-name.pdf');
    await sleep(40);
    first();
    (await second)();
  } finally { console.log = orig; }
  const mine = lines.filter((l) => l.includes('[large-document-lock]'));
  assert.equal(mine.length, 1, 'only the waiting acquire logs');
  assert.match(mine[0], /doc=[0-9a-f]{8} waitedMs=\d+/);
  assert.ok(Number(/waitedMs=(\d+)/.exec(mine[0])[1]) >= 30);
  assert.doesNotMatch(mine[0], /QA-SYNTH|synthetic-doc|\.pdf/);
});

test('#1878: an acquire that finds the lock free logs nothing', async () => {
  const lines = [];
  const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
  try { (await lock.acquire('x'))(); } finally { console.log = orig; }
  assert.deepEqual(lines, []);
});

test('#1878: giving up on the wait logs the busy outcome with a hash only', () => withEnv({ LARGE_DOCUMENT_ACQUIRE_WAIT_MS: '40' }, async () => {
  const lines = [];
  const orig = console.warn; console.warn = (...a) => lines.push(a.join(' '));
  const holderRelease = await lock.acquire('holder');
  try {
    await assert.rejects(lock.acquire('QA-SYNTH-secret-name.pdf'), { code: 'large-document-busy' });
  } finally { console.warn = orig; holderRelease(); }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /outcome=busy/);
  assert.doesNotMatch(lines[0], /QA-SYNTH|\.pdf/);
}));
