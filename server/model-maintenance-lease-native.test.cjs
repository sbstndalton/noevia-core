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

const { authority, SECRET } = require('./synthetic-lease-authority.test-helper.cjs');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 5000) => { for (let i = 0; i < ms / 20; i++) { if (f()) return true; await delay(20); } return false; };

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
  assert.equal(LEASE_CLIENT_MARKER, 'noevia-maintenance-lease-client/2');
  assert.match(require('node:fs').readFileSync(require.resolve('./model-maintenance-lease.cjs'), 'utf8'), /'noevia-maintenance-lease-client\/2'/);
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
    const m = await ready(manager(client, { gateOptions: { coverageMarginMs: 50, presetStepMs: 0, recoveryRetryMs: 20 }, router }), client);
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
    assert.equal(a.calls.filter((c) => c.op === 'acquire' && !/recovers/.test(c.body.reason)).length, 1, 'the lease is never taken again for the same work');
    // Delta review P1: chat opens only after a recovery under a fresh lease confirmed the engine idle.
    assert.ok(await until(() => !m.maintenanceHeld()), 'recovered');
    const recovery = a.calls.filter((c) => c.op === 'acquire' && /recovers/.test(c.body.reason));
    assert.equal(recovery.length >= 1, true, 'the recovery took its own lease');
    assert.ok(router.length > routerAtLoss, 'the recovery checked the engine (under its own lease)');
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
  // A lease that can never cover a step: it is treated as lost, and chat stays closed (fail closed),
  // since no recovery lease can cover the check either.
  assert.equal(m.maintenanceHeld(), true);
  assert.throws(() => m.enterInference(), (e) => e.status === 503);
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

