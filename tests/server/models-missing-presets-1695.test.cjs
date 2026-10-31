'use strict';
// #1695: a deleted model must leave the router's list, not only models.ini; a preset whose file is
// gone is cleaned up (idempotently, only when the model service also reports no file); a reranker
// pointing at a missing model says so even while reranking is off. Synthetic fakes only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createModelRoutes } = require('../../server/routes/models.cjs');
const { modelAssignments } = require('../../server/model-assignments.cjs');

function routes({ installed, sections, reload = { ok: true, status: 200, body: { reloaded: true } }, scan = null, cache = new Map(), manager = {} }) {
  const sent = [], fetched = [], reloads = [];
  let presets = sections.map((s) => ({ ...s }));
  // The router lists a preset until it re-reads models.ini (the #1695 regression).
  let routerRows = installed.map((m) => ({ ...m }));
  const listedAt = [];
  // The loader's folder scan: by default one file per model that is not missing.
  const scanFiles = () => scan || installed.filter((m) => !m.missingFile).map((m) => ({ modelId: m.name, sections: [m.name] }));
  const modelManager = { enabled: true, kind: 'other', capabilities: {}, unload: async () => ({ ok: true }),
    deleteModel: async () => ({ ok: false, status: 404 }),
    reloadPresets: async (opts) => { reloads.push(opts); if (reload.ok) routerRows = routerRows.filter((m) => presets.some((p) => p.name === m.name)); return reload; }, ...manager };
  const handle = createModelRoutes({
    servedEmbeddingModels: async () => null,
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    readJson: async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
    fetchJson: async (url, init) => {
      fetched.push(`${init.method} ${url.replace('http://loader.invalid/api/v1/', '')}`);
      if (url.endsWith('/api/v1/models') && init.method === 'GET') return { ok: true, status: 200, body: { models: scanFiles() } };
      if (url.endsWith('/sections') && init.method === 'GET') return { ok: true, status: 200, body: { revision: `r${presets.length}`, sections: presets } };
      const m = /sections\/([^?]+)\?baseRevision=r(\d+)$/.exec(url);
      if (m && init.method === 'DELETE' && Number(m[2]) === presets.length) { presets = presets.filter((x) => x.name !== decodeURIComponent(m[1])); return { ok: true, status: 200, body: {} }; }
      return { ok: false, status: 409, body: {} };
    },
    env: { MODEL_LOADER_URL: 'http://loader.invalid', RERANK_MODEL: 'tiny-reranker' }, modelManager,
    getProvider: () => ({}), providerHeaders: () => ({}), DEFAULT_PROVIDER_ID: 'default',
    createVisionProbe: () => async () => ({ supported: true }),
    missingRoles: () => null, currentWorkspace: () => ({ userId: 'u1' }),
    service: { modelScanCache: cache, refreshModelScan: () => {}, autoRoles: () => null, setAutoRoles: () => {}, ensureRolesLoaded: () => {},
      servedCatalogue: async () => [], modelsInstalled: async () => { listedAt.push(cache.has('models')); return routerRows; }, deriveUserModelName: (c) => c,
      lastLoadedModel: () => null, clearLastLoadedModel: () => {}, clearRoleReferences: () => [] },
  });
  const call = async (method, p, body) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    await handle(req, { setHeader() {} }, { path: p, authn: { user: { id: 'u1', role: 'admin' } }, url: new URL('http://localhost' + p) });
    return sent.pop();
  };
  return { call, fetched, reloads, listedAt, presets: () => presets.map((p) => p.name), rows: () => routerRows.map((m) => m.name) };
}

test('#1695 deleting a missing-file model reloads the router, so the installed list no longer has it', async () => {
  const f = routes({ installed: [{ name: 'gone-e2b', labels: [], missingFile: true }, { name: 'kept', labels: [] }],
    sections: [{ name: 'gone-e2b', hasFile: false }, { name: 'kept', hasFile: true }] });
  const out = await f.call('POST', '/api/models/delete', { name: 'gone-e2b' });
  assert.equal(out.status, 200);
  assert.equal(out.body.presetRemoved, true);
  assert.equal(out.body.presetsReloaded, true);
  assert.deepEqual(f.reloads, [{ unload: false }], 'reload never unloads a running model');
  assert.deepEqual(f.rows(), ['kept']);
});

