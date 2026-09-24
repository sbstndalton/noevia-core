'use strict';
// The model routes over a fake adapter and service: the administrator gate on every write,
// the proxy with its cached folder scan, and the words each refusal keeps. The numbers and
// the role config are models.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createModelRoutes } = require('./models.cjs');

function fixture({ env = {}, enabled = true, kind = 'llamacpp', manager = {}, workspace = { userId: 'u1' }, catalogue = [{ name: 'm' }], servedCatalogue = async () => catalogue } = {}) {
  const sent = [], headers = [], fetched = [];
  const scan = new Map();
  let refreshes = 0;
  const roles = { current: null };
  const modelManager = {
    enabled, kind, capabilities: { routing: true },
    stats: async () => ({ ok: true, body: { scope: 'engine', tokens_per_second: 41.5, mtp: [] } }),
    systemStats: async () => ({ ok: true, body: { cpu_percent: 12, vram_gb: 7.5 } }),
    health: async () => ({ ok: true, body: { all_models_loaded: [] } }),
    metrics: async () => ({ ok: false }),
    listModels: async () => ({ ok: true, body: { data: [] } }),
    downloads: async () => ({ ok: true, body: { jobs: [{ id: 'j1', model_name: 'm', percent: 40, status: 'running' }] } }),
    pull: async ({ modelName }) => ({ ok: true, body: { id: 'pull-1', modelName } }),
    deleteModel: async () => ({ ok: false, status: 500 }),
    load: async () => ({ ok: true }), unload: async () => ({ ok: true }),
    ...manager,
  };
  const routes = createModelRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    readJson: async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
    fetchJson: async (url, init) => { fetched.push({ url, init }); return { ok: true, status: 200, body: { models: ['a'] } }; },
    env, modelManager,
    getProvider: () => ({ baseUrl: 'http://engine', apiKey: 'local' }), providerHeaders: () => ({}), DEFAULT_PROVIDER_ID: 'default',
    createVisionProbe: () => async () => ({ supported: true }),
    reportedTokenRate: (g) => g.tokens_per_second ?? null,
    missingRoles: (r, catalogue) => ({ roles: r, catalogue }),
    currentWorkspace: () => workspace,
    service: {
      modelScanCache: scan, refreshModelScan: () => { refreshes += 1; },
      autoRoles: () => roles.current, setAutoRoles: (next) => { roles.current = next; }, ensureRolesLoaded: () => { roles.warmed = true; },
      servedCatalogue, modelsInstalled: async () => [{ name: 'm', loaded: true }],
      deriveUserModelName: (c) => `user.${c}`,
    },
  });
  const call = (method, path, body, role = 'member', search = '') => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    req.method = method;
    const res = { setHeader: (k, v) => headers.push([k, v]) };
    return routes(req, res, { path, authn: { user: { id: 'u1', role } }, url: new URL(`http://localhost${path}${search}`) });
  };
  return { call, sent, headers, fetched, scan, refreshes: () => refreshes, roles };
}

test('every write under /api/models/ is refused for members before anything else is looked at', async () => {
  const f = fixture();
  assert.equal(await f.call('POST', '/api/models/anything-at-all'), true);
  assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'administrator required' } });
  assert.equal(await f.call('GET', '/api/models/downloads'), true, 'reads stay open to members');
  assert.deepEqual(f.sent.pop(), { status: 200, body: [{ id: 'j1', model: 'm', progress: 0.4, status: 'running' }] });
  assert.equal(await f.call('GET', '/api/model'), false);
  assert.equal(await f.call('DELETE', '/api/auto-roles'), false, 'an unhandled method keeps falling through');
});

test('stats and capabilities read the adapter; the roles round-trip and warm up', async () => {
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' } });
  await f.call('GET', '/api/stats');
  const stats = f.sent.pop();
  assert.equal(stats.status, 200);
  assert.equal(stats.body.up, true);
  assert.equal(stats.body.tokensPerSecond, 41.5);
  assert.equal(stats.body.cpuPercent, 12);
  assert.equal(stats.body.gpuPercent, null);
  await f.call('GET', '/api/models/capabilities', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { kind: 'llamacpp', enabled: true, admin: true, routing: true, modelManagement: true } });
  await f.call('GET', '/api/models/capabilities');
  assert.equal(f.sent.pop().body.modelManagement, false, 'members do not see model management');
  await f.call('GET', '/api/auto-roles');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { configured: false, roles: null, missing: { roles: null, catalogue: [{ name: 'm' }] } } });
  await f.call('PUT', '/api/auto-roles', { fast: ' m ', smart: 'm' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { configured: true, roles: { fast: 'm', smart: 'm', vision: '', code: '' } } });
  assert.equal(f.roles.warmed, true, 'an admin save warms the roles up');
  await f.call('PUT', '/api/auto-roles', { fast: 'f' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'both fast and smart model names are required' } });
  await f.call('PUT', '/api/auto-roles', '{');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'invalid JSON' } });
});

