const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const fresh = () => { delete require.cache[require.resolve('./source-jobs.cjs')]; return require('./source-jobs.cjs'); };
const wait = async (fn) => { for (let i = 0; i < 100; i++) { const v = fn(); if (v?.done) return v; await new Promise((r) => setTimeout(r, 10)); } throw Error('timeout'); };

test('source jobs keep their polling contract, tenant/project scope and busy limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-source-jobs-'));
  try {
    const jobs = fresh(), ws = { dir };
    let release;
    const gate = new Promise((r) => { release = r; });
    const id = jobs.start(ws, 'p1', async (progress) => { progress('Reading PDF'); await gate; return { status: 200, body: { name: 'a.pdf' } }; });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(jobs.read(ws, 'p1', id), { done: false, stage: 'Reading PDF' });
    assert.equal(jobs.read(ws, 'p2', id), null, 'another project cannot read it');
    assert.equal(jobs.read({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-other-')) }, 'p1', id), null, 'another tenant cannot read it');
    jobs.start(ws, 'p1', () => gate.then(() => ({ status: 200, body: {} })));
    assert.throws(() => jobs.start(ws, 'p1', async () => ({})), (e) => e.status === 429);
    release();
    assert.deepEqual(await wait(() => jobs.read(ws, 'p1', id)), { done: true, status: 200, body: { name: 'a.pdf' } });
    const failed = jobs.start(ws, 'p1', async () => { throw Object.assign(Error('ocr crashed with /secret/path'), { status: 422 }); });
    const f = await wait(() => jobs.read(ws, 'p1', failed));
    assert.equal(f.status, 422); assert.doesNotMatch(f.body.error, /secret/);
    assert.equal(jobs.read(ws, 'p1', 'not-a-uuid'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a poll after a restart reports interruption instead of a missing job', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-source-restart-'));
  try {
    const before = fresh(), ws = { dir };
    const id = before.start(ws, 'p1', () => new Promise(() => {}));
    await new Promise((r) => setTimeout(r, 20));
    const after = fresh();
    const polled = after.read({ dir }, 'p1', id);
    assert.equal(polled.done, true); assert.equal(polled.status, 503); assert.match(polled.body.error, /restarted/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('settle waits for a project\'s running file jobs, reports failures and timeouts, and ignores the rest (#1441)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-source-settle-'));
  try {
    const jobs = fresh(), ws = { dir };
    assert.deepEqual(await jobs.settle(ws, 'p1'), { notReady: [], aborted: false }, 'nothing running');
    let release;
    const gate = new Promise((r) => { release = r; });
    jobs.start(ws, 'p1', async () => { await gate; return { status: 200, body: {} }; }, { name: 'ok.md' });
    let free; jobs.start(ws, 'p2', () => new Promise((r) => { free = r; }), { name: 'elsewhere.md' });
    assert.deepEqual(await jobs.settle(ws, 'p3'), { notReady: [], aborted: false }, 'another project is not waited for');
    setTimeout(release, 20);
    assert.deepEqual(await jobs.settle(ws, 'p1', { timeoutMs: 2000 }), { notReady: [], aborted: false });
    free({ status: 200, body: {} });
    await new Promise((r) => setTimeout(r, 20));
    jobs.start(ws, 'p1', async () => ({ status: 422, body: { error: 'unreadable' } }), { name: 'bad.pdf' });
    jobs.start(ws, 'p1', async () => { throw new Error('boom'); }, { name: 'crash.pdf' });
    assert.deepEqual((await jobs.settle(ws, 'p1', { timeoutMs: 2000 })).notReady, [{ name: 'bad.pdf', reason: 'failed' }, { name: 'crash.pdf', reason: 'failed' }]);
    assert.deepEqual(await jobs.settle(ws, 'p1'), { notReady: [], aborted: false }, 'finished jobs are not waited for again');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('settle stops at once when the client cancels (#1441)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-source-settle-cancel-'));
  try {
    const jobs = fresh(), ws = { dir };
    jobs.start(ws, 'p1', () => new Promise(() => {}), { name: 'stuck.md' });
    const cancel = new AbortController();
    setTimeout(() => cancel.abort(), 10);
    const started = Date.now();
    assert.deepEqual(await jobs.settle(ws, 'p1', { timeoutMs: 5000, signal: cancel.signal }), { notReady: [], aborted: true });
    assert.ok(Date.now() - started < 1000);
    const gone = new AbortController(); gone.abort();
    assert.equal((await jobs.settle(ws, 'p1', { timeoutMs: 5000, signal: gone.signal })).aborted, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a job that never settles costs one bounded wait, not one per later turn, and is forgotten after a while (#1441)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-source-settle-stuck-'));
  const realNow = Date.now;
  try {
    const jobs = fresh(), ws = { dir };
    jobs.start(ws, 'p1', () => new Promise(() => {}), { name: 'stuck.md' });
    const stuck = [{ name: 'stuck.md', reason: 'timeout' }];
    assert.deepEqual(await jobs.settle(ws, 'p1', { timeoutMs: 20 }), { notReady: stuck, aborted: false });
    const started = realNow();
    for (let i = 0; i < 3; i++) assert.deepEqual(await jobs.settle(ws, 'p1', { timeoutMs: 5000 }), { notReady: stuck, aborted: false }, 'still reported as not ready');
    assert.ok(realNow() - started < 500, 'later turns do not wait for it again');
    Date.now = () => realNow() + 11 * 60000;
    assert.deepEqual(await jobs.settle(ws, 'p1', { timeoutMs: 5000 }), { notReady: [], aborted: false }, 'forgotten after ten minutes');
  } finally { Date.now = realNow; fs.rmSync(dir, { recursive: true, force: true }); }
});
