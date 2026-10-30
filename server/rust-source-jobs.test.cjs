'use strict';
// #2191 round 6: the source-job store is the Rust front's alone (noevia-rs crates/server-projects
// source_jobs.rs; bins/noevia-server source_job_routes.rs and tests/source_jobs.rs, which run a job
// against a synthetic worker). Node refuses a background start and a poll before authentication,
// keeps no source journal client, and answers the front's worker call (document-routes.test.cjs).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned } = require('./rust-source-jobs.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });
const params = (q) => new URLSearchParams(q);

test('the owned list is the background starts and the poll', () => {
  assert.deepEqual([...OWNED_ROUTES], ['POST /api/projects/{id}/upload', 'POST /api/projects/{id}/sources/sync', 'GET /api/projects/{id}/source-jobs/{jobId}']);
  assert.ok(Object.isFrozen(OWNED_ROUTES));
  assert.equal(ROUTE_REFUSAL.code, 'RUST_SOURCE_JOBS_OWNED');
  for (const p of ['/api/projects/p1/upload', '/api/projects/p%2F1/sources/sync']) {
    assert.equal(owned('POST', p, params('background=1')), true, p);
    assert.equal(owned('POST', p, params('background=1&background=0')), true, 'the first value, as URLSearchParams.get');
    for (const q of ['', 'background=0', 'background=true', 'background=0&background=1']) assert.equal(owned('POST', p, params(q)), false, `${p}?${q}`);
    assert.equal(owned('PUT', p, params('background=1')), false);
  }
  assert.equal(owned('GET', '/api/projects/p1/source-jobs/j1', params('')), true);
  for (const m of ['POST', 'DELETE', 'HEAD']) assert.equal(owned(m, '/api/projects/p1/source-jobs/j1', params('')), false, m);
  for (const p of ['/api/projects//upload', '/api/projects/p1/upload/', '/api/projects/a/b/upload', '/api/projects/p1/documents', '/api/projects/p1/source-jobs/', '/api/projects/p1/source-jobs/a/b']) {
    assert.equal(owned('POST', p, params('background=1')) || owned('GET', p, params('')), false, p);
  }
});

test('an owned request is refused with a 503 before its body is read; the synchronous worker route falls through', () => {
  for (const [method, url] of [['POST', '/api/projects/p1/upload?background=1'], ['POST', '/api/projects/p1/sources/sync?background=1'], ['GET', '/api/projects/p1/source-jobs/j1']]) {
    const res = {};
    const req = { url, method, headers: { host: 'localhost' }, on() { throw new Error('body listener'); } };
    assert.equal(refuseOwned(req, res, { parseRequestUrl, json }), true, url);
    assert.deepEqual(res, { status: 503, body: ROUTE_REFUSAL });
  }
  for (const [method, url] of [['POST', '/api/projects/p1/upload'], ['POST', '/api/projects/p1/sources/sync'], ['POST', '/api/projects/p1/folder-import/plan'], ['GET', '/api/projects/p1/upload']]) {
    assert.equal(refuseOwned({ url, method, headers: { 'x-noevia-source-work': '1' } }, {}, { parseRequestUrl, json }), false, `${method} ${url}`);
  }
  assert.equal(refuseOwned({ url: '//[', method: 'GET', headers: {} }, {}, { parseRequestUrl, json }), false);
});

test('Node keeps no source journal client: the module, the store client and the workspace handle are gone', () => {
  assert.equal(fs.existsSync(path.join(__dirname, 'source-jobs.cjs')), false);
  const client = fs.readFileSync(path.join(__dirname, 'project-store-client.cjs'), 'utf8');
  assert.equal(client.includes('source-jobs/'), false);
  assert.equal(client.includes('sourceJobsFor'), false);
  assert.equal(client.includes('SOURCE_JOBS_CLIENT_MARKER'), false, 'no source job client capability for the release pairing');
  assert.equal(fs.readFileSync(path.join(__dirname, 'workspace.cjs'), 'utf8').includes('sourceJobs'), false);
  const routes = fs.readFileSync(path.join(__dirname, 'routes', 'projects.cjs'), 'utf8');
  assert.equal(routes.includes("searchParams.get('background')"), false, 'no background wrapper here');
  assert.equal(routes.includes("require('../source-jobs.cjs')"), false);
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.ok(index.indexOf("require('./rust-source-jobs.cjs').refuseOwned") < index.indexOf('requestAuth.authenticate(req)'), 'refused before authentication');
});

test('a chat turn waits for a tracked file operation and names one that failed (#1441)', async () => {
  const work = require('./source-work.cjs');
  const ws = {};
  let release;
  const gate = new Promise((r) => { release = r; });
  const ok = work.track(ws, 'p1', async () => { await gate; return { status: 200, body: {} }; }, { name: 'dir/a.md' });
  const bad = work.track(ws, 'p1', async () => ({ status: 409, body: {} }), { name: 'b.md' });
  work.track(ws, 'p2', () => new Promise(() => {}), { name: 'other.md' });
  work.track(ws, 'p1', () => new Promise(() => {})); // a sync: no name, not waited for
  setTimeout(release, 20);
  const settled = await work.settle(ws, 'p1', { timeoutMs: 2000 });
  assert.deepEqual(settled, { notReady: [{ name: 'b.md', reason: 'failed' }], aborted: false });
  assert.deepEqual(await ok, { status: 200, body: {} });
  assert.equal((await bad).status, 409);
  assert.deepEqual(await work.settle(ws, 'p1'), { notReady: [], aborted: false }, 'a finished operation is forgotten');
  const timedOut = await work.settle(ws, 'p2', { timeoutMs: 10 });
  assert.deepEqual(timedOut, { notReady: [{ name: 'other.md', reason: 'timeout' }], aborted: false });
  const abort = new AbortController(); abort.abort();
  work.track(ws, 'p3', () => new Promise(() => {}), { name: 'c.md' });
  assert.deepEqual(await work.settle(ws, 'p3', { signal: abort.signal }), { notReady: [], aborted: true });
});
