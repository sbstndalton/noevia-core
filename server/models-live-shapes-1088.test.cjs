'use strict';
// #1087 / #1088: the installed list built from the REAL row shapes, not hand-written ones. The
// fixture is a synthetic copy of what the live router (GET /models) and the model-loader scan
// (GET /api/v1/models) returned for an eight-model install: the router rows carry no size, no
// shape and (for unloaded models) no meta; the llama.cpp adapter reduces them again before
// modelsInstalled() sees them; Laya's preset points at a file that only exists in its own service.
// Everything runs through the real llama.cpp adapter, so a change to what the adapter passes on
// (it drops status.args, for one) shows up here and not only live.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelManager } = require('./model-manager.cjs');
const { createModelService } = require('./models.cjs');
const shapes = require('./fixtures/models-live-shapes-1088.json');

const CHAT = ['Qwen3.5-4B-UD-Q8_K_XL', 'Qwen3.5-9B-UD-Q4_K_XL', 'gemma-4-12b-it-qat-q4_0', 'gemma-4-E2B_q4_0-it', 'gemma-4-E4B-it-qat-UD-Q4_K_XL'];
const env = { MODEL_LOADER_URL: 'http://loader:8090', MODEL_LOADER_TOKEN: 'test-only', EMBEDDING_MODEL: 'nomic-embed-text-v1', RERANK_MODEL: 'qwen3-reranker-0.6b-q8_0', NOEVIA_FEATURE_RAG_RERANK: 'false' };

function build({ scan = () => ({ ok: true, status: 200, body: shapes.scan }), env: e = env } = {}) {
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    if (url === 'http://router/models') return { ok: true, status: 200, body: structuredClone(shapes.router) };
    if (url.startsWith('http://router/props')) return { ok: false, status: 404, body: {} };
    if (url === 'http://loader:8090/api/v1/models') return scan();
    if (url === 'http://loader:8090/api/v1/backends') return { ok: true, status: 200, body: { backends: [{ status: 'running', loaded_model: 'nomic-embed-text-v1' }] } };
    throw new Error(`unexpected request ${url}`);
  };
  const modelManager = createModelManager({ kind: 'llamacpp', baseUrl: 'http://router', apiKey: 'local', fetchJson });
  const service = createModelService({ fetchJson, env: e, modelManager, currentWorkspace: () => ({}), listWorkspaces: () => [] });
  return { service, calls };
}
const byName = (list) => Object.fromEntries(list.map((m) => [m.name, m]));

test('#1088: every local model has a GB size and a shape; the loader byte count wins over the router meta', async () => {
  const { service } = build();
  const by = byName(await service.modelsInstalled());
  for (const id of [...CHAT, 'nomic-embed-text-v1', 'qwen3-reranker-0.6b-q8_0']) {
    assert.equal(typeof by[id].sizeGB, 'number', `${id} has a size`);
    assert.ok(by[id].sizeGB > 0, id);
    assert.equal(by[id].shape?.label, 'dense', `${id} has a shape`);
  }
  assert.equal(by['Qwen3.5-4B-UD-Q8_K_XL'].sizeGB, 6.1);
  assert.equal(by['gemma-4-E2B_q4_0-it'].sizeGB, 3.3);
  assert.equal(by['gemma-4-E4B-it-qat-UD-Q4_K_XL'].sizeGB, 4.2);
  assert.equal(by['nomic-embed-text-v1'].sizeGB, 0.1);
  assert.equal(by['qwen3-reranker-0.6b-q8_0'].sizeGB, 0.6);
  assert.equal(by['gemma-4-12b-it-qat-q4_0'].sizeGB, 7, 'the one loaded model, which also has router meta');
});

test('#1087: Laya reads as served elsewhere, not missing, with its real row shape', async () => {
  const { service } = build();
  const laya = byName(await service.modelsInstalled())['laya_multilingual_f16'];
  assert.equal(laya.servedElsewhere, true);
  assert.equal(laya.missingFile, false);
  assert.equal(laya.failed, false);
  assert.equal(laya.status, 'served-elsewhere');
});

test('#1087: Laya is still served elsewhere when the folder scan cannot be read, and no ordinary model turns missing', async () => {
  for (const scan of [() => { throw new Error('timeout'); }, () => ({ ok: false, status: 502, body: {} }), () => ({ ok: true, status: 200, body: { models: [] } })]) {
    const { service } = build({ scan });
    const by = byName(await service.modelsInstalled());
    assert.equal(by['laya_multilingual_f16'].servedElsewhere, true);
    assert.equal(by['laya_multilingual_f16'].status, 'served-elsewhere');
    assert.equal(by['laya_multilingual_f16'].missingFile, false);
    for (const id of CHAT) assert.equal(by[id].missingFile, false, `${id} is never reported missing because a scan failed`);
  }
});

test('#1088: a scan that fails once is retried by the next list instead of leaving sizes empty', async () => {
  let n = 0;
  const { service } = build({ scan: () => (n++ === 0 ? { ok: false, status: 504, body: {} } : { ok: true, status: 200, body: shapes.scan }) });
  const first = byName(await service.modelsInstalled());
  assert.equal(first['Qwen3.5-9B-UD-Q4_K_XL'].sizeGB, null, 'no scan, no size for an unloaded model');
  const second = byName(await service.modelsInstalled());
  assert.equal(second['Qwen3.5-9B-UD-Q4_K_XL'].sizeGB, 6.1);
});
