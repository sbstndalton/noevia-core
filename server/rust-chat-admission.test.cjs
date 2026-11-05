'use strict';
// Chat port S8 (rust-chat-admission.cjs): the front takes the inference gate for a chat turn, a Cowork start or the
// Diary local exchange with an admission lease, over real loopback HTTP. These are chat-admission-1896's cases as the
// front meets them (a briefly held gate is waited for, a longer hold is refused with the gate's words and code after
// the bounded wait, the wait ends when the front goes away) and the cover rule that keeps one gate count per call.
// Synthetic only.
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { createAdmissionRoutes, createAdmission, PREFIX } = require('./inference-admission-lease.cjs');
const { createMaintenanceGate } = require('./inference-maintenance.cjs');
const front = require('./rust-chat-admission.cjs');
const { json, readJson } = require('./http.cjs');

const SECRET = 's'.repeat(40);
const manager = (gate) => ({ enterInference: gate.enter, enterInferenceWithin: gate.enterWithin });

async function serve(t, options) {
  const routes = createAdmissionRoutes({ secret: SECRET, json, readJson, admitEngineModel: async () => {}, log: () => {}, ...options });
  const server = http.createServer(async (req, res) => { if (!await routes.handle(req, res)) { res.statusCode = 418; res.end(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { routes, base: `http://127.0.0.1:${server.address().port}` };
}
const ask = (base, body, { path = PREFIX, method = 'POST', signal } = {}) =>
  fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-noevia-store-token': SECRET }, body: body && JSON.stringify(body), signal });
const settled = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('the capability marker and the names the front pairs with', () => {
  assert.equal(front.FRONT_CAPABILITY, 'rust-chat-admission');
  assert.equal(front.LEASE_HEADER, 'x-noevia-admission-lease');
  assert.deepEqual(front.GATE_ROUTES, ['chat', 'diary']);
  // The route a request's lease must be for (index.cjs): the relay is chat's (a turn or a Cowork start).
  assert.equal(front.gateRoute('turn', '/api/chat'), 'chat');
  assert.equal(front.gateRoute(null, '/api/diary/local-exchange'), 'diary');
  for (const [relay, pathname] of [[null, '/api/chat'], [null, '/api/diary/other'], [undefined, '/api/diary/local-exchange/'], ['done', '/api/chat']]) {
    assert.equal(front.gateRoute(relay, pathname), '', `${relay} ${pathname}`);
  }
});

test('a free gate: the lease is one gate count, held until the front deletes it', async (t) => {
  const gate = createMaintenanceGate();
  const { base, routes } = await serve(t, { modelManager: manager(gate) });
  for (const route of front.GATE_ROUTES) {
    const r = await ask(base, { gate: route });
    assert.equal(r.status, 201, route);
    const grant = await r.json();
    assert.match(grant.lease, /^[0-9a-f]{32}$/);
    assert.equal(grant.headers, undefined, 'the gate alone sends no engine header');
    assert.equal(gate.active(), 1, 'exactly one count');
    assert.equal((await ask(base, null, { path: `${PREFIX}/${grant.lease}/renew` })).status, 200);
    assert.equal((await ask(base, null, { path: `${PREFIX}/${grant.lease}`, method: 'DELETE' })).status, 204);
    assert.equal(gate.active(), 0);
  }
  assert.equal(routes.leases.size(), 0);
});

test('#1896 as the front meets it: a gate held for a moment is waited for, and the lease is granted', async (t) => {
  const gate = createMaintenanceGate();
  const release = gate.hold('Chat is paused while noevia tunes m: preparing.');
  const { base } = await serve(t, { modelManager: manager(gate) });
  setTimeout(release, 50);
  const t0 = Date.now();
  const r = await ask(base, { gate: 'chat' });
  assert.equal(r.status, 201);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(gate.active(), 1);
  await ask(base, null, { path: `${PREFIX}/${(await r.json()).lease}`, method: 'DELETE' });
  assert.equal(gate.active(), 0);
});

test('#1896 as the front meets it: a longer hold is refused after the bounded wait with the gate\'s words and code', async (t) => {
  const gate = createMaintenanceGate();
  const release = gate.hold('Chat is paused while noevia calibrates m.');
  const { base, routes } = await serve(t, { modelManager: manager(gate), gateWaitMs: 60 });
  const t0 = Date.now();
  const r = await ask(base, { gate: 'chat' });
  const took = Date.now() - t0;
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 'Chat is paused while noevia calibrates m.', code: 'inferenceMaintenance' });
  assert.ok(took >= 50 && took < 1000, `waited ${took} ms`);
  assert.equal(routes.leases.size(), 0);
  release();
});

test('the wait is never past 3 s, even when configured longer', async (t) => {
  const gate = createMaintenanceGate();
  const release = gate.hold('x');
  const { base } = await serve(t, { modelManager: manager(gate), gateWaitMs: 60_000 });
  const t0 = Date.now();
  const r = await ask(base, { gate: 'chat' });
  const took = Date.now() - t0;
  assert.equal(r.status, 503);
  assert.ok(took >= 2900 && took < 3600, `waited ${took} ms`);
  release();
});

test('the front going away during the wait ends it and holds nothing, even when the gate opens just after', async (t) => {
  const gate = createMaintenanceGate();
  const release = gate.hold('x');
  const { base, routes } = await serve(t, { modelManager: manager(gate) });
  const abort = new AbortController();
  const pending = ask(base, { gate: 'chat' }, { signal: abort.signal }).catch((e) => e);
  await settled();
  abort.abort();
  assert.equal((await pending).name, 'AbortError');
  await settled();
  release();
  await settled();
  assert.equal(gate.active(), 0);
  assert.equal(routes.leases.size(), 0);
});

test('a manager without a gate admits; an unknown gate or an ask mixing kinds is a 400', async (t) => {
  const { base } = await serve(t, { modelManager: {} });
  const r = await ask(base, { gate: 'chat' });
  assert.equal(r.status, 201);
  for (const body of [{ gate: 'other' }, { gate: 'chat', model: 'm' }, { gate: '' }, { gate: ['chat'] }]) {
    const refused = await ask(base, body);
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
});

test('one gate count per call: a live gate lease covers one call of its route, the header is always removed', async (t) => {
  const gate = createMaintenanceGate();
  const { base, routes } = await serve(t, { modelManager: manager(gate) });
  const chat = (await (await ask(base, { gate: 'chat' })).json()).lease;
  const diary = (await (await ask(base, { gate: 'diary' })).json()).lease;
  const engine = (await (await ask(base, { model: 'm' })).json()).lease;
  const req = (id, extra = {}) => ({ headers: { [front.LEASE_HEADER]: id, cookie: 'c', ...extra } });
  const wrongRoute = req(chat);
  assert.equal(routes.covers(wrongRoute, 'diary'), false, 'bound to its route');
  assert.deepEqual(wrongRoute.headers, { cookie: 'c' }, 'removed whatever happens');
  assert.equal(routes.covers(req(engine), 'chat'), false, 'a model lease is not a gate lease');
  assert.equal(routes.covers(req(chat), ''), false, 'no route, no cover');
  const first = req(chat);
  const settleChat = routes.covers(first, 'chat');
  assert.equal(typeof settleChat, 'function', "covered: the call's settle()");
  assert.deepEqual(first.headers, { cookie: 'c' });
  assert.equal(routes.covers(req(chat), 'chat'), false, 'single use');
  const settleDiary = routes.covers(req(diary), 'diary');
  assert.equal(typeof settleDiary, 'function');
  assert.equal(routes.covers({ headers: {} }, 'chat'), false);
  assert.equal(routes.covers({ headers: { [front.LEASE_HEADER]: ['x'] } }, 'chat'), false);
  assert.equal(routes.covers(null, 'chat'), false);
  // The covered call holds no count of its own: the leases are the counts. Deleting them gives them back, a covered
  // one only once its call has settled (exclusion-settle rule).
  assert.equal(gate.active(), 3);
  for (const id of [chat, diary, engine]) await ask(base, null, { path: `${PREFIX}/${id}`, method: 'DELETE' });
  assert.equal(gate.active(), 2, 'the covered calls still run');
  settleChat();
  settleDiary();
  assert.equal(gate.active(), 0);
  const ended = req(chat);
  assert.equal(routes.covers(ended, 'chat'), false, 'an ended lease covers nothing');
});

test('a gate lease the front stops renewing ends by itself and gives the count back', async (t) => {
  const gate = createMaintenanceGate();
  const { base, routes } = await serve(t, { modelManager: manager(gate), ttlMs: 60 });
  assert.equal((await ask(base, { gate: 'chat' })).status, 201);
  assert.equal(gate.active(), 1);
  await settled(150);
  assert.equal(gate.active(), 0);
  assert.equal(routes.leases.size(), 0);
});

test('review P2-2: the gate opening as the front goes away gives the count back, whatever comes first', async () => {
  // Deterministic: the gate lets the call in and the abort lands before the admission's continuation resumes.
  const gate = createMaintenanceGate();
  const abort = new AbortController();
  const modelManager = {
    enterInference: gate.enter,
    enterInferenceWithin: async () => { const leave = gate.enter(); abort.abort(); return leave; },
  };
  const admit = createAdmission({ modelManager, admitEngineModel: async () => {} });
  await assert.rejects(admit({ gate: 'chat' }, abort.signal));
  assert.equal(gate.active(), 0, 'no gate count is left behind');
});


test('the real gate keeps a 70042-byte refusal complete and exposes bounded retry metadata', { timeout: 5000 }, async (t) => {
  const gate = createMaintenanceGate();
  const reason = 'r'.repeat(70000);
  const release = gate.hold(reason);
  t.after(release);
  const { base } = await serve(t, { modelManager: manager(gate), gateWaitMs: 1 });
  const r = await ask(base, { gate: 'chat' });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('retry-after'), '3');
  assert.equal(r.headers.get('x-noevia-admission-code'), 'inferenceMaintenance');
  const body = await r.text();
  assert.equal(Buffer.byteLength(body), 70042);
  assert.deepEqual(JSON.parse(body), { error: reason, code: 'inferenceMaintenance' });
});

test('oversized refusals keep a bounded code header without putting free text in a header', { timeout: 5000 }, async (t) => {
  const { base } = await serve(t, { modelManager: { enterInference: () => {
    throw Object.assign(Error('r'.repeat(1024 * 1024)), { status: 503, code: 'engineHeld' });
  } } });
  const r = await ask(base, { gate: 'chat' });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('retry-after'), '3');
  assert.equal(r.headers.get('x-noevia-admission-code'), 'engineHeld');
  assert.ok((await r.text()).length > 1024 * 1024);
});


test('refusal code headers exclude overlong values and header delimiters', { timeout: 5000 }, async (t) => {
  for (const code of ['c'.repeat(129), 'bad\r\nheader']) {
    const { base } = await serve(t, { modelManager: { enterInference: () => {
      throw Object.assign(Error('synthetic refusal'), { status: 503, code });
    } } });
    const r = await ask(base, { gate: 'chat' });
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('x-noevia-admission-code'), null);
    assert.equal((await r.json()).code, code);
  }
});


test('the Diary gate keeps its existing refusal headers', { timeout: 5000 }, async (t) => {
  const gate = createMaintenanceGate();
  const release = gate.hold('synthetic maintenance');
  t.after(release);
  const { base } = await serve(t, { modelManager: manager(gate), gateWaitMs: 1 });
  const r = await ask(base, { gate: 'diary' });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('retry-after'), null);
  assert.deepEqual(await r.json(), { error: 'synthetic maintenance', code: 'inferenceMaintenance' });
});
