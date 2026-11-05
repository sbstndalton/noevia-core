'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createAutotuneActorBridge, attachWhenReady, PREFIX, OPS } = require('./rust-autotune-actor-bridge.cjs');

const SECRET = 'synthetic-secret-0123456789abcdef0123456789';
const request = (op, over = {}) => ({ url: PREFIX + op, method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-noevia-store-token': SECRET }, ...over });
function rig(actor, extra = {}) {
  const sent = [], invalidated = [];
  const emitter = () => { const h = {}; return { once: (e, f) => { h[e] = f; }, removeListener: (e) => { delete h[e]; }, fire: e => h[e]?.(), writableFinished: false }; };
  const handle = createAutotuneActorBridge({ secret: SECRET, json: (_r, status, body) => sent.push({ status, body }), readJson: async () => ('ask' in extra ? extra.ask : {}), autotune: () => actor, invalidate: () => invalidated.push(1), log: () => {} });
  return { handle, sent, invalidated, emitter };
}
const live = over => ({ outsideFacts: m => ({ revision: 'r1', allowBelowQ5Kv: false, models: Object.fromEntries((m || []).map(n => [n, { configured: true, system: false }])) }),
  listingFacts: async items => ({ models: items.map((_, index) => ({ index })) }), identityFacts: async () => ({ identities: [] }),
  abort: () => ({ aborted: true }), launch: () => ({ launched: true }), ...over });

test('only the trusted front reaches any actor operation: public, forwarded, wrong-secret and non-POST calls are 404 before the actor', async () => {
  const { handle, sent } = rig(null);
  for (const op of OPS) {
    for (const over of [{ method: 'GET' }, { socket: { remoteAddress: '10.0.0.2' } }, { headers: {} }, { headers: { 'x-noevia-store-token': 'bad' } },
      { headers: { 'x-noevia-store-token': SECRET, 'x-forwarded-for': '' } }, { headers: { 'x-noevia-store-token': SECRET, 'x-noevia-client-ip': '1.2.3.4' } }]) {
      assert.equal(await handle(request(op, over), {}), true);
      assert.equal(sent.pop().status, 404, op);
    }
  }
  assert.equal(await handle({ url: '/internal/autotune-actor/other', method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: {} }, {}), false);
  assert.equal(await handle({ url: '/api/models', method: 'POST', headers: {} }, {}), false);
});

test('each operation reaches the actor with the front\'s arguments and answers its result', async () => {
  const seen = [];
  const actor = live({ outsideFacts: m => { seen.push(['outside', m]); return { revision: 'r1', allowBelowQ5Kv: false, models: {} }; },
    abort: a => { seen.push(['abort', a]); return { aborted: true }; }, launch: a => { seen.push(['launch', a]); return { launched: true }; } });
  for (const [op, ask, expected] of [
    ['outside', { models: ['m'] }, { revision: 'r1', allowBelowQ5Kv: false, models: {} }],
    ['abort', { jobId: 'j', epoch: 4 }, { aborted: true }],
    ['launch', { epoch: 5, jobRev: 6, job: { id: 'j' }, history: {} }, { launched: true }],
    ['listing', { items: [{ model: 'm' }] }, { models: [{ index: 0 }] }],
    ['identities', { selectors: [] }, { identities: [] }],
    ['invalidate', {}, { ok: true }],
  ]) {
    const { handle, sent, invalidated } = rig(actor, { ask });
    await handle(request(op), { writableFinished: true });
    assert.deepEqual(sent, [{ status: 200, body: expected }], op);
    assert.equal(invalidated.length, op === 'invalidate' || op === 'launch' ? 1 : 0, op);
  }
  assert.deepEqual(seen, [['outside', ['m']], ['abort', { jobId: 'j', epoch: 4 }], ['launch', { epoch: 5, jobRev: 6, job: { id: 'j' }, history: {} }]]);
});

test('a launch the actor did not take invalidates nothing; failures and a missing actor are fixed 503s without detail', async () => {
  let r = rig(live({ launch: () => ({ launched: false }) }), { ask: {} });
  await r.handle(request('launch'), { writableFinished: true });
  assert.deepEqual(r.sent, [{ status: 200, body: { launched: false } }]); assert.equal(r.invalidated.length, 0);
  for (const actor of [null, live({ abort: () => { throw Error('never-public'); } }), live({ abort: () => ({ data: 'x'.repeat(9 * 1024 * 1024) }) })]) {
    r = rig(actor, { ask: {} });
    await r.handle(request('abort'), { writableFinished: true });
    assert.equal(r.sent[0].status, 503); assert.ok(!JSON.stringify(r.sent[0]).includes('never-public'));
  }
  for (const ask of [null, [], 'x']) {
    r = rig(live(), { ask });
    await r.handle(request('outside'), {});
    assert.equal(r.sent[0].status, 400);
  }
});

test('the preparation stops when the front stops waiting: its connection closing fires the signal the actor checks', async () => {
  let signal;
  const actor = live({ identityFacts: async (_s, sig) => { signal = sig; await new Promise(r => setTimeout(r, 20)); return { applied: !sig.aborted }; } });
  const r = rig(actor, { ask: { selectors: [] } });
  const res = { writableFinished: false, once(ev, f) { this.on = f; }, removeListener() {} };
  const pending = r.handle(request('identities'), res);
  await new Promise(x => setTimeout(x, 5));
  res.on();
  await pending;
  assert.equal(signal.aborted, true);
  assert.deepEqual(r.sent.pop().body, { applied: false });
});

test('attachWhenReady retries until the front answers, then recovers; a deployment without a tuner is announced as unavailable', async () => {
  const log = []; let tries = 0;
  const actor = { attach: async () => { if (++tries < 3) throw new Error('down'); log.push('attach'); }, recover: async () => { log.push('recover'); } };
  await attachWhenReady({ actor, sleep: async () => { log.push('wait'); }, log: () => {} });
  assert.deepEqual(log, ['wait', 'wait', 'attach', 'recover']);
  const told = [];
  await attachWhenReady({ actor: null, unavailableClient: { attach: async () => { told.push('unavailable'); } }, log: () => {} });
  assert.deepEqual(told, ['unavailable']);
  // A failed recovery is reported, not retried as an attach.
  await attachWhenReady({ actor: { attach: async () => {}, recover: async () => { throw Error('x'); } }, log: m => log.push(m) });
  assert.equal(log.at(-1), '[autotune-actor] recovery failed');
});
