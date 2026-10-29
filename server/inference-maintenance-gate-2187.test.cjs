'use strict';
// sbstndalton/noevia#2187: the inference gate is the one maintenance authority. With a gate (an
// admin token and a gate that knows the hold) a maintenance hold here is the gate's hold; without
// one it stays this process's own, as before. A synthetic gate stub (in memory) and a synthetic gate
// on loopback; no model, no router, no request content.
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http');
const { createMaintenanceGate } = require('./inference-maintenance.cjs');
const { createGateClient, GateError, HOLD_HEADER } = require('./inference-gate-client.cjs');
const { createModelManager } = require('./model-manager.cjs');
const { fakeGate } = require('./fixtures/fake-inference-gate.cjs');

const HOLD = 'c'.repeat(32);
const BUSY = 'Inference is busy. Wait for requests to finish before changing native presets.';
const tick = () => new Promise((resolve) => setImmediate(resolve));

// An in-memory stand-in for the gate client's maintenance calls. `answer(reason, options)` decides a hold request.
function stubRemote({ answer = async () => ({ token: HOLD, idleTtlMs: 60000 }) } = {}) {
  const log = { holds: [], renewals: [], releases: [] };
  return {
    log,
    async holdMaintenance(reason, options = {}) { log.holds.push({ reason, waitMs: options.waitMs ?? 0 }); return answer(reason, options); },
    async renewMaintenance(token, reason) { log.renewals.push({ token, reason }); return true; },
    async releaseMaintenance(token) { log.releases.push(token); },
  };
}
const timers = () => { const set = []; return { set, setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; set.push(t); return t; }, clearTimer: (t) => { t.cleared = true; } }; };

test('#2187: with a gate, a hold is the gate\'s hold: its token on this process\'s requests, chat refused here with the reason, renewed, released', async () => {
  const remote = stubRemote(), clock = timers();
  const gate = createMaintenanceGate({ remote, setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: () => {} });
  assert.equal(gate.delegated(), true);
  const pending = gate.hold('Chat is paused while noevia calibrates synthetic.');
  // Reserved at once: nothing of this process starts while the gate is asked.
  assert.throws(() => gate.enter(), (e) => e.status === 503 && /calibrates synthetic/.test(e.message));
  const release = await pending;
  assert.deepEqual(remote.log.holds, [{ reason: 'Chat is paused while noevia calibrates synthetic.', waitMs: 0 }]);
  assert.deepEqual(gate.holdHeaders(), { [HOLD_HEADER]: HOLD });
  assert.equal(gate.held(), true);
  assert.equal(clock.set[0].ms, 20000, 'renewed every third of the gate\'s idle limit');
  await clock.set[0].fn();
  release.setReason('Chat is paused while noevia tunes synthetic: phase 2.');
  assert.deepEqual(remote.log.renewals.map((r) => r.reason), ['Chat is paused while noevia calibrates synthetic.', 'Chat is paused while noevia tunes synthetic: phase 2.']);
  release(); release();
  assert.deepEqual(remote.log.releases, [HOLD], 'released once');
  assert.equal(clock.set[0].cleared, true);
  assert.deepEqual(gate.holdHeaders(), {});
  const leave = gate.enter(); leave();
});

test('#2187: the gate refusing the hold (work running, or another client\'s hold) is the same 409 as before, and leaves nothing held', async () => {
  for (const refusal of [
    new GateError({ code: 'engine_busy', status: 409, retryable: true, message: 'The local model engine is busy switching or answering. Try again shortly.' }),
    new GateError({ code: 'maintenance_held', status: 503, retryable: true, message: 'Model settings are being changed or measured. Try again shortly.' }),
  ]) {
    const remote = stubRemote({ answer: async () => { throw refusal; } });
    const gate = createMaintenanceGate({ remote, log: () => {} });
    await assert.rejects(gate.hold('Applying'), (e) => e.status === 409 && e.message === BUSY);
    assert.equal(gate.held(), false);
    const leave = gate.enter(); leave();
    await assert.rejects(gate.exclusive(async () => 'never'), (e) => e.status === 409);
  }
});

test('#2187: a gate that does not answer fails the hold closed (no local hold instead)', async () => {
  const remote = stubRemote({ answer: async () => { throw new GateError({ code: 'engine_unavailable', status: 502, retryable: true, message: 'The local model engine is not answering. Try again shortly.' }); } });
  const gate = createMaintenanceGate({ remote, log: () => {} });
  await assert.rejects(gate.hold('Applying'), (e) => e.status === 502 && e.code === 'engine_unavailable');
  assert.equal(gate.held(), false);
  assert.equal(gate.delegated(), true, 'still the gate\'s next time');
});

