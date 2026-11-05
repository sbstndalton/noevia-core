'use strict';
// #2218: the Rust front's model steps enter this process's admission over real loopback HTTP: only the front may ask, a
// refusal keeps the step's own words, a caller that goes away holds nothing, and an unrenewed lease ends by itself.
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { createAdmissionRoutes, PREFIX } = require('./inference-admission-lease.cjs');
const { json, readJson } = require('./http.cjs');

const SECRET = 's'.repeat(40);

async function serve(t, options) {
  const routes = createAdmissionRoutes({ secret: SECRET, json, readJson, admitEngineModel: async () => {}, modelManager: {}, log: () => {}, ...options });
  const server = http.createServer(async (req, res) => { if (!await routes.handle(req, res)) { res.statusCode = 418; res.end(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { routes, base: `http://127.0.0.1:${server.address().port}` };
}
const ask = (base, body, headers = { 'x-noevia-store-token': SECRET }, path = PREFIX, method = 'POST', signal) =>
  fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body), signal });
const settled = () => new Promise((r) => setTimeout(r, 30));

test('only the front may ask: a wrong secret and a proxied request get an unknown path\'s 404, and hold nothing', async (t) => {
  let entered = 0;
  const { base, routes } = await serve(t, { modelManager: { enterInference: () => { entered++; return () => {}; } } });
  for (const headers of [{}, { 'x-noevia-store-token': 'wrong' }, { 'x-noevia-store-token': SECRET, 'x-noevia-client-ip': '203.0.113.9' }, { 'x-noevia-store-token': SECRET, 'x-forwarded-for': '203.0.113.9' }]) {
    const r = await ask(base, { model: 'm' }, headers);
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: 'Not found' });
  }
  assert.equal(entered, 0);
  assert.equal(routes.leases.size(), 0);
  const noSecret = await serve(t, { secret: '' });
  assert.equal((await ask(noSecret.base, { model: 'm' }, { 'x-noevia-store-token': '' })).status, 404);
  assert.equal((await ask(base, null, undefined, '/internal/inference-admission/other', 'GET')).status, 418, 'not this route');
});

test('a lease holds maintenance and the gate; release and the renewal limit give both back', async (t) => {
  const log = [];
  const modelManager = {
    enterInference: () => { log.push('enter'); return () => log.push('leave'); },
    acquireLease: async (model, o) => { log.push(`gate ${model} ${o.maxWaitMs}`); return { headers: () => ({ 'x-noevia-lease': 'abc' }), release: async () => log.push('gate-release') }; },
  };
  const { base, routes } = await serve(t, { modelManager, ttlMs: 60 });
  const r = await ask(base, { model: 'm' });
  assert.equal(r.status, 201);
  const grant = await r.json();
  assert.match(grant.lease, /^[0-9a-f]{32}$/);
  assert.deepEqual(grant.headers, { 'x-noevia-lease': 'abc' });
  assert.equal((await ask(base, null, undefined, `${PREFIX}/${grant.lease}/renew`)).status, 200);
  const del = await ask(base, null, undefined, `${PREFIX}/${grant.lease}`, 'DELETE');
  assert.equal(del.status, 204);
  assert.deepEqual(log, ['enter', 'gate m 120000', 'gate-release', 'leave']);
  assert.equal((await ask(base, null, undefined, `${PREFIX}/${grant.lease}/renew`)).status, 404);
  assert.equal((await ask(base, null, undefined, `${PREFIX}/${grant.lease}`, 'DELETE')).status, 204, 'already ended is still done');
  // A front that died: not renewed, and it ends by itself.
  log.length = 0;
  await ask(base, { model: 'm' });
  assert.equal(routes.leases.size(), 1);
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(routes.leases.size(), 0);
  assert.deepEqual(log.slice(-2), ['gate-release', 'leave']);
});

test('without a gate the budget check still refuses, in its words, and gives the gate of maintenance back', async (t) => {
  let left = 0;
  const { base } = await serve(t, {
    modelManager: { enterInference: () => () => { left++; } },
    admitEngineModel: async () => { throw Object.assign(Error('over'), { status: 409, publicMessage: 'Over the inference budget.', code: 'overBudget' }); },
  });
  const r = await ask(base, { model: 'big' });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: 'Over the inference budget.', code: 'overBudget' });
  assert.equal(left, 1);
});

