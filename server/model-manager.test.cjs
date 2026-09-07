'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelManager } = require('./model-manager.cjs');

test('disabled manager rejects provider-specific operations', async () => {
  const manager = createModelManager({ kind: 'none', baseUrl: '', apiKey: '', fetchJson: async () => ({ ok: true }) });
  assert.equal(manager.enabled, false);
  await assert.rejects(manager.request('/api/v1/models'), /disabled/);
});

test('lemonade manager scopes URL and authentication', async () => {
  let call;
  const manager = createModelManager({
    kind: 'lemonade',
    baseUrl: 'http://inference.local/',
    apiKey: 'secret',
    fetchJson: async (...args) => {
      call = args;
      return { ok: true };
    },
  });
  await manager.request('/api/v1/models', { headers: { 'X-Test': 'yes' } }, 5000);
  assert.equal(call[0], 'http://inference.local/api/v1/models');
  assert.equal(call[1].headers.Authorization, 'Bearer secret');
  assert.equal(call[1].headers['X-Test'], 'yes');
  assert.equal(call[2], 5000);
});

test('pull sends model_name/recipe/checkpoint and a pollable job request', async () => {
  // Lemonade's /v1/pull 400s on {checkpoint} alone (model_name and recipe are
  // required to register an unknown HF checkpoint), and without
  // stream+subscribe=false it blocks on the whole download instead of
  // handing back a job id for /v1/downloads to poll.
  let call;
  const manager = createModelManager({
    kind: 'lemonade',
    baseUrl: 'http://inference.local',
    apiKey: '',
    fetchJson: async (...args) => {
      call = args;
      return { ok: true, body: { id: 'model:user.Qwen3-0.6B-GGUF-Q4_K_M' } };
    },
  });
  await manager.pull({ modelName: 'user.Qwen3-0.6B-GGUF-Q4_K_M', checkpoint: 'unsloth/Qwen3-0.6B-GGUF:Q4_K_M', recipe: 'llamacpp' });
  assert.equal(call[0], 'http://inference.local/api/v1/pull');
  const body = JSON.parse(call[1].body);
  assert.deepEqual(body, {
    model_name: 'user.Qwen3-0.6B-GGUF-Q4_K_M',
    checkpoint: 'unsloth/Qwen3-0.6B-GGUF:Q4_K_M',
    recipe: 'llamacpp',
    stream: true,
    subscribe: false,
  });
});
