'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { CAPABILITY, ROUTES, deriveFileKey, deriveControlKey, deriveGrantKey, requestMac, responseMac, createControlClient, publishWebKey } = require('./code-egress-control.cjs');
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
      assert.equal(f.calls.length, count, 'no revoke, renewal, or replacement Ready request may escape'); await c.close();
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
