'use strict';
// Port contract row J: this process's maintenance gate is a client of the Rust front's lease authority
// (noevia-rs model_maint/lease.rs, POST /v1/maintenance-lease/* on the store listener). Over real HTTP to a
// synthetic authority that applies the front's rules; the real manager. Fails closed when it is unreachable.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createNativeLeaseClient, chainRemotes, createLeaseRoutes, LEASE_CLIENT_MARKER, PREFIX } = require('./model-maintenance-lease.cjs');
const { createLlamaCppManager } = require('./llamacpp-manager.cjs');

const SECRET = 'synthetic-store-token-0123456789abcdef';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** A synthetic authority with the front's semantics: one lease, generation fence, boot tracking. */
async function authority(t, { renewMs = 10000, refuseRenew = false } = {}) {
  const calls = [];
  let holder = null, generation = 0, boot = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
      if (req.headers['x-noevia-store-token'] !== SECRET) return send(401, { error: 'unauthorised' });
      const op = req.url.replace('/v1/maintenance-lease/', '');
      const body = JSON.parse(raw || '{}');
      calls.push({ op, body });
      if (body.boot !== boot && (op === 'session' || op === 'acquire')) { boot = body.boot; }
      if (op === 'session') return send(200, { epoch: 'e' });
      if (op === 'acquire') {
        if (holder) return send(409, { error: 'Inference is busy. Wait for requests to finish before changing native presets.', code: 'maintenance_held', chatActive: false });
        holder = { lease: crypto.randomBytes(16).toString('hex'), generation: ++generation };
        return send(201, { ...holder, epoch: 'e', ttlMs: 180000, renewMs, hardMs: 3600000 });
      }
      if (op === 'renew') return holder && holder.lease === body.lease && !refuseRenew ? send(200, {}) : send(404, { error: 'Not found' });
      if (op === 'release') { if (holder && holder.lease === body.lease) holder = null; return send(204); }
      if (op === 'held') return send(200, { held: !!holder, front: false });
      return send(404, { error: 'Not found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return {
    port: server.address().port, calls,
    takeAsFront: () => { holder = { lease: 'f'.repeat(32), generation: ++generation }; },
    releaseFront: () => { holder = null; },
    held: () => holder,
  };
}

function manager(client) {
  return createLlamaCppManager({
    baseUrl: 'http://127.0.0.1:9/v1', gateAdminToken: null, fetchStream: async () => ({ ok: false }),
    gate: { hasAdmin: () => false, waiting: () => 0 },
    fetchJson: async () => ({ ok: true, status: 200, body: { data: [] } }),
    maintenanceAuthority: client,
  });
}

test('the client carries the release marker the assembly pairs with the front', () => {
  assert.equal(LEASE_CLIENT_MARKER, 'noevia-maintenance-lease-client/1');
  assert.match(require('node:fs').readFileSync(require.resolve('./model-maintenance-lease.cjs'), 'utf8'), /'noevia-maintenance-lease-client\/1'/);
});

test('a Node hold is a lease of the front\'s authority: taken there, exclusive, and given back there', async (t) => {
  const a = await authority(t);
  const client = createNativeLeaseClient({ port: a.port, token: SECRET, boot: 'boot-1' });
  const m = manager(client);
  const release = await m.holdMaintenance('synthetic delete');
  const acquire = a.calls.find((c) => c.op === 'acquire');
  assert.equal(acquire.body.boot, 'boot-1');
  assert.equal(acquire.body.reason, 'synthetic delete');
  assert.ok(a.held(), 'the authority records the hold');
  assert.equal(m.maintenanceHeld(), true);
  assert.throws(() => m.enterInference(), (e) => e.status === 503, 'chat is held back');
  assert.deepEqual(m.holdHeaders?.() || {}, {}, 'a native lease id is never sent to the engine as a gate token');
  release();
  await delay(50);
  assert.equal(a.held(), null, 'released at the authority');
  assert.ok(a.calls.some((c) => c.op === 'release'));
  m.enterInference()();
});

test('a lease the front holds refuses Node\'s hold with the waitable 409, and nothing stays held locally', async (t) => {
  const a = await authority(t);
  const m = manager(createNativeLeaseClient({ port: a.port, token: SECRET, boot: 'b' }));
  a.takeAsFront();
  await assert.rejects(m.holdMaintenance('synthetic prune'), (e) => e.status === 409 && e.fromGate === true);
  assert.equal(m.maintenanceHeld(), false, 'the local reservation is undone');
  m.enterInference()();
  a.releaseFront();
  (await m.holdMaintenance('synthetic prune'))();
});

test('an unreachable authority fails the hold closed (503) and changes nothing', async () => {
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const m = manager(createNativeLeaseClient({ port, token: SECRET, boot: 'b' }));
  await assert.rejects(m.holdMaintenance('synthetic tune'), (e) => e.status === 503 && e.code === 'maintenanceAuthorityUnavailable');
  assert.equal(m.maintenanceHeld(), false);
  // Without a secret or a port the client never reaches the network and answers the same 503.
  await assert.rejects(createNativeLeaseClient({ port: NaN, token: '' }).holdMaintenance('x'), (e) => e.status === 503);
  m.enterInference()();
});

test('the gate renews on the authority\'s cadence and retakes a lease the authority forgot (front restart)', async (t) => {
  const a = await authority(t, { renewMs: 400 });
  const m = manager(createNativeLeaseClient({ port: a.port, token: SECRET, boot: 'b' }));
  const release = await m.holdMaintenance('synthetic calibration');
  const first = a.held().lease;
  // idleTtlMs = renewMs * 3, renewed every third of it (the gate's floor is 1 s).
  await delay(1500);
  assert.ok(a.calls.filter((c) => c.op === 'renew').length >= 1, 'renewed');
  a.releaseFront(); // the front restarted: an empty table
  await delay(1500);
  assert.ok(a.held() && a.held().lease !== first, 'taken again under a new lease');
  assert.equal(m.maintenanceHeld(), true, 'the local hold stayed throughout');
  release();
});

test('the latch is a local-only hold: the front\'s lease pauses chat without a second trip to the authority', async (t) => {
  const a = await authority(t);
  const m = manager(createNativeLeaseClient({ port: a.port, token: SECRET, boot: 'b' }));
  const routes = createLeaseRoutes({ secret: SECRET, hold: () => m.holdMaintenanceLocal(), json: (res, s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); } });
  const server = http.createServer(async (req, res) => { if (!(await routes.handle(req, res))) { res.writeHead(418); res.end(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const url = `http://127.0.0.1:${server.address().port}${PREFIX}`;
  const before = a.calls.filter((c) => c.op === 'acquire').length;
  const latched = await fetch(url, { method: 'POST', headers: { 'x-noevia-store-token': SECRET } });
  assert.equal(latched.status, 201);
  const { lease } = await latched.json();
  assert.equal(a.calls.filter((c) => c.op === 'acquire').length, before, 'the authority is not asked again');
  assert.throws(() => m.enterInference(), (e) => e.status === 503);
  assert.throws(() => m.holdMaintenance('x'), (e) => e.status === 409, 'Node\'s own work is refused during the latch');
  assert.equal((await fetch(`${url}/${lease}`, { method: 'DELETE', headers: { 'x-noevia-store-token': SECRET } })).status, 204);
  m.enterInference()();
  // Chat running: the latch is refused with chatActive, as before.
  const leave = m.enterInference();
  const refused = await fetch(url, { method: 'POST', headers: { 'x-noevia-store-token': SECRET } });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).chatActive, true);
  leave();
});

test('a cancelled wait for the authority takes nothing and rejects as cancelled', async (t) => {
  const a = await authority(t);
  const client = createNativeLeaseClient({ port: a.port, token: SECRET, boot: 'b' });
  const ac = new AbortController();
  const pending = client.holdMaintenance('x', { waitMs: 5000, signal: ac.signal });
  ac.abort();
  await assert.rejects(pending, (e) => e.cancelled === true || e.status === 409 || e.status === undefined);
});

test('chainRemotes: the inference gate when it grants, the authority when it has no hold API', async (t) => {
  const a = await authority(t);
  const native = createNativeLeaseClient({ port: a.port, token: SECRET, boot: 'b' });
  const gateCalls = [];
  const gate = { holdMaintenance: async () => null, renewMaintenance: async (tk) => { gateCalls.push(['renew', tk]); return true; }, releaseMaintenance: async (tk) => { gateCalls.push(['release', tk]); }, maintenanceHeld: async () => null };
  const chain = chainRemotes(gate, native);
  const g = await chain.holdMaintenance('x', {});
  assert.equal(g.header, false);
  assert.equal(await chain.renewMaintenance(g.token), true);
  await chain.releaseMaintenance(g.token);
  assert.equal(a.held(), null);
  assert.deepEqual(gateCalls, [], 'a native token never goes to the gate');
  const granted = chainRemotes({ ...gate, holdMaintenance: async () => ({ token: 'a'.repeat(32), idleTtlMs: 60000 }) }, native);
  assert.equal((await granted.holdMaintenance('x', {})).token, 'a'.repeat(32));
  assert.equal(a.held(), null, 'the authority is not asked when the gate grants');
});