test('a member may save their own auto-roles but never warms the shared engine, and unknown names 400', async () => {
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' } });
  await f.call('PUT', '/api/auto-roles', { fast: 'm', smart: 'm' }, 'member');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { configured: true, roles: { fast: 'm', smart: 'm', vision: '', code: '' } } });
  assert.equal(f.roles.warmed, undefined, 'a member save never calls ensureRolesLoaded / modelManager.load');

  const bad = fixture({ env: { MODEL_LOADER_URL: 'http://loader' } });
  await bad.call('PUT', '/api/auto-roles', { fast: 'nope', smart: 'm' }, 'admin');
  assert.deepEqual(bad.sent.pop(), { status: 400, body: { error: 'unknown model(s): nope' } });
  assert.equal(bad.roles.current, null, 'a bad name is never saved either');
  assert.equal(bad.roles.warmed, undefined);

  // When the catalogue cannot be read (engine unreachable), saving is still allowed.
  const unreachable = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, servedCatalogue: async () => null });
  await unreachable.call('PUT', '/api/auto-roles', { fast: 'anything', smart: 'goes' }, 'admin');
  assert.deepEqual(unreachable.sent.pop(), { status: 200, body: { configured: true, roles: { fast: 'anything', smart: 'goes', vision: '', code: '' } } });
});

test('the model manager proxy is admin-only, validates the path and serves the cached scan', async () => {
  const unset = fixture();
  await unset.call('GET', '/api/model-manager/models', undefined, 'admin');
  assert.deepEqual(unset.sent.pop(), { status: 404, body: { error: 'Model management service is not configured' } });
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader/', MODEL_LOADER_TOKEN: 'tok' } });
  await f.call('GET', '/api/model-manager/models');
  assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'Administrator required for model management' } });
  await f.call('GET', '/api/model-manager/../secret', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'Invalid path' } });
  await f.call('GET', '/api/model-manager/models', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { models: ['a'] } });
  assert.equal(f.fetched[0].url, 'http://loader/api/v1/models');
  assert.equal(f.fetched[0].init.headers['X-Model-Loader-Token'], 'tok');
  assert.deepEqual(f.scan.get('models').body, { models: ['a'] }, 'the scan result is cached');
  f.scan.set('models', { at: Date.now() - 6000, body: { models: ['cached'] } });
  await f.call('GET', '/api/model-manager/models', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { models: ['cached'] } });
  assert.ok(f.headers.some(([k, v]) => k === 'X-Model-Scan' && v === 'cached'));
  assert.equal(f.refreshes(), 1, 'a stale hit is refreshed behind the response');
  assert.equal(f.fetched.length, 1);
  await f.call('POST', '/api/model-manager/sections/x/safe-defaults', '{}', 'admin');
  assert.equal(f.scan.has('models'), false, 'any write through the proxy drops the scan');
  assert.equal(f.fetched.length, 2);
});

test('the model-manager delete proxy rejects a system model by its scanned key, even though keys are opaque', async () => {
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' } });
  f.scan.set('models', { at: Date.now(), body: { models: [
    { key: 'k-laya', modelId: 'laya_multilingual_f16', sections: ['laya_multilingual_f16'] },
    { key: 'k-synthetic', modelId: 'synthetic', sections: ['synthetic'] },
  ] } });
  await f.call('POST', '/api/model-manager/models/delete', { models: ['k-laya'] }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'System routing model — not deleted' } });
  assert.equal(f.fetched.length, 0, 'the model management service is never called for a blocked delete');
  await f.call('POST', '/api/model-manager/models/delete', { models: ['k-synthetic'] }, 'admin');
  assert.equal(f.sent.pop().status, 200, 'an ordinary model still deletes through the proxy');
  assert.equal(f.fetched.length, 1);
});

