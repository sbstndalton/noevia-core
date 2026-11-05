'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createModelRoutes } = require('./routes/models.cjs');
const { createBridge } = require('./rust-auto-roles-write.cjs');

test('#2408 a disconnect before commit cannot consume the final invalidation', async () => {
  let release, started, invalidations = 0;
  const pending = new Promise(r => { release = r; }), entered = new Promise(r => { started = r; });
  const route = createModelRoutes({ json() {}, env: { MODEL_LOADER_URL: 'http://synthetic.invalid' }, modelManager: {},
    readBody: async () => '{}', fetchJson: async () => { started(); await pending; return { ok: true, status: 200, body: {} }; },
    service: { modelScanCache: { clear() {} }, invalidateModelReads() { invalidations++; } } });
  const res = new EventEmitter(); res.setHeader = () => {};
  const done = route({ method: 'POST' }, res, { path: '/api/model-manager/noop', authn: { user: { role: 'admin' } }, url: new URL('http://localhost/api/model-manager/noop') });
  await entered; res.emit('close');
  const beforeCommit = invalidations;
  release(); await done;
  assert.ok(invalidations > beforeCommit, 'must invalidate after the mutation actually commits');
});

test('native warm bridge authenticates, rechecks admin and invokes the existing trigger in user scope', async () => {
  const seen = []; let role = 'admin';
  const bridge = createBridge({ secret: 'synthetic-secret', json: (res, status, body) => Object.assign(res, { status, body }), readJson: async req => req.body,
    service: { ensureRolesLoaded() { seen.push('warm'); }, servedCatalogue: async () => null, invalidateModelReads() { seen.push('invalidate'); } },
    asUser: (id, fn) => { seen.push(id); return fn(); }, user: () => ({ role }) });
  const call = async (op, body = {}, extra = {}) => { const res = {}; await bridge({ method: 'POST', url: '/internal/auto-roles/' + op, body, headers: { 'x-noevia-store-token': 'synthetic-secret' }, socket: { remoteAddress: '127.0.0.1' }, ...extra }, res); return res; };
  assert.equal((await call('warm', { user: 'u' })).status, 200); assert.deepEqual(seen, ['u','warm']);
  role = 'member'; assert.equal((await call('warm', { user: 'u' })).status, 403); assert.deepEqual(seen, ['u','warm']);
  for (const extra of [{headers:{}}, {socket:{remoteAddress:'192.0.2.1'}}, {headers:{'x-noevia-store-token':'synthetic-secret','x-forwarded-for':''}}]) assert.equal((await call('warm', {user:'u'}, extra)).status,404);
  assert.equal((await call('warm', {user:'u', roles:{fast:'x'}})).status,400);
  assert.deepEqual((await call('facts')).body, {catalogue:null});
  assert.equal((await call('invalidate')).status,200);
});
