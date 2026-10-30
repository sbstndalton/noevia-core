'use strict';
// sbstndalton/noevia#2210: the Rust front's reload against this process's own maintenance gate, over real HTTP and
// the real manager. Synthetic router only; no engine is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createLeaseRoutes, PREFIX } = require('./model-maintenance-lease.cjs');
const { createMaintenanceGate } = require('./inference-maintenance.cjs');
const { createLlamaCppManager } = require('./llamacpp-manager.cjs');

const SECRET = 'synthetic-store-token-0123456789abcdef';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** The real manager with no gate configured (no admin token): its maintenance gate is in-process. */
function realManager() {
  return createLlamaCppManager({
    baseUrl: 'http://127.0.0.1:9/v1', gateAdminToken: null, fetchStream: async () => ({ ok: false }),
    gate: { hasAdmin: () => false, waiting: () => 0 },
    fetchJson: async () => ({ ok: true, status: 200, body: { data: [] } }),
  });
}

async function serve(t, { hold, ...options }) {
  const logs = [];
  const routes = createLeaseRoutes({ secret: SECRET, hold, log: (m) => logs.push(m), json: (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  }, ...options });
  const server = http.createServer(async (req, res) => {
    if (!(await routes.handle(req, res))) { res.writeHead(418); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ask = async (method, path = PREFIX, headers = { 'x-noevia-store-token': SECRET }) => {
    const r = await fetch(base + path, { method, headers });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  return { ask, routes, logs };
}

test('chat active refuses the lease with the 409, and nothing is held', async (t) => {
  const manager = realManager();
  const { ask } = await serve(t, { hold: () => manager.holdMaintenance() });
  const leave = manager.enterInference();
  const refused = await ask('POST');
  assert.equal(refused.status, 409);
  assert.equal(refused.body.chatActive, true);
  assert.equal(manager.maintenanceHeld(), false);
  leave();
  assert.equal((await ask('POST')).status, 201, 'the same request passes once the chat has ended');
});

test('a held lease holds chat, tune, calibration and every other hold back, until it is released', async (t) => {
  const manager = realManager();
  const { ask } = await serve(t, { hold: () => manager.holdMaintenance() });
  const { body: { lease } } = await ask('POST');
  assert.throws(() => manager.enterInference(), (e) => e.status === 503, 'chat is held back');
  await assert.rejects(manager.enterInferenceWithin(10), (e) => e.status === 503 && e.retryable === true);
  assert.equal(manager.maintenanceHeld(), true);
  assert.equal(manager.tuningActive(), true, 'tune and calibration read this');
  assert.throws(() => manager.holdMaintenance('calibration'), (e) => e.status === 409, 'a tune or calibration start is refused');
  assert.equal((await ask('POST')).status, 409, 'a second reload is refused');
  // A chat that waits within its allowance gets in as soon as the lease ends.
  const waiting = manager.enterInferenceWithin(2000);
  assert.equal((await ask('DELETE', `${PREFIX}/${lease}`)).status, 204);
  (await waiting)();
  assert.equal(manager.maintenanceHeld(), false);
  assert.equal((await ask('DELETE', `${PREFIX}/${lease}`)).status, 204, 'release is idempotent');
});

test('Node\'s own reload, delete and prune path (exclusive) is refused during a lease', async (t) => {
  const manager = realManager();
  const { ask } = await serve(t, { hold: () => manager.holdMaintenance() });
  await ask('POST');
  await assert.rejects(manager.reloadPresets({ unload: true }), (e) => e.status === 409);
});

test('a lease whose front died expires by itself; a renewed one lasts; an ended one answers 404', async (t) => {
  const manager = realManager();
  const { ask, logs, routes } = await serve(t, { hold: () => manager.holdMaintenance(), ttlMs: 120 });
  const { body: { lease, ttlMs } } = await ask('POST');
  assert.equal(ttlMs, 120);
  for (let i = 0; i < 4; i++) {
    await delay(60);
    assert.equal((await ask('POST', `${PREFIX}/${lease}/renew`)).status, 200);
    assert.equal(manager.maintenanceHeld(), true, 'renewed: still held');
  }
  await delay(250);
  assert.equal(manager.maintenanceHeld(), false, 'not renewed: over by itself');
  assert.equal(routes.leases.size(), 0);
  assert.match(logs.join('\n'), /was not renewed/);
  manager.enterInference()();
  assert.equal((await ask('POST', `${PREFIX}/${lease}/renew`)).status, 404, 'the front learns it has ended');
});

test('renewal cannot keep a lease past its hard limit', async (t) => {
  const manager = realManager();
  const { ask } = await serve(t, { hold: () => manager.holdMaintenance(), ttlMs: 100, hardMs: 150 });
  const { body: { lease } } = await ask('POST');
  await delay(70);
  assert.equal((await ask('POST', `${PREFIX}/${lease}/renew`)).status, 200);
  await delay(120);
  assert.equal(manager.maintenanceHeld(), false);
});

test('no window between check and act: in one tick, either the chat or the lease wins, never both', async () => {
  const gate = createMaintenanceGate();
  // The hold is taken synchronously, so a chat entering right after it is refused...
  const release = gate.hold();
  assert.throws(() => gate.enter(), (e) => e.status === 503);
  release();
  // ...and a chat that entered first refuses the hold, however close together they are.
  const leave = gate.enter();
  assert.throws(() => gate.hold(), (e) => e.status === 409 && e.chatActive === true);
  leave();
});

test('concurrent asks: exactly one lease', async (t) => {
  const manager = realManager();
  const { ask } = await serve(t, { hold: () => manager.holdMaintenance() });
  const answers = await Promise.all([ask('POST'), ask('POST'), ask('POST'), ask('POST')]);
  assert.deepEqual(answers.map((a) => a.status).sort(), [201, 409, 409, 409]);
});

test('only the front may ask: a wrong or missing secret, or a proxied request, is the 404 of an unknown path', async (t) => {
  const manager = realManager();
  const { ask } = await serve(t, { hold: () => manager.holdMaintenance() });
  for (const headers of [{}, { 'x-noevia-store-token': 'wrong' }, { 'x-noevia-store-token': SECRET, 'x-noevia-client-ip': '192.0.2.7' }, { 'x-noevia-store-token': SECRET, 'x-forwarded-for': '192.0.2.7' }]) {
    assert.equal((await ask('POST', PREFIX, headers)).status, 404, JSON.stringify(Object.keys(headers)));
  }
  assert.equal(manager.maintenanceHeld(), false);
  assert.equal((await ask('GET')).status, 404);
  assert.equal((await ask('POST', `${PREFIX}/nothex/renew`)).status, 404);
});

test('an empty secret refuses everyone, and an engine without holds has no lease', async (t) => {
  const manager = realManager();
  const blank = await serve(t, { hold: () => manager.holdMaintenance(), secret: '' });
  assert.equal((await blank.ask('POST', PREFIX, { 'x-noevia-store-token': '' })).status, 404);
  const none = await serve(t, { hold: null });
  assert.equal((await none.ask('POST')).status, 404);
});

test('a failure other than busy is not a lease', async (t) => {
  const { ask } = await serve(t, { hold: async () => { throw new Error('gate down'); } });
  assert.equal((await ask('POST')).status, 503);
});

test('other paths are not this route\'s', async (t) => {
  const manager = realManager();
  const { ask } = await serve(t, { hold: () => manager.holdMaintenance() });
  assert.equal((await ask('POST', '/internal/model-maintenance/leases')).status, 418);
});