test('#2187: no gate hold API (null) falls back to this process\'s own hold, synchronously from then on', async () => {
  const remote = stubRemote({ answer: async () => null });
  const gate = createMaintenanceGate({ remote, log: () => {} });
  const release = await gate.hold('Applying');
  assert.equal(gate.held(), true);
  assert.deepEqual(gate.holdHeaders(), {}, 'no token to carry');
  release();
  assert.equal(gate.delegated(), false);
  const again = gate.hold('Applying');
  assert.equal(typeof again, 'function', 'local and synchronous, as before #2187');
  assert.throws(() => gate.hold('Second'), (e) => e.status === 409 && e.message === BUSY);
  again();
  assert.equal(remote.log.holds.length, 1, 'the gate is not asked again');
  assert.equal(remote.log.releases.length, 0);
  // Without any remote it is the old gate, unchanged.
  const local = createMaintenanceGate();
  assert.equal(local.delegated(), false);
  const leave = local.enter();
  assert.throws(() => local.hold('x'), (e) => e.status === 409);
  leave();
  const r = local.hold('x'); assert.equal(typeof r, 'function'); r();
});

test('#2187: holdWhenIdle waits at the gate (bounded slices) and gives the gate\'s hold back when a chat turn of this process started meanwhile', async () => {
  let grant;
  const remote = stubRemote({ answer: (reason, options) => new Promise((resolve) => { grant = () => resolve({ token: HOLD, idleTtlMs: 60000 }); }) });
  const gate = createMaintenanceGate({ remote, setTimer: () => null, clearTimer: () => {}, log: () => {} });
  const holding = gate.holdWhenIdle('Chat is paused while noevia tunes synthetic: preparing.', { timeoutMs: 5000 });
  await tick();
  assert.equal(remote.log.holds.length, 1);
  assert.ok(remote.log.holds[0].waitMs > 0 && remote.log.holds[0].waitMs <= 30000, 'the gate waits for other clients, at most a slice');
  // This process's chat may still start while the gate waits for the others (as without a gate).
  const leave = gate.enter();
  grant();
  await tick(); await tick();
  assert.deepEqual(remote.log.releases, [HOLD], 'the gate\'s hold was given back: a turn here is running');
  assert.equal(gate.held(), false);
  leave();
  await tick();
  grant();
  const release = await holding;
  assert.equal(gate.held(), true);
  assert.equal(remote.log.holds.length, 2);
  release();
  assert.deepEqual(remote.log.releases, [HOLD, HOLD]);
});

test('#2187: holdWhenIdle times out and cancels as before when the gate stays busy', async () => {
  const busy = new GateError({ code: 'engine_busy', status: 409, retryable: true, message: 'busy' });
  const remote = stubRemote({ answer: async (reason, { waitMs }) => { await new Promise((r) => setTimeout(r, Math.min(waitMs, 20))); throw busy; } });
  const gate = createMaintenanceGate({ remote, log: () => {} });
  await assert.rejects(gate.holdWhenIdle('Tune', { timeoutMs: 60 }), (e) => e.idleTimeout === true);
  const abort = new AbortController();
  const pending = gate.holdWhenIdle('Tune', { timeoutMs: 5000, signal: abort.signal });
  await tick();
  abort.abort();
  await assert.rejects(pending, (e) => e.cancelled === true);
  assert.equal(gate.held(), false);
});

async function syntheticGate(t, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body }); handler(req, res, body); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}
const ADMIN = 'synthetic-admin-token-0001';
const gateError = (code, message, retryable) => JSON.stringify({ error: { code, message, type: 'gate_error', retryable } });

test('#2187: the gate client takes, renews and releases the hold with the admin token', async (t) => {
  const g = await syntheticGate(t, (req, res) => {
    if (req.method === 'POST' && req.url === '/gate/v1/maintenance') { res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ hold: HOLD, idle_ttl_ms: 45000 })); return; }
    if (req.method === 'POST' && req.url === `/gate/v1/maintenance/${HOLD}/renew`) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"idle_ttl_ms":45000}'); return; }
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
    res.writeHead(500); res.end();
  });
  const client = createGateClient({ baseUrl: g.base + '/v1', adminToken: ADMIN, log: () => {} });
  assert.deepEqual(await client.holdMaintenance('Applying settings', { waitMs: 1500 }), { token: HOLD, idleTtlMs: 45000 });
  assert.equal(await client.renewMaintenance(HOLD, 'Applying settings: reload'), true);
  await client.releaseMaintenance(HOLD);
  assert.deepEqual(g.seen.map((s) => `${s.method} ${s.url}`), ['POST /gate/v1/maintenance', `POST /gate/v1/maintenance/${HOLD}/renew`, `DELETE /gate/v1/maintenance/${HOLD}`]);
  for (const s of g.seen) assert.equal(s.headers['x-noevia-gate-admin'], ADMIN);
  assert.deepEqual(JSON.parse(g.seen[0].body), { reason: 'Applying settings', wait_ms: 1500 });
  assert.deepEqual(JSON.parse(g.seen[1].body), { reason: 'Applying settings: reload' });
});

