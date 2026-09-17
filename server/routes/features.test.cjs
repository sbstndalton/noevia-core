'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createFeatures } = require('../features.cjs');
const { createFeatureRoutes } = require('./features.cjs');

function harness() {
  const m = new Map();
  const features = createFeatures({ env: {}, store: { get: k => m.get(k), set: (k, v) => m.set(k, v) } });
  const json = (res, status, body) => { res.status = status; res.body = body; };
  const readJson = async req => JSON.parse(req.raw || '{}');
  return { features, route: createFeatureRoutes({ features, json, readJson }) };
}
const call = async (route, method, path, role, raw) => {
  const req = Object.assign(Readable.from([]), { method, raw });
  const res = {};
  const handled = await route(req, res, { path, authn: role ? { user: { id: 'u', role } } : null });
  return { handled, ...res };
};

test('members read flags but cannot list or change them', async () => {
  const { route } = harness();
  const read = await call(route, 'GET', '/api/features', 'member');
  assert.equal(read.status, 200); assert.equal(read.body.flags.previews, false);
  assert.equal((await call(route, 'GET', '/api/admin/features', 'member')).status, 403);
  assert.equal((await call(route, 'PUT', '/api/admin/features/previews', 'member', '{"enabled":true}')).status, 403);
});

test('admin toggles a feature; unknown and malformed requests are refused', async () => {
  const { route, features } = harness();
  const put = await call(route, 'PUT', '/api/admin/features/previews', 'admin', '{"enabled":true}');
  assert.equal(put.status, 200); assert.equal(put.body.enabled, true); assert.equal(features.enabled('previews'), true);
  assert.equal((await call(route, 'PUT', '/api/admin/features/nope', 'admin', '{"enabled":true}')).status, 404);
  assert.equal((await call(route, 'PUT', '/api/admin/features/previews', 'admin', '{"enabled":"yes"}')).status, 400);
  assert.equal((await call(route, 'PUT', '/api/admin/features/previews', 'admin', '{bad')).status, 400);
  assert.equal((await call(route, 'POST', '/api/features', 'admin')).status, 405);
});

test('unrelated paths are not handled', async () => {
  const { route } = harness();
  assert.equal((await call(route, 'GET', '/api/featuresX', 'admin')).handled, false);
  assert.equal((await call(route, 'GET', '/api/admin/users', 'admin')).handled, false);
});
