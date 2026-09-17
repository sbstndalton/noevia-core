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
