'use strict';
// #2191 round 6: the source-job store is the Rust front's alone (noevia-rs crates/server-projects
// source_jobs.rs; bins/noevia-server source_job_routes.rs and tests/source_jobs.rs, which run a job
// against a synthetic worker). Node refuses a background start and a poll before authentication,
// and keeps no source journal client.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned } = require('./rust-source-jobs.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });

test('the owned list is the poll; the two POSTs are rust-project-source-work.cjs\'s', () => {
  assert.deepEqual([...OWNED_ROUTES], ['GET /api/projects/{id}/source-jobs/{jobId}']);
  assert.ok(Object.isFrozen(OWNED_ROUTES));
  assert.equal(ROUTE_REFUSAL.code, 'RUST_SOURCE_JOBS_OWNED');
  assert.equal(owned('GET', '/api/projects/p1/source-jobs/j1'), true);
  for (const m of ['POST', 'DELETE', 'HEAD']) assert.equal(owned(m, '/api/projects/p1/source-jobs/j1'), false, m);
  for (const p of ['/api/projects/p1/upload', '/api/projects/p1/sources/sync', '/api/projects//upload', '/api/projects/p1/documents', '/api/projects/p1/source-jobs/', '/api/projects/p1/source-jobs/a/b']) {
    assert.equal(owned('POST', p) || owned('GET', p), false, p);
  }
});

test('a poll is refused with a 503 before authentication; the POSTs are another refuser\'s', () => {
  const res = {};
  const req = { url: '/api/projects/p1/source-jobs/j1', method: 'GET', headers: { host: 'localhost' }, on() { throw new Error('body listener'); } };
  assert.equal(refuseOwned(req, res, { parseRequestUrl, json }), true);
  assert.deepEqual(res, { status: 503, body: ROUTE_REFUSAL });
  for (const [method, url] of [['POST', '/api/projects/p1/upload?background=1'], ['POST', '/api/projects/p1/sources/sync'], ['GET', '/api/projects/p1/upload']]) {
    assert.equal(refuseOwned({ url, method, headers: {} }, {}, { parseRequestUrl, json }), false, `${method} ${url}`);
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