test('#2187: the gate client passes refusals on and says null where no gate knows the hold', async (t) => {
  let answer = (res) => { res.writeHead(409, { 'content-type': 'application/json' }); res.end(gateError('engine_busy', 'The local model engine is busy switching or answering. Try again shortly.', true)); };
  const g = await syntheticGate(t, (req, res) => answer(res));
  const lines = [];
  const client = createGateClient({ baseUrl: g.base, adminToken: ADMIN, log: (l) => lines.push(l) });
  await assert.rejects(client.holdMaintenance('x'), (e) => e instanceof GateError && e.status === 409 && e.code === 'engine_busy' && e.retryable === true);
  answer = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"hold":"not-a-token"}'); };
  await assert.rejects(client.holdMaintenance('x'), (e) => e.code === 'engine_unavailable');
  // A gate from before #2187 answers its own 404; a router with no gate answers its own.
  answer = (res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end(gateError('not_found', 'No such gate endpoint.', false)); };
  assert.equal(await client.holdMaintenance('x'), null);
  assert.equal(await client.holdMaintenance('x'), null);
  assert.equal(lines.filter((l) => /no maintenance hold/.test(l)).length, 1, 'said once');
  assert.equal(g.seen.length, 3, 'not asked again once known absent');
  const router = await syntheticGate(t, (req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"File Not Found"}'); });
  assert.equal(await createGateClient({ baseUrl: router.base, adminToken: ADMIN, log: () => {} }).holdMaintenance('x'), null);
  // Renewal: 404 is "ended", other failures unknown.
  const ended = await syntheticGate(t, (req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end(gateError('maintenance_hold_unknown', 'ended', false)); });
  assert.equal(await createGateClient({ baseUrl: ended.base, adminToken: ADMIN, log: () => {} }).renewMaintenance(HOLD), false);
  // No admin token: never asks.
  const none = await syntheticGate(t, (req, res) => { res.writeHead(500); res.end(); });
  assert.equal(await createGateClient({ baseUrl: none.base, log: () => {} }).holdMaintenance('x'), null);
  assert.equal(none.seen.length, 0);
});

// The model manager end to end: a preset reload (maintenance.exclusive) takes the gate's hold, its
// router requests carry it, and it is released; without a gate admin it is the in-process hold.
const routerFake = (calls) => async (url, options = {}) => {
  const route = new URL(url).pathname + new URL(url).search;
  calls.push({ route, hold: options.headers?.[HOLD_HEADER] || null });
  return { ok: true, status: 200, body: { data: [{ id: 'synthetic-chat', status: { value: 'unloaded' } }] } };
};

test('#2187: the model manager\'s preset reload holds the gate\'s hold and its router requests carry it', async () => {
  const remote = stubRemote();
  const gate = { ...fakeGate({ admin: ADMIN }), ...remote };
  const calls = [];
  const manager = createModelManager({ gate, kind: 'llamacpp', baseUrl: 'http://synthetic', fetchJson: routerFake(calls) });
  const result = await manager.reloadPresets({ unload: false });
  assert.equal(result.ok, true);
  assert.deepEqual(remote.log.holds.map((h) => h.waitMs), [0]);
  assert.ok(calls.length >= 2);
  assert.ok(calls.every((c) => c.hold === HOLD), 'every request under the hold carries it');
  assert.ok(calls.some((c) => c.route === '/models?reload=1'));
  assert.deepEqual(remote.log.releases, [HOLD]);
  assert.equal(manager.maintenanceHeld(), false);
  calls.length = 0;
  await manager.request('/models');
  assert.equal(calls[0].hold, null, 'not after the release');
  // The sweep's hold: a promise of the release, rejected with the busy 409 while a chat runs here.
  const leave = manager.enterInference();
  assert.throws(() => manager.holdMaintenance('Sweep'), (e) => e.status === 409);
  leave();
  const sweep = await manager.holdMaintenance('Sweep');
  assert.equal(manager.maintenanceHeld(), true);
  sweep();
});

test('#2187: without a gate admin token the manager keeps its own in-process hold (nothing asked of the gate)', async () => {
  const remote = stubRemote();
  const gate = { ...fakeGate(), ...remote };
  const calls = [];
  const manager = createModelManager({ gate, kind: 'llamacpp', baseUrl: 'http://synthetic', fetchJson: routerFake(calls) });
  assert.equal((await manager.reloadPresets({ unload: false })).ok, true);
  assert.equal(remote.log.holds.length, 0);
  assert.ok(calls.every((c) => c.hold === null));
  const release = manager.holdMaintenance('Sweep');
  assert.equal(typeof release, 'function', 'synchronous, as before #2187');
  release();
});
