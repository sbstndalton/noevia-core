'use strict';
// #536: the context limit a chat budgets against. A hosted/custom provider's own setting wins,
// else a hosted default; the local model-manager path is exactly what it was.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ctx = require('./chat-context.cjs');

const loadedHealth = (model, limit) => ({ ok: true, body: { version: '1', all_models_loaded: [{ model_name: model, loaded: true, recipe_options: { ctx_size: limit } }] } });

test('a hosted provider with contextTokens uses it, labelled as the provider setting', async () => {
  const result = await ctx.resolveRuntimeLimit({ manager: null, model: 'hosted-model', hosted: { id: 'prov-1', baseUrl: 'https://synthetic.example/v1', contextTokens: 200000 } });
  assert.deepEqual(result, { limit: 200000, limitSource: 'Provider setting' });
});

test('a hosted provider without a (valid) setting gets the hosted default, not the local 8k floor', async () => {
  for (const contextTokens of [undefined, null, 0, 100, 3000000, 4096.5, '65536']) {
    const result = await ctx.resolveRuntimeLimit({ manager: null, model: 'hosted-model', hosted: { id: 'prov-1', contextTokens } });
    assert.deepEqual(result, { limit: 32768, limitSource: 'Default for hosted providers' }, String(contextTokens));
  }
  assert.equal(ctx.HOSTED_DEFAULT_LIMIT, 32768);
});

test('the local default is unchanged: model-manager ctx_size, else the 8192 fallback, never the provider row', async () => {
  const manager = { enabled: true, health: async () => loadedHealth('local', 16384), load: async () => assert.fail('already loaded') };
  // Even if a row carried contextTokens, the managed path reads the backend allocation.
  assert.deepEqual(await ctx.resolveRuntimeLimit({ manager, model: 'local', hosted: { contextTokens: 999999 } }), { limit: 16384, limitSource: 'Configured backend context' });
  assert.deepEqual(await ctx.resolveRuntimeLimit({ manager, model: 'local' }), { limit: 16384, limitSource: 'Configured backend context' });
  const noCtx = { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'local', loaded: true, recipe_options: {} }] } }), load: async () => assert.fail('loaded') };
  assert.equal((await ctx.resolveRuntimeLimit({ manager: noCtx, model: 'local' })).limit, 8192);
  // Default provider without a manager: hosted is null, so the conservative fallback stays.
  assert.deepEqual(await ctx.resolveRuntimeLimit({ manager: null, model: 'local', hosted: null }), { limit: 8192, limitSource: 'Conservative fallback; backend limit unavailable' });
  assert.equal((await ctx.resolveRuntimeLimit({ manager: { enabled: false }, model: 'local' })).limit, 8192);
});

test('chat.cjs passes the provider row only for non-default providers', () => {
  const src = require('node:fs').readFileSync(require.resolve('./chat.cjs'), 'utf8');
  assert.match(src, /hosted:provider\.id===DEFAULT_PROVIDER_ID\?null:provider/);
  assert.match(src, /manager:provider\.id===DEFAULT_PROVIDER_ID\?modelManager:null/);
});
