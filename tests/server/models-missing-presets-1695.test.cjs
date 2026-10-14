'use strict';
// #1695: a deleted model must leave the router's list, not only models.ini; a preset whose file is
// gone is cleaned up (idempotently, only when the model service also reports no file); a reranker
// pointing at a missing model says so even while reranking is off. Synthetic fakes only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createModelRoutes } = require('../../server/routes/models.cjs');
const { modelAssignments } = require('../../server/model-assignments.cjs');

function routes({ installed, sections, reload = { ok: true, status: 200, body: { reloaded: true } } }) {
  const sent = [], fetched = [], reloads = [];
  let presets = sections.map((s) => ({ ...s }));
  // The router lists a preset until it re-reads models.ini (the #1695 regression).
  let routerRows = installed.map((m) => ({ ...m }));
  const modelManager = { enabled: true, kind: 'other', capabilities: {}, unload: async () => ({ ok: true }),
    deleteModel: async () => ({ ok: false, status: 404 }),
    reloadPresets: async (opts) => { reloads.push(opts); if (reload.ok) routerRows = routerRows.filter((m) => presets.some((p) => p.name === m.name)); return reload; } };
  const handle = createModelRoutes({
    servedEmbeddingModels: async () => null,
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    readJson: async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
    fetchJson: async (url, init) => {
      fetched.push(`${init.method} ${url.replace('http://loader.invalid/api/v1/', '')}`);
      if (url.endsWith('/sections') && init.method === 'GET') return { ok: true, status: 200, body: { revision: `r${presets.length}`, sections: presets } };
      const m = /sections\/([^?]+)\?baseRevision=r(\d+)$/.exec(url);
      if (m && init.method === 'DELETE' && Number(m[2]) === presets.length) { presets = presets.filter((x) => x.name !== decodeURIComponent(m[1])); return { ok: true, status: 200, body: {} }; }
      return { ok: false, status: 409, body: {} };
    },
    env: { MODEL_LOADER_URL: 'http://loader.invalid', RERANK_MODEL: 'tiny-reranker' }, modelManager,
    getProvider: () => ({}), providerHeaders: () => ({}), DEFAULT_PROVIDER_ID: 'default',
    createVisionProbe: () => async () => ({ supported: true }), reportedTokenRate: () => null,
    missingRoles: () => null, currentWorkspace: () => ({ userId: 'u1' }),
    service: { modelScanCache: new Map(), refreshModelScan: () => {}, autoRoles: () => null, setAutoRoles: () => {}, ensureRolesLoaded: () => {},
      servedCatalogue: async () => [], modelsInstalled: async () => routerRows, deriveUserModelName: (c) => c,
      lastLoadedModel: () => null, clearLastLoadedModel: () => {}, clearRoleReferences: () => [] },
  });
  const call = async (method, p, body) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    await handle(req, { setHeader() {} }, { path: p, authn: { user: { id: 'u1', role: 'admin' } }, url: new URL('http://localhost' + p) });
    return sent.pop();
  };
  return { call, fetched, reloads, presets: () => presets.map((p) => p.name), rows: () => routerRows.map((m) => m.name) };
}

test('#1695 deleting a missing-file model reloads the router, so the installed list no longer has it', async () => {
  const f = routes({ installed: [{ name: 'gone-e2b', labels: [], missingFile: true }, { name: 'kept', labels: [] }],
    sections: [{ name: 'gone-e2b', hasFile: false }, { name: 'kept', hasFile: true }] });
  const out = await f.call('POST', '/api/models/delete', { name: 'gone-e2b' });
  assert.equal(out.status, 200);
  assert.equal(out.body.presetRemoved, true);
  assert.equal(out.body.presetsReloaded, true);
  assert.deepEqual(f.reloads, [{ unload: false }], 'reload never unloads a running model');
  const listed = await f.call('GET', '/api/models/installed');
  assert.deepEqual(listed.body.map((m) => m.name), ['kept']);
});

test('#1695 prune-missing removes only presets whose file is gone by both checks, then reloads; a rerun is a no-op', async () => {
  const f = routes({
    installed: [
      { name: 'gone-e2b', labels: [], missingFile: true },
      { name: 'gone-rerank', labels: ['reranking'], missingFile: true },
      { name: 'scan-says-missing', labels: [], missingFile: true }, // service still sees a file: kept
      { name: 'laya_multilingual_f16', labels: [], missingFile: true, system: true },
      { name: 'kept', labels: [] },
    ],
    sections: [{ name: 'gone-e2b', hasFile: false }, { name: 'gone-rerank', hasFile: false }, { name: 'scan-says-missing', hasFile: true },
      { name: 'laya_multilingual_f16', hasFile: false }, { name: 'kept', hasFile: true }],
  });
  const first = await f.call('POST', '/api/models/prune-missing');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.removed, ['gone-e2b', 'gone-rerank']);
  assert.deepEqual(first.body.kept, ['scan-says-missing']);
  assert.equal(first.body.reloaded, true);
  assert.deepEqual(f.presets(), ['scan-says-missing', 'laya_multilingual_f16', 'kept']);
  assert.deepEqual(f.rows(), ['scan-says-missing', 'laya_multilingual_f16', 'kept']);
  const before = f.fetched.length;
  const second = await f.call('POST', '/api/models/prune-missing');
  assert.deepEqual(second.body.removed, []);
  assert.equal(second.body.reloaded, false);
  assert.ok(!f.fetched.slice(before).some((x) => x.startsWith('DELETE')), 'second run deletes nothing');
  assert.equal(f.reloads.length, 1, 'second run does not reload');
});

test('#1695 prune-missing is POST-only', async () => {
  const f = routes({ installed: [], sections: [] });
  assert.equal((await f.call('GET', '/api/models/prune-missing')).status, 405);
});

test('#1695 a configured reranker whose file is gone reads "missing", not "off", while reranking is off', () => {
  const installed = [{ name: 'chat', labels: [] }, { name: 'tiny-reranker', labels: ['reranking'], missingFile: true }];
  const off = modelAssignments({ installed, env: { RERANK_MODEL: 'tiny-reranker' } }).services.find((s) => s.id === 'reranker');
  assert.equal(off.state, 'missing');
  const pruned = modelAssignments({ installed: [installed[0]], env: { RERANK_MODEL: 'tiny-reranker' } }).services.find((s) => s.id === 'reranker');
  assert.equal(pruned.state, 'missing', 'still missing after its preset was removed');
  const fine = modelAssignments({ installed: [{ name: 'tiny-reranker', labels: ['reranking'] }], env: { RERANK_MODEL: 'tiny-reranker' } }).services.find((s) => s.id === 'reranker');
  assert.equal(fine.state, 'off', 'a present reranker with reranking off is still just off');
});