test('the model-manager sections proxy rejects delete and rename of a Laya section, never forwarding them', async () => {
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' } });
  f.scan.set('models', { at: Date.now(), body: { models: [
    { key: 'k-laya', modelId: 'laya_multilingual_f16', sections: ['laya_multilingual_f16'] },
    { key: 'k-synthetic', modelId: 'synthetic', sections: ['synthetic'] },
  ] } });
  await f.call('DELETE', '/api/model-manager/sections/laya_multilingual_f16', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'System routing model — not deleted' } });
  assert.equal(f.fetched.length, 0, 'a blocked delete never reaches the model management service');
  f.scan.set('models', { at: Date.now(), body: { models: [
    { key: 'k-laya', modelId: 'laya_multilingual_f16', sections: ['laya_multilingual_f16'] },
    { key: 'k-synthetic', modelId: 'synthetic', sections: ['synthetic'] },
  ] } });
  await f.call('POST', '/api/model-manager/sections/laya_multilingual_f16/rename', { to: 'renamed' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'System routing model — not deleted' } });
  assert.equal(f.fetched.length, 0, 'a blocked rename never reaches the model management service');
  // A cached scan section id that only resolves to Laya through its modelId is caught too.
  f.scan.set('models', { at: Date.now(), body: { models: [
    { key: 'k-router', modelId: 'router_a', sections: ['laya-router-section'] },
  ] } });
  await f.call('DELETE', '/api/model-manager/sections/laya-router-section', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'System routing model — not deleted' } });
  assert.equal(f.fetched.length, 0);
  f.scan.set('models', { at: Date.now(), body: { models: [
    { key: 'k-synthetic', modelId: 'synthetic', sections: ['synthetic'] },
  ] } });
  await f.call('DELETE', '/api/model-manager/sections/synthetic', undefined, 'admin');
  assert.equal(f.sent.pop().status, 200, 'an ordinary section still deletes through the proxy');
  assert.equal(f.fetched.length, 1);
});

test('any write under /api/models/ drops the scan, and pull/delete/load keep their answers', async () => {
  const f = fixture();
  f.scan.set('models', { at: Date.now(), body: {} });
  await f.call('POST', '/api/models/pull', { checkpoint: 'org/m:q4' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { jobId: 'pull-1', modelName: 'user.org/m:q4' } });
  assert.equal(f.scan.has('models'), false);
  await f.call('POST', '/api/models/pull', {}, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'checkpoint required' } });
  await f.call('POST', '/api/models/delete', { name: 'm' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 502, body: { error: 'delete failed: 500' } });
  await f.call('POST', '/api/models/delete', { name: 'laya_multilingual_f16' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'System routing model — not deleted' } });
  await f.call('POST', '/api/models/load', { name: 'm', mtp: true }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'Use the native preset editor to configure speculative decoding.' } });
  await f.call('POST', '/api/models/unload', { name: 'm' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  await f.call('POST', '/api/models/load', '{', 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'invalid JSON' } });
  const off = fixture({ enabled: false });
  await off.call('POST', '/api/models/load', { name: 'm' }, 'admin');
  assert.deepEqual(off.sent.pop(), { status: 404, body: { error: 'model management is disabled' } });
  await off.call('GET', '/api/models/downloads');
  assert.deepEqual(off.sent.pop(), { status: 200, body: [] });
  await off.call('GET', '/api/models/hardware');
  assert.deepEqual(off.sent.pop(), { status: 404, body: { error: 'Model manager is disabled. Enter a memory plan manually.' } });
});

test('engine-specific routes say what is unavailable and guard the method', async () => {
  const f = fixture();
  await f.call('POST', '/api/models/presets/reload', {}, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'This engine does not use a preset file' } });
  await f.call('GET', '/api/models/presets/reload', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } });
  await f.call('GET', '/api/models/evidence', undefined, 'member', '?model=m');
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'Qualification evidence needs the native engine' } });
  await f.call('GET', '/api/models/autotune', undefined, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'Auto-tune is unavailable' } });
  await f.call('GET', '/api/models/preset', undefined, 'member');
  assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'Administrator required for shared model profiles' } });
  await f.call('GET', '/api/models/mtp-artifact', undefined, 'member', '?repo=bad');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'Invalid repository' } });
  await f.call('GET', '/api/models/installed');
  assert.deepEqual(f.sent.pop(), { status: 200, body: [{ name: 'm', loaded: true }] });
  const native = fixture({ manager: { autotune: { status: (model) => ({ status: 200, body: { model, state: 'idle' } }), cancel: () => ({ status: 200, body: { cancelled: true } }) } } });
  await native.call('GET', '/api/models/autotune', undefined, 'admin', '?model=m');
  assert.deepEqual(native.sent.pop(), { status: 200, body: { model: 'm', state: 'idle' } });
  await native.call('GET', '/api/models/autotune/cancel', undefined, 'admin');
  assert.deepEqual(native.sent.pop(), { status: 405, body: { error: 'Method not allowed' } });
  await native.call('POST', '/api/models/autotune/cancel', undefined, 'admin');
  assert.deepEqual(native.sent.pop(), { status: 200, body: { cancelled: true } });
});

