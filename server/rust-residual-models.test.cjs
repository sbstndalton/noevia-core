'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { refuseOwned, ROUTE_REFUSAL } = require('./rust-residual-fallbacks.cjs');
const { createModelRoutes } = require('./routes/models.cjs');
const parseRequestUrl = req => new URL(req.url, 'http://localhost');
const json = (res, status, body) => (Object.assign(res, { status, body }), true);
function refuse(method, url) {
  const res = {};
  return refuseOwned({ method, url }, res, { parseRequestUrl, json }) ? res : null;
}
test('model residual oracle paths are refused for every method', () => {
  for (const path of ['/api/models/grid-unmatched', '/api/models/grid-unmatched/', '/api/models/pull/', '/api/models/grid-unmatched/deep']) {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      assert.deepEqual(refuse(method, path), { status: 503, body: ROUTE_REFUSAL }, `${method} ${path}`);
    }
  }
});
test('substantive model handlers remain reachable', async () => {
  const routes = createModelRoutes({ json, readBody: async () => '{}', env: {}, modelManager: { enabled: false }, service: { modelScanCache: { clear() {} } }, currentWorkspace: () => ({}) });
  for (const [method, path, status] of [['POST', '/api/models/pull', 400], ['POST', '/api/models/unload', 400], ['GET', '/api/models/mtp-artifact', 400]]) {
    assert.equal(refuse(method, path), null);
    const res = {};
    assert.equal(await routes({ method }, res, { path, url: new URL(path, 'http://localhost'), authn: { user: { role: 'admin' } } }), true);
    assert.equal(res.status, status);
  }
});
