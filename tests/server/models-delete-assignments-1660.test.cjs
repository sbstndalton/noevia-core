'use strict';
// #1660/#1661/#1662: every model can be deleted (Laya with an explicit confirm, an in-use
// sidecar model refused with the service named), a delete also removes the models.ini preset,
// a "File missing" preset deletes by removing its section, and /api/models/assignments lists
// what each service uses. Synthetic fakes only: no model server, no model runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createModelRoutes } = require('../../server/routes/models.cjs');
const { modelAssignments, embeddingProfileFor, serviceUsing } = require('../../server/model-assignments.cjs');

function routes({ installed = [], env = {}, routerDelete = { ok: true, status: 200 }, sections = ['plain', 'orphan'], role = 'admin' } = {}) {
  const sent = [], fetched = [], deleted = [];
  let presets = [...sections];
  const modelManager = { enabled: true, kind: 'other', capabilities: {}, unload: async () => ({ ok: true }),
    deleteModel: async (name) => { deleted.push(name); return routerDelete; } };
  const handle = createModelRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    readJson: async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; },
    fetchJson: async (url, init) => {
      fetched.push(`${init.method} ${url.replace('http://loader.invalid/api/v1/', '')}`);
      if (url.endsWith('/sections') && init.method === 'GET') return { ok: true, status: 200, body: { revision: 'r7', sections: presets.map((name) => ({ name })) } };
      const m = /sections\/([^?]+)\?baseRevision=r7$/.exec(url);
      if (m && init.method === 'DELETE') { presets = presets.filter((x) => x !== decodeURIComponent(m[1])); return { ok: true, status: 200, body: { revision: 'r8' } }; }
      return { ok: false, status: 404, body: {} };
    },
    env: { MODEL_LOADER_URL: 'http://loader.invalid', ...env }, modelManager,
    getProvider: () => ({}), providerHeaders: () => ({}), DEFAULT_PROVIDER_ID: 'default',
    createVisionProbe: () => async () => ({ supported: true }), reportedTokenRate: () => null,
    missingRoles: () => null, currentWorkspace: () => ({ userId: 'u1' }),
    service: { modelScanCache: new Map(), refreshModelScan: () => {}, autoRoles: () => null, setAutoRoles: () => {}, ensureRolesLoaded: () => {},
      servedCatalogue: async () => [], modelsInstalled: async () => installed, modelsInstalledNow: async () => installed, deriveUserModelName: (c) => c,
      lastLoadedModel: () => null, clearLastLoadedModel: () => {}, clearRoleReferences: (n) => (n === 'plain' ? ['fast'] : []) },
  });
  const call = (method, p, body) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = method;
    return handle(req, { setHeader() {} }, { path: p, authn: { user: { id: 'u1', role } }, url: new URL('http://localhost' + p) });
  };
  return { call, sent, fetched, deleted, presets: () => presets };
}

test('#1661 a delete removes the files and the preset section, so the model leaves the list', async () => {
  const f = routes({ installed: [{ name: 'plain', labels: [] }] });
  await f.call('POST', '/api/models/delete', { name: 'plain' });
  const out = f.sent.pop();
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { ok: true, unloaded: false, rolesCleared: ['fast'], presetRemoved: true });
  assert.deepEqual(f.deleted, ['plain']);
  assert.deepEqual(f.presets(), ['orphan']);
  assert.ok(f.fetched.includes('DELETE sections/plain?baseRevision=r7'));
});

test('#1661 a "File missing" preset deletes by removing its section even when the engine has no file to delete', async () => {
  const f = routes({ installed: [{ name: 'orphan', labels: [], missingFile: true }], routerDelete: { ok: false, status: 404 } });
  await f.call('POST', '/api/models/delete', { name: 'orphan' });
  const out = f.sent.pop();
  assert.equal(out.status, 200);
  assert.equal(out.body.presetRemoved, true);
  assert.deepEqual(f.presets(), ['plain']);
});

test('an engine failure on a model whose file exists is still a failure', async () => {
  const f = routes({ installed: [{ name: 'plain', labels: [] }], routerDelete: { ok: false, status: 500 } });
  await f.call('POST', '/api/models/delete', { name: 'plain' });
  assert.equal(f.sent.pop().status, 502);
  // The file is still there, so its settings stay too: the card remains and the delete can be retried.
  assert.deepEqual(f.presets(), ['plain', 'orphan']);
  assert.ok(!f.fetched.some((x) => x.startsWith('DELETE sections/')), 'no section delete after a refused engine delete');
});