test('maintenance refuses with core\'s words: tuning\'s own 503 text, anything else busy', async (t) => {
  const refuse = (status, message) => ({ enterInference: () => { throw Object.assign(Error(message), { status }); } });
  const tuning = await serve(t, { modelManager: refuse(503, 'A model is being tuned.') });
  let r = await ask(tuning.base, { model: 'm' });
  assert.deepEqual([r.status, await r.json()], [503, { error: 'A model is being tuned.' }]);
  const other = await serve(t, { modelManager: refuse(409, 'internal words') });
  r = await ask(other.base, { model: 'm' });
  assert.deepEqual([r.status, await r.json()], [409, { error: 'The model is busy. Try again shortly.' }]);
  r = await ask(other.base, {});
  assert.equal(r.status, 400);
});

test('a caller that goes away while queued aborts the wait and holds nothing', async (t) => {
  let left = 0, aborted = false, released = 0;
  let granted;
  const modelManager = {
    enterInference: () => () => { left++; },
    acquireLease: (m, { signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { aborted = true; });
      granted = () => resolve({ headers: () => ({}), release: async () => { released++; } });
    }),
  };
  const { base, routes } = await serve(t, { modelManager });
  const controller = new AbortController();
  const pending = ask(base, { model: 'm' }, undefined, PREFIX, 'POST', controller.signal).catch(() => 'gone');
  await settled();
  controller.abort();
  assert.equal(await pending, 'gone');
  await settled();
  assert.equal(aborted, true, 'the wait saw the caller go');
  granted();
  await settled();
  assert.equal(routes.leases.size(), 0, 'a late grant is no lease');
  assert.equal(released, 1, 'and the gate gets its lease back');
  assert.equal(left, 1);
});

test('a machine turn granted after the caller left is given straight back', async (t) => {
  let readyNow, ended = 0;
  const chatMachines = {
    target: () => ({ machine: { id: 'm1' }, model: 'm' }),
    ready: () => new Promise((resolve) => { readyNow = () => resolve({ ok: true }); }),
    beginTurn: () => () => { ended++; },
  };
  const { base, routes } = await serve(t, { chatMachines });
  const controller = new AbortController();
  const pending = ask(base, { role: 'smart', machine: 'm1', model: 'm' }, undefined, PREFIX, 'POST', controller.signal).catch(() => 'gone');
  await settled();
  controller.abort();
  assert.equal(await pending, 'gone');
  await settled();
  readyNow();
  await settled();
  assert.equal(routes.leases.size(), 0);
  assert.equal(ended, 1);
});

// The front's Diary local exchange (rust-diary-local-exchange.cjs): the gate waited for briefly, the throttle chat
// shares counted once, the backfill paused; all held until the lease ends.
test('a Diary exchange lease holds the gate, counts the throttle once and pauses the backfill until it ends', async (t) => {
  const log = [];
  const modelManager = {
    enterInferenceWithin: async (waitMs, signal) => { log.push(`enter ${waitMs} ${signal instanceof AbortSignal}`); return () => log.push('leave'); },
    enterInference: () => { throw new Error('the exchange waits like chat, it does not use the immediate enter'); },
    acquireLease: async () => { throw new Error('an exchange does not take a model lease'); },
  };
  const diaryExchange = { rateLimited: (user) => { log.push(`throttle ${user}`); return false; }, foreground: () => { log.push('pause'); return () => log.push('resume'); } };
  const { base, routes } = await serve(t, { modelManager, diaryExchange });
  const r = await ask(base, { diaryExchange: { user: 'u-synthetic' } });
  assert.equal(r.status, 201);
  const grant = await r.json();
  assert.match(grant.lease, /^[0-9a-f]{32}$/);
  assert.equal('headers' in grant, false);
  assert.deepEqual(log, ['enter 3000 true', 'throttle u-synthetic', 'pause']);
  assert.equal((await ask(base, null, undefined, `${PREFIX}/${grant.lease}/renew`)).status, 200);
  assert.equal((await ask(base, null, undefined, `${PREFIX}/${grant.lease}`, 'DELETE')).status, 204);
  assert.deepEqual(log.slice(3), ['resume', 'leave']);
  assert.equal(routes.leases.size(), 0);
});

