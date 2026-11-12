'use strict';
// R3-0 shim: Node no longer clears the last-loaded model or the identity cache by itself; it asks the
// Rust front (project-store `model-state/forget`), which clears its copies and then calls back
// `/internal/model-state/forget` here. Node's own clear is only the fallback when the front does not
// answer (an older front, or an outage), so a delete never throws after the engine file is gone.
const test = require('node:test'), assert = require('node:assert/strict');
const { createModelService } = require('./models.cjs');
const { createBridge } = require('./rust-model-state-bridge.cjs');

function fixture({ writer } = {}) {
  const forgotten = [];
  const modelManager = {
    enabled: true, capabilities: { routing: false }, requireEnabled() {},
    listModels: async () => ({ ok: true, status: 200, body: { data: [{ id: 'qa-gone' }] } }),
    health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'qa-gone', loaded: true }] } }),
    forgetIdentity: (name) => forgotten.push(name),
  };
  const service = createModelService({ env: {}, modelManager, currentWorkspace: () => ({}), modelStateWriter: writer });
  return { service, forgotten };
}

test('with the front answering and clearing Node, Node writes nothing itself', async () => {
  const asked = [];
  const { service, forgotten } = fixture({ writer: async (name) => { asked.push(name); return { lastLoadedCleared: true, nodeCleared: true }; } });
  await service.modelsInstalled();
  assert.equal(service.lastLoadedModel(), 'qa-gone');
  await service.forgetModelState('qa-gone');
  assert.deepEqual(asked, ['qa-gone']);
  assert.equal(service.lastLoadedModel(), 'qa-gone', 'the front clears it through the bridge, not this call');
  assert.deepEqual(forgotten, []);
});

test('without a front writer, or when it fails or reports Node uncleared, Node clears its own copy and never throws', async () => {
  for (const writer of [undefined, async () => { throw new Error('front down'); }, async () => ({ lastLoadedCleared: false, nodeCleared: false }), async () => null]) {
    const { service, forgotten } = fixture({ writer });
    await service.modelsInstalled();
    await service.forgetModelState('qa-gone');
    assert.equal(service.lastLoadedModel(), null);
    assert.deepEqual(forgotten, ['qa-gone']);
  }
});

test('a different name leaves the last-loaded model alone in the fallback', async () => {
  const { service, forgotten } = fixture();
  await service.modelsInstalled();
  await service.forgetModelState('qa-other');
  assert.equal(service.lastLoadedModel(), 'qa-gone');
  assert.deepEqual(forgotten, ['qa-other']);
});

test('the bridge authenticates the front, validates the body and clears only Node\'s copies', async () => {
  const { service, forgotten } = fixture();
  await service.modelsInstalled();
  const bridge = createBridge({ secret: 'synthetic-secret', json: (res, status, body) => Object.assign(res, { status, body }), readJson: async (req) => req.body, service });
  const call = async (body, extra = {}, url = '/internal/model-state/forget') => { const res = {}; const handled = await bridge({ method: 'POST', url, body, headers: { 'x-noevia-store-token': 'synthetic-secret' }, socket: { remoteAddress: '127.0.0.1' }, ...extra }, res); return { handled, res }; };
  assert.equal((await call({ name: 'qa-gone' }, {}, '/api/other')).handled, false);
  for (const extra of [{ headers: {} }, { socket: { remoteAddress: '192.0.2.1' } }, { headers: { 'x-noevia-store-token': 'synthetic-secret', 'x-forwarded-for': '' } }, { method: 'GET' }]) {
    const { res } = await call({ name: 'qa-gone' }, extra);
    assert.equal(res.status, 404);
  }
  for (const body of [null, {}, { name: '' }, { name: 3 }, { name: 'a', extra: 1 }, [], 'x']) {
    assert.equal((await call(body)).res.status, 400, JSON.stringify(body));
  }
  assert.equal(service.lastLoadedModel(), 'qa-gone');
  assert.deepEqual(forgotten, []);
  const { res } = await call({ name: 'qa-gone' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(service.lastLoadedModel(), null);
  assert.deepEqual(forgotten, ['qa-gone']);
});

test('the store client asks the front on model-state/forget and returns its answer', async () => {
  const { createClient } = require('./project-store-client.cjs');
  const seen = [];
  const client = createClient({ port: 4000, token: 'x'.repeat(40), fetchImpl: async (url, init) => { seen.push([url, JSON.parse(init.body)]); return new Response('{"lastLoadedCleared":true,"nodeCleared":true}', { status: 200, headers: { 'content-type': 'application/json' } }); } });
  assert.deepEqual(await client.forgetModelState('qa-gone'), { lastLoadedCleared: true, nodeCleared: true });
  assert.deepEqual(seen, [['http://127.0.0.1:4000/v1/model-state/forget', { name: 'qa-gone' }]]);
  const bad = createClient({ port: 4000, token: 'x'.repeat(40), fetchImpl: async () => new Response('{}', { status: 500 }) });
  await assert.rejects(bad.forgetModelState('qa-gone'));
});