test('#1660 Laya is refused without confirmSystem and deleted with it', async () => {
  const f = routes({ installed: [{ name: 'laya_multilingual_f16', labels: [] }], sections: ['laya_multilingual_f16'] });
  await f.call('POST', '/api/models/delete', { name: 'laya_multilingual_f16' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'System routing model — not deleted', errorId: 'systemModel', service: 'decision' } });
  assert.deepEqual(f.deleted, []);
  await f.call('POST', '/api/models/delete', { name: 'laya_multilingual_f16', confirmSystem: true });
  assert.equal(f.sent.pop().status, 200);
  assert.deepEqual(f.deleted, ['laya_multilingual_f16']);
  assert.deepEqual(f.presets(), []);
});

test('#336/#1660 the in-use embedding model is still refused, naming the service so the client can offer a switch', async () => {
  const f = routes({ installed: [{ name: 'nomic-embed-text-v1', labels: ['embeddings'] }], env: { EMBEDDING_MODEL: 'nomic-embed-text-v1' } });
  await f.call('POST', '/api/models/delete', { name: 'nomic-embed-text-v1', confirmSystem: true });
  const out = f.sent.pop();
  assert.equal(out.status, 409);
  assert.equal(out.body.errorId, 'modelInUse');
  assert.equal(out.body.service, 'embedding');
  assert.deepEqual(f.deleted, []);
  assert.ok(!f.fetched.some((x) => x.startsWith('DELETE')), 'no preset removed');
});

test('#1662 GET /api/models/assignments: admins get options, members a read-only view without them', async () => {
  const installed = [
    { name: 'nomic-embed-text-v1', labels: ['embeddings'] }, { name: 'embeddinggemma-2', labels: ['embeddings'] },
    { name: 'laya_multilingual_f16', labels: [], system: true }, { name: 'qwen3-reranker', labels: ['reranking'], missingFile: true },
  ];
  const env = { EMBEDDING_MODEL: 'nomic-embed-text-v1', RERANK_MODEL: 'qwen3-reranker', NOEVIA_FEATURE_RAG_RERANK: '1', OCR_BASE_URL: 'http://ocr.invalid' };
  const admin = routes({ installed, env });
  await admin.call('GET', '/api/models/assignments');
  const a = admin.sent.pop();
  assert.equal(a.status, 200);
  const by = Object.fromEntries(a.body.services.map((s) => [s.id, s]));
  assert.equal(a.body.admin, true);
  assert.deepEqual([by.embedding.model, by.embedding.state], ['nomic-embed-text-v1', 'active']);
  assert.deepEqual(by.embedding.options, [{ model: 'embeddinggemma-2', profile: 'embeddinggemma-2' }]);
  assert.deepEqual([by.reranker.model, by.reranker.state], ['qwen3-reranker', 'missing']);
  assert.deepEqual([by.decision.model, by.decision.state], ['laya_multilingual_f16', 'active']);
  assert.equal(by.ocr.state, 'active');
  assert.equal(by.documents.state, 'off');
  assert.ok(!JSON.stringify(a.body).includes('ocr.invalid'), 'no service address is sent');
  const member = routes({ installed, env, role: 'member' });
  await member.call('GET', '/api/models/assignments');
  const m = member.sent.pop().body;
  assert.equal(m.admin, false);
  assert.ok(m.services.every((s) => !('options' in s) && s.canChange === false));
});

test('assignment helpers', () => {
  assert.equal(embeddingProfileFor('EmbeddingGemma-2-Q8'), 'embeddinggemma-2');
  assert.equal(embeddingProfileFor('nomic-embed-text-v1.5'), 'nomic-v1');
  const a = modelAssignments({ installed: [], env: { RERANK_MODEL: 'r' } });
  assert.equal(a.services.find((s) => s.id === 'reranker').state, 'off', 'reranking off when the feature is off');
  const d = a.services.find((s) => s.id === 'decision');
  assert.deepEqual([d.model, d.state], [null, 'missing'], 'a deleted Laya reads missing, not off or running');
  assert.equal(serviceUsing('r', { services: [{ id: 'reranker', model: 'r' }] }), 'reranker');
});
