'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { CAPABILITY, ROUTES, deriveFileKey, deriveControlKey, deriveGrantKey, requestMac, responseMac, createControlClient, publishWebKey, republishMissingKey, createKeyKeeper } = require('./code-egress-control.cjs');
const { mintGrant } = require('./code-egress.cjs');
const vectors = require('../contracts/egress-control.v1.vectors.json');
const file = Buffer.alloc(32, 7), boot = 'ab'.repeat(16), session = 'cd'.repeat(16), snapshot = 'ef'.repeat(16);
function headers(tag, bytes) { return ['content-type', 'application/json', 'content-length', String(bytes.length), 'cache-control', 'no-store', 'connection', 'close', 'x-noevia-control-mac', tag]; }
function response(req, value, status = 200, key = file) { const bytes = Buffer.from(JSON.stringify({ version: 1, requestId: req.headers['x-noevia-request-id'], ...value })); return { status, rawHeaders: headers(responseMac(key, req.headers['x-noevia-control-mac'], status, bytes), bytes), body: bytes }; }
function fake() {
  const calls = []; let mode = 'normal', lost = false;
  const transport = async (req) => {
    calls.push({ ...req, body: Buffer.from(req.body), headers: { ...req.headers } }); const b = JSON.parse(req.body);
    if (req.route === ROUTES.ready) return response(req, { state: 'ready', capability: CAPABILITY, bootId: boot, sessionId: session, keyFingerprint: crypto.createHash('sha256').update(file).digest('hex'), sequence: 0, leaseMs: 15000, challenge: b.challenge });
    if (req.route === ROUTES.renew) return response(req, { state: 'renewed', capability: CAPABILITY, bootId: boot, sessionId: session, keyFingerprint: crypto.createHash('sha256').update(file).digest('hex'), sequence: b.sequence, leaseMs: 15000 });
    if (req.route === ROUTES.forget) return response(req, { state: 'forgotten', bootId: boot, sessionId: session, taskId: b.taskId, leaseNonce: b.leaseNonce, snapshotId: b.snapshotId });
    if (mode === 'uncertain') return response(req, { state: 'drain-incomplete' }, 503);
    const value = { state: req.route === ROUTES.revoke ? 'revoke-confirmed' : 'activity', bootId: boot, sessionId: session, taskId: mode === 'cross-task' ? 'another' : b.taskId, leaseNonce: b.leaseNonce, barrierInstalled: req.route === ROUTES.revoke, drained: req.route === ROUTES.revoke, snapshot: { id: snapshot, state: 'complete', final: req.route === ROUTES.revoke, summary: { hosts: [{ host: 'example.com', allowed: 2, refused: 1, reason: 'host does not resolve' }], allowed: 2, refused: 1 }, partial: false, overflow: false } };
    if (mode === 'lost' && req.route === ROUTES.revoke && !lost) { lost = true; throw Object.assign(Error('synthetic transport loss'), { code: 'ECONNRESET' }); }
    return response(req, value);
  };
  return { calls, transport, mode(value) { mode = value; } };
}
test('independent frozen byte vectors and copied Rust contracts agree', () => {
  assert.equal(deriveFileKey(Buffer.from(vectors.masterKey, 'hex'), Buffer.from(vectors.webNonce, 'hex')).toString('hex'), vectors.fileKey);
  const k = Buffer.from(vectors.fileKey, 'hex'); assert.equal(deriveControlKey(k).length, 32);
  for (const c of vectors.cases) { const meta = { requestId: c.requestId, deadlineMs: c.deadlineMs, bootId: c.bootId, keyFingerprint: c.keyFingerprint }; assert.equal(requestMac(k, c.route, meta, Buffer.from(c.body)), c.requestMac); assert.equal(responseMac(k, c.requestMac, c.responseStatus, Buffer.from(c.responseBody)), c.responseMac); }
  const tokenBody = JSON.parse(Buffer.from(vectors.grantToken.split('.')[1], 'base64url')); assert.equal(mintGrant(deriveGrantKey(k, vectors.bootId, vectors.sessionId), tokenBody), vectors.grantToken);
  const dir = process.env.NOEVIA_RS_CONTROL_CONTRACT_DIR; assert.ok(dir, 'explicit reviewed Rust contract directory is required');
  for (const name of ['egress-control.v1.schema.json', 'egress-control.v1.vectors.json']) assert.deepEqual(fs.readFileSync(path.join(__dirname, '../contracts', name)), fs.readFileSync(path.join(dir, name)));
});
test('one Ready flight, ordered renewal and private scoped grant handles', async () => {
  const f = fake(), c = createControlClient({ fileKey: file, endpoint: 'localhost:3001', transport: f.transport, autoRenew: false });
  const a = c.ready(), b = c.ready(); assert.equal(a, b); await a; await c.renew();
  const lease = await c.grant({ taskId: 'task:1', domains: ['.EXAMPLE.com.'] }); assert.equal(lease.taskId, 'task:1'); assert.ok(lease.token.startsWith('ngr1.')); assert.ok(!JSON.stringify(lease).includes('ngr1.'));
  assert.equal(f.calls.filter((r) => r.route === ROUTES.ready).length, 1); assert.equal(f.calls.filter((r) => r.route === ROUTES.renew).length, 1);
  assert.throws(() => c.revoke({ ...lease })); await c.revoke(lease); await c.close();
});
test('lost revoke response retries exact identity/body/deadline and concurrent owners share cleanup', async () => {
  const f = fake(), c = createControlClient({ fileKey: file, endpoint: 'localhost:3001', transport: f.transport, autoRenew: false }); const lease = await c.grant({ taskId: 'job.1', domains: ['example.com'] }); f.mode('lost');
  const a = c.revoke(lease), b = c.revoke(lease); assert.equal(a, b); const result = await a; assert.equal(result.confirmed, true); assert.equal(result.report.refused, 1); assert.equal(result.report.final, true);
  const attempts = f.calls.filter((r) => r.route === ROUTES.revoke); assert.equal(attempts.length, 2); assert.deepEqual(attempts[0].body, attempts[1].body); assert.deepEqual(attempts[0].headers, attempts[1].headers);
  const x = c.forget(lease, result.report.snapshotId), y = c.forget(lease, result.report.snapshotId); assert.equal(x, y); assert.equal((await x).confirmed, true); await assert.rejects(c.forget(lease, '01'.repeat(16)));
  assert.equal(result.report.hosts[0].host, 'example.com'); await c.close();
});
test('scope mismatch and uncertainty never fabricate empty success or allow a replacement grant', async () => {
  const f = fake(), c = createControlClient({ fileKey: file, endpoint: 'localhost:3001', transport: f.transport, autoRenew: false }); const lease = await c.grant({ taskId: 'job.1', domains: ['example.com'] }); f.mode('cross-task'); await assert.rejects(c.activity(lease)); f.mode('uncertain');
  const r = await c.revoke(lease); assert.equal(r.confirmed, false); assert.equal(r.report.available, false); assert.equal(Object.hasOwn(r.report, 'hosts'), false); await assert.rejects(c.grant({ taskId: 'job.1', domains: ['example.com'] })); await c.close();
});
test('zero and negative cleanup budgets stop renewal and new grants without a mutation request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    for (const budget of [0, -1]) {
      const f = fake(), c = createControlClient({ fileKey: file, endpoint: 'localhost:3001', transport: f.transport });
      const lease = await c.grant({ taskId: 'budget.1', domains: ['example.com'] }), count = f.calls.length;
      const cleanup = c.revoke(lease, budget), result = await cleanup;
      assert.equal(result.confirmed, false); assert.equal(result.report.available, false); assert.equal(Object.hasOwn(result.report, 'hosts'), false);
      assert.equal(c.revoke(lease, 10000), cleanup);
      await assert.rejects(c.grant({ taskId: 'budget.2', domains: ['example.com'] })); await assert.rejects(c.renew());
      t.mock.timers.tick(15000); await Promise.resolve(); await Promise.resolve();
      assert.equal(f.calls.length, count, 'no revoke, renewal, or replacement Ready request may escape while the lease runs'); await c.close();
    }
  } finally { t.mock.timers.reset(); }
});
test('late active reports before and after acknowledgement cannot downgrade a delivered final snapshot', async () => {
  const f = fake(), pending = [];
  const c = createControlClient({ fileKey: file, endpoint: 'localhost:3001', autoRenew: false, transport: async (req) => {
    const reply = await f.transport(req);
    if (req.route === ROUTES.activity) return new Promise((resolve) => pending.push(() => resolve(reply)));
    return reply;
  } });
  const lease = await c.grant({ taskId: 'ordering.1', domains: ['example.com'] });
  const early = c.activity(lease), later = c.activity(lease);
  // Both transport calls have captured authenticated nonfinal native observations.
  await Promise.resolve(); assert.equal(pending.length, 2);
  const done = await c.revoke(lease); assert.equal(done.confirmed, true); assert.equal(done.report.final, true);
  pending.shift()(); assert.equal((await early).final, false);
  const ack = c.forget(lease, done.report.snapshotId); assert.equal((await ack).confirmed, true);
  pending.shift()(); assert.equal((await later).final, false);
  assert.equal(c.forget(lease, done.report.snapshotId), ack); assert.equal((await ack).confirmed, true);
  await assert.rejects(c.forget(lease, '01'.repeat(16))); assert.equal(done.report.hosts[0].host, 'example.com');
  assert.equal(f.calls.filter((r) => r.route === ROUTES.forget).length, 1); await c.close();
});
test('confirmed barrier with unavailable follow-up cannot erase a previously delivered final acknowledgement', async () => {
  const f = fake(); let activityCount = 0;
  const c = createControlClient({ fileKey: file, endpoint: 'localhost:3001', autoRenew: false, transport: async (req) => {
    const b = JSON.parse(req.body);
    if (req.route === ROUTES.revoke) return response(req, { state: 'barrier-installed', bootId: boot, sessionId: session, taskId: b.taskId, leaseNonce: b.leaseNonce, barrierInstalled: true, drained: true });
    if (req.route === ROUTES.activity) {
      if (++activityCount > 1) return response(req, { state: 'unavailable' }, 503);
      const reply = await f.transport(req), value = JSON.parse(reply.body); value.drained = true; value.barrierInstalled = true; value.snapshot.final = true; return response(req, value);
    }
    return f.transport(req);
  } });
  const lease = await c.grant({ taskId: 'prior.final.1', domains: ['example.com'] }), final = await c.activity(lease);
  const cleanup = await c.revoke(lease); assert.equal(cleanup.confirmed, true); assert.equal(cleanup.report.available, false);
  assert.equal((await c.forget(lease, final.snapshotId)).confirmed, true); assert.equal(final.hosts[0].host, 'example.com'); await c.close();
});
test('native final FIFO eviction advances acknowledgement without late held replies restoring the old identity', async () => {
  for (const heldState of ['complete', 'partial', 'interrupted']) {
    const f = fake(), evictedId = '12'.repeat(16); let reads = 0, release;
    const c = createControlClient({ fileKey: file, endpoint: 'localhost:3001', autoRenew: false, transport: async (req) => {
      if (req.route === ROUTES.forget) return f.transport(req);
      const reply = await f.transport(req);
      if (![ROUTES.activity, ROUTES.revoke].includes(req.route)) return reply;
      const value = JSON.parse(reply.body); value.drained = true; value.barrierInstalled = true; value.snapshot.final = true;
      if (req.route === ROUTES.revoke || reads >= 2) value.snapshot = { id: evictedId, state: 'evicted', final: true, summary: null, partial: false, overflow: false };
      else { value.snapshot.state = heldState; value.snapshot.partial = heldState === 'partial'; }
      const signed = response(req, value);
      if (req.route === ROUTES.activity && ++reads === 2) return new Promise((resolve) => { release = () => resolve(signed); });
      return signed;
    } });
    const lease = await c.grant({ taskId: `eviction.${heldState}`, domains: ['example.com'] });
    const original = await c.activity(lease), stale = c.activity(lease); await Promise.resolve(); await Promise.resolve(); assert.equal(typeof release, 'function');
    const cleanup = await c.revoke(lease); release(); assert.equal((await stale).snapshotId, original.snapshotId);
    assert.equal(cleanup.confirmed, true); assert.equal(cleanup.report.available, false); assert.equal(cleanup.report.state, 'evicted'); assert.equal(cleanup.report.snapshotId, evictedId);
    await assert.rejects(c.forget(lease, original.snapshotId));
    const ack = c.forget(lease, evictedId); assert.equal((await ack).confirmed, true); assert.equal(c.forget(lease, evictedId), ack);
    assert.equal(original.hosts[0].host, 'example.com'); assert.equal(f.calls.filter((r) => r.route === ROUTES.forget).length, 1); await c.close();
  }
});
test('an unexplained new identity in the same held final state is rejected', async () => {
  const f = fake(); let changed = false;
  const c = createControlClient({ fileKey: file, endpoint: 'localhost:3001', autoRenew: false, transport: async (req) => {
    const reply = await f.transport(req); if (req.route !== ROUTES.activity) return reply;
    const v = JSON.parse(reply.body); v.drained = true; v.barrierInstalled = true; v.snapshot.final = true; if (changed) v.snapshot.id = '12'.repeat(16); return response(req, v);
  } });
  const lease = await c.grant({ taskId: 'identity.1', domains: ['example.com'] }); await c.activity(lease); changed = true;
  await assert.rejects(c.activity(lease)); await c.revoke(lease); await c.close();
});
test('forged and late cached Ready proofs cannot create a live grant', async () => {
  const f = fake(); let clock = 0;
  const late = createControlClient({ fileKey: file, endpoint: 'localhost:3001', autoRenew: false, monotonic: () => clock, transport: async (req) => { const r = await f.transport(req); clock = 16000; return r; } });
  await assert.rejects(late.grant({ taskId: 'job.1', domains: ['example.com'] })); await late.close();
  const bad = createControlClient({ fileKey: file, endpoint: 'localhost:3001', autoRenew: false, transport: async (req) => { const r = await f.transport(req); r.rawHeaders[r.rawHeaders.length - 1] = '00'.repeat(32); return r; } });
  await assert.rejects(bad.ready()); await assert.rejects(bad.grant({ taskId: 'job.1', domains: ['example.com'] })); await bad.close();
});
test('fresh file publication is confined to an owned profile and never repairs unsafe paths', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noevia-core-control-'));
  try {
    const uid = process.getuid(), gid = process.getgid() || (uid === 0 ? 1 : 0); assert.ok(gid > 0);
    fs.chownSync(dir, uid, gid); fs.chmodSync(dir, 0o750); const keyFile = path.join(dir, 'control.key'), master = Buffer.alloc(32, 19);
    const first = publishWebKey({ masterKey: master, file: keyFile, uid, gid }); assert.notDeepEqual(first, master); assert.equal(fs.readFileSync(keyFile, 'utf8'), `${first.toString('hex')}\n`); assert.equal(fs.statSync(keyFile).mode & 0o7777, 0o440);
    const second = publishWebKey({ masterKey: master, file: keyFile, uid, gid }); assert.notDeepEqual(first, second);
    fs.chmodSync(keyFile, 0o600); assert.throws(() => publishWebKey({ masterKey: master, file: keyFile, uid, gid })); assert.equal(fs.statSync(keyFile).mode & 0o7777, 0o600);
    assert.throws(() => publishWebKey({ masterKey: master, file: path.join(dir, 'missing', 'control.key'), uid, gid })); assert.equal(fs.existsSync(path.join(dir, 'missing')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
// A proxy with the real Ready rules: boot and session identity change on restart, a live session refuses Ready.
function restartable() {
  const calls = [], fpOf = (k) => crypto.createHash('sha256').update(k).digest('hex');
  let key = file, fp = fpOf(file), up = true, seq = 0, bootId = 'a1'.repeat(16), sessionId = null, sessionLive = false;
  const fresh = () => crypto.randomBytes(16).toString('hex');
  const signed = (req, value, status = 200) => response(req, value, status, key);
  const transport = async (req) => {
    if (!up) throw Object.assign(Error('synthetic refused'), { code: 'ECONNREFUSED' });
    const b = JSON.parse(req.body); calls.push({ route: req.route, mode: b.mode });
    if (req.route === ROUTES.ready) {
      const fit = b.mode === 'initial' ? sessionId === null : (req.headers['x-noevia-boot-id'] === bootId && b.priorSession === sessionId && sessionId !== null);
      if (sessionLive || !fit) return signed(req, { state: 'conflict' }, 409);
      sessionId = fresh(); sessionLive = true;
      return signed(req, { state: 'ready', capability: CAPABILITY, bootId, sessionId, keyFingerprint: fp, sequence: 0, leaseMs: 15000, challenge: b.challenge });
    }
    if (req.route === ROUTES.renew) { if (!sessionLive || b.sessionId !== sessionId) return signed(req, { state: 'conflict' }, 409); return signed(req, { state: 'renewed', capability: CAPABILITY, bootId, sessionId, keyFingerprint: fp, sequence: b.sequence, leaseMs: 15000 }); }
    if (b.sessionId !== sessionId) return signed(req, { state: 'conflict' }, 409);
    seq++;
    return signed(req, { state: req.route === ROUTES.revoke ? 'revoke-confirmed' : 'activity', bootId, sessionId, taskId: b.taskId, leaseNonce: b.leaseNonce, barrierInstalled: req.route === ROUTES.revoke, drained: req.route === ROUTES.revoke, snapshot: { id: seq.toString(16).padStart(32, '0'), state: 'complete', final: req.route === ROUTES.revoke, summary: { hosts: [], allowed: 0, refused: 0 }, partial: false, overflow: false } });
  };
  return { calls, transport, stop() { up = false; }, rekey(next) { key = next; fp = fpOf(next); sessionId = null; sessionLive = false; }, restart() { up = true; bootId = fresh(); sessionId = null; sessionLive = false; }, expire() { sessionLive = false; } };
}
const quick = { retryMinMs: 1, retryMaxMs: 2, autoRenew: false };
const settle = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, ms = 20000) { const end = Date.now() + ms; for (;;) { let ok = false; try { ok = await check(); } catch { /* still down */ } if (ok) return; assert.ok(Date.now() < end, 'condition was not reached in time'); await settle(25); } }
test('#2226: a restarted proxy gets a new Ready and new grants without replacing the client', async () => {
  const p = restartable(), events = [], c = createControlClient({ fileKey: file, endpoint: 'localhost:3001', transport: p.transport, log: (e) => events.push(e), ...quick });
  await c.ready(); assert.equal(c.available(), true); assert.deepEqual(events.at(-1), { event: 'egress.control_ready', recovered: false });
  const before = await c.grant({ taskId: 'old.task', domains: ['example.com'] });
  p.restart();
  await assert.rejects(c.renew(), { code: 'EGRESS_UNAVAILABLE' }); assert.equal(c.available(), false);
  assert.equal(events.at(-1).event, 'egress.control_unavailable');
  await settle(); await c.ready(); assert.equal(c.available(), true);
  assert.deepEqual(p.calls.filter((r) => r.route === ROUTES.ready).map((r) => r.mode), ['initial', 'replace', 'initial']);
  assert.equal(events.at(-1).event, 'egress.control_ready'); assert.equal(events.at(-1).recovered, true);
  const after = await c.grant({ taskId: 'new.task', domains: ['example.com'] }); assert.notEqual(after.token, before.token);
  // The task that outlived the restart gets no invented report, and its cleanup leaves the new session alone.
  assert.equal((await c.revoke(before)).confirmed, false); assert.equal(c.available(), true);
  assert.equal((await c.revoke(after)).confirmed, true); await c.close();
});
test('#2226: an expired session on a live proxy is replaced, never reused', async () => {
  const p = restartable(), c = createControlClient({ fileKey: file, endpoint: 'localhost:3001', transport: p.transport, ...quick });
  await c.ready(); p.expire(); await assert.rejects(c.renew()); await settle(); await c.ready();
  assert.deepEqual(p.calls.filter((r) => r.route === ROUTES.ready).map((r) => r.mode), ['initial', 'replace']); await c.close();
});
test('#2226: recovery refuses a Ready for the same session, so an uncertain revoke cannot be forgotten', async () => {
  const f = fake(), c = createControlClient({ fileKey: file, endpoint: 'localhost:3001', transport: f.transport, ...quick });
  const lease = await c.grant({ taskId: 'held.1', domains: ['example.com'] }); f.mode('uncertain');
  assert.equal((await c.revoke(lease, 50)).confirmed, false); assert.equal(c.available(), false);
  const before = f.calls.filter((r) => r.route === ROUTES.ready).length;
  await assert.rejects(c.grant({ taskId: 'held.2', domains: ['example.com'] }));
  assert.equal(f.calls.filter((r) => r.route === ROUTES.ready).length, before, 'no Ready while the uncertain lease is still running');
  await c.close();
  let clock = 0; const g = fake(), d = createControlClient({ fileKey: file, endpoint: 'localhost:3001', transport: g.transport, monotonic: () => clock, ...quick });
  const held = await d.grant({ taskId: 'held.3', domains: ['example.com'] }); g.mode('uncertain');
  assert.equal((await d.revoke(held, 50)).confirmed, false); clock = 16000;
  await assert.rejects(d.grant({ taskId: 'held.4', domains: ['example.com'] }), { code: 'EGRESS_UNAVAILABLE' });
  assert.ok(g.calls.filter((r) => r.route === ROUTES.ready).length > 1, 'it did ask'); assert.equal(d.available(), false); await d.close();
});
test('#2226: an outage at start refuses grants at once, retries alone and logs one outage', async () => {
  const p = restartable(), events = []; p.stop();
  const c = createControlClient({ fileKey: file, endpoint: 'localhost:3001', transport: p.transport, log: (e) => events.push(e), retryMinMs: 5, retryMaxMs: 10 });
  c.start(); await until(() => events.length > 0);
  assert.equal(c.available(), false); await assert.rejects(c.grant({ taskId: 'x.1', domains: ['example.com'] }), { code: 'EGRESS_UNAVAILABLE' });
  p.restart(); await until(() => c.available());
  assert.deepEqual(events.map((e) => e.event), ['egress.control_unavailable', 'egress.control_ready']);
  assert.ok((await c.grant({ taskId: 'x.2', domains: ['example.com'] })).token); await c.close();
});
test('#2226: close stops recovery for good and a clock fault stays final', async () => {
  const p = restartable(); p.stop();
  const c = createControlClient({ fileKey: file, endpoint: 'localhost:3001', transport: p.transport, retryMinMs: 1, retryMaxMs: 1 });
  c.start(); await c.close(); p.restart(); const n = p.calls.length; await settle(20);
  assert.equal(p.calls.length, n); await assert.rejects(c.ready());
  let clock = 100; const q = restartable(), d = createControlClient({ fileKey: file, endpoint: 'localhost:3001', transport: q.transport, monotonic: () => clock, ...quick });
  await d.ready(); clock = 50; await assert.rejects(d.renew()); clock = 100000; await assert.rejects(d.ready()); assert.equal(d.available(), false); await d.close();
});
// A Ready that commits on the proxy while its reply misses the deadline, then a clock that runs on.
function wedge(extra = {}) {
  const p = restartable(), events = []; let shift = 0, losing = true, next = null;
  const c = createControlClient({ fileKey: file, endpoint: 'localhost:3001', autoRenew: false, retryMinMs: 1, retryMaxMs: 2, monotonic: () => performance.now() + shift, log: (e) => events.push(e.event),
    transport: async (req) => { const reply = await p.transport(req); if (losing && req.route === ROUTES.ready) { losing = false; shift += 11000; } return reply; },
    keeper: { restore: () => 'present', rekey: () => { if (extra.refuse) return null; next = Buffer.alloc(32, 9); p.rekey(next); return next; } } });
  return { p, c, events, later(ms) { shift += ms; }, rekeyed: () => next };
}
const { performance } = require('node:perf_hooks');
test('#2226: a committed Ready whose reply was lost heals by a new key once the signed refusals outlast any session', async () => {
  const { p, c, events, later, rekeyed } = wedge();
  await assert.rejects(c.ready()); assert.equal(c.available(), false);
  await settle(); await assert.rejects(c.ready(), { reason: 'conflict' }); assert.ok(events.includes('egress.control_conflict'));
  assert.equal(rekeyed(), null, 'a live unknown session is waited out, not cut short');
  p.expire(); later(10000); await settle(); await assert.rejects(c.ready(), { reason: 'conflict' }); assert.equal(rekeyed(), null);
  later(16000); await settle(); await c.ready(); assert.equal(c.available(), true); assert.ok(rekeyed());
  assert.ok(events.includes('egress.control_rekeyed')); assert.ok((await c.grant({ taskId: 'healed.1', domains: ['example.com'] })).token); await c.close();
});
test('#2226: a refused re-key stays closed and says so', async () => {
  const { p, c, events, later } = wedge({ refuse: true });
  await assert.rejects(c.ready()); await settle(); await assert.rejects(c.ready()); p.expire(); later(26000); await settle();
  await assert.rejects(c.ready(), { reason: 'conflict' }); assert.ok(events.includes('egress.control_rekey_refused')); assert.equal(c.available(), false); await c.close();
});
test('#2226: only an unbroken run of signed refusals counts, never a network failure or an unsigned answer', async () => {
  let shift = 0, mode = 'down', rekeys = 0; const p = restartable();
  const c = createControlClient({ fileKey: file, endpoint: 'localhost:3001', autoRenew: false, retryMinMs: 1, retryMaxMs: 2, monotonic: () => performance.now() + shift, keeper: { restore: () => 'present', rekey: () => { rekeys++; return null; } },
    transport: async (req) => { if (mode === 'down') throw Error('synthetic refused'); if (mode === 'unsigned') return response(req, { state: 'conflict' }, 409, Buffer.alloc(32, 66)); return p.transport(req); } });
  c.start(); await settle(20);
  for (const m of ['down', 'unsigned']) { mode = m; for (let i = 0; i < 3; i++) { shift += 30000; await settle(); await c.ready().catch(() => {}); } }
  assert.equal(rekeys, 0); await c.close();
});
test('#2226: the key keeper replaces only its own key, and one that saw another web key never writes again', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noevia-core-keeper-'));
  try {
    const uid = process.getuid(), gid = process.getgid() || (uid === 0 ? 1 : 0); fs.chownSync(dir, uid, gid); fs.chmodSync(dir, 0o750);
    const keyFile = path.join(dir, 'k'), master = Buffer.alloc(32, 5), own = publishWebKey({ masterKey: master, file: keyFile, uid, gid });
    const keeper = createKeyKeeper({ deriveMaster: () => master, fileKey: own, file: keyFile, uid, gid });
    assert.equal(keeper.restore(), 'present'); const next = keeper.rekey(); assert.ok(next && !next.equals(own)); assert.equal(fs.readFileSync(keyFile, 'utf8'), `${next.toString('hex')}\n`);
    const newer = publishWebKey({ masterKey: master, file: keyFile, uid, gid }), text = fs.readFileSync(keyFile, 'utf8'); assert.ok(!newer.equals(next));
    assert.equal(keeper.rekey(), null); assert.equal(fs.readFileSync(keyFile, 'utf8'), text);
    fs.unlinkSync(keyFile); assert.equal(keeper.restore(), 'superseded'); assert.equal(fs.existsSync(keyFile), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('#2226: a crash between link and unlink is cleared; any other extra link still refuses', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noevia-core-link-'));
  try {
    const uid = process.getuid(), gid = process.getgid() || (uid === 0 ? 1 : 0); fs.chownSync(dir, uid, gid); fs.chmodSync(dir, 0o750);
    const keyFile = path.join(dir, 'k'), master = Buffer.alloc(32, 6); publishWebKey({ masterKey: master, file: keyFile, uid, gid });
    fs.linkSync(keyFile, path.join(dir, `.egress-key-${'a'.repeat(32)}.tmp`)); publishWebKey({ masterKey: master, file: keyFile, uid, gid });
    assert.deepEqual(fs.readdirSync(dir), ['k']);
    fs.linkSync(keyFile, path.join(dir, 'other')); assert.throws(() => publishWebKey({ masterKey: master, file: keyFile, uid, gid }));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('#2226: a retry timer survives a clock fault thrown inside ready()', async () => {
  let clock = 100; const q = restartable(), d = createControlClient({ fileKey: file, endpoint: 'localhost:3001', transport: q.transport, monotonic: () => clock, ...quick });
  await d.ready(); clock = 50; await assert.rejects(d.ready(), { reason: 'clock' }); clock = 1e6; await d.close();
});
test('#2226: only a missing key file is restored, with the same key, safely', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'noevia-core-republish-'));
  try {
    const uid = process.getuid(), gid = process.getgid() || (uid === 0 ? 1 : 0); fs.chownSync(dir, uid, gid); fs.chmodSync(dir, 0o750);
    const keyFile = path.join(dir, 'control.key'), own = publishWebKey({ masterKey: Buffer.alloc(32, 3), file: keyFile, uid, gid }), text = fs.readFileSync(keyFile, 'utf8');
    assert.equal(republishMissingKey({ fileKey: Buffer.alloc(32, 4), file: keyFile, uid, gid }), false); assert.equal(fs.readFileSync(keyFile, 'utf8'), text, 'a present key is never replaced');
    fs.unlinkSync(keyFile); assert.equal(republishMissingKey({ fileKey: own, file: keyFile, uid, gid }), true);
    assert.equal(fs.readFileSync(keyFile, 'utf8'), text); const st = fs.statSync(keyFile); assert.equal(st.mode & 0o7777, 0o440); assert.equal(st.nlink, 1);
    assert.deepEqual(fs.readdirSync(dir), ['control.key']);
    fs.unlinkSync(keyFile); fs.chmodSync(dir, 0o777); assert.throws(() => republishMissingKey({ fileKey: own, file: keyFile, uid, gid })); assert.equal(fs.existsSync(keyFile), false);
  } finally { fs.chmodSync(dir, 0o700); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('#2226: a real proxy restart and a boot outage recover by themselves, without ever accepting an old token', { timeout: 240000 }, async () => {
  const { spawn } = require('node:child_process'), { once } = require('node:events'), net = require('node:net');
  const binary = process.env.NOEVIA_EGRESS_CONTROL_BINARY; assert.ok(binary, 'explicit paired Rust binary is required');
  const hermetic = globalThis[Symbol.for('noevia.hermetic.nativeFixture.v1')];
  const dir = fs.mkdtempSync(path.join(hermetic?.directory || fs.realpathSync(os.tmpdir()), 'noevia-core-restart-'));
  const uid = process.getuid(), gid = process.getgid() || (uid === 0 ? 1 : 0); fs.chownSync(dir, uid, gid); fs.chmodSync(dir, 0o750);
  const keyFile = path.join(dir, 'control.key'), events = [];
  let child = null, closed = null, release = null, client = null;
  const free = await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  const launch = async () => {
    const probe = net.createServer(); await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(free, '127.0.0.1', resolve); });
    const reservation = hermetic?.reserve(probe); await new Promise((resolve) => probe.close(resolve));
    child = spawn(binary, ['--native-control-v1', '--control-key-file', keyFile, '--control-key-uid', String(uid), '--control-key-gid', String(gid), '--listen', `127.0.0.1:${free}`], { stdio: ['ignore', 'ignore', 'ignore'] });
    closed = new Promise((resolve) => child.once('close', resolve)); await once(child, 'spawn');
    if (reservation) release = reservation.adopt(child);
  };
  const kill = async () => { child.kill('SIGKILL'); await closed; release?.(); child = null; };
  try {
    // Boot outage: web starts first, with nothing listening.
    client = require('./code-egress.cjs').startEgressFromEnv({ CODE_EGRESS_PORT: String(free), CODE_EGRESS_RUST_HOST: '127.0.0.1', CODE_EGRESS_CONTROL_KEY_FILE: keyFile, CODE_EGRESS_KEY_UID: String(uid), CODE_EGRESS_KEY_GID: String(gid) }, { secrets: { derive: () => Buffer.alloc(32, 41) }, log: (e) => events.push(e) });
    client.start(); await until(() => events.some((e) => e.event === 'egress.control_unavailable'));
    assert.equal(client.available(), false); await assert.rejects(client.grant({ taskId: 'boot.refused', domains: ['example.com'] }), { code: 'EGRESS_UNAVAILABLE' });
    await launch(); await until(() => client.available(), 30000);
    const first = await client.grant({ taskId: 'first.job', domains: ['example.com'] }); assert.equal((await client.activity(first)).final, false);
    // Restart: everything the proxy held is gone. The old token verifies nowhere afterwards.
    await kill(); await assert.rejects(client.renew(), { code: 'EGRESS_UNAVAILABLE' });
    assert.equal(client.available(), false); await assert.rejects(client.grant({ taskId: 'down.refused', domains: ['example.com'] }), { code: 'EGRESS_UNAVAILABLE' });
    await launch(); await until(() => client.available(), 30000);
    const second = await client.grant({ taskId: 'second.job', domains: ['example.com'] }); assert.notEqual(second.token, first.token);
    await client.renew(); assert.equal((await client.activity(second)).final, false);
    // The data path agrees: the new token is admitted (then refused by host policy, before any lookup) and the old one is not authenticated.
    const connect = (token) => new Promise((resolve, reject) => { const sock = net.connect({ host: '127.0.0.1', port: free }); let got = ''; sock.on('error', reject); sock.on('data', (d) => { got += d; if (got.includes('\r\n')) { sock.destroy(); resolve(Number(got.split(' ')[1])); } }); sock.write(`CONNECT refused.invalid:443 HTTP/1.1\r\nHost: refused.invalid:443\r\nProxy-Authorization: Basic ${Buffer.from(`task:${token}`).toString('base64')}\r\n\r\n`); });
    assert.equal(await connect(first.token), 407); assert.equal(await connect(second.token), 403);
    await assert.rejects(client.activity(first)); assert.equal((await client.revoke(first, 2000)).confirmed, false); assert.equal(client.available(), true, 'old cleanup leaves the new session alone');
    // A lost key file comes back on its own, after the proxy has dropped the session it no longer has a key for.
    fs.unlinkSync(keyFile); await assert.rejects(client.renew()); await until(() => client.available(), 40000); assert.equal(fs.existsSync(keyFile), true);
    assert.ok(events.some((e) => e.event === 'egress.key_republished'));
    // A Ready the real proxy committed, its reply lost past the budget: no restart of anything.
    await kill(); await assert.rejects(client.renew()); await client.close(); events.length = 0;
    const { defaultTransport } = require('./code-egress-control.cjs'); let lose = true;
    client = require('./code-egress.cjs').startEgressFromEnv({ CODE_EGRESS_PORT: String(free), CODE_EGRESS_RUST_HOST: '127.0.0.1', CODE_EGRESS_CONTROL_KEY_FILE: keyFile, CODE_EGRESS_KEY_UID: String(uid), CODE_EGRESS_KEY_GID: String(gid) }, { secrets: { derive: () => Buffer.alloc(32, 41) }, log: (e) => events.push(e), transport: async (req) => { const reply = await defaultTransport(req); if (lose && req.route === ROUTES.ready) throw Error('synthetic reply lost after commit'); return reply; } });
    await launch(); client.start(); await until(() => events.some((e) => e.event === 'egress.control_unavailable'));
    lose = false; await until(() => client.available(), 90000);
    assert.ok(events.some((e) => e.event === 'egress.control_conflict')); assert.ok(events.some((e) => e.event === 'egress.control_rekeyed'));
    const third = await client.grant({ taskId: 'third.job', domains: ['example.com'] });
    const ended = await client.revoke(third); assert.equal(ended.confirmed, true); assert.equal(ended.report.final, true);
    assert.equal((await client.forget(third, ended.report.snapshotId)).confirmed, true);
    assert.equal(events.filter((e) => e.event === 'egress.control_ready').at(-1).recovered, true);
    assert.ok(!JSON.stringify(events).includes(second.token));
  } finally {
    try { if (client) await client.close(); } finally { if (child) await kill(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
test('actual paired Rust binary authenticates Ready, scoped cleanup, retained reports and Forget', async () => {
  const { spawn } = require('node:child_process'), { once } = require('node:events'), net = require('node:net');
  const binary = process.env.NOEVIA_EGRESS_CONTROL_BINARY; assert.ok(binary, 'explicit paired Rust binary is required');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  assert.equal(digest, process.env.NOEVIA_EGRESS_CONTROL_BINARY_SHA256, 'binary provenance must match the source build receipt');
  const hermetic = globalThis[Symbol.for('noevia.hermetic.nativeFixture.v1')];
  if (process.env.NOEVIA_HERMETIC_NATIVE_REQUIRED === '1') assert.ok(hermetic, 'actual hermetic native fixture lifecycle is required');
  const dir = fs.mkdtempSync(path.join(hermetic?.directory || fs.realpathSync(os.tmpdir()), 'noevia-core-native-'));
  let child, childClosed, client, releaseNative;
  const refused = (port) => assert.throws(() => { const socket = net.connect({ host: '127.0.0.1', port }); socket.on('error', () => {}); socket.destroy(); }, /Hermetic test refused outbound connection/);
  try {
    const uid = process.getuid(), gid = process.getgid() || (uid === 0 ? 1 : 0); assert.ok(gid > 0);
    fs.chownSync(dir, uid, gid); fs.chmodSync(dir, 0o750);
    const keyFile = path.join(dir, 'control.key');
    publishWebKey({ masterKey: Buffer.alloc(32, 29), file: keyFile, uid, gid }); // earlier owned web incarnation
    const probe = net.createServer(); await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    const port = probe.address().port, reservation = hermetic?.reserve(probe);
    await new Promise((resolve) => probe.close(resolve));
    if (hermetic) {
      refused(port);
      assert.throws(() => hermetic.reserve({ listening: true, address: () => ({ address: '127.0.0.1', port }) }), /ownership refused/);
    }
    child = spawn(binary, ['--native-control-v1', '--control-key-file', keyFile, '--control-key-uid', String(uid), '--control-key-gid', String(gid), '--listen', `127.0.0.1:${port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    childClosed = new Promise((resolve) => child.once('close', resolve)); child.on('error', () => {});
    let diagnostics = ''; child.stderr.on('data', (b) => { diagnostics = (diagnostics + b).slice(-4096); });
    await once(child, 'spawn');
    if (reservation) {
      assert.throws(() => reservation.adopt({ pid: child.pid }), /ownership refused/);
      releaseNative = reservation.adopt(child);
      assert.throws(() => reservation.adopt(child), /ownership refused/);
    }
    const { defaultTransport } = require('./code-egress-control.cjs'); let dropped = false;
    client = require('./code-egress.cjs').startEgressFromEnv({ CODE_EGRESS_PORT: String(port), CODE_EGRESS_RUST_HOST: '127.0.0.1', CODE_EGRESS_CONTROL_KEY_FILE: keyFile, CODE_EGRESS_KEY_UID: String(uid), CODE_EGRESS_KEY_GID: String(gid) }, { secrets: { derive: () => Buffer.alloc(32, 29) }, transport: async (req) => {
      const reply = await defaultTransport(req);
      if (req.route === ROUTES.revoke && !dropped) { dropped = true; throw Error('owned synthetic lost reply after native commit'); }
      return reply;
    } });
    await client.ready(); await client.renew();
    const lease = await client.grant({ taskId: 'owned.synthetic.job', domains: ['example.com'] });
    const before = await client.activity(lease); assert.equal(before.available, true); assert.equal(before.final, false);
    const result = await client.revoke(lease); assert.equal(result.confirmed, true); assert.equal(result.report.final, true); assert.equal(dropped, true);
    assert.equal(result.report.allowed, 0); assert.equal(result.report.refused, 0);
    assert.equal((await client.activity(lease)).snapshotId, result.report.snapshotId);
    assert.equal((await client.forget(lease, result.report.snapshotId)).confirmed, true);
    const forgotten = await client.activity(lease); assert.equal(forgotten.available, false); assert.equal(Object.hasOwn(forgotten, 'hosts'), false);
    assert.equal(child.exitCode, null, `owned native process unexpectedly exited: ${diagnostics}`);
    await client.close(); client = null;
    child.kill('SIGKILL'); await childClosed;
    if (hermetic) { refused(port); releaseNative(); releaseNative(); refused(port); }
    child = null;
    if (hermetic) {
      // A real child with a rejected startup profile must never acquire a port.
      const failedProbe = net.createServer(); await new Promise((resolve) => failedProbe.listen(0, '127.0.0.1', resolve));
      const failedPort = failedProbe.address().port, failedReservation = hermetic.reserve(failedProbe);
      await new Promise((resolve) => failedProbe.close(resolve));
      child = spawn(binary, [], { stdio: 'ignore' }); childClosed = new Promise((resolve) => child.once('close', resolve)); child.on('error', () => {});
      await once(child, 'spawn'); assert.throws(() => failedReservation.adopt(child), /ownership refused/);
      await childClosed; assert.equal(child.exitCode, 2); refused(failedPort); child = null;
    }
  } finally {
    try { if (client) await client.close(); }
    finally {
      releaseNative?.();
      if (child) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await childClosed; }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ---- #2243: key file reads, re-key window and three test gaps ----
const { spawnSync, execFileSync } = require('node:child_process');
function keyDir(prefix) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix)), uid = process.getuid(), gid = process.getgid() || (uid === 0 ? 1 : 0);
  fs.chownSync(dir, uid, gid); fs.chmodSync(dir, 0o750); return { dir, uid, gid, done: () => { fs.chmodSync(dir, 0o700); fs.rmSync(dir, { recursive: true, force: true }); } };
}
test('#2243: a FIFO at the key path is not opened blocking, and a key file is never read past its line', (t) => {
  const k = keyDir('noevia-core-keyread-');
  try {
    const keyFile = path.join(k.dir, 'control.key'), master = Buffer.alloc(32, 8), own = publishWebKey({ masterKey: master, file: keyFile, uid: k.uid, gid: k.gid });
    // A child process, so a blocking open() fails this test by timeout instead of hanging the runner.
    const probe = (note) => spawnSync(process.execPath, ['-e', `
      const { createKeyKeeper } = require(${JSON.stringify(path.join(__dirname, 'code-egress-control.cjs'))});
      const keeper = createKeyKeeper({ deriveMaster: () => Buffer.alloc(32, 8), fileKey: Buffer.from(${JSON.stringify(own.toString('hex'))}, 'hex'), file: ${JSON.stringify(keyFile)}, uid: ${k.uid}, gid: ${k.gid} });
      console.log(JSON.stringify({ restore: keeper.restore(), rekey: keeper.rekey() }));`], { timeout: 4000, encoding: 'utf8' });
    fs.unlinkSync(keyFile); execFileSync('mkfifo', [keyFile]);
    const fifo = probe('fifo');
    assert.equal(fifo.signal, null, `a FIFO at the key path hung the web (${fifo.error?.code || fifo.stderr})`);
    assert.deepEqual(JSON.parse(fifo.stdout), { restore: 'present', rekey: null }, 'a FIFO is not our key and is never replaced');
    fs.unlinkSync(keyFile);
    // The key line followed by more bytes is not the key: foreign, not replaced, and only 66 bytes are read.
    fs.writeFileSync(keyFile, `${own.toString('hex')}\n${'x'.repeat(1 << 20)}`, { mode: 0o440 });
    const reads = []; const realRead = fs.readSync, realReadFile = fs.readFileSync;
    t.mock.method(fs, 'readSync', function (...a) { const n = realRead.apply(this, a); reads.push(n); return n; });
    t.mock.method(fs, 'readFileSync', function (f, ...rest) { assert.ok(typeof f === 'string' && !Buffer.isBuffer(f), 'the key file is read through a bounded read, not readFileSync(fd)'); return realReadFile.call(this, f, ...rest); });
    const keeper = createKeyKeeper({ deriveMaster: () => master, fileKey: own, file: keyFile, uid: k.uid, gid: k.gid });
    assert.equal(keeper.restore(), 'superseded'); assert.equal(keeper.rekey(), null);
    assert.ok(reads.length > 0 && reads.reduce((a, b) => a + b, 0) <= 66, `read ${reads.reduce((a, b) => a + b, 0)} bytes of a 1 MiB file`);
  } finally { k.done(); }
});
test('#2243: a newer web that wrote its key after the first check is not overwritten by the re-key', () => {
  const k = keyDir('noevia-core-rekey-race-');
  try {
    const keyFile = path.join(k.dir, 'control.key'), master = Buffer.alloc(32, 9), own = publishWebKey({ masterKey: master, file: keyFile, uid: k.uid, gid: k.gid });
    let newer = null;
    const keeper = createKeyKeeper({ fileKey: own, file: keyFile, uid: k.uid, gid: k.gid,
      // Runs after the keeper's first check and before it renames: a newer web publishes in between.
      deriveMaster: () => { newer = publishWebKey({ masterKey: Buffer.alloc(32, 10), file: keyFile, uid: k.uid, gid: k.gid }); return master; } });
    assert.equal(keeper.rekey(), null, 'it must not replace a key it did not write');
    assert.equal(fs.readFileSync(keyFile, 'utf8'), `${newer.toString('hex')}\n`, 'the newer web key is still the one on disk');
    assert.deepEqual(fs.readdirSync(k.dir), ['control.key'], 'no temporary file is left behind');
    assert.equal(keeper.restore(), 'superseded');
  } finally { k.done(); }
});
test('#2243: a signed refusal, a failure, and a signed refusal 30 s later never add up to a re-key', async () => {
  for (const breakWith of ['down', 'unsigned']) {
    const p = restartable(), events = []; let shift = 0, losing = true, mode = 'up', rekeys = 0;
    const c = createControlClient({ fileKey: file, endpoint: 'localhost:3001', autoRenew: false, retryMinMs: 1, retryMaxMs: 2, monotonic: () => performance.now() + shift, log: (e) => events.push(e.event),
      keeper: { restore: () => 'present', rekey: () => { rekeys++; return null; } },
      transport: async (req) => {
        if (mode === 'down') throw Object.assign(Error('synthetic refused'), { code: 'ECONNREFUSED' });
        if (mode === 'unsigned') return response(req, { state: 'conflict' }, 409, Buffer.alloc(32, 66));
        const reply = await p.transport(req); if (losing && req.route === ROUTES.ready) { losing = false; shift += 11000; } return reply;
      } });
    await assert.rejects(c.ready());                         // the Ready commits, its reply is lost
    await settle(); await assert.rejects(c.ready(), { reason: 'conflict' }); assert.ok(events.includes('egress.control_conflict'));
    mode = breakWith; shift += 1000; await settle(); await assert.rejects(c.ready());   // not a signed refusal: the run is broken
    mode = 'up'; p.expire(); shift += 30000; await settle();
    await assert.rejects(c.ready(), { reason: 'conflict' });
    assert.equal(rekeys, 0, `a ${breakWith} failure between two signed refusals must restart the wait, not continue it`); assert.equal(c.available(), false);
    shift += 30000; await settle(); await assert.rejects(c.ready(), { reason: 'conflict' });
    assert.equal(rekeys, 1, 'a fresh unbroken run does reach the re-key'); await c.close();
  }
});
test('#2243: a Replace that commits with its reply lost, while a prior session is held, heals by a new key', async () => {
  const p = restartable(), events = []; let shift = 0, losing = false, next = null;
  const c = createControlClient({ fileKey: file, endpoint: 'localhost:3001', autoRenew: false, retryMinMs: 1, retryMaxMs: 2, monotonic: () => performance.now() + shift, log: (e) => events.push(e.event),
    keeper: { restore: () => 'present', rekey: () => { next = Buffer.alloc(32, 11); p.rekey(next); return next; } },
    transport: async (req) => { const reply = await p.transport(req); if (losing && req.route === ROUTES.ready) { losing = false; shift += 11000; } return reply; } });
  await c.ready(); const held = await c.grant({ taskId: 'held.old', domains: ['example.com'] });
  shift += 16000; p.expire(); await assert.rejects(c.ready(), { reason: 'unavailable' }); // the session ran out; the client keeps it as the prior one
  await settle(); losing = true; await assert.rejects(c.ready());                          // it asks to Replace it and the reply is lost
  assert.equal(c.available(), false);
  assert.deepEqual(p.calls.filter((r) => r.route === ROUTES.ready).map((r) => r.mode), ['initial', 'replace']);
  await settle(); await assert.rejects(c.ready(), { reason: 'conflict' }); assert.equal(next, null, 'a live unknown session is waited out');
  p.expire(); shift += 10000; await settle(); await assert.rejects(c.ready(), { reason: 'conflict' }); assert.equal(next, null);
  shift += 16000; await settle(); await c.ready();
  assert.ok(next, 'the new key was written once the signed refusals outlasted any session'); assert.equal(c.available(), true); assert.ok(events.includes('egress.control_rekeyed'));
  const fresh = await c.grant({ taskId: 'held.new', domains: ['example.com'] }); assert.ok(fresh.token && fresh.token !== held.token);
  assert.equal((await c.revoke(held)).confirmed, false, 'a lease of the replaced session is never confirmed by the new one'); assert.equal(c.available(), true, 'and does not take the new session down');
  await c.close();
});
test('#2243: close while a request is retrying and still in flight stops it for good', async () => {
  for (const outcome of ['fails', 'commits']) {
    const p = restartable(); let gate, entered; const waiting = new Promise((r) => { entered = r; }), release = new Promise((r) => { gate = r; }); let calls = 0;
    const c = createControlClient({ fileKey: file, endpoint: 'localhost:3001', retryMinMs: 1, retryMaxMs: 2,
      transport: async (req) => { calls++; if (calls === 1) { entered(); await release; if (outcome === 'fails') throw Object.assign(Error('synthetic reset'), { code: 'ECONNRESET' }); } return p.transport(req); } });
    c.start(); await waiting;                              // the first Ready is in flight
    const closing = c.close(); gate();
    await closing; const after = calls; await settle(600);   // longer than the 250 ms retry pause
    assert.equal(calls, after, `no request leaves after close (${outcome})`); assert.equal(calls, 1, `the in-flight Ready is the only one (${outcome})`);
    assert.equal(c.available(), false, `a Ready that commits after close does not make the client available (${outcome})`);
    await assert.rejects(c.ready()); await assert.rejects(c.grant({ taskId: 'late.1', domains: ['example.com'] }));
  }
});
