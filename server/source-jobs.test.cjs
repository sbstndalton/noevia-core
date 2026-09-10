'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const jobs = require('./source-jobs.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
test('source jobs isolate users and projects, bound active work and retain errors for polling', async () => {
  const workspace = {}, other = {}; let finish;
  const id = jobs.start(workspace, 'a', () => new Promise(resolve => { finish = resolve; }));
  await tick();
  assert.equal(jobs.read(other, 'a', id), null); assert.equal(jobs.read(workspace, 'b', id), null);
  assert.deepEqual(jobs.read(workspace, 'a', id), { done: false });
  const second = jobs.start(workspace, 'b', async () => { throw new Error('secret'); });
  assert.throws(() => jobs.start(workspace, 'c', async () => {}), /busy/);
  finish({ status: 200, body: { name: 'synthetic.pdf' } }); await tick();
  assert.deepEqual(jobs.read(workspace, 'a', id), { done: true, status: 200, body: { name: 'synthetic.pdf' } });
  assert.equal(jobs.read(workspace, 'b', second).status, 500);
  assert.equal(JSON.stringify(jobs.read(workspace, 'b', second)).includes('secret'), false);
});
