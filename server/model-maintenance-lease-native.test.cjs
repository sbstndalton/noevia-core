'use strict';
// Port contract row J: this process's maintenance gate is a client of the Rust front's lease authority
// (noevia-rs model_maint/lease.rs, POST /v1/maintenance-lease/* on the store listener). Over real HTTP to a
// synthetic authority that applies the front's rules (ordered incarnations, fenced front leases); the real
// manager and its consumers. Fails closed when the authority is unreachable or coverage ends.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createNativeLeaseClient, chainRemotes, createLeaseRoutes, LEASE_CLIENT_MARKER, PREFIX } = require('./model-maintenance-lease.cjs');
const { createLlamaCppManager } = require('./llamacpp-manager.cjs');

const SECRET = 'synthetic-store-token-0123456789abcdef';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** A synthetic authority with the front's semantics (lease.rs): one lease, generation fence, ordered
 *  server-issued incarnations (410 for retired ones), front leases bound to the incarnation they latched. */
async function authority(t, { ttlMs = 180000, renewMs = 10000, hardMs = 3600000 } = {}) {
  const calls = [];
  let holder = null, generation = 0, node = null, incarnations = 0, renew = 'ok';
  const now = () => Date.now();
  const expire = () => { if (holder && (now() >= holder.until || now() >= holder.hardAt)) holder = null; };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
      if (req.headers['x-noevia-store-token'] !== SECRET) return send(401, { error: 'unauthorised' });
      const op = req.url.replace('/v1/maintenance-lease/', '');
      const body = JSON.parse(raw || '{}');
      calls.push({ op, body });
      expire();
      if (op === 'session') {
        if (node && node.boot === body.boot) return send(200, { incarnation: node.inc, frontHeld: holder?.origin === 'front' });
        if (node && body.startedAt <= node.started) return send(410, { code: 'incarnation_retired' });
        node = { inc: ++incarnations, boot: body.boot, started: body.startedAt };
        if (holder?.origin === 'node') holder = null;
        if (holder?.origin === 'front' && holder.bound !== node.inc) holder.fenced = true;
        return send(200, { incarnation: node.inc, frontHeld: holder?.origin === 'front' });
      }
      if (!node || body.incarnation !== node.inc) return send(410, { code: 'incarnation_retired' });
      if (op === 'acquire') {
        if (holder) return send(409, { error: 'Inference is busy. Wait for requests to finish before changing native presets.', code: 'maintenance_held', chatActive: false });
        holder = { origin: 'node', lease: crypto.randomBytes(16).toString('hex'), generation: ++generation, until: now() + ttlMs, hardAt: now() + hardMs };
        return send(201, { lease: holder.lease, generation: holder.generation, epoch: 'e', ttlMs, renewMs, hardMs });
      }
      if (op === 'renew') {
        if (renew === 'hang') return; // never answers: the client's call times out (no answer)
        if (renew === 'error') return send(500, {});
        if (holder && holder.lease === body.lease && renew === 'ok') { holder.until = now() + ttlMs; return send(200, {}); }
        return send(404, { error: 'Not found' });
      }
      if (op === 'release') { if (holder && holder.lease === body.lease) holder = null; return send(204); }
      if (op === 'held') return send(200, { held: !!holder, front: holder?.origin === 'front' });
      return send(404, { error: 'Not found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return {
    port: server.address().port, calls,
    acquires: () => calls.filter((c) => c.op === 'acquire').length,
    takeAsFront: () => { holder = { origin: 'front', lease: 'f'.repeat(32), generation: ++generation, until: Infinity, hardAt: Infinity, bound: node?.inc ?? null }; },
    releaseFront: () => { if (holder?.origin === 'front') holder = null; },
    forget: () => { holder = null; },
    setRenew: (v) => { renew = v; },
    held: () => holder,
  };
}

function manager(client, { gateOptions = {}, router = [] } = {}) {
  return createLlamaCppManager({
    baseUrl: 'http://127.0.0.1:9/v1', gateAdminToken: null, fetchStream: async () => ({ ok: false }),
    gate: { hasAdmin: () => false, waiting: () => 0 },
    fetchJson: async (url) => { router.push(String(url)); return { ok: true, status: 200, body: { data: [] } }; },
    maintenanceAuthority: client, maintenanceGateOptions: gateOptions,
  });
}

/** The manager once its start is registered (chat opens when no front lease remains). */
async function ready(m, client) { await client.ready(); await delay(5); return m; }

test('the client carries the release marker the assembly pairs with the front', () => {
  assert.equal(LEASE_CLIENT_MARKER, 'noevia-maintenance-lease-client/1');
  assert.match(require('node:fs').readFileSync(require.resolve('./model-maintenance-lease.cjs'), 'utf8'), /'noevia-maintenance-lease-client\/1'/);
});

test('a Node hold is a lease of the front\'s authority: registered start, exclusive, given back there', async (t) => {
  const a = await authority(t);
  const client = createNativeLeaseClient({ port: a.port, token: SECRET, boot: 'boot-1', startedAt: 1000 });
  const m = await ready(manager(client), client);
  const release = await m.holdMaintenance('synthetic delete');
  const acquire = a.calls.find((c) => c.op === 'acquire');
  assert.equal(acquire.body.incarnation, 1);
  assert.equal(acquire.body.reason, 'synthetic delete');
  assert.equal(acquire.body.maxMs, 24 * 60 * 60 * 1000, 'this process\'s holds ask for the longest cap');
  assert.equal(a.calls.find((c) => c.op === 'session').body.startedAt, 1000);
  assert.ok(a.held());
  assert.equal(m.maintenanceHeld(), true);
  assert.throws(() => m.enterInference(), (e) => e.status === 503, 'chat is held back');
  release();
  await delay(50);
  assert.equal(a.held(), null, 'released at the authority');
  m.enterInference()();
});

test('a lease the front holds refuses Node\'s hold with the waitable 409, and nothing stays held locally', async (t) => {
  const a = await authority(t);
  const client = createNativeLeaseClient({ port: a.port, token: SECRET, boot: 'b', startedAt: 1 });
  const m = await ready(manager(client), client);
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
  const m = manager(createNativeLeaseClient({ port, token: SECRET, boot: 'b', startedAt: 1 }));
  await assert.rejects(m.holdMaintenance('synthetic tune'), (e) => e.status === 503 && e.code === 'maintenanceAuthorityUnavailable');
  assert.throws(() => m.enterInference(), (e) => e.status === 503, 'and chat stays closed until the start is registered');
  await assert.rejects(createNativeLeaseClient({ port: NaN, token: '' }).holdMaintenance('x'), (e) => e.status === 503);
});

// ---- Review P1: Node consumers stop when native coverage ends (through the real writePresets). ----

/** Polls until the manager reports its lease's coverage lost; the error, or null after `ms`. */
async function lostWithin(m, ms = 3000) {
  for (let i = 0; i < ms / 10; i++) { try { m.assertMaintenanceCovered(0); } catch (e) { return e; } await delay(10); }
  return null;
}

for (const [name, setup] of [
  ['the authority ends the lease (renewal answered ended)', (a) => a.setRenew('ended')],
  ['renewals stop being answered past the TTL margin', (a) => a.setRenew('error')],
]) {
  test(`lost coverage: ${name}: no further step, no retake, exclusion kept until the work settles`, async (t) => {
    const a = await authority(t, { ttlMs: 600, renewMs: 100 });
    const client = createNativeLeaseClient({ port: a.port, token: SECRET, boot: 'b', startedAt: 1 });
    const router = [];
    const m = await ready(manager(client, { gateOptions: { coverageMarginMs: 50, presetStepMs: 0 }, router }), client);
    let lost = null, chatDuringLoss = null, routerAtLoss = -1;
    // The write is the job's in-flight step: coverage ends while it runs.
    const done = m.writePresets(async () => {
      for (let i = 0; i < 300 && !a.calls.some((c) => c.op === 'renew'); i++) await delay(10);
      setup(a);
      lost = await lostWithin(m);
      try { m.enterInference()(); chatDuringLoss = 'open'; } catch (e) { chatDuringLoss = e.status; }
      routerAtLoss = router.length;
      return { ok: true };
    }, () => true);
    await assert.rejects(done, (e) => e.code === 'maintenanceCoverageLost', 'the reload step after the write does not run');
    assert.equal(lost?.code, 'maintenanceCoverageLost');
    assert.equal(chatDuringLoss, 503, 'chat stays paused while the in-flight step settles');
    assert.equal(router.length, routerAtLoss, 'no router call after coverage ended');
    assert.equal(a.acquires(), 1, 'the lease is never taken again for the same work');
    assert.equal(m.maintenanceHeld(), false, 'released once the work settled');
    m.enterInference()();
  });
}

test('lost coverage: the hard cap ends the work even while every renewal succeeds', async (t) => {
  const a = await authority(t, { ttlMs: 10000, renewMs: 50, hardMs: 400 });
  const client = createNativeLeaseClient({ port: a.port, token: SECRET, boot: 'b', startedAt: 1 });
  const m = await ready(manager(client, { gateOptions: { coverageMarginMs: 100, presetStepMs: 0 } }), client);
  let lost = null;
  const done = m.writePresets(async () => { lost = await lostWithin(m); return { ok: true }; }, () => true);
  await assert.rejects(done, (e) => e.code === 'maintenanceCoverageLost');
  assert.equal(lost?.code, 'maintenanceCoverageLost');
  assert.ok(a.calls.filter((c) => c.op === 'renew').length >= 2, 'renewals kept succeeding');
  assert.equal(a.acquires(), 1);
});

test('a step the lease cannot cover does not start (writePresets refuses before writing)', async (t) => {
  const a = await authority(t, { ttlMs: 1000, renewMs: 100 });
  const client = createNativeLeaseClient({ port: a.port, token: SECRET, boot: 'b', startedAt: 1 });
  const m = await ready(manager(client), client); // default margin 15 s > the 1 s TTL
  let wrote = false;
  await assert.rejects(m.writePresets(async () => { wrote = true; }, () => false), (e) => e.code === 'maintenanceCoverageLost');
  assert.equal(wrote, false);
  assert.equal(m.maintenanceHeld(), false);
});

// ---- Review P1: a Node restart while a front lease is held keeps chat closed (two real processes). ----

const CHILD = `
const { createNativeLeaseClient } = require(${JSON.stringify(path.join(__dirname, 'model-maintenance-lease.cjs'))});
const { createLlamaCppManager } = require(${JSON.stringify(path.join(__dirname, 'llamacpp-manager.cjs'))});
const client = createNativeLeaseClient({ port: Number(process.argv[1]), token: process.argv[2], boot: process.argv[3], startedAt: Number(process.argv[4]), retryMs: 50 });
const m = createLlamaCppManager({ baseUrl: 'http://127.0.0.1:9/v1', gateAdminToken: null, fetchStream: async () => ({ ok: false }),
  gate: { hasAdmin: () => false, waiting: () => 0 }, fetchJson: async () => ({ ok: true, status: 200, body: { data: [] } }), maintenanceAuthority: client });
setInterval(() => { let open = false; try { m.enterInference()(); open = true; } catch {} process.stdout.write((open ? 'open' : 'closed') + '\\n'); }, 50);
`;
function child(t, a, boot, startedAt) {
  const p = spawn(process.execPath, ['-e', CHILD, String(a.port), SECRET, boot, String(startedAt)], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { p.kill('SIGKILL'); });
  const lines = [];
  p.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
  return { p, lines, last: () => lines[lines.length - 1] };
}
const until = async (f, ms = 5000) => { for (let i = 0; i < ms / 20; i++) { if (f()) return true; await delay(20); } return false; };

test('restart: a new Node process keeps chat closed while the front still holds a lease the old one latched', async (t) => {
  const a = await authority(t);
  const first = child(t, a, 'boot-a', Date.now());
  assert.ok(await until(() => first.last() === 'open'), 'the first start opens chat');
  a.takeAsFront(); // the front's reload, latched on the first start
  first.p.kill('SIGKILL');
  const second = child(t, a, 'boot-b', Date.now() + 1);
  assert.ok(await until(() => second.lines.length >= 10), 'the second start reports admission');
  assert.ok(second.lines.every((l) => l === 'closed'), 'chat never opened while the front lease was held');
  assert.equal(a.held().fenced, true, 'the front lease was fenced by the new start');
  a.releaseFront();
  assert.ok(await until(() => second.last() === 'open'), 'chat opens once the front lease ends');
});

// ---- Review P2: ordered incarnations seen from the client. ----

test('an older start is retired: its session and holds fail closed and do not touch the newer start\'s lease', async (t) => {
  const a = await authority(t);
  const older = createNativeLeaseClient({ port: a.port, token: SECRET, boot: 'old', startedAt: 10 });
  await older.session();
  const newer = createNativeLeaseClient({ port: a.port, token: SECRET, boot: 'new', startedAt: 20 });
  await newer.session();
  const grant = await newer.holdMaintenance('x');
  await assert.rejects(older.holdMaintenance('x'), (e) => e.status === 503);
  await assert.rejects(older.session(), (e) => e.status === 503);
  assert.equal(await older.renewMaintenance(grant.token), false);
  assert.equal(a.held().lease, grant.token, 'the newer start\'s lease is untouched');
});

// ---- The latch: local-only, ticketed. ----

test('the latch is a local-only hold: no second trip to the authority, and a ticket gives it back', async (t) => {
  const a = await authority(t);
  const client = createNativeLeaseClient({ port: a.port, token: SECRET, boot: 'b', startedAt: 1 });
  const m = await ready(manager(client), client);
  const routes = createLeaseRoutes({ secret: SECRET, hold: () => m.holdMaintenanceLocal(), json: (res, s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); } });
  const server = http.createServer(async (req, res) => { if (!(await routes.handle(req, res))) { res.writeHead(418); res.end(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const url = `http://127.0.0.1:${server.address().port}${PREFIX}`;
  const h = { 'x-noevia-store-token': SECRET, 'content-type': 'application/json' };
  const before = a.acquires();
  const ticket = 'a'.repeat(32);
  const latched = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify({ ticket }) });
  assert.equal(latched.status, 201);
  assert.equal(a.acquires(), before, 'the authority is not asked again');
  assert.throws(() => m.enterInference(), (e) => e.status === 503);
  assert.throws(() => m.holdMaintenance('x'), (e) => e.status === 409);
  // The grant's answer "never arrived": the front gives it back by its ticket.
  assert.equal((await fetch(`${url}/ticket/${ticket}`, { method: 'DELETE', headers: h })).status, 204);
  m.enterInference()();
  assert.equal((await fetch(`${url}/ticket/${ticket}`, { method: 'DELETE', headers: h })).status, 204, 'idempotent');
  assert.equal((await fetch(url, { method: 'POST', headers: h, body: JSON.stringify({ ticket: 'NOTHEX' }) })).status, 400);
  const leave = m.enterInference();
  const refused = await fetch(url, { method: 'POST', headers: h });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).chatActive, true);
  leave();
});

