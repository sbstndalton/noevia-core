'use strict';
// Row V: Node is a fail-closed client of the native issuer (code-egress-client.cjs). A fake front stands
// in for the Rust internal store; synthetic data only.
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http');
const { createEgressClient, EgressUnavailableError, CODE_EGRESS_CLIENT_MARKER } = require('./code-egress-client.cjs');

const TOKEN = 'synthetic-store-token-0123456789abcdef', SNAP = 'ee'.repeat(16);
const report = (final) => ({ available: true, state: 'complete', final, partial: false, overflow: false, snapshotId: SNAP, allowed: 1, refused: 0, hosts: [{ host: 'example.com', allowed: 1, refused: 0, reason: null }] });

async function front(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {}; const op = req.url.replace('/v1/egress/', '');
      calls.push({ op, body, token: req.headers['x-noevia-store-token'], method: req.method });
      const [status, value] = handler(op, body, calls.length);
      if (status === 'hangup') return req.socket.destroy();
      res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, calls, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) };
}
const normal = (op, body) => {
  if (op === 'status') return [200, { configured: true, available: true, endpoint: 'egress-rs-code:8040' }];
  if (op === 'grant') return [200, { handle: 'h-1', taskId: body.taskId, domains: body.domains.map((d) => d.toLowerCase()), token: 'ngr1.synthetic' }];
  if (op === 'activity') return [200, { report: report(false) }];
  if (op === 'revoke') return [200, { confirmed: true, report: report(true) }];
  if (op === 'forget') return [200, { confirmed: body.snapshotId === SNAP }];
  return [404, {}];
};

test('the marker the release check reads is present', () => { assert.equal(CODE_EGRESS_CLIENT_MARKER, 'noevia-code-egress-client/1'); });

test('grant, activity, revoke and forget go to the front with the store secret, and the token stays off the handle JSON', async (t) => {
  const f = await front(normal); t.after(f.close);
  const c = createEgressClient({ port: f.port, token: TOKEN, endpoint: 'egress-rs-code:8040' });
  const handle = await c.grant({ taskId: 'task:1', domains: ['Example.COM'] });
  assert.equal(handle.token, 'ngr1.synthetic'); assert.deepEqual([...handle.domains], ['example.com']); assert.ok(!JSON.stringify(handle).includes('ngr1.'));
  assert.ok(Object.isFrozen(handle)); assert.throws(() => c.revoke({ ...handle }), (e) => e.code === 'EGRESS_UNAVAILABLE' && e.reason === 'handle');
  assert.equal((await c.activity(handle)).final, false);
  const a = c.revoke(handle), b = c.revoke(handle); assert.equal(a, b);
  const done = await a; assert.equal(done.confirmed, true); assert.equal(done.report.final, true); assert.equal(done.report.hosts[0].host, 'example.com');
  assert.equal((await c.forget(handle, SNAP)).confirmed, true);
  assert.deepEqual(f.calls.map((x) => x.op), ['grant', 'activity', 'revoke', 'forget']);
  assert.ok(f.calls.every((x) => x.token === TOKEN && x.method === 'POST'));
  assert.equal(f.calls[2].body.handle, 'h-1'); assert.equal(JSON.stringify(f.calls).includes('ngr1.'), false, 'the token is never sent back');
});

test('an unreachable or refusing front refuses every grant (never a made-up one) and names the outage', async (t) => {
  const f = await front(() => [503, { error: 'native egress is unavailable', code: 'EGRESS_UNAVAILABLE', reason: 'transport' }]); t.after(f.close);
  const c = createEgressClient({ port: f.port, token: TOKEN, endpoint: 'x:1' });
  await assert.rejects(c.grant({ taskId: 'task:1', domains: ['example.com'] }), (e) => e instanceof EgressUnavailableError && e.status === 503 && e.code === 'EGRESS_UNAVAILABLE' && e.reason === 'transport');
  const dead = createEgressClient({ port: 9, token: TOKEN, endpoint: 'x:1' });
  await assert.rejects(dead.grant({ taskId: 'task:1', domains: ['example.com'] }), (e) => e.code === 'EGRESS_UNAVAILABLE' && e.status === 503);
  assert.equal(dead.available(), false);
});

test('malformed or mismatched answers are refusals, not grants', async (t) => {
  for (const answer of [[200, {}], [200, { handle: 'h', token: 'ngr1.x', domains: [], taskId: 'other' }], [200, { handle: 7, token: 'ngr1.x', domains: [], taskId: 'task:1' }], [200, null], [500, { handle: 'h', token: 'ngr1.x', domains: [], taskId: 'task:1' }]]) {
    const f = await front(() => answer); t.after(f.close);
    await assert.rejects(createEgressClient({ port: f.port, token: TOKEN, endpoint: 'x:1' }).grant({ taskId: 'task:1', domains: ['example.com'] }), (e) => e.code === 'EGRESS_UNAVAILABLE');
  }
  const c = createEgressClient({ port: 1, token: TOKEN, endpoint: 'x:1' });
  await assert.rejects(c.grant({ taskId: 7, domains: [] }), (e) => e.reason === 'task');
});

