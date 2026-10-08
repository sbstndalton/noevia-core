'use strict';
// #1079: the served model list folds a model's `<model>-long` profile into the model itself
// (longVariant, and whether that profile is the loaded one), so the chat picker and the Auto roles
// keep naming models, never profiles. Synthetic rows; no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelService } = require('./models.cjs');

const service = (rows, loaded = []) => createModelService({
  fetchJson: async () => null, env: {}, currentWorkspace: () => ({ dir: '/synthetic-only' }),
  modelManager: {
    enabled: true, requireEnabled() {},
    listModels: async () => ({ ok: true, body: { data: rows } }),
    health: async () => ({ ok: true, body: { all_models_loaded: loaded.map((model_name) => ({ model_name, loaded: true })) } }),
  },
});
const row = (id, extra = {}) => ({ id, status: { value: 'unloaded' }, labels: [], long_variant: null, long_of: null, ...extra });

test('#1079 a long profile is listed on its model, not as a model of its own', async () => {
  const list = await service([
    row('Synthetic-12B-it', { long_variant: 'Synthetic-12B-it-long' }),
    row('Synthetic-12B-it-long', { long_of: 'Synthetic-12B-it' }),
    row('Synthetic-9B'),
  ]).modelsInstalled();
  assert.deepEqual(list.map((m) => m.name), ['Synthetic-12B-it', 'Synthetic-9B']);
  assert.equal(list[0].longVariant, 'Synthetic-12B-it-long');
  assert.equal(list[0].longLoaded, false);
  assert.equal('longVariant' in list[1], false);
});

test('#1079 a loaded long profile shows on its model; the model itself is not loaded', async () => {
  const list = await service([
    row('Synthetic-12B-it', { long_variant: 'Synthetic-12B-it-long' }),
    row('Synthetic-12B-it-long', { long_of: 'Synthetic-12B-it', status: { value: 'loaded' } }),
  ], ['Synthetic-12B-it-long']).modelsInstalled();
  assert.equal(list.length, 1);
  assert.equal(list[0].loaded, false);
  assert.equal(list[0].longLoaded, true);
});

test('#1079 an engine that reports no pairing (another manager, or the module unavailable) lists every row as before', async () => {
  const list = await service([{ id: 'a', status: { value: 'unloaded' }, labels: [] }, { id: 'a-long', status: { value: 'unloaded' }, labels: [] }]).modelsInstalled();
  assert.deepEqual(list.map((m) => m.name), ['a', 'a-long']);
});