test('a Diary exchange refusal: the gate\'s 503 in its words, the throttle\'s 429 (gate given back), a bad ask 400', async (t) => {
  let entered = 0, left = 0, paused = 0;
  const held = Object.assign(new Error('Model configuration is being applied. Try again shortly.'), { status: 503 });
  let gateHeld = false, limited = false;
  const modelManager = { enterInferenceWithin: async () => { if (gateHeld) throw Object.assign(held, { code: 'inferenceMaintenance' }); entered++; return () => left++; } };
  const diaryExchange = { rateLimited: () => limited, foreground: () => { paused++; return () => {}; } };
  const { base, routes } = await serve(t, { modelManager, diaryExchange });
  gateHeld = true;
  let r = await ask(base, { diaryExchange: { user: 'u1' } });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 'Model configuration is being applied. Try again shortly.', code: 'inferenceMaintenance' });
  gateHeld = false; limited = true;
  r = await ask(base, { diaryExchange: { user: 'u1' } });
  assert.equal(r.status, 429);
  assert.deepEqual(await r.json(), { error: 'Please wait before sending another message' });
  assert.deepEqual([entered, left, paused], [1, 1, 0], 'the throttled exchange gave the gate back and never paused the backfill');
  for (const body of [{ diaryExchange: {} }, { diaryExchange: { user: '' } }, { diaryExchange: { user: 7 } }, { diaryExchange: { user: 'u1' }, model: 'm' }, { diaryExchange: null }]) {
    r = await ask(base, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(routes.leases.size(), 0);
  // A Core wired without the exchange's throttle refuses rather than admit an uncounted exchange.
  const bare = await serve(t, { modelManager });
  assert.equal((await ask(bare.base, { diaryExchange: { user: 'u1' } })).status, 400);
});

test('a Diary exchange whose caller went away while the gate was waited for holds nothing', async (t) => {
  let release;
  const waiting = new Promise((r) => { release = r; });
  let left = 0, counted = 0;
  const modelManager = { enterInferenceWithin: async () => { await waiting; return () => left++; } };
  const diaryExchange = { rateLimited: () => { counted++; return false; }, foreground: () => () => {} };
  const { base, routes } = await serve(t, { modelManager, diaryExchange });
  const controller = new AbortController();
  const pending = ask(base, { diaryExchange: { user: 'u1' } }, undefined, PREFIX, 'POST', controller.signal).catch(() => null);
  await settled();
  controller.abort();
  await pending;
  await settled();
  release();
  await settled();
  assert.equal(routes.leases.size(), 0);
  assert.equal(left, counted, 'whatever was entered was given back');
});

test('chat port S6: a Diary exchange wired without a throttle (the front counts the llm: budget) is admitted and counts nothing here', async (t) => {
  let entered = 0, left = 0, paused = 0;
  const modelManager = { enterInferenceWithin: async () => { entered++; return () => left++; } };
  const { base, routes } = await serve(t, { modelManager, diaryExchange: { foreground: () => { paused++; return () => {}; } } });
  for (let i = 0; i < 3; i++) {
    const r = await ask(base, { diaryExchange: { user: 'u-synthetic' } });
    assert.equal(r.status, 201);
    const { lease } = await r.json();
    assert.equal((await ask(base, null, undefined, `${PREFIX}/${lease}`, 'DELETE')).status, 204);
  }
  assert.deepEqual([entered, left, paused], [3, 3, 3]);
  assert.equal(routes.leases.size(), 0);
});

test('exclusion-settle: a covered call keeps the gate count after its lease ends until the call has settled', () => {
  const lease = require('./inference-admission-lease.cjs');
  const ev = [];
  for (const how of ['delete', 'expire']) {
    let t = 0;
    const leases = lease.createLeases({ ttlMs: 50, log: () => {}, now: () => t });
    const id = leases.add({ gate: 'chat', release: () => ev.push(`${how}:released`) });
    const settle = leases.cover(id, 'chat');
    assert.equal(typeof settle, 'function');
    if (how === 'delete') leases.release(id);
    else { t = 10 ** 9; assert.equal(leases.renew(id), false); leases.release(id); }
    assert.equal(leases.renew(id), false, 'an ended lease is not renewable');
    assert.deepEqual(ev.filter((e) => e.startsWith(how)), [], `${how}: released while the covered call still ran`);
    settle();
    settle();
    assert.deepEqual(ev.filter((e) => e.startsWith(how)), [`${how}:released`]);
  }
  // A call that settles first: the count is the front's until it deletes the lease.
  const leases = lease.createLeases({ log: () => {} });
  const id = leases.add({ gate: 'chat', release: () => ev.push('early:released') });
  leases.cover(id, 'chat')();
  assert.ok(!ev.includes('early:released'));
  leases.release(id);
  assert.deepEqual(ev.filter((e) => e.startsWith('early')), ['early:released']);
  // An uncovered lease still gives its count back at once.
  const id2 = leases.add({ gate: 'chat', release: () => ev.push('plain:released') });
  leases.release(id2);
  assert.ok(ev.includes('plain:released'));
});