test('a cleanup the front cannot confirm is reported as unconfirmed, and a snapshot mismatch rejects', async (t) => {
  const bad = new Set(['revoke']);
  const f = await front((op, body, n) => (bad.has(op) ? (op === 'revoke' && n % 2 ? ['hangup'] : [503, { code: 'EGRESS_UNAVAILABLE', reason: 'uncertain' }]) : (op === 'forget' && body.snapshotId !== SNAP ? [503, { code: 'EGRESS_UNAVAILABLE', reason: 'snapshot' }] : normal(op, body)))); t.after(f.close);
  const c = createEgressClient({ port: f.port, token: TOKEN, endpoint: 'x:1' });
  const h1 = await c.grant({ taskId: 'task:1', domains: ['example.com'] }), h2 = await c.grant({ taskId: 'task:2', domains: ['example.com'] });
  for (const h of [h1, h2]) { const r = await c.revoke(h); assert.equal(r.confirmed, false); assert.deepEqual({ ...r.report }, { available: false, state: 'uncertain', final: false, partial: true }); }
  await assert.rejects(c.forget(h1, '00'.repeat(16)), (e) => e.reason === 'snapshot');
  assert.equal((await c.forget(h1, SNAP)).confirmed, true);
  bad.clear();
  // A handle from a previous front incarnation: the front refuses it; Node never re-acquires.
  const g = await front((op, body) => (op === 'revoke' ? [503, { code: 'EGRESS_UNAVAILABLE', reason: 'handle' }] : normal(op, body))); t.after(g.close);
  const d = createEgressClient({ port: g.port, token: TOKEN, endpoint: 'x:1' }); const h = await d.grant({ taskId: 'task:3', domains: ['example.com'] });
  assert.equal((await d.revoke(h)).confirmed, false); assert.deepEqual(g.calls.map((x) => x.op), ['grant', 'revoke']);
});

test('availability is the front\'s own recent word: false before it, after a failure and once stale', async (t) => {
  let up = true; const f = await front((op, body) => (op === 'status' ? (up ? normal(op, body) : [200, { configured: true, available: false }]) : normal(op, body))); t.after(f.close);
  let clock = 1_000_000; const logs = [];
  const c = createEgressClient({ port: f.port, token: TOKEN, endpoint: 'x:1', now: () => clock, statusEveryMs: 3600000, log: (e) => logs.push(e.event) });
  assert.equal(c.available(), false, 'fail closed until the front has answered');
  await c.ready(); assert.equal(c.available(), true);
  clock += 5000; assert.equal(c.available(), true); clock += 2000; assert.equal(c.available(), false, 'a stale answer is not an answer');
  await c.ready(); assert.equal(c.available(), true);
  up = false; await c.ready(); assert.equal(c.available(), false); up = true; await c.ready(); assert.equal(c.available(), true);
  assert.deepEqual(logs, ['egress.client_ready', 'egress.client_unavailable', 'egress.client_ready']);
  await c.close(); assert.equal(c.available(), false);
  await assert.rejects(c.grant({ taskId: 'task:1', domains: ['example.com'] }), (e) => e.reason === 'closed');
});

test('close revokes what is still held', async (t) => {
  const f = await front(normal); t.after(f.close);
  const c = createEgressClient({ port: f.port, token: TOKEN, endpoint: 'x:1' });
  await c.grant({ taskId: 'task:1', domains: ['example.com'] }); await c.grant({ taskId: 'task:2', domains: ['example.com'] });
  const results = await c.close(); assert.equal(results.length, 2); assert.ok(results.every((r) => r.confirmed));
  assert.equal(f.calls.filter((x) => x.op === 'revoke').length, 2);
});

test('the client config refuses a missing or weak store secret and port', () => {
  for (const o of [{ port: 0, token: TOKEN }, { port: 70000, token: TOKEN }, { port: 1, token: 'short' }, { port: 1 }]) assert.throws(() => createEgressClient({ ...o, endpoint: 'x:1' }), (e) => e.code === 'EGRESS_UNAVAILABLE');
});

test('unconfirmed cleanups do not accumulate across recoveries: Node drops its reference once the flight settles', async (t) => {
  let revokeStatus = 503;
  const f = await front((op, body) => (op === 'revoke' ? [revokeStatus, { code: 'EGRESS_UNAVAILABLE', reason: 'handle' }] : normal(op, body))); t.after(f.close);
  const c = createEgressClient({ port: f.port, token: TOKEN, endpoint: 'x:1' });
  let kept = null;
  for (let i = 0; i < 300; i++) {
    const h = await c.grant({ taskId: `task:${i}`, domains: ['example.com'] });
    const r = await c.revoke(h); assert.equal(r.confirmed, false);
    if (i === 0) kept = { h, r };
    if (i % 50 === 0) await c.ready(); // a successful native recovery poll must not be what clears them either
  }
  assert.equal(c.retained(), 0, 'no strong reference survives a settled cleanup');
  // A still-held handle keeps its (unconfirmed) answer: same result, no second revoke request, no re-acquire.
  const before = f.calls.length;
  assert.equal(await c.revoke(kept.h), kept.r); assert.equal(f.calls.length, before);
  assert.equal(f.calls.filter((x) => x.op === 'revoke').length, 300);
  assert.equal(f.calls.filter((x) => x.op === 'grant').length, 300);
  // A live handle is still tracked until its flight settles, and close() revokes only what remains.
  const live = await c.grant({ taskId: 'task:live', domains: ['example.com'] }); assert.equal(c.retained(), 1);
  revokeStatus = 200;
  const results = await c.close(); assert.equal(results.length, 1); assert.equal(c.retained(), 0); void live;
});
