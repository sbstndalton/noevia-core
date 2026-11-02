'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createAutotuneCancellation } = require('./llamacpp-full-autotune.cjs');
const { createAutotuneCancelBridge, PREFIX } = require('./rust-autotune-cancel-bridge.cjs');
const { refuseOwned, ROUTE_REFUSAL } = require('./rust-autotune-cancel.cjs');
const secret = 'synthetic-front-secret';
const req = (over = {}) => ({ url: PREFIX + 'facts', method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-noevia-store-token': secret }, ...over });
function actor() {
  const calls = [];
  const state = { job: { id: 'j', model: 'synthetic', status: 'running', models: [], originalText: 'private-profile', _http: { headers: { Authorization: 'private-token' } }, unknown: 'private-extra' }, starting: false, cancelled: false, completion: Promise.resolve(),
    child: { cancel() { calls.push('child'); } }, inflight: { abort() { calls.push('inflight'); } }, idleAbort: { abort() { calls.push('idle'); } } };
  const control = createAutotuneCancellation(() => ({ ...state }), () => { state.cancelled = true; });
  return { state, calls, control, live: { cancellationFacts: control.facts, compareAndAbort: control.compareAndAbort } };
}
function fixture(over = {}) {
  const a = actor(), sent = [];
  const handle = createAutotuneCancelBridge({ secret, json: (_r, status, body) => sent.push({ status, body }), readJson: async () => ({}), autotune: () => a.live, log: () => {}, ...over });
  return { ...a, sent, handle };
}
test('bounded facts select non-secret worker data recursively and preserve WTF16 without a model selector', () => {
  const a = actor(); a.state.job.model = 'm\ud800';
  a.state.job.models = [{ _profile: 'private-one', beforeText: 'private-two', headers: { Authorization: 'private-three' }, phases: [{ steps: [{ originalRevision: 'private-four', lastRevision: 'private-five', originalText: 'private-six', answer: 'visible' }] }] }];
  const facts = a.control.facts();
  assert.match(facts.token, /^[0-9a-f]{64}$/); assert.match(facts.generation, /^[0-9a-f]{64}$/);
  assert.equal(facts.job.model, 'm\ud800'); assert.ok(!JSON.stringify(facts).includes('private-')); assert.ok(JSON.stringify(facts).includes('visible'));
  assert.deepEqual(a.control.compareAndAbort(facts.token), { applied: true, generation: facts.generation, job: facts.job });
  assert.deepEqual(a.calls, ['child', 'inflight', 'idle']); assert.equal(a.state.cancelled, true);
});
test('progress retains generation; replacement job or same-object resumed run gets a new generation', () => {
  const a = actor(), first = a.control.facts();
  a.state.job.phase = 'Progress'; assert.equal(a.control.facts().generation, first.generation); assert.notEqual(a.control.facts().token, first.token);
  a.state.completion = Promise.resolve(); assert.notEqual(a.control.facts().generation, first.generation);
  const resumed = a.control.facts(); a.state.job = { ...a.state.job }; assert.notEqual(a.control.facts().generation, resumed.generation);
  assert.deepEqual(a.control.compareAndAbort(first.token), { applied: false }); assert.deepEqual(a.calls, []);
});
test('exact token binds private state, process, flags and each active controller handle', () => {
  for (const mutate of [a => { a.state.starting = true; }, a => { a.state.cancelled = true; }, a => { a.state.job.originalText += 'changed'; }, a => { a.state.job.status = 'passed'; }, a => { a.state.child = {}; }, a => { a.state.inflight = {}; }, a => { a.state.idleAbort = {}; }]) {
    const a = actor(), token = a.control.facts().token; mutate(a);
    assert.deepEqual(a.control.compareAndAbort(token), { applied: false }); assert.deepEqual(a.calls, []);
  }
  assert.deepEqual(actor().control.compareAndAbort(actor().control.facts().token), { applied: false });
});
test('reentrant cancellation listeners cannot retarget replacement job or handles or change the response target', () => {
  const a = actor();
  a.state.child.cancel = () => {
    a.calls.push('child');
    a.state.job = { id: 'replacement', model: 'other', status: 'running', models: [] };
    a.state.completion = Promise.resolve();
    a.state.inflight = { abort() { assert.fail('replacement inflight'); } };
    a.state.idleAbort = { abort() { assert.fail('replacement idle'); } };
  };
  const before = a.control.facts(), out = a.control.compareAndAbort(before.token);
  assert.deepEqual(a.calls, ['child', 'inflight', 'idle']); assert.equal(out.job.id, 'j'); assert.equal(out.generation, before.generation);
  assert.equal(a.state.job.id, 'replacement'); assert.notEqual(a.control.facts().generation, before.generation);
});
test('all captured handles are attempted when a child canceller throws; worker recovery and holds are not released here', () => {
  const a = actor(); a.state.child.cancel = () => { a.calls.push('child'); throw Error('synthetic child failure'); };
  assert.throws(() => a.control.compareAndAbort(a.control.facts().token), /synthetic child failure/);
  assert.deepEqual(a.calls, ['child', 'inflight', 'idle']); assert.equal(a.state.cancelled, true);
});
test('repeat cancellation is idempotent on the same still-running worker and consumes the old flag snapshot', () => {
  const a = actor(), old = a.control.facts(); assert.equal(a.control.compareAndAbort(old.token).applied, true);
  assert.deepEqual(a.control.compareAndAbort(old.token), { applied: false });
  assert.equal(a.control.compareAndAbort(a.control.facts().token).applied, true);
  a.state.job = null; assert.deepEqual(a.control.compareAndAbort(a.control.facts().token), { applied: false });
});
test('bridge rejects forwarded/public/wrong-secret calls before actor access, including empty forwarding headers', async () => {
  for (const request of [req({ socket: { remoteAddress: '10.0.0.2' } }), req({ headers: {} }), req({ headers: { 'x-noevia-store-token': 'wrong' } }), req({ headers: { 'x-noevia-store-token': secret, 'x-forwarded-for': '' } }), req({ headers: { 'x-noevia-store-token': secret, 'x-noevia-client-ip': '' } }), req({ method: 'GET' })]) {
    const f = fixture({ autotune: () => assert.fail('no actor access') }); await f.handle(request, {}); assert.equal(f.sent.pop().status, 404);
  }
});
test('bridge accepts no model selector, rejects token coercion, and compares the exact snapshot synchronously', async () => {
  const f = fixture(); await f.handle(req(), {}); const token = f.sent.pop().body.token;
  const g = fixture({ autotune: () => f.live, readJson: async () => ({ token }) }); await g.handle(req({ url: PREFIX + 'abort' }), {}); assert.equal(g.sent.pop().body.applied, true);
  await g.handle(req({ url: PREFIX + 'abort' }), {}); assert.equal(g.sent.pop().status, 409);
  for (const ask of [{ model: 'other' }, { token: { toString: null } }, { token: 7 }, { token: 'bad' }, { token, model: 'other' }, null, []]) {
    const h = fixture({ readJson: async () => ask }); await h.handle(req({ url: PREFIX + 'abort' }), {}); assert.equal(h.sent.pop().status, 400);
  }
});
test('missing, older, failing and over-cap actors are unavailable rather than false successes', async () => {
  for (const autotune of [() => ({}), () => { throw Error('private failure'); }, () => ({ cancellationFacts: () => ({ job: 'x'.repeat(8 * 1024 * 1024) }), compareAndAbort() {} })]) {
    const f = fixture({ autotune }); await f.handle(req(), {}); assert.equal(f.sent.pop().status, 503);
  }
  const f = fixture({ autotune: () => null }); await f.handle(req(), {}); assert.deepEqual(f.sent.pop(), { status: 200, body: { available: false } });
});
test('all exact public methods refuse in Node; start/status/clear and path neighbors remain separate', () => {
  const parseRequestUrl = r => new URL(r.url, 'http://synthetic');
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const sent = []; assert.equal(refuseOwned({ method, url: '/api/models/autotune/cancel' }, {}, { parseRequestUrl, json: (_r, status, body) => sent.push({ status, body }) }), true);
    assert.deepEqual(sent, [{ status: 503, body: ROUTE_REFUSAL }]);
  }
  for (const url of ['/api/models/autotune', '/api/models/autotune/clear', '/api/models/autotune/cancel/', '/api/models/autotune/cancelled']) assert.equal(refuseOwned({ url }, {}, { parseRequestUrl, json: () => assert.fail('neighbor') }), false);
});
