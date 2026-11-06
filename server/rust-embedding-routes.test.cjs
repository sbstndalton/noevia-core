'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { refuseOwned, EMBEDDING_ROUTES_MARKER } = require('./rust-embedding-routes.cjs');
test('all direct Node embedding methods refuse without executing any operation', () => {
  assert.equal(EMBEDDING_ROUTES_MARKER, 'noevia-embedding-routes-client/1');
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    let answer;
    assert.equal(refuseOwned({ method }, {}, { parseRequestUrl: () => ({ pathname: '/api/embedding' }), json: (_res, status, body) => { answer = { status, body }; } }), true);
    assert.equal(answer.status, 503);
    assert.equal(answer.body.code, 'RUST_EMBEDDING_ROUTES_OWNED');
  }
  const source = fs.readFileSync(require.resolve('./index.cjs'), 'utf8');
  assert.ok(!source.includes("require('./routes/embedding.cjs')"));
  assert.ok(!source.includes("require('./embedding-migration.cjs')"));
  assert.ok(source.indexOf("require('./rust-embedding-routes.cjs').refuseOwned") < source.indexOf('requestAuth.authenticate('));
});

test('startup refuses an old front after request ownership moves', () => {
  const { createOwner } = require('./rust-embedding-background.cjs');
  const options = { env: { NOEVIA_START_ID: 'fixture-start' }, frontSecret: 'fixture-token', requiredFeatures: [require('./rust-embedding-routes.cjs').FRONT_FEATURE] };
  assert.throws(() => createOwner({ ...options, features: () => 'rust-embedding-background-v1 rust-index-outbox-v3' }));
  assert.doesNotThrow(() => createOwner({ ...options, features: () => 'rust-embedding-background-v1 rust-index-outbox-v3 noevia-embedding-routes-authority/1' }));
});
