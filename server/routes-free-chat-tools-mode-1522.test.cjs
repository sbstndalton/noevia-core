'use strict';
// #1522 defaults are now proved through actual Rust HTTP and persisted JSON:
// noevia-rs bins/noevia-server/tests/project_routes.rs. The pinned independent
// Node corpus retains the historical route response. Node must not recreate it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { refuseOwnedRoute } = require('./rust-projects.cjs');

test('#1522/#1071: free-chat context creation is refused by Node before it can choose defaults', () => {
  const sent = [];
  assert.equal(refuseOwnedRoute({ method: 'POST' }, {}, '/api/chats/fixture-chat-1522/context',
    (_res, status, body) => sent.push({ status, body })), true);
  assert.deepEqual(sent, [{ status: 503, body: { error: 'This route is served by the Rust front.', code: 'RUST_PROJECTS_OWNED' } }]);
});
