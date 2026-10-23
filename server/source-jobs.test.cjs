const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

const fresh = () => { delete require.cache[require.resolve('./source-jobs.cjs')]; return require('./source-jobs.cjs'); };
const workspace = (dir) => ({ dir, sourceJobs: require('../tests/server/project-store-stub.cjs').createStubStore(dir, { flat: true }).sourceJobsFor('stub') });
const wait = async (fn) => { for (let i = 0; i < 100; i++) { const v = await fn(); if (v?.done) return v; await new Promise((r) => setTimeout(r, 10)); } throw Error('timeout'); };

test('source jobs keep their polling contract, tenant/project scope and busy limit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-source-jobs-'));
  try {
    const jobs = fresh(), ws = workspace(dir);
    let release;
    const gate = new Promise((r) => { release = r; });
    const id = await jobs.start(ws, 'p1', async (progress) => { progress('Reading PDF'); await gate; return { status: 200, body: { name: 'a.pdf' } }; });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(await jobs.read(ws, 'p1', id), { done: false, stage: 'Reading PDF' });
    assert.equal(await jobs.read(ws, 'p2', id), null, 'another project cannot read it');
    assert.equal(await jobs.read(workspace(fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-other-'))), 'p1', id), null, 'another tenant cannot read it');
    await jobs.start(ws, 'p1', () => gate.then(() => ({ status: 200, body: {} })));
    await assert.rejects(jobs.start(ws, 'p1', async () => ({})), (e) => e.status === 429);
    release();
    assert.deepEqual(await wait(() => jobs.read(ws, 'p1', id)), { done: true, status: 200, body: { name: 'a.pdf' } });
    const failed = await jobs.start(ws, 'p1', async () => { throw Object.assign(Error('ocr crashed with /secret/path'), { status: 422 }); });
    const f = await wait(() => jobs.read(ws, 'p1', failed));
    assert.equal(f.status, 422); assert.doesNotMatch(f.body.error, /secret/);
    assert.equal(await jobs.read(ws, 'p1', 'not-a-uuid'), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('store poll failures stay unavailable and a rejected progress write cannot complete cleanly', async () => {
  const jobs = fresh();
  const finishes = [];
  let resolveFinish;
  const finished = new Promise((resolve) => { resolveFinish = resolve; });
  const ws = { sourceJobs: {
    recover: async () => ({ count: 0 }),
    start: async () => ({ id: '11111111-1111-4111-8111-111111111111', run: '22222222-2222-4222-8222-222222222222' }),
    progress: async () => { throw Object.assign(Error('store down'), { status: 503 }); },
    finish: async (_owner, _id, _run, ok, result) => { finishes.push({ ok, result }); resolveFinish(); },
    read: async () => { throw Object.assign(Error('store down'), { status: 503 }); },
  } };
  await assert.rejects(jobs.read(ws, 'p1', '11111111-1111-4111-8111-111111111111'), (e) => e.status === 503);
  await jobs.start(ws, 'p1', async (progress) => { progress('indexing'); return { status: 200, body: {} }; });
  await finished;
  assert.deepEqual(finishes.map((f) => f.ok), [false]);
  assert.equal(finishes[0].result.status, 503);
});

test('two lost start replies are reconciled after store recovery without a Node restart', async () => {
  const jobs = fresh();
  const committed = new Map();
  let recoverNetwork = false, startCalls = 0, finished;
  const complete = new Promise((resolve) => { finished = resolve; });
  const fetchImpl = async (url, init) => {
    const op = url.split('/').pop(), body = JSON.parse(init.body);
    const reply = (data) => new Response(JSON.stringify(data), { status: 200 });
    if (op === 'recover') return reply({ count: 0 });
    if (op === 'start') {
      startCalls += 1;
      if (!committed.has(body.request)) committed.set(body.request, { id: crypto.randomUUID(), run: crypto.randomUUID(), state: 'running' });
      if (startCalls <= 2) throw Error('both start replies lost after commit');
      return reply(committed.get(body.request));
    }
    if (op === 'abandon') {
      if (!recoverNetwork) throw Error('store temporarily unavailable');
      const job = committed.get(body.request);
      if (job?.state === 'running') job.state = 'interrupted';
      return reply({ ok: true });
    }
    if (op === 'finish') {
      for (const job of committed.values()) if (job.id === body.id) job.state = 'completed';
      finished();
      return reply({ ok: true });
    }
    if (op === 'read') return reply({ status: 'completed', result: { status: 200, body: {} } });
    return reply({ ok: true });
  };
  const crypto = require('node:crypto');
  const client = require('./project-store-client.cjs').createClient({ port: 1, token: 'synthetic-source-secret-0123456789', fetchImpl });
  const ws = { userId: 'synthetic-owner', sourceJobs: client.sourceJobsFor('synthetic-owner') };
  await assert.rejects(jobs.start(ws, 'p1', async () => ({ status: 200 })), (e) => e.status === 503);
  assert.equal(committed.size, 1);
  assert.equal([...committed.values()][0].state, 'running');
  recoverNetwork = true;
  await jobs.start(ws, 'p1', async () => ({ status: 200, body: {} }));
  await complete;
  assert.equal([...committed.values()].filter((j) => j.state === 'running').length, 0);
  assert.deepEqual([...committed.values()].map((j) => j.state).sort(), ['completed', 'interrupted']);
});

test('a poll after a restart reports interruption instead of a missing job', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-source-restart-'));
  try {
    const before = fresh(), ws = workspace(dir);
    const id = await before.start(ws, 'p1', () => new Promise(() => {}));
    await new Promise((r) => setTimeout(r, 20));
    const after = fresh();
    const polled = await after.read(workspace(dir), 'p1', id);
    assert.equal(polled.done, true); assert.equal(polled.status, 503); assert.match(polled.body.error, /restarted/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('settle waits for a project\'s running file jobs, reports failures and timeouts, and ignores the rest (#1441)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-source-settle-'));
  try {
    const jobs = fresh(), ws = workspace(dir);
    assert.deepEqual(await jobs.settle(ws, 'p1'), { notReady: [], aborted: false }, 'nothing running');
    let release;
    const gate = new Promise((r) => { release = r; });
    await jobs.start(ws, 'p1', async () => { await gate; return { status: 200, body: {} }; }, { name: 'ok.md' });
    let free; await jobs.start(ws, 'p2', () => new Promise((r) => { free = r; }), { name: 'elsewhere.md' });
    assert.deepEqual(await jobs.settle(ws, 'p3'), { notReady: [], aborted: false }, 'another project is not waited for');
    setTimeout(release, 20);
    assert.deepEqual(await jobs.settle(ws, 'p1', { timeoutMs: 2000 }), { notReady: [], aborted: false });
    free({ status: 200, body: {} });
    await new Promise((r) => setTimeout(r, 20));
    let releaseFailures;
    const failuresGate = new Promise((r) => { releaseFailures = r; });
    await jobs.start(ws, 'p1', async () => { await failuresGate; return { status: 422, body: { error: 'unreadable' } }; }, { name: 'bad.pdf' });
    await jobs.start(ws, 'p1', async () => { await failuresGate; throw new Error('boom'); }, { name: 'crash.pdf' });
    setTimeout(releaseFailures, 10);
    assert.deepEqual((await jobs.settle(ws, 'p1', { timeoutMs: 2000 })).notReady, [{ name: 'bad.pdf', reason: 'failed' }, { name: 'crash.pdf', reason: 'failed' }]);
    assert.deepEqual(await jobs.settle(ws, 'p1'), { notReady: [], aborted: false }, 'finished jobs are not waited for again');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('settle stops at once when the client cancels (#1441)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-source-settle-cancel-'));
  try {
    const jobs = fresh(), ws = workspace(dir);
    await jobs.start(ws, 'p1', () => new Promise(() => {}), { name: 'stuck.md' });
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
    const jobs = fresh(), ws = workspace(dir);
    await jobs.start(ws, 'p1', () => new Promise(() => {}), { name: 'stuck.md' });
    const stuck = [{ name: 'stuck.md', reason: 'timeout' }];
    assert.deepEqual(await jobs.settle(ws, 'p1', { timeoutMs: 20 }), { notReady: stuck, aborted: false });
    const started = realNow();
    for (let i = 0; i < 3; i++) assert.deepEqual(await jobs.settle(ws, 'p1', { timeoutMs: 5000 }), { notReady: stuck, aborted: false }, 'still reported as not ready');
    assert.ok(realNow() - started < 500, 'later turns do not wait for it again');
    Date.now = () => realNow() + 11 * 60000;
    assert.deepEqual(await jobs.settle(ws, 'p1', { timeoutMs: 5000 }), { notReady: [], aborted: false }, 'forgotten after ten minutes');
  } finally { Date.now = realNow; fs.rmSync(dir, { recursive: true, force: true }); }
});
