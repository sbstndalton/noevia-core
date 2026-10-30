'use strict';
// #2191 round 8: the project source operations are the Rust front's (noevia-rs bins/noevia-server
// tests/source_work.rs runs them end to end). Node refuses the three POSTs before authentication, whatever
// the query or headers, and keeps no copy of the operations or of the worker call.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned } = require('./rust-project-source-work.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });

test('the owned list is the upload, the sync and the folder plan, POST only', () => {
  assert.deepEqual([...OWNED_ROUTES], ['POST /api/projects/{id}/upload', 'POST /api/projects/{id}/sources/sync', 'POST /api/projects/{id}/folder-import/plan']);
  assert.ok(Object.isFrozen(OWNED_ROUTES));
  assert.equal(ROUTE_REFUSAL.code, 'RUST_PROJECT_SOURCE_WORK_OWNED');
  for (const p of ['/api/projects/p1/upload', '/api/projects/p%2F1/sources/sync', '/api/projects/p1/folder-import/plan']) {
    assert.equal(owned('POST', p), true, p);
    for (const m of ['GET', 'PUT', 'DELETE', 'HEAD']) assert.equal(owned(m, p), false, `${m} ${p}`);
  }
  for (const p of ['/api/projects//upload', '/api/projects/p1/upload/', '/api/projects/a/b/upload', '/api/projects/p1/documents', '/api/projects/p1/folder-import', '/api/projects/p1/sources/text']) {
    assert.equal(owned('POST', p), false, p);
  }
});

test('an owned request is refused with a 503 before its body is read, with or without the old worker header or a background query', () => {
  for (const [method, url, headers] of [
    ['POST', '/api/projects/p1/upload', {}],
    ['POST', '/api/projects/p1/upload?background=1', {}],
    ['POST', '/api/projects/p1/sources/sync', { 'x-noevia-source-work': '1' }],
    ['POST', '/api/projects/p1/folder-import/plan', {}],
  ]) {
    const res = {};
    const req = { url, method, headers: { host: 'localhost', ...headers }, on() { throw new Error('body listener'); } };
    assert.equal(refuseOwned(req, res, { parseRequestUrl, json }), true, url);
    assert.deepEqual(res, { status: 503, body: ROUTE_REFUSAL });
  }
  for (const [method, url] of [['GET', '/api/projects/p1/upload'], ['PUT', '/api/projects/p1/sources/sync'], ['GET', '/api/projects/p1/folder-import/plan']]) {
    assert.equal(refuseOwned({ url, method, headers: {} }, {}, { parseRequestUrl, json }), false, `${method} ${url}`);
  }
  assert.equal(refuseOwned({ url: '//[', method: 'POST', headers: {} }, {}, { parseRequestUrl, json }), false);
});

test('Node keeps no copy of the operations, no worker call and no in-memory file-operation registry', () => {
  for (const gone of ['source-work.cjs', 'folder-import.cjs', 'pdf-reduce.cjs']) {
    assert.equal(fs.existsSync(path.join(__dirname, gone)), false, gone);
  }
  const routes = fs.readFileSync(path.join(__dirname, 'routes', 'projects.cjs'), 'utf8');
  for (const needle of ['x-noevia-source-work', 'application/x-ndjson', "require('../source-work.cjs')", "require('../folder-import.cjs')", "require('../pdf-reduce.cjs')", 'projUpload', 'projSync', 'folderPlan']) {
    assert.equal(routes.includes(needle), false, needle);
  }
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.ok(index.indexOf("require('./rust-project-source-work.cjs').refuseOwned") > 0);
  assert.ok(index.indexOf("require('./rust-project-source-work.cjs').refuseOwned") < index.indexOf('requestAuth.authenticate(req)'), 'refused before authentication');
});

test('the folder-import contract copy is the one the front pins (noevia-rs crates/server-projects/data)', () => {
  const sha = require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'contracts', 'folder-import.json'))).digest('hex');
  assert.equal(sha, 'eb1ab98abd6fe6f2f881cfe3d09c1609f76af8feb21359ff48bfe7e338e84cb4');
});