test('bulk tuning discovery and start are admin-only and the server owns the queue', async () => {
  const starts = [];
  const f = fixture({ manager: { autotune: {
    untuned: async () => ({ status: 200, body: { models: ['m'], skipped: [] } }),
    start: async (model, options) => { starts.push({ model, options }); return { status: 202, body: { status: 'running' } }; },
  } } });
  await f.call('GET', '/api/models/autotune/untuned');
  assert.equal(f.sent.pop().status, 403);
  await f.call('GET', '/api/models/autotune/untuned', undefined, 'admin');
  assert.deepEqual(f.sent.pop().body.models, ['m']);
  await f.call('POST', '/api/models/autotune', { untuned: true, confirmPause: true, models: ['untrusted'] }, 'admin');
  assert.equal(f.sent.pop().status, 202);
  assert.deepEqual(starts, [{ model: '', options: { confirmPause: true, promptBudgetSeconds: undefined, untuned: true } }]);
  await f.call('POST', '/api/models/autotune/untuned', {}, 'admin');
  assert.equal(f.sent.pop().status, 405);
});

test('starting auto-tune on a system routing model (Laya) is rejected as a 4xx, even requested directly', async () => {
  const f = fixture({ manager: { autotune: {
    untuned: async () => ({ status: 200, body: { models: [], skipped: [{ model: 'laya_multilingual_f16', reason: 'System routing model — not tuned' }] } }),
    start: async (model) => model === 'laya_multilingual_f16'
      ? { status: 400, body: { error: 'System routing model — not tuned' } }
      : { status: 202, body: { status: 'running' } },
  } } });
  await f.call('POST', '/api/models/autotune', { model: 'laya_multilingual_f16', confirmPause: true }, 'admin');
  const sent = f.sent.pop();
  assert.equal(sent.status, 400);
  assert.equal(sent.body.error, 'System routing model — not tuned');
});

test('resume is admin-only, POST-only and passes renewed pause confirmation', async () => {
  const calls = [];
  const f = fixture({ manager: { autotune: {
    resume: async options => { calls.push(options); return { status: options.confirmPause ? 202 : 400, body: { resumed: options.confirmPause } }; },
  } } });
  await f.call('POST', '/api/models/autotune/resume', { confirmPause: true });
  assert.equal(f.sent.pop().status, 403);
  await f.call('GET', '/api/models/autotune/resume', undefined, 'admin');
  assert.equal(f.sent.pop().status, 405);
  await f.call('POST', '/api/models/autotune/resume', {}, 'admin');
  assert.equal(f.sent.pop().status, 400);
  await f.call('POST', '/api/models/autotune/resume', { confirmPause: true }, 'admin');
  assert.equal(f.sent.pop().status, 202);
  assert.deepEqual(calls, [{ confirmPause: undefined }, { confirmPause: true }]);
  const speedOnly = fixture({ manager: { autotune: { start: () => ({ status: 202, body: {} }) } } });
  await speedOnly.call('POST', '/api/models/autotune/resume', { confirmPause: true }, 'admin');
  assert.deepEqual(speedOnly.sent.pop(), { status: 404, body: { error: 'Resume is unavailable' } });
});

test('the default model mode round-trips, and only an explicit apply switches existing projects', async () => {
  let saves = 0;
  const workspace = { userId: 'u1', preferences: {}, projects: [{ id: 'a', routing: 'manual' }, { id: 'b', routing: 'auto' }],
    savePreferences() {}, saveProjects() { saves += 1; } };
  const f = fixture({ workspace });
  await f.call('GET', '/api/routing-default');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { routing: 'auto' } });
  await f.call('PUT', '/api/routing-default', { routing: 'manual' });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { routing: 'manual', updated: 0 } });
  assert.equal(workspace.projects[1].routing, 'auto', 'changing the default alone rewrites nothing');
  await f.call('PUT', '/api/routing-default', { routing: 'auto', applyToExisting: true });
  assert.deepEqual(f.sent.pop(), { status: 200, body: { routing: 'auto', updated: 1 } });
  assert.deepEqual(workspace.projects.map((p) => p.routing), ['auto', 'auto']);
  assert.equal(saves, 1);
  await f.call('PUT', '/api/routing-default', { routing: 'fast' });
  assert.equal(f.sent.pop().status, 400);
});

