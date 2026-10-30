'use strict';
// #2191 round 4: POST /api/import/conversations is the Rust front's (noevia-rs crates/server-projects import.rs:
// planImport, the recovery journal, transcripts and lists; rust-conversation-import.test.cjs covers the refusal).
// What stays here is the path's answer for every other method.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createImportRoutes } = require('./import.cjs');

const json = (res, status, body) => Object.assign(res, { status, body });

test('other methods keep their 405; other paths are not this mount\'s', async () => {
  const route = createImportRoutes({ json });
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    const res = {};
    assert.equal(await route({ method }, res, { path: '/api/import/conversations', authn: { user: { id: 'u1' } } }), true);
    assert.deepEqual(res, { status: 405, body: { error: 'method not allowed' } }, method);
  }
  const signedOut = {};
  assert.equal(await route({ method: 'GET' }, signedOut, { path: '/api/import/conversations', authn: null }), true);
  assert.deepEqual(signedOut, { status: 401, body: { error: 'Sign in first' } });
  assert.equal(await route({ method: 'POST' }, {}, { path: '/api/import/conversations/', authn: { user: { id: 'u1' } } }), false);
});