test('a cancelled wait for the authority takes nothing and rejects as cancelled', async (t) => {
  const a = await authority(t);
  const client = createNativeLeaseClient({ port: a.port, token: SECRET, boot: 'b', startedAt: 1 });
  await client.session();
  a.takeAsFront();
  const ac = new AbortController();
  const pending = client.holdMaintenance('x', { waitMs: 5000, signal: ac.signal });
  ac.abort();
  await assert.rejects(pending, (e) => e.cancelled === true || e.status === 409);
  assert.equal(a.held().origin, 'front');
});

test('chainRemotes: the inference gate when it grants, the authority when it has no hold API', async (t) => {
  const a = await authority(t);
  const native = createNativeLeaseClient({ port: a.port, token: SECRET, boot: 'b', startedAt: 1 });
  const gateCalls = [];
  const gate = { holdMaintenance: async () => null, renewMaintenance: async (tk) => { gateCalls.push(['renew', tk]); return true; }, releaseMaintenance: async (tk) => { gateCalls.push(['release', tk]); }, maintenanceHeld: async () => null };
  const chain = chainRemotes(gate, native);
  assert.equal(typeof chain.ready, 'function', 'the boot barrier reaches the gate through the chain');
  const g = await chain.holdMaintenance('x', {});
  assert.equal(g.native, true);
  assert.equal(await chain.renewMaintenance(g.token), true);
  await chain.releaseMaintenance(g.token);
  assert.equal(a.held(), null);
  assert.deepEqual(gateCalls, [], 'a native token never goes to the gate');
  const granted = chainRemotes({ ...gate, holdMaintenance: async () => ({ token: 'a'.repeat(32), idleTtlMs: 60000 }) }, native);
  assert.equal((await granted.holdMaintenance('x', {})).token, 'a'.repeat(32));
  assert.equal(a.held(), null, 'the authority is not asked when the gate grants');
});
