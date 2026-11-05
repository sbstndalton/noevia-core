'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createModelRoutes } = require('./routes/models.cjs');
const { RUST_AUTO_ROLES_WRITE_OWNED, createBridge } = require('./rust-auto-roles-write.cjs');

test('the native writer advertises its paired capability', () => {
  assert.equal(RUST_AUTO_ROLES_WRITE_OWNED, 'rust-auto-roles-write');
});

test('#2408 a disconnect before commit cannot consume the final invalidation', async () => {
  let release, started, value = 'old';
  const cache = require('./short-read.cjs').createSharedRead(async () => value, 60000);
  const pending = new Promise(r => { release = r; }), entered = new Promise(r => { started = r; });
  const route = createModelRoutes({ json() {}, env: { MODEL_LOADER_URL: 'http://synthetic.invalid' }, modelManager: {},
    readBody: async () => '{}', fetchJson: async () => { started(); await pending; value = 'new'; return { ok: true, status: 200, body: {} }; },
    service: { modelScanCache: { clear() {} }, invalidateModelReads() { cache.clear(); } } });
  const res = new EventEmitter(); res.setHeader = () => {};
  const done = route({ method: 'POST' }, res, { path: '/api/model-manager/noop', authn: { user: { role: 'admin' } }, url: new URL('http://localhost/api/model-manager/noop') });
  await entered; res.emit('close');
  assert.equal(await cache.get(), 'old', 'the read in the gap sees the pre-commit state');
  release(); await done;
  assert.equal(await cache.get(), 'new', 'the read in the gap must not remain cached after commit');
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

test('the bridge warms only the existing trigger against a synthetic engine', async t => {
  const http = require('node:http');
  const { AsyncLocalStorage } = require('node:async_hooks');
  const scope = new AsyncLocalStorage(), calls = [];
  let loaded;
  const done = new Promise(resolve => { loaded = resolve; });
  const engine = http.createServer((req, res) => {
    calls.push(req.url); res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}');
    loaded();
  });
  await new Promise(resolve => engine.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => engine.close(resolve)));
  const manager = { enabled: true, requireEnabled() {}, capabilities: { routing: false },
    listModels: async () => ({ok:true, body:{data:[{id:'alpha'},{id:'beta'},{id:'creative'}]}}),
    health: async () => ({ok:true, body:{all_models_loaded:[{model_name:'alpha',loaded:true}]}}),
    load: async name => (await fetch(`http://127.0.0.1:${engine.address().port}/load/${name}`, {method:'POST'})).json(),
  };
  const service = require('./models.cjs').createModelService({env:{}, modelManager:manager,
    currentWorkspace: () => { assert.equal(scope.getStore(), 'synthetic-admin'); return {autoRoles:{fast:'alpha',smart:'beta',creative:'creative'}}; },
  });
  const bridge = createBridge({secret:'synthetic-secret',service,user:()=>({role:'admin'}),
    asUser:(user,fn)=>scope.run(user,fn),readJson:async()=>({user:'synthetic-admin'}),
    json:(res,status)=>{res.status=status;},
  });
  const req={method:'POST',url:'/internal/auto-roles/warm',headers:{'x-noevia-store-token':'synthetic-secret'},socket:{remoteAddress:'127.0.0.1'}};
  const res={}; await bridge(req,res); assert.equal(res.status,200);
  await Promise.race([done,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('synthetic warm timeout')),2000);timer.unref();})]);
  // The loop skips separately configured Creative; Fast is already loaded.
  assert.deepEqual(calls,['/load/beta']);
  manager.capabilities.routing=true;
  await bridge(req,{});
  assert.deepEqual(calls,['/load/beta']);
});
