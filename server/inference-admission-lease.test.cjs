'use strict';
// #2218, port contract row H: the Rust front's authority issues each lease and this process latches its holds for the
// ticket over real loopback HTTP: only the front may ask, a refusal keeps the step's own words, a caller that goes
// away holds nothing, an unrenewed latch ends by itself, and nothing is latched outside the current session.
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const crypto = require('node:crypto');
const { createAdmissionRoutes, createAuthoritySession, PREFIX } = require('./inference-admission-lease.cjs');
const { json, readJson } = require('./http.cjs');

const SECRET = 's'.repeat(40);

const EPOCH = 'e'.repeat(32);
/** A synthetic session with the front's authority: `set(next)` changes it as a re-registration would. */
function fakeAuthority(initial = { epoch: EPOCH, incarnation: 1 }) {
  let current = initial;
  const listeners = [];
  return { current: () => current, onChange: (fn) => listeners.push(fn), set(next) { current = next; for (const fn of listeners) fn(next); } };
}
const fence = (a = { epoch: EPOCH, incarnation: 1 }) => ({ 'x-noevia-admission-epoch': a.epoch, 'x-noevia-admission-incarnation': String(a.incarnation) });
const ticket = () => crypto.randomBytes(16).toString('hex');

async function serve(t, options) {
  const authority = options?.authority || fakeAuthority();
  const routes = createAdmissionRoutes({ secret: SECRET, json, readJson, admitEngineModel: async () => {}, modelManager: {}, log: () => {}, ...options, authority });
  const server = http.createServer(async (req, res) => { if (!await routes.handle(req, res)) { res.statusCode = 418; res.end(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { routes, authority, base: `http://127.0.0.1:${server.address().port}` };
}
const FRONT = { 'x-noevia-store-token': SECRET, ...fence() };
// `path` null: a fresh ticket's PUT.
const ask = (base, body, headers = FRONT, path = null, method = 'PUT', signal) =>
  fetch(base + (path ?? `${PREFIX}/${ticket()}`), { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body), signal });
const settled = () => new Promise((r) => setTimeout(r, 30));

test('only the front may ask: a wrong secret and a proxied request get an unknown path\'s 404, and hold nothing', async (t) => {
  let entered = 0;
  const { base, routes } = await serve(t, { modelManager: { enterInference: () => { entered++; return () => {}; } } });
  for (const headers of [{}, { 'x-noevia-store-token': 'wrong' }, { 'x-noevia-store-token': SECRET, 'x-noevia-client-ip': '203.0.113.9' }, { 'x-noevia-store-token': SECRET, 'x-forwarded-for': '203.0.113.9' }]) {
    const r = await ask(base, { model: 'm' }, { ...headers, ...fence() });
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: 'Not found' });
  }
  assert.equal(entered, 0);
  assert.equal(routes.latches.size(), 0);
  const noSecret = await serve(t, { secret: '' });
  assert.equal((await ask(noSecret.base, { model: 'm' }, { 'x-noevia-store-token': '', ...fence() })).status, 404);
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
  assert.equal(grant.ttlMs, 60);
  assert.equal((await ask(base, null, undefined, `${PREFIX}/${grant.lease}/renew`, 'POST')).status, 200);
  const del = await ask(base, null, undefined, `${PREFIX}/${grant.lease}`, 'DELETE');
  assert.equal(del.status, 204);
  assert.deepEqual(log, ['enter', 'gate m 120000', 'gate-release', 'leave']);
  assert.equal((await ask(base, null, undefined, `${PREFIX}/${grant.lease}/renew`, 'POST')).status, 404);
  assert.equal((await ask(base, null, undefined, `${PREFIX}/${grant.lease}`, 'DELETE')).status, 204, 'already ended is still done');
  // A front that died: not renewed, and it ends by itself.
  log.length = 0;
  await ask(base, { model: 'm' });
  assert.equal(routes.latches.size(), 1);
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(routes.latches.size(), 0);
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
  const pending = ask(base, { model: 'm' }, undefined, null, 'PUT', controller.signal).catch(() => 'gone');
  await settled();
  controller.abort();
  assert.equal(await pending, 'gone');
  await settled();
  assert.equal(aborted, true, 'the wait saw the caller go');
  granted();
  await settled();
  assert.equal(routes.latches.size(), 0, 'a late grant is no lease');
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
  const pending = ask(base, { role: 'smart', machine: 'm1', model: 'm' }, undefined, null, 'PUT', controller.signal).catch(() => 'gone');
  await settled();
  controller.abort();
  assert.equal(await pending, 'gone');
  await settled();
  readyNow();
  await settled();
  assert.equal(routes.latches.size(), 0);
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
  assert.equal((await ask(base, null, undefined, `${PREFIX}/${grant.lease}/renew`, 'POST')).status, 200);
  assert.equal((await ask(base, null, undefined, `${PREFIX}/${grant.lease}`, 'DELETE')).status, 204);
  assert.deepEqual(log.slice(3), ['resume', 'leave']);
  assert.equal(routes.latches.size(), 0);
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
  assert.equal(routes.latches.size(), 0);
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
  const pending = ask(base, { diaryExchange: { user: 'u1' } }, undefined, null, 'PUT', controller.signal).catch(() => null);
  await settled();
  controller.abort();
  await pending;
  await settled();
  release();
  await settled();
  assert.equal(routes.latches.size(), 0);
  assert.equal(left, counted, 'whatever was entered was given back');
});

// Port contract row H: this process no longer issues leases; it latches only for the front's current session.
test('this process issues no lease of its own: the old POST is gone and a bad ticket is an unknown path', async (t) => {
  let entered = 0;
  const { base, routes } = await serve(t, { modelManager: { enterInference: () => { entered++; return () => {}; } } });
  assert.equal((await ask(base, { model: 'm' }, FRONT, PREFIX, 'POST')).status, 404);
  assert.equal((await ask(base, { model: 'm' }, FRONT, `${PREFIX}/short`)).status, 404);
  assert.equal((await ask(base, { model: 'm' }, FRONT, `${PREFIX}/${'A'.repeat(32)}`)).status, 404);
  assert.deepEqual([entered, routes.latches.size()], [0, 0]);
});

test('without a session nothing is latched (503), and another epoch or incarnation is refused (410)', async (t) => {
  let entered = 0;
  const modelManager = { enterInference: () => { entered++; return () => {}; } };
  const none = await serve(t, { modelManager, authority: fakeAuthority(null) });
  let r = await ask(none.base, { model: 'm' });
  assert.deepEqual([r.status, await r.json()], [503, { error: 'The model is busy. Try again shortly.' }]);
  const { base } = await serve(t, { modelManager });
  for (const f of [{ epoch: 'f'.repeat(32), incarnation: 1 }, { epoch: EPOCH, incarnation: 2 }]) {
    r = await ask(base, { model: 'm' }, { 'x-noevia-store-token': SECRET, ...fence(f) });
    assert.equal(r.status, 410);
  }
  r = await ask(base, { model: 'm' }, { 'x-noevia-store-token': SECRET });
  assert.equal(r.status, 410, 'no fence at all');
  assert.equal(entered, 0);
});

test('a front restart (new epoch) or a retirement ends every latch of the old session at once', async (t) => {
  const log = [];
  const modelManager = { enterInference: () => { log.push('enter'); return () => log.push('leave'); } };
  const { base, routes, authority } = await serve(t, { modelManager });
  const id = ticket();
  assert.equal((await ask(base, { model: 'm' }, FRONT, `${PREFIX}/${id}`)).status, 201);
  assert.equal(routes.latches.size(), 1);
  authority.set({ epoch: 'f'.repeat(32), incarnation: 1 });
  assert.deepEqual([routes.latches.size(), log], [0, ['enter', 'leave']]);
  // The old front's renewal is refused as another session's, the new front can latch.
  assert.equal((await ask(base, null, FRONT, `${PREFIX}/${id}/renew`, 'POST')).status, 410);
  const next = fence({ epoch: 'f'.repeat(32), incarnation: 1 });
  assert.equal((await ask(base, { model: 'm' }, { 'x-noevia-store-token': SECRET, ...next })).status, 201);
  authority.set(null);
  assert.equal(routes.latches.size(), 0);
  assert.equal((await ask(base, { model: 'm' }, { 'x-noevia-store-token': SECRET, ...next })).status, 503);
});

test('a ticket given back while its latch is being taken holds nothing (ticketed give-back), and is not retaken', async (t) => {
  let grant, released = 0, left = 0;
  const modelManager = {
    enterInference: () => () => { left++; },
    acquireLease: () => new Promise((resolve) => { grant = () => resolve({ headers: () => ({}), release: async () => { released++; } }); }),
  };
  const { base, routes } = await serve(t, { modelManager });
  const id = ticket();
  const pending = ask(base, { model: 'm' }, FRONT, `${PREFIX}/${id}`).then((r) => r.status);
  await settled();
  assert.equal((await ask(base, null, FRONT, `${PREFIX}/${id}`, 'DELETE')).status, 204);
  grant();
  assert.equal(await pending, 503);
  await settled();
  assert.deepEqual([routes.latches.size(), released, left], [0, 1, 1]);
  assert.equal((await ask(base, { model: 'm' }, FRONT, `${PREFIX}/${id}`)).status, 404, 'a given-back ticket is never latched again');
});

test('the same ticket cannot latch twice', async (t) => {
  const { base, routes } = await serve(t, {});
  const id = ticket();
  assert.equal((await ask(base, { model: 'm' }, FRONT, `${PREFIX}/${id}`)).status, 201);
  assert.equal((await ask(base, { model: 'm' }, FRONT, `${PREFIX}/${id}`)).status, 409);
  assert.equal(routes.latches.size(), 1);
});

test('the session registers with the front, keeps its incarnation, follows a new epoch and retires on 410', async () => {
  const calls = [];
  let answer = { status: 200, body: { incarnation: 3, epoch: 'a'.repeat(32), ttlMs: 30000 } };
  const fetchImpl = async (url, init) => { calls.push([url, init.headers['x-noevia-store-token'], JSON.parse(init.body)]); return { status: answer.status, json: async () => answer.body }; };
  const changes = [];
  const s = createAuthoritySession({ port: 4321, token: 'tok', fetchImpl, boot: 'b1', startedAt: 7, log: () => {} });
  s.onChange((n) => changes.push(n));
  assert.equal(s.current(), null);
  await s.register();
  assert.deepEqual(s.current(), { epoch: 'a'.repeat(32), incarnation: 3 });
  assert.deepEqual(calls[0], ['http://127.0.0.1:4321/v1/inference-admission/session', 'tok', { boot: 'b1', startedAt: 7 }]);
  await s.register();
  assert.equal(changes.length, 1, 'the same answer is no change');
  answer = { status: 500, body: null };
  await s.register();
  assert.deepEqual(s.current(), { epoch: 'a'.repeat(32), incarnation: 3 }, 'no answer keeps the session');
  answer = { status: 200, body: { incarnation: 1, epoch: 'b'.repeat(32) } };
  await s.register();
  assert.deepEqual(changes.at(-1), { epoch: 'b'.repeat(32), incarnation: 1 });
  answer = { status: 410, body: { error: 'newer' } };
  await s.register();
  assert.equal(s.current(), null);
  assert.equal(s.retired(), true);
  answer = { status: 200, body: { incarnation: 9, epoch: 'c'.repeat(32) } };
  await s.register();
  assert.equal(s.current(), null, 'a retired start never registers again');
  const unconfigured = createAuthoritySession({ port: 0, token: '', fetchImpl: async () => { throw new Error('never'); } });
  assert.equal(await unconfigured.register(), null);
});