test('the benchmark start proxy refuses non-chat models with 400 and forwards chat-only suites (#206)', async () => {
  const f = fixture({ env: { MODEL_LOADER_URL: 'http://loader' }, catalogue: [{ name: 'chat-syn', labels: [] }, { name: 'vec-syn', labels: ['embeddings'] }] });
  for (const alias of ['vec-syn', 'nomic-embed-text-v1', 'qwen3-reranker-0.6b-q8_0', 'laya_multilingual_f16']) {
    await f.call('POST', '/api/model-manager/benchmark/start', { backend: 'b', aliases: ['chat-syn', alias], promptIds: [1], reps: 1 }, 'admin');
    const out = f.sent.pop();
    assert.equal(out.status, 400, alias);
    assert.match(out.body.error, new RegExp(alias.replace(/[.]/g, '\\.')));
  }
  assert.equal(f.fetched.length, 0, 'a refused suite never reaches the model management service');
  await f.call('POST', '/api/model-manager/benchmark/start', { backend: 'b', aliases: ['chat-syn'], promptIds: [1], reps: 1 }, 'admin');
  assert.equal(f.sent.pop().status, 200);
  assert.equal(f.fetched.length, 1);
});

test('the memory estimate is admin-only, read-only and validates the model name (#204)', async () => {
  const seen = [];
  const f = fixture({ manager: { estimateMemory: async (m) => { seen.push(m); return { ok: true, status: 200, body: { model: m, rows: [] } }; } } });
  await f.call('GET', '/api/models/estimate', undefined, 'member', '?model=m');
  assert.equal(f.sent.pop().status, 403);
  await f.call('POST', '/api/models/estimate', {}, 'admin', '?model=m');
  assert.equal(f.sent.pop().status, 405);
  await f.call('GET', '/api/models/estimate', undefined, 'admin', '');
  assert.equal(f.sent.pop().status, 400);
  await f.call('GET', '/api/models/estimate', undefined, 'admin', '?model=m');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { model: 'm', rows: [] } });
  assert.deepEqual(seen, ['m']);
  assert.equal(f.scan.size, 0);
  const none = fixture();
  await none.call('GET', '/api/models/estimate', undefined, 'admin', '?model=m');
  assert.equal(none.sent.pop().status, 404);
  const boom = fixture({ manager: { estimateMemory: async () => { throw Error('/secret/path exploded'); } } });
  const orig = console.error; console.error = () => {};
  try { await boom.call('GET', '/api/models/estimate', undefined, 'admin', '?model=m'); } finally { console.error = orig; }
  assert.deepEqual(boom.sent.pop(), { status: 500, body: { error: 'Could not estimate memory for this model.' } });
});

test('evidence import (#266) is admin-only, validates the model, and always reports current evidence back', async () => {
  const calls = [];
  const f = fixture({
    manager: {
      importEvidence: async (model, opts) => { calls.push([model, opts]); return { ok: true }; },
      evidence: async (model) => ({ status: 200, body: { model, external: { category: 'external_model_card', state: 'reported' } } }),
    },
  });
  await f.call('POST', '/api/models/evidence/import', { model: 'm' }, 'member');
  assert.deepEqual(f.sent.pop(), { status: 403, body: { error: 'administrator required' } });
  await f.call('GET', '/api/models/evidence/import', { model: 'm' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 405, body: { error: 'Method not allowed' } });
  await f.call('POST', '/api/models/evidence/import', {}, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'Choose a model' } });
  await f.call('POST', '/api/models/evidence/import', { model: 'm', checkpoint: 'acme/model-7b' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { model: 'm', external: { category: 'external_model_card', state: 'reported' } } });
  assert.deepEqual(calls, [['m', { checkpoint: 'acme/model-7b' }]]);

  const none = fixture();
  await none.call('POST', '/api/models/evidence/import', { model: 'm' }, 'admin');
  assert.deepEqual(none.sent.pop(), { status: 404, body: { error: 'Model evidence import needs the native engine' } });
});

test('evidence import never throws through the route when the source lookup fails', async () => {
  const f = fixture({
    manager: {
      importEvidence: async () => { throw Error('source unavailable'); },
      evidence: async (model) => ({ status: 200, body: { model, external: { state: 'unavailable' } } }),
    },
  });
  await f.call('POST', '/api/models/evidence/import', { model: 'm' }, 'admin');
  assert.deepEqual(f.sent.pop(), { status: 200, body: { model: 'm', external: { state: 'unavailable' } } });
});
