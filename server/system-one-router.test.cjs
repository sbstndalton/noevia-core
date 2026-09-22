'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { configuration, createSystemOneRouter } = require('./system-one-router.cjs');
const { createFeatures } = require('./features.cjs');

function harness(decide = async () => ({ selected: 'smart', scores: { smart: 1 } })) {
  let on = false, calls = 0, legacy = 0;
  const router = createSystemOneRouter({ enabled: () => on, roles: () => ({ fast: 'a', smart: 'b' }),
    fallback: async () => { legacy++; return 'fast'; }, deadlineMs: 10,
    backend: { supports: () => true, locality: 'local', decide: async (...args) => { calls++; return decide(...args); } } });
  return { router, enable: value => { on = value; }, counts: () => [calls, legacy] };
}
test('switch selects alternate logic and disabling restores legacy routing', async () => {
  const h = harness();
  assert.equal(await h.router.classify('hi'), 'fast');
  h.enable(true); assert.equal(await h.router.classify('hi'), 'smart');
  h.enable(false); assert.equal(await h.router.classify('hi'), 'fast');
  assert.deepEqual(h.counts(), [1, 2]);
});
test('malformed, failed and timed-out decisions use legacy routing', async () => {
  for (const decide of [async () => ({ selected: 'code', scores: { code: 1 } }),
    async () => { throw Error('model died'); }, () => new Promise(() => {})]) {
    const h = harness(decide); h.enable(true);
    assert.equal(await h.router.classify('hi'), 'fast'); assert.deepEqual(h.counts(), [1, 1]);
  }
});
test('role choices and input are bounded and no tenant state is retained', async () => {
  const seen = [];
  const h = harness(async request => { seen.push(request); return { selected: 'fast', scores: { fast: 1 } }; });
  h.enable(true);
  await h.router.classify('a'.repeat(2000)); await h.router.classify('tenant two');
  assert.equal(seen[0].context.stateText.length, 1000);
  assert.equal(seen[1].context.stateText, 'tenant two');
  assert.equal(seen[0].context.cloud, 'forbidden');
  assert.deepEqual(seen[0].options.map(o => o.id), ['fast', 'smart']);
});
test('Code is offered only with a configured Code role', async () => {
  const router = createSystemOneRouter({ enabled: () => true, roles: () => ({ fast:'a', smart:'b', code:'c' }),
    fallback: () => { throw Error('unexpected fallback'); }, backend: { supports: () => true, locality:'local',
      decide: async request => { assert.equal(request.options[2].id, 'code'); return { selected:'code', scores:{code:1} }; } } });
  assert.equal(await router.classify('debug'), 'code');
});
test('private dedicated endpoint required; no credentials, public URL or redirect target config', () => {
  for (const value of [undefined, 'https://example.com', 'http://10.0.0.1/?key=x', 'http://user:pass@127.0.0.1', 'http://127.0.0.1/path'])
    assert.ok(configuration({ COWORK_SYSTEM_ONE_URL: value }).reason);
  assert.equal(configuration({ COWORK_SYSTEM_ONE_URL:'http://127.0.0.1:9999/v1' }).baseUrl, 'http://127.0.0.1:9999');
});
test('experiment persists using existing feature settings but cannot enable without configuration', () => {
  const values = new Map(); const store = { get:k => values.get(k), set:(k,v) => values.set(k,v) };
  let features = createFeatures({ env:{}, store });
  assert.throws(() => features.set('systemOneRouting', true, 'admin'), e => e.status === 409);
  const env = { COWORK_SYSTEM_ONE_URL:'http://127.0.0.1:9999' };
  features = createFeatures({ env, store }); features.set('systemOneRouting', true, 'admin');
  assert.equal(createFeatures({ env, store }).enabled('systemOneRouting'), true);
  features = createFeatures({ env:{}, store });
  assert.equal(features.flags().systemOneRouting, false);
  features.set('systemOneRouting', false, 'admin');
  assert.equal(values.get('feature:systemOneRouting'), 'false');
});
