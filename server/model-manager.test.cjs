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
