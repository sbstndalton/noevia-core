'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createCalibrator } = require('./llamacpp-calibration.cjs');
const { createCalibrationCancelBridge, PREFIX } = require('./rust-calibration-cancel-bridge.cjs');
const { refuseOwned, ROUTE_REFUSAL } = require('./rust-calibration-cancel.cjs');
const secret = 'synthetic-front-secret';
const req = (over = {}) => ({ url: PREFIX + 'facts', method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-noevia-store-token': secret }, ...over });
function actor() {
  const a = createCalibrator({});
  a._state().job = { id: 'j', model: 'synthetic', status: 'running', phase: 'Waiting', steps: [], originalText: 'private-profile-text', privateField: 'private-extra' };
  return a;
}
function fixture(over = {}) {
  const live = actor(), sent = [];
  const handle = createCalibrationCancelBridge({ secret, json: (_r, status, body) => sent.push({ status, body }), readJson: async () => ({}), calibration: () => live, log: () => {}, ...over });
  return { live, sent, handle };
}
test('actor exposes selected lossless facts with an opaque exact snapshot', () => {
  const a = actor(); a._state().job.model = 'm\ud800';
  const facts = a.cancellationFacts();
  assert.match(facts.token, /^[0-9a-f]{64}$/);
  assert.equal(facts.job.model, 'm\ud800');
  assert.equal(facts.job.originalText, undefined); assert.equal(facts.job.privateField, undefined);
  assert.ok(!JSON.stringify(facts).includes('private-'));
  assert.deepEqual(a.compareAndAbort(facts.token), { applied: true, job: facts.job, generation: facts.generation });
  assert.notEqual(a.cancellationFacts().token, facts.token, 'flag consumption changes snapshot');
});
test('changed/replaced/completed/private-mutated jobs and another process cannot consume a stale snapshot', () => {
  for (const mutate of [a => { a._state().job.phase = 'Changed'; }, a => { a._state().job = { ...a._state().job }; }, a => { a._state().job.status = 'passed'; }, a => { a._state().job.originalText += 'changed'; }]) {
    const a = actor(), snapshot = a.cancellationFacts(), token = snapshot.token; mutate(a);
    const before = a.cancellationFacts();
    assert.deepEqual(a.compareAndAbort(token), { applied: false });
    assert.deepEqual(a.cancellationFacts(), before);
  }
  assert.deepEqual(actor().compareAndAbort(actor().cancellationFacts().token), { applied: false });
});
test('job generation remains stable across progress but changes for a replacement object', () => {
  const a = actor(), first = a.cancellationFacts();
  a._state().job.phase = 'Progress';
  const progress = a.cancellationFacts();
  assert.equal(progress.generation, first.generation); assert.notEqual(progress.token, first.token);
  a._state().job = { ...a._state().job };
  assert.notEqual(a.cancellationFacts().generation, first.generation);
});
test('repeat cancellation of the same still-running synthetic worker is idempotent; no job is never aborted', () => {
  const a = actor();
  assert.equal(a.compareAndAbort(a.cancellationFacts().token).applied, true);
  assert.equal(a.compareAndAbort(a.cancellationFacts().token).applied, true);
  a._state().job = null;
  assert.deepEqual(a.compareAndAbort(a.cancellationFacts().token), { applied: false });
});
test('bridge accepts only trusted exact loopback calls with no forwarding header even empty', async () => {
  for (const request of [req({ socket: { remoteAddress: '10.0.0.2' } }), req({ headers: {} }), req({ headers: { 'x-noevia-store-token': 'wrong' } }), req({ headers: { 'x-noevia-store-token': secret, 'x-forwarded-for': '' } }), req({ headers: { 'x-noevia-store-token': secret, 'x-noevia-client-ip': '' } }), req({ method: 'GET' })]) {
    const f = fixture({ calibration: () => assert.fail('no actor access') });
    assert.equal(await f.handle(request, {}), true); assert.equal(f.sent[0].status, 404);
  }
});
test('bridge selects the actor, refuses selectors/invalid tokens and compares synchronously', async () => {
  const f = fixture(); await f.handle(req(), {});
  const token = f.sent.pop().body.token;
  const g = fixture({ calibration: () => f.live, readJson: async () => ({ token }) });
  await g.handle(req({ url: PREFIX + 'abort' }), {}); assert.equal(g.sent.pop().body.applied, true);
  await g.handle(req({ url: PREFIX + 'abort' }), {}); assert.equal(g.sent.pop().status, 409);
  for (const ask of [{ model: 'other' }, { token: 'wrong' }, { token, model: 'other' }, null, []]) {
    const h = fixture({ readJson: async () => ask }); await h.handle(req({ url: PREFIX + 'abort' }), {}); assert.equal(h.sent.pop().status, 400);
  }
});
test('unavailable, older, failing and oversized actors fail closed without public response data', async () => {
  for (const calibration of [() => ({}), () => { throw Error('private failure'); }, () => ({ cancellationFacts: () => ({ token: 't', job: 'x'.repeat(8 * 1024 * 1024) }), compareAndAbort() {} })]) {
    const f = fixture({ calibration }); await f.handle(req(), {}); assert.equal(f.sent.pop().status, 503);
  }
  const f = fixture({ calibration: () => null }); await f.handle(req(), {}); assert.deepEqual(f.sent.pop(), { status: 200, body: { available: false } });
});
test('direct Node refuses all exact public methods and leaves start/status/neighbors unchanged', () => {
  const parseRequestUrl = r => new URL(r.url, 'http://synthetic');
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const sent = []; assert.equal(refuseOwned({ method, url: '/api/models/calibration/cancel' }, {}, { parseRequestUrl, json: (_r, status, body) => sent.push({ status, body }) }), true);
    assert.deepEqual(sent, [{ status: 503, body: ROUTE_REFUSAL }]);
  }
  for (const url of ['/api/models/calibration', '/api/models/calibration/cancel/', '/api/models/calibration/cancelled']) assert.equal(refuseOwned({ url }, {}, { parseRequestUrl, json: () => assert.fail('neighbor') }), false);
});