// Delta review P2: the ticket give-back is cancellation-safe. A DELETE that reaches Node before (or while)
// the POST is granted leaves a bounded tombstone, so the late grant is refused or given back at once; a
// repeated POST with one ticket is idempotent; another ticket's latch is untouched.
async function latchRoutes(t, { hold, ...options }) {
  const { createMaintenanceGate } = require('./inference-maintenance.cjs');
  const gate = createMaintenanceGate();
  const routes = createLeaseRoutes({ secret: SECRET, hold: hold || (() => gate.holdLocal('front latch')), json: (res, s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); }, ...options });
  const server = http.createServer(async (req, res) => { if (!(await routes.handle(req, res))) { res.writeHead(418); res.end(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const url = `http://127.0.0.1:${server.address().port}${PREFIX}`;
  const h = { 'x-noevia-store-token': SECRET, 'content-type': 'application/json' };
  const post = (ticket) => fetch(url, { method: 'POST', headers: h, body: JSON.stringify(ticket ? { ticket } : {}) });
  const del = (ticket) => fetch(`${url}/ticket/${ticket}`, { method: 'DELETE', headers: h });
  return { gate, post, del };
}

test('ticket: a DELETE before the POST arrives refuses the late grant, and nothing stays held', async (t) => {
  const { gate, post, del } = await latchRoutes(t, {});
  const ticket = 'b'.repeat(32);
  assert.equal((await del(ticket)).status, 204);
  const late = await post(ticket);
  assert.equal(late.status, 410, 'a cancelled ticket is not granted');
  assert.equal(gate.held(), false, 'the late POST holds nothing');
  gate.enter()();
});

test('ticket: a DELETE while the grant is being taken gives it back the moment it is taken', async (t) => {
  let open; const taken = new Promise((r) => { open = r; });
  let released = 0;
  const { post, del } = await latchRoutes(t, { hold: async () => { await taken; return () => { released++; }; } });
  const ticket = 'c'.repeat(32);
  const pending = post(ticket);
  await delay(30);
  assert.equal((await del(ticket)).status, 204);
  open();
  const answer = await pending;
  assert.equal(answer.status, 410);
  assert.equal(released, 1, 'the hold taken after the DELETE is released at once');
});

test('ticket: one ticket is one latch (idempotent POST), and another ticket\'s latch is isolated', async (t) => {
  const { gate, post, del } = await latchRoutes(t, {});
  const one = 'd'.repeat(32), two = 'e'.repeat(32);
  const first = await post(one);
  assert.equal(first.status, 201);
  const again = await post(one);
  assert.equal(again.status, 201, 'a retried POST of the same ticket is the same latch, not a busy 409');
  assert.equal((await again.json()).lease, (await first.json()).lease);
  assert.equal((await del(one)).status, 204);
  assert.equal(gate.held(), false);
  // An old ticket's tombstone does not touch a new ticket's latch.
  assert.equal((await post(two)).status, 201);
  assert.equal((await del(one)).status, 204);
  assert.equal(gate.held(), true, 'the new latch is untouched');
  assert.equal((await del(two)).status, 204);
  assert.equal(gate.held(), false);
});

test('ticket: bounded retention fails closed rather than forgetting admissible cancellations', async (t) => {
  let clock = 0;
  const { post, del } = await latchRoutes(t, { now: () => clock, ticketTombstoneMs: 1000, ticketTombstones: 4 });
  const tk = i => i.toString(16).padStart(32,'0');
  for(let i=1;i<=6;i++)assert.equal((await del(tk(i))).status,204);
  assert.equal((await post(tk(1))).status,410);
  assert.equal((await post(tk(6))).status,503);
  clock+=1001;
  assert.equal((await post(tk(1))).status,410);
  assert.equal((await post(tk(7))).status,503);
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

// ---- Delta review P1: every engine dispatch is covered, and the loss aborts work in flight. ----

/** A real manager over a synthetic router whose replies the test scripts per path. */
function routed(client, handler, gateOptions = {}) {
  const calls = [];
  const m = createLlamaCppManager({
    baseUrl: 'http://127.0.0.1:9/v1', gateAdminToken: null, fetchStream: async () => ({ ok: false }),
    gate: { hasAdmin: () => false, waiting: () => 0, adminHeaders: () => ({}) },
    fetchJson: async (url, opts = {}) => {
      const u = new URL(url), name = (opts.method || 'GET') + ' ' + u.pathname + (u.searchParams.has('reload') ? '?reload' : '');
      calls.push(name);
      return handler(name, opts, calls);
    },
    maintenanceAuthority: client, maintenanceGateOptions: { coverageMarginMs: 50, recoveryRetryMs: 20, recoveryPollMs: 5, ...gateOptions },
  });
  return { m, calls };
}
const listing = (rows) => ({ ok: true, status: 200, body: { data: rows.map(([id, value]) => ({ id, status: { value } })) } });

test('P1 loss during an await of a reload: no unload or router reload is dispatched after it', async (t) => {
  const a = await authority(t, { ttlMs: 600, renewMs: 100 });
  const client = createNativeLeaseClient({ port: a.port, token: SECRET, boot: 'b', startedAt: 1 });
  let lossDone = false, rows = [['synthetic', 'loaded']];
  const { m, calls } = routed(client, async (name) => {
    if (name === 'GET /models' && !lossDone) {
      // Coverage ends while the listing is awaited.
      a.setRenew('ended');
      for (let i = 0; i < 300; i++) { try { m.assertMaintenanceCovered(0); } catch { break; } await delay(10); }
      lossDone = true;
      return listing(rows);
    }
    if (name === 'POST /models/unload') { rows = [['synthetic', 'unloaded']]; return { ok: true, status: 200, body: {} }; }
    if (name === 'GET /models') return listing(rows);
    return { ok: true, status: 200, body: {} };
  });
  await ready(m, client);
  const before = calls.length;
  const result = m.reloadPresets({ unload: true });
  await assert.rejects(result, (e) => e.code === 'maintenanceCoverageLost');
  const job = calls.slice(before, before + 1);
  assert.deepEqual(job, ['GET /models']);
  assert.equal(calls.slice(before).includes('GET /models?reload'), false, 'no router reload on the lost lease');
  // The recovery (its own lease) is what unloads; chat opens only after it confirmed the engine idle.
  assert.throws(() => m.enterInference(), (e) => e.status === 503);
  a.setRenew('ok');
  assert.ok(await until(() => !m.maintenanceHeld()), 'recovered');
  assert.deepEqual(rows, [['synthetic', 'unloaded']]);
  m.enterInference()();
});

test('P1 a router call in flight when the lease is lost is aborted, and chat stays closed until the engine is confirmed idle', async (t) => {
  const a = await authority(t, { ttlMs: 600, renewMs: 100 });
  const client = createNativeLeaseClient({ port: a.port, token: SECRET, boot: 'b', startedAt: 1 });
  let aborted = false, engineBusy = true, idleChecks = 0;
  const { m } = routed(client, async (name, opts) => {
    if (name === 'GET /models?reload') {
      a.setRenew('ended');
      await new Promise((resolve) => { if (opts.signal?.aborted) resolve(); opts.signal?.addEventListener('abort', resolve, { once: true }); });
      aborted = true;
      throw Object.assign(Error('aborted'), { name: 'AbortError' });
    }
    if (name === 'GET /models') {
      // The engine is still reloading for a while after our call was cancelled.
      if (aborted) idleChecks++;
      if (aborted && idleChecks > 3) engineBusy = false;
      return listing([['synthetic', aborted && engineBusy ? 'loading' : 'unloaded']]);
    }
    return { ok: true, status: 200, body: {} };
  });
  await ready(m, client);
  await assert.rejects(m.reloadPresets({ unload: false }), (e) => e.code === 'maintenanceCoverageLost');
  assert.equal(aborted, true, 'the in-flight call carried the loss signal');
  a.setRenew('ok');
  for (let i = 0; i < 300 && engineBusy; i++) {
    assert.throws(() => m.enterInference(), (e) => e.status === 503, 'closed while the engine still works');
    await delay(5);
  }
  assert.ok(await until(() => !m.maintenanceHeld()), 'recovered');
  m.enterInference()();
});


test('the native authority reply limit refuses an oversized valid JSON prefix', async () => {
  const text = JSON.stringify({ incarnation: 7, frontHeld: false });
  for (const bytes of [4096, 4097]) {
    const client = createNativeLeaseClient({ port: 1, token: SECRET, boot: 'boot', startedAt: 1,
      fetchImpl: async () => new Response(text + ' '.repeat(bytes - Buffer.byteLength(text)), { status: 200 }) });
    if (bytes === 4096) assert.equal((await client.session()).incarnation, 7);
    else await assert.rejects(client.session(), e => e.status === 503 && e.code === 'maintenanceAuthorityUnavailable');
  }
});

test('authority body reads keep the original deadline after headers', async () => {
  const client = createNativeLeaseClient({ port: 1, token: SECRET, timeoutMs: 20,
    fetchImpl: async (_url, request) => new Response(new ReadableStream({ start(controller) {
      request.signal.addEventListener('abort', () => controller.error(Error('synthetic body deadline')), { once: true });
    } }), { status: 200 }) });
  const keep = setTimeout(() => {}, 1000);
  try { await assert.rejects(client.session(), e => e.status === 503 && e.code === 'maintenanceAuthorityUnavailable'); }
  finally { clearTimeout(keep); }
});