test('#1695 prune-missing removes only presets whose file is gone by both checks, then reloads; a rerun is a no-op', async () => {
  const f = routes({
    installed: [
      { name: 'gone-e2b', labels: [], missingFile: true },
      { name: 'gone-rerank', labels: ['reranking'], missingFile: true },
      { name: 'scan-says-missing', labels: [], missingFile: true }, // service still sees a file: kept
      { name: 'laya_multilingual_f16', labels: [], missingFile: true, system: true },
      { name: 'kept', labels: [] }, { name: 'kept-2', labels: [] }, { name: 'kept-3', labels: [] },
    ],
    sections: [{ name: 'gone-e2b', hasFile: false }, { name: 'gone-rerank', hasFile: false }, { name: 'scan-says-missing', hasFile: true },
      { name: 'laya_multilingual_f16', hasFile: false }, { name: 'kept', hasFile: true }, { name: 'kept-2', hasFile: true }, { name: 'kept-3', hasFile: true }],
  });
  const first = await f.call('POST', '/api/models/prune-missing');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.removed, ['gone-e2b', 'gone-rerank']);
  assert.deepEqual(first.body.kept, ['scan-says-missing']);
  assert.equal(first.body.reloaded, true);
  assert.deepEqual(f.presets(), ['scan-says-missing', 'laya_multilingual_f16', 'kept', 'kept-2', 'kept-3']);
  assert.deepEqual(f.rows(), ['scan-says-missing', 'laya_multilingual_f16', 'kept', 'kept-2', 'kept-3']);
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

// #1698: the scan and hasFile share one models folder, so a dropped share makes both say "gone".
const many = (missing, present) => ({
  installed: [...missing.map((name) => ({ name, labels: [], missingFile: true })), ...present.map((name) => ({ name, labels: [] }))],
  sections: [...missing.map((name) => ({ name, hasFile: false })), ...present.map((name) => ({ name, hasFile: true }))],
});

test('#1698 an empty folder scan with every hasFile false removes nothing (409 scanUntrusted)', async () => {
  const f = routes({ ...many(['a', 'b', 'c'], []), scan: [] });
  const out = await f.call('POST', '/api/models/prune-missing');
  assert.equal(out.status, 409);
  assert.equal(out.body.code, 'scanUntrusted');
  assert.deepEqual(f.presets(), ['a', 'b', 'c']);
  assert.ok(!f.fetched.some((x) => x.startsWith('DELETE')));
  assert.equal(f.reloads.length, 0);
});

test('#1698 a majority of presets missing is refused (409), nothing removed', async () => {
  const f = routes(many(['a', 'b', 'c'], ['d', 'e']));
  const out = await f.call('POST', '/api/models/prune-missing');
  assert.equal(out.status, 409);
  assert.equal(out.body.code, 'scanUntrusted');
  assert.deepEqual(f.presets(), ['a', 'b', 'c', 'd', 'e']);
  assert.ok(!f.fetched.some((x) => x.startsWith('DELETE')));
});

test('#1698 one missing preset out of several is pruned', async () => {
  const f = routes(many(['a'], ['b', 'c', 'd']));
  const out = await f.call('POST', '/api/models/prune-missing');
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.removed, ['a']);
  assert.deepEqual(f.presets(), ['b', 'c', 'd']);
});

test('#1698 a stale cached scan is dropped before the prune reads anything', async () => {
  const cache = new Map([['models', { at: 0, body: { models: [] } }]]);   // a cached glitch: empty folder
  const f = routes({ ...many(['a'], ['b', 'c']), cache });
  const out = await f.call('POST', '/api/models/prune-missing');
  assert.equal(cache.has('models'), false, 'the cached scan is cleared');
  assert.deepEqual(f.listedAt, [false], 'the installed list was read with no cached scan behind it');
  assert.ok(f.fetched.includes('GET models'), 'a fresh scan was asked for');
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.removed, ['a']);
});

// #2219: a hold that is refused means models.ini is not written.
const refusedHold = { writePresets: async () => { throw Object.assign(Error('busy'), { status: 409, holdRefused: true }); } };
const gone = { installed: [{ name: 'gone-e2b', labels: [], missingFile: true }, { name: 'a', labels: [] }, { name: 'b', labels: [] }],
  sections: [{ name: 'gone-e2b', hasFile: false }, { name: 'a', hasFile: true }, { name: 'b', hasFile: true }] };
const wrote = (f) => f.fetched.filter((c) => c.startsWith('DELETE '));

test('#2219 a refused hold: delete and prune leave models.ini alone and say to retry', async () => {
  const del = routes({ ...gone, manager: refusedHold });
  const out = await del.call('POST', '/api/models/delete', { name: 'gone-e2b' });
  assert.equal(out.status, 409);
  assert.equal(out.body.code, 'maintenance_held');
  assert.equal(out.body.retryable, true);
  assert.deepEqual(wrote(del), []);
  assert.equal(del.presets().length, 3);

  const prune = routes({ ...gone, manager: refusedHold });
  const pruned = await prune.call('POST', '/api/models/prune-missing', {});
  assert.equal(pruned.status, 409);
  assert.equal(pruned.body.code, 'maintenance_held');
  assert.deepEqual(wrote(prune), []);
  assert.deepEqual(prune.reloads, []);
});

test('#2219 a file already deleted with the hold refused: the delete stands, the preset waits for a retry', async () => {
  const f = routes({ installed: [{ name: 'm', labels: [] }], sections: [{ name: 'm', hasFile: true }],
    manager: { ...refusedHold, removeModel: async () => ({ ok: true, unloaded: false }) } });
  const out = await f.call('POST', '/api/models/delete', { name: 'm' });
  assert.equal(out.status, 200);
  assert.equal(out.body.presetRemoved, false);
  assert.equal(out.body.presetBusy, true);
  assert.deepEqual(wrote(f), []);
});

test('#2219 delete and prune write and reload inside one hold', async () => {
  for (const [p, body] of [['/api/models/delete', { name: 'gone-e2b' }], ['/api/models/prune-missing', {}]]) {
    const steps = [];
    let f;
    const writePresets = async (write, reloadIf) => {
      steps.push('hold');
      const written = await write();
      steps.push(`wrote ${wrote(f).length}`);
      const reload = reloadIf(written) ? (steps.push('reload'), { ok: true }) : null;
      steps.push('release');
      return { written, reload };
    };
    f = routes({ ...gone, manager: { writePresets } });
    const out = await f.call('POST', p, body);
    assert.equal(out.status, 200, p);
    assert.deepEqual(steps, ['hold', 'wrote 1', 'reload', 'release'], p);
    assert.deepEqual(f.reloads, [], 'not the separate reload, which would need its own hold');
    assert.equal(out.body.presetsReloaded ?? out.body.reloaded, true, p);
  }
});
