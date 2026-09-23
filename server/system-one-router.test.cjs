'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { configuration, createSystemOneRouter } = require('./system-one-router.cjs');
const { createFeatures } = require('./features.cjs');

function harness(decide = async () => ({ selected: 'smart', scores: { smart: 1 } })) {
  let on = false, calls = 0, legacy = 0;
  const router = createSystemOneRouter({ enabled: () => on, roles: () => ({ fast: 'a', smart: 'b' }),
    fallback: async () => { legacy++; return 'fast'; }, deadlineMs: 10, log: () => {},
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
test('role labels name concrete examples of each role (measured on Laya)', async () => {
  const seen = [];
  const h = harness(async request => { seen.push(request); return { selected: 'smart', scores: { fast: 0.2, smart: 0.8 } }; });
  h.enable(true); await h.router.classify('Compare two designs');
  assert.deepEqual(seen[0].options.map(o => o.id), ['fast', 'smart']);
  assert.match(seen[0].options[0].label, /one-line factual/);
  assert.match(seen[0].options[1].label, /comparing, planning, reasoning/);
});
test('each decision logs role, margin and fallback but never the message', async () => {
  const lines = [];
  const router = createSystemOneRouter({ enabled: () => true, roles: () => ({ fast: 'a', smart: 'b' }),
    fallback: async () => 'fast', deadlineMs: 50, log: e => lines.push(e),
    backend: { supports: () => true, locality: 'local', decide: async () => ({ selected: 'smart', scores: { fast: 0.3, smart: 0.7 } }) } });
  await router.classify('secret synthetic text');
  assert.equal(lines[0].selected, 'smart'); assert.equal(lines[0].margin, 0.4); assert.equal(lines[0].fellBack, null);
  assert.ok(!JSON.stringify(lines).includes('secret'));
});

test('per-request detail preserves actual offered scores and isolates simultaneous decisions', async () => {
  const router = createSystemOneRouter({ enabled: () => true, roles: () => ({ fast: 'a', smart: 'b' }),
    fallback: () => 'fast', log: () => {}, backend: { id: 'decision-service', supports: () => true,
      locality: 'local', decide: async request => {
        if (request.context.stateText === 'first') await new Promise(resolve => setTimeout(resolve, 5));
        return { selected: request.context.stateText === 'first' ? 'smart' : 'fast',
          scores: request.context.stateText === 'first' ? { fast: 0.23, smart: 0.77 } : { fast: 0.61, smart: 0.39 },
          metadata: { model: 'convaiinnovations/laya', calibrated: false } };
      } } });
  const [first, second] = await Promise.all([router.classifyWithDetails('first'), router.classifyWithDetails('second')]);
  assert.equal(first.role, 'smart'); assert.deepEqual(first.routingDecision.scores, { fast: 0.23, smart: 0.77 });
  assert.equal(second.role, 'fast'); assert.deepEqual(second.routingDecision.scores, { fast: 0.61, smart: 0.39 });
  assert.equal(first.routingDecision.model, 'convaiinnovations/laya');
  assert.equal(first.routingDecision.calibrated, false);
  assert.deepEqual(first.routingDecision.offered.map(o => o.id), ['fast', 'smart']);
  assert.ok(Number.isFinite(first.routingDecision.latencyMs));
  assert.ok(!JSON.stringify(first.routingDecision).includes('first'));
});

test('fallback detail has no fabricated classifier scores or private error text', async () => {
  const router = createSystemOneRouter({ enabled: () => true, roles: () => ({ fast: 'a', smart: 'b' }),
    fallback: () => 'fast', log: () => {}, backend: { supports: () => true, locality: 'local',
      decide: async () => { throw Error('private synthetic backend error'); } } });
  const result = await router.classifyWithDetails('secret synthetic message');
  assert.equal(result.routingDecision.status, 'fallback');
  assert.equal(result.routingDecision.fallbackReason, 'no-backend-answered');
  assert.deepEqual(result.routingDecision.scores, {});
  assert.ok(!JSON.stringify(result).includes('private synthetic'));
  assert.ok(!JSON.stringify(result).includes('secret synthetic'));
});
