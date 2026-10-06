'use strict';
// System-model guards on the delete and autotune paths, and client-safe error messages.
// Synthetic fakes only: no model server, no model runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Readable } = require('node:stream');
const { createModelRoutes } = require('../../server/routes/models.cjs');
const { createFullAutotuner, newModel } = require('../../server/llamacpp-full-autotune.cjs');

const LAYA_KEY = 'files/laya_multilingual_f16.gguf';
const SCAN = { models: [{ key: LAYA_KEY, modelId: 'laya_multilingual_f16', sections: [] }, { key: 'files/other.gguf', modelId: 'other', sections: [] }] };

function routes({ manager = {}, loader = async () => ({ ok: true, status: 200, body: SCAN }) } = {}) {
  const sent = [], fetched = [], scan = new Map();
  const modelManager = { enabled: true, kind: 'llamacpp', capabilities: {}, deleteModel: async () => ({ ok: true }), unload: async () => ({ ok: true }), ...manager };
  const handle = createModelRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    readJson: async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
    fetchJson: async (url, init) => { fetched.push({ url, method: init.method }); return loader(url, init); },
    env: { MODEL_LOADER_URL: 'http://loader.invalid' }, modelManager,
    getProvider: () => ({}), providerHeaders: () => ({}), DEFAULT_PROVIDER_ID: 'default',
    createVisionProbe: () => async () => ({ supported: true }), reportedTokenRate: () => null,
    missingRoles: () => null, currentWorkspace: () => ({ userId: 'u1' }),
    service: { modelScanCache: scan, refreshModelScan: () => {}, autoRoles: () => null, setAutoRoles: () => {}, ensureRolesLoaded: () => {},
      servedCatalogue: async () => [], modelsInstalled: async () => { throw Error('ENOENT /secret/path/models.ini'); }, deriveUserModelName: c => c,
      lastLoadedModel: () => null, clearLastLoadedModel: () => {}, clearRoleReferences: () => [] },
  });
  const call = (method, p, body) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    return handle(req, { setHeader() {} }, { path: p, authn: { user: { id: 'u1', role: 'admin' } }, url: new URL('http://localhost' + p) });
  };
  return { call, sent, fetched, scan };
}

test('model-manager delete of Laya is refused even when the scan cache was just cleared', async () => {
  const f = routes();
  await f.call('POST', '/api/models/unload', { name: 'x' }); // any /api/models write clears the cache
  assert.equal(f.scan.size, 0);
  await f.call('POST', '/api/model-manager/models/delete', { models: [LAYA_KEY] });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'System routing model — not deleted' } });
  assert.deepEqual(f.fetched.map(x => x.method), ['GET'], 'scanned first, never forwarded the delete');
});

test('model-manager delete refuses with 409 when the scan cannot be read', async () => {
  const f = routes({ loader: async () => null });
  await f.call('POST', '/api/model-manager/models/delete', { models: [LAYA_KEY] });
  assert.equal(f.sent.pop().status, 409);
  assert.equal(f.fetched.length, 1);
});

test('model-manager delete of a non-system file still goes through after a fresh scan', async () => {
  const f = routes();
  await f.call('POST', '/api/model-manager/models/delete', { models: ['files/other.gguf'] });
  assert.equal(f.sent.pop().status, 200);
  assert.deepEqual(f.fetched.map(x => x.method), ['GET', 'POST']);
});

test('/api/models/delete refuses a neutral id whose --model path is Laya', async () => {
  let deleted = 0;
  const f = routes({ manager: {
    request: async () => ({ ok: true, body: { data: [{ id: 'router-a', status: { args: ['--model', '/models/laya_multilingual_f16.gguf'] } }, { id: 'plain', status: { args: ['-m', '/models/plain.gguf'] } }] } }),
    deleteModel: async () => { deleted++; return { ok: true }; },
  } });
  await f.call('POST', '/api/models/delete', { name: 'router-a' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'System routing model — not deleted' } });
  await f.call('POST', '/api/models/delete', { name: 'plain' });
  assert.equal(f.sent.pop().status, 200);
  assert.equal(deleted, 1);
});

test('/api/models/delete refuses with 409 when the router listing is unavailable', async () => {
  const f = routes({ manager: { request: async () => { throw Error('down'); } } });
  await f.call('POST', '/api/models/delete', { name: 'router-a' });
  assert.equal(f.sent.pop().status, 409);
});

test('internal error text is not sent to the client', async (t) => {
  t.mock.method(console, 'error', () => {});
  const f = routes({ manager: { reloadPresets: async () => { throw Error('EACCES /secret/models.ini'); } } });
  await f.call('GET', '/api/models/installed');
  assert.deepEqual(f.sent.pop(), { status: 502, body: { error: 'Could not list installed models.' } });
  await f.call('POST', '/api/models/presets/reload', {});
  assert.deepEqual(f.sent.pop(), { status: 500, body: { error: 'Could not reload model profiles.' } });
});

function tuner(t, rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-tune-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'tune.json');
  return { stateFile, make: () => createFullAutotuner({
    request: async () => ({ ok: true, body: {} }), rawModels: rows,
    presets: { snapshot: () => ({ revision: 'r1' }), get: () => ({ exists: true, defaults: {}, options: {} }) },
    maintenance: { enter: () => () => {} }, applyUnlocked: async () => ({ ok: true }), identityFor: async m => ({ model: m }), stateFile,
  }) };
}

test('resume drops a queued model whose --model path is Laya even under a neutral id', async (t) => {
  const f = tuner(t, async () => ({ ok: true, body: { data: [{ id: 'router-a', status: { args: ['--model', '/m/Laya_Multilingual_F16.gguf'] } }] } }));
  const job = { id: 'j', status: 'interrupted', _revision: 'r1', model: 'router-a', bulk: true, log: [], queueProgress: { done: 0, total: 1 }, models: [newModel('router-a')] };
  fs.writeFileSync(f.stateFile, JSON.stringify({ history: {}, job }));
  const r = await f.make().resume({ confirmPause: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'passed');
  assert.deepEqual(r.body.skipped, [{ model: 'router-a', reason: 'System routing model — not tuned' }]);
});

test('autotune hides raw exception text and keeps public messages', async (t) => {
  t.mock.method(console, 'error', () => {});
  const broken = tuner(t, async () => { throw Error('connect ECONNREFUSED 10.0.0.1:8080'); });
  assert.deepEqual((await broken.make().untuned()).body, { error: 'Could not list untuned models.' });
  const down = tuner(t, async () => ({ ok: false }));
  assert.deepEqual((await down.make().untuned()).body, { error: 'The model server is not responding.' });
});
