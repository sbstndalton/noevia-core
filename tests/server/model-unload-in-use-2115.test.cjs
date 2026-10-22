'use strict';
// sbstndalton/noevia#2115: the inference gate refuses to unload or delete a model that is answering a request. The
// Models page gets the gate's code (model_in_use), whether an admin may unload it anyway, and the plain text; the
// admin's "unload anyway" (force) needs the gate's admin token on this server. Synthetic fakes only: no model server.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createModelRoutes } = require('../../server/routes/models.cjs');

const IN_USE = { ok: false, status: 409, body: { error: { code: 'model_in_use', message: 'The model is answering a request. Unload it when it is idle, or unload it anyway as an admin.', type: 'gate_error', retryable: true } } };

function routes(manager, role = 'admin') {
  const sent = [];
  const modelManager = { enabled: true, kind: 'llamacpp', capabilities: {}, ...manager };
  const handle = createModelRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    readJson: async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
    fetchJson: async () => ({ ok: true, status: 200, body: { models: [] } }),
    env: {}, modelManager,
    getProvider: () => ({}), providerHeaders: () => ({}), DEFAULT_PROVIDER_ID: 'default',
    createVisionProbe: () => async () => ({ supported: true }),
    missingRoles: () => null, currentWorkspace: () => ({ userId: 'u1' }),
    service: { modelScanCache: new Map(), refreshModelScan: () => {}, autoRoles: () => null, setAutoRoles: () => {}, ensureRolesLoaded: () => {},
      servedCatalogue: async () => [], modelsInstalled: async () => [], modelsInstalledNow: async () => [], deriveUserModelName: (c) => c,
      lastLoadedModel: () => null, clearLastLoadedModel: () => {}, clearRoleReferences: () => [] },
  });
  const call = (p, body) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = 'POST';
    return handle(req, { setHeader() {} }, { path: p, authn: { user: { id: 'u1', role } }, url: new URL('http://localhost' + p) });
  };
  return { call, sent };
}

test('an unload the gate refuses because the model is in use answers 409 model_in_use, and says whether an admin may force it', async () => {
  for (const admin of [false, true]) {
    let forced = 0;
    const f = routes({ unload: async () => IN_USE, unloadAnyway: async () => { forced++; return { ok: true, status: 200, body: {} }; }, gateAdmin: () => admin });
    await f.call('/api/models/unload', { name: 'route-code' });
    assert.deepEqual(f.sent.pop(), { status: 409, body: { error: IN_USE.body.error.message, code: 'model_in_use', retryable: true, canForce: admin } });
    assert.equal(forced, 0, 'never forced without the admin asking');
  }
});

test('"unload anyway" goes through the forced path; without the gate\'s admin token it is refused', async () => {
  let plain = 0, forced = 0;
  const f = routes({ unload: async () => { plain++; return IN_USE; }, unloadAnyway: async () => { forced++; return { ok: true, status: 200, body: { success: true } }; } });
  await f.call('/api/models/unload', { name: 'route-code', force: true });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true, forced: true } });
  assert.equal(forced, 1); assert.equal(plain, 0);
  const noToken = routes({ unloadAnyway: async () => ({ ok: false, status: 403, body: { error: 'Unloading a model in use is not set up on this server.', code: 'admin_required' } }) });
  await noToken.call('/api/models/unload', { name: 'route-code', force: true });
  assert.deepEqual(noToken.sent.pop(), { status: 403, body: { error: 'Unloading a model in use is not set up on this server.', code: 'admin_required', retryable: false } });
  // `force` must be exactly true; anything else is a plain unload.
  const loose = routes({ unload: async () => IN_USE, unloadAnyway: async () => { throw Error('must not force'); } });
  await loose.call('/api/models/unload', { name: 'route-code', force: 'yes' });
  assert.equal(loose.sent.pop().body.code, 'model_in_use');
});

test('members never reach unload or its forced path', async () => {
  let calls = 0;
  const f = routes({ unload: async () => { calls++; return IN_USE; }, unloadAnyway: async () => { calls++; return { ok: true }; } }, 'member');
  await f.call('/api/models/unload', { name: 'route-code', force: true });
  assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'administrator required' } });
  assert.equal(calls, 0);
});

test('a load the gate or the budget refuses keeps its status, code and text', async () => {
  const f = routes({ load: async () => ({ ok: false, status: 503, body: { error: 'Another chat was still using the local model. Try again when it has finished.', code: 'inference_queue_timeout', retryable: true } }) });
  await f.call('/api/models/load', { name: 'route-smart' });
  assert.deepEqual(f.sent.pop(), { status: 503, body: { error: 'Another chat was still using the local model. Try again when it has finished.', code: 'inference_queue_timeout', retryable: true } });
  // Anything that is not a refusal keeps the old answer.
  const g = routes({ load: async () => ({ ok: false, status: 500, body: { error: 'synthetic' } }) });
  await g.call('/api/models/load', { name: 'route-smart' });
  assert.deepEqual(g.sent.pop(), { status: 502, body: { error: 'load failed: 500' } });
});
