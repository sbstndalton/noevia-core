'use strict';
// GET /api/health is the Rust front's (#2190 close-out; noevia-rs tests/health.rs holds the probes, the
// bounds, the snapshot and the abort safety, and rust-health.test.cjs here the refusal and the publisher).
// What is left in routes/health.cjs is GET /api/ready.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReadyRoutes } = require('./health.cjs');

test('the health check is not this mount\'s any more', () => {
  assert.equal(require('./health.cjs').createHealthRoutes, undefined);
});

// #297: unauthenticated, no tenant/upstream detail, just whether startup wiring has finished.
test('/api/ready is unauthenticated and reports only {ready, version}', async () => {
  const sent = [];
  let readyFlag = false;
  const routes = createReadyRoutes({ json: (res, status, body) => { sent.push({ status, body }); }, isReady: () => readyFlag, version: '1.2.3' });
  assert.equal(await routes({ method: 'GET' }, {}, { path: '/api/other' }), false, 'unmatched paths pass through');
  assert.equal(await routes({ method: 'GET' }, {}, { path: '/api/ready' }), true);
  assert.deepEqual(sent.pop(), { status: 200, body: { ready: false, version: '1.2.3' } });
  readyFlag = true;
  await routes({ method: 'GET' }, {}, { path: '/api/ready' });
  assert.deepEqual(sent.pop(), { status: 200, body: { ready: true, version: '1.2.3' } });
});

test('/api/ready ignores non-GET methods and never needs an authn context', async () => {
  const sent = [];
  const routes = createReadyRoutes({ json: (res, status, body) => { sent.push({ status, body }); }, isReady: () => true, version: 'v' });
  assert.equal(await routes({ method: 'POST' }, {}, { path: '/api/ready' }), false);
  assert.equal(sent.length, 0);
});
