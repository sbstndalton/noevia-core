'use strict';
// sbstndalton/noevia#2115, #2117: the web's client of the inference gate, against a synthetic gate on loopback that
// speaks the gate's lease protocol (an event stream of `queued`, then `granted` or `error`) and its refusal shape.
// Synthetic model ids and tokens only; no model, no router, no request content.
const test = require('node:test'), assert = require('node:assert/strict');
const http = require('node:http');
const { createGateClient, GateError, LEASE_HEADER, adminTokenWarning } = require('./inference-gate-client.cjs');

const TOKEN_A = 'a'.repeat(32), TOKEN_B = 'b'.repeat(32);
const gateError = (code, message, retryable) => JSON.stringify({ error: { code, message, type: 'gate_error', retryable } });

async function gate(t, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body }); handler(req, res, body, seen); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}
const sse = (res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

test('a lease granted at once: the token, the lease header, one release', async (t) => {
  const g = await gate(t, (req, res) => {
    if (req.method === 'POST' && req.url === '/gate/v1/leases') { const send = sse(res); send('granted', { lease: TOKEN_A, model: 'route-code', waited_ms: 0, idle_ttl_ms: 30000, hard_ttl_ms: 1800000 }); res.end(); return; }
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
    res.writeHead(500); res.end();
  });
  const client = createGateClient({ baseUrl: g.base + '/v1', log: () => {} });
  const lease = await client.acquire('route-code', { maxWaitMs: 5000 });
  assert.equal(lease.token, TOKEN_A);
  assert.deepEqual(lease.headers(), { [LEASE_HEADER]: TOKEN_A });
  const asked = g.seen[0];
  assert.deepEqual(JSON.parse(asked.body), { model: 'route-code', holder: 'web', max_wait_ms: 5000 });
  assert.equal(asked.headers['x-noevia-client'], 'web');
  await lease.release(); await lease.release();
  assert.deepEqual(g.seen.filter((s) => s.method === 'DELETE').map((s) => s.url), [`/gate/v1/leases/${TOKEN_A}`], 'released once');
  assert.equal(client.waiting(), 0);
});

test('a queued lease reports its position and wait, and counts as waiting until it is granted', async (t) => {
  let grant;
  const g = await gate(t, (req, res) => {
    const send = sse(res);
    send('queued', { model: 'route-smart', position: 2, waited_ms: 0 });
    grant = () => { send('queued', { model: 'route-smart', position: 1, waited_ms: 2500 }); send('granted', { lease: TOKEN_A, model: 'route-smart', waited_ms: 4000 }); res.end(); };
  });
  const client = createGateClient({ baseUrl: g.base });
  const queued = [];
  const pending = client.acquire('route-smart', { onQueued: (q) => queued.push(q) });
  for (let i = 0; i < 100 && !grant; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(client.waiting(), 1);
  grant();
  const lease = await pending;
  assert.equal(lease.token, TOKEN_A);
  assert.deepEqual(queued, [{ position: 2, waitedMs: 0 }, { position: 1, waitedMs: 2500 }]);
  assert.equal(client.waiting(), 0);
});

test('refusals are GateErrors with the gate\'s code, status, retryable flag and text', async (t) => {
  const g = await gate(t, (req, res, body) => {
    const model = JSON.parse(body).model;
    if (model === 'route-gone') { res.writeHead(404, { 'content-type': 'application/json', 'x-noevia-gate-refusal': 'model_not_found' }); res.end(gateError('model_not_found', 'The local model engine has no model of that name.', false)); return; }
    if (model === 'route-full') { res.writeHead(503, { 'content-type': 'application/json' }); res.end(gateError('inference_queue_full', 'Too many requests are waiting for the local model. Try again shortly.', true)); return; }
    const send = sse(res);
    send('queued', { model, position: 1, waited_ms: 0 });
    send('error', { code: 'inference_queue_timeout', message: 'Another chat was still using the local model. Try again when it has finished.', retryable: true });
    res.end();
  });
  const client = createGateClient({ baseUrl: g.base });
  await assert.rejects(client.acquire('route-gone'), (e) => e instanceof GateError && e.code === 'model_not_found' && e.status === 404 && e.retryable === false);
  await assert.rejects(client.acquire('route-full'), (e) => e.code === 'inference_queue_full' && e.status === 503 && e.retryable === true && /Too many/.test(e.publicMessage));
  await assert.rejects(client.acquire('route-code'), (e) => e.code === 'inference_queue_timeout' && e.retryable === true && /still using/.test(e.message));
  assert.equal(client.waiting(), 0);
});

test('a router without a gate in front: no lease, said once; an unreachable gate is engine_unavailable', async (t) => {
  const g = await gate(t, (req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 404, message: 'File Not Found', type: 'not_found_error' } })); });
  const lines = [];
  const client = createGateClient({ baseUrl: g.base, log: (l) => lines.push(l) });
  assert.equal(await client.acquire('route-code'), null);
  assert.equal(await client.acquire('route-code'), null);
  assert.equal(lines.length, 1);
  const closed = http.createServer(); await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const port = closed.address().port; await new Promise((r) => closed.close(r));
  const down = createGateClient({ baseUrl: `http://127.0.0.1:${port}` });
  await assert.rejects(down.acquire('route-code'), (e) => e.code === 'engine_unavailable' && e.status === 502 && e.retryable === true);
  // A 200 that is not an event stream, or a grant without a valid token, is not the gate's answer.
  const odd = await gate(t, (req, res) => { const send = sse(res); send('granted', { lease: 'not-a-token' }); res.end(); });
  await assert.rejects(createGateClient({ baseUrl: odd.base }).acquire('route-code'), (e) => e.code === 'engine_unavailable');
});

test('stopping while queued leaves the queue: the event stream is closed and the stop reason is thrown', async (t) => {
  let closed = false;
  const g = await gate(t, (req, res) => { const send = sse(res); send('queued', { model: 'route-smart', position: 1, waited_ms: 0 }); res.on('close', () => { closed = true; }); });
  const client = createGateClient({ baseUrl: g.base });
  const controller = new AbortController();
  const pending = client.acquire('route-smart', { signal: controller.signal, onQueued: () => controller.abort(new Error('stopped by the user')) });
  await assert.rejects(pending, /stopped by the user/);
  for (let i = 0; i < 100 && !closed; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(closed, true, 'the gate sees the client leave');
  assert.equal(client.waiting(), 0);
});

test('a lease rides only on requests to the gate; a forgotten lease is taken again once and the request resent', async (t) => {
  let grants = 0, forgetFirst = true;
  const g = await gate(t, (req, res, body) => {
    if (req.url === '/gate/v1/leases') { const send = sse(res); send('granted', { lease: ++grants === 1 ? TOKEN_A : TOKEN_B }); res.end(); return; }
    if (req.url === '/v1/chat/completions') {
      if (forgetFirst && req.headers['x-noevia-lease'] === TOKEN_A) { forgetFirst = false; res.writeHead(409, { 'content-type': 'application/json', 'x-noevia-gate-refusal': 'lease_unknown' }); res.end(gateError('lease_unknown', 'This chat\'s turn on the local model has ended. Start the request again.', true)); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ lease: req.headers['x-noevia-lease'], body: JSON.parse(body) })); return;
    }
    res.writeHead(204); res.end();
  });
  const lines = [];
  const client = createGateClient({ baseUrl: g.base, log: (l) => lines.push(l) });
  const lease = await client.acquire('route-code');
  const other = [];
  const leased = lease.fetch(async (url, init) => { if (!String(url).startsWith(g.base)) { other.push({ url, init }); return new Response('{}'); } return fetch(url, init); });
  const r = await leased(`${g.base}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-noevia-lease': 'stale' }, body: JSON.stringify({ model: 'route-code', stream: false }) });
  assert.equal(r.status, 200);
  const answer = await r.json();
  assert.equal(answer.lease, TOKEN_B, 'sent again under the new lease');
  assert.deepEqual(answer.body, { model: 'route-code', stream: false });
  assert.equal(lease.token, TOKEN_B);
  assert.equal(grants, 2, 'taken again once');
  assert.ok(lines.some((l) => l.includes('lease-renew')));
  await leased('http://elsewhere.invalid/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(other[0].init.headers[LEASE_HEADER], undefined, 'never sent to another host');
  // A second refusal is passed on as it is: one renewal per request.
  forgetFirst = true;
  const lease2 = await client.acquire('route-code');
  assert.equal(lease2.token, TOKEN_B);
  await lease.release();
  assert.deepEqual(g.seen.filter((s) => s.method === 'DELETE').map((s) => s.url), [`/gate/v1/leases/${TOKEN_B}`], 'the renewed lease is the one given back');
});

test('admin headers only with a configured token', () => {
  assert.equal(createGateClient({ baseUrl: 'http://127.0.0.1:9' }).adminHeaders(), null);
  assert.equal(createGateClient({ baseUrl: 'http://127.0.0.1:9', adminToken: '  ' }).hasAdmin(), false);
  const admin = createGateClient({ baseUrl: 'http://127.0.0.1:9', adminToken: 'synthetic-admin-0001' });
  assert.deepEqual(admin.adminHeaders(), { 'X-Noevia-Gate-Admin': 'synthetic-admin-0001' });
  assert.equal(admin.hasAdmin(), true);
  assert.equal(admin.refusal(409, JSON.parse(gateError('model_in_use', 'busy', true))).code, 'model_in_use');
  assert.equal(admin.refusal(409, { error: 'busy' }), null, 'not the gate\'s shape');
});

// A synthetic gate in memory that ends a lease idle for longer than its limit (the test ends them by hand), so
// the real client can be driven through a tool turn with long pauses. No network.
function memoryGate({ refuseGrantsAfter = Infinity } = {}) {
  const live = new Set(), grants = [], released = [], requests = [];
  let issued = 0;
  const sseBody = (text) => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/gate/v1/leases' && init.method === 'POST') {
      if (grants.length >= refuseGrantsAfter) return sseBody(`event: error\ndata: ${JSON.stringify({ code: 'inference_queue_full', message: 'Too many requests are waiting for the local model. Try again shortly.', retryable: true })}\n\n`);
      const token = (++issued).toString(16).padStart(32, '0'); live.add(token); grants.push(token);
      return sseBody(`event: granted\ndata: ${JSON.stringify({ lease: token, model: 'route-smart', waited_ms: 0 })}\n\n`);
    }
    if (u.pathname.startsWith('/gate/v1/leases/') && init.method === 'DELETE') { const token = u.pathname.split('/').pop(); live.delete(token); released.push(token); return new Response(null, { status: 204 }); }
    const token = new Headers(init.headers).get(LEASE_HEADER);
    requests.push(token);
    if (!live.has(token)) return new Response(gateError('lease_unknown', 'The turn on the local model has ended. Start the request again.', true), { status: 409, headers: { 'x-noevia-gate-refusal': 'lease_unknown', 'content-type': 'application/json' } });
    return new Response('{}', { status: 200 });
  };
  return { fetch, live, grants, released, requests, idle: () => live.clear() };
}
const GATE_URL = 'http://gate.invalid:8080';
const completion = (send) => send(`${GATE_URL}/v1/chat/completions`, { method: 'POST', body: '{}' });

test('a tool turn survives two idle gaps longer than the gate lease limit: every round is answered, a new lease for each gap', async () => {
  const gate = memoryGate();
  const client = createGateClient({ baseUrl: GATE_URL, fetch: gate.fetch, log: () => {} });
  const lease = await client.acquire('route-smart');
  const send = lease.fetch(gate.fetch);
  assert.equal((await completion(send)).status, 200, 'round 1');
  gate.idle(); // a long approval or a slow tool between rounds
  assert.equal((await completion(send)).status, 200, 'round 2, after the first lapse');
  gate.idle();
  assert.equal((await completion(send)).status, 200, 'round 3, after the second lapse');
  gate.idle();
  assert.equal((await completion(send)).status, 200, 'round 4, after the third lapse');
  assert.equal(gate.grants.length, 4, 'one lease at the start, one more per lapse');
  assert.equal(lease.token, gate.grants[3]);
  await lease.release();
  assert.deepEqual(gate.released, [gate.grants[3]], 'the lease in hand at the end is the one given back');
});

test('requests that hit the same ended lease together share one renewal; a later one finds the lease renewed', async () => {
  const gate = memoryGate();
  const client = createGateClient({ baseUrl: GATE_URL, fetch: gate.fetch, log: () => {} });
  const lease = await client.acquire('route-smart');
  const send = lease.fetch(gate.fetch);
  gate.idle();
  const statuses = (await Promise.all([completion(send), completion(send), completion(send)])).map((r) => r.status);
  assert.deepEqual(statuses, [200, 200, 200]);
  assert.equal(gate.grants.length, 2, 'one renewal for all three');
  gate.idle();
  assert.deepEqual((await Promise.all([completion(send), completion(send)])).map((r) => r.status), [200, 200]);
  assert.equal(gate.grants.length, 3, 'one renewal for the second lapse');
});

test('a renewal the gate refuses ends the request with its refusal; no loop, and the next request may try again', async () => {
  const gate = memoryGate({ refuseGrantsAfter: 1 });
  const client = createGateClient({ baseUrl: GATE_URL, fetch: gate.fetch, log: () => {} });
  const lease = await client.acquire('route-smart');
  const send = lease.fetch(gate.fetch);
  assert.equal((await completion(send)).status, 200);
  gate.idle();
  const before = gate.requests.length;
  await assert.rejects(completion(send), (e) => e instanceof GateError && e.code === 'inference_queue_full' && e.retryable === true);
  assert.equal(gate.requests.length, before + 1, 'the request was sent once, never again after the refused renewal');
  assert.equal(gate.grants.length, 1, 'one lease was ever granted; the refused renewal is not a lease');
  await assert.rejects(completion(send), (e) => e.code === 'inference_queue_full', 'a later request asks again and is refused again');
  await lease.release();
});

test('a request is sent again once only: a lease still unknown after its renewal is passed on, not renewed again', async () => {
  let grants = 0;
  const seen = [];
  const baseFetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === '/gate/v1/leases') return new Response(`event: granted\ndata: ${JSON.stringify({ lease: (++grants).toString(16).padStart(32, '0') })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    seen.push(new Headers(init.headers).get(LEASE_HEADER));
    return new Response(gateError('lease_unknown', 'ended', true), { status: 409, headers: { 'x-noevia-gate-refusal': 'lease_unknown' } });
  };
  const client = createGateClient({ baseUrl: GATE_URL, fetch: baseFetch, log: () => {} });
  const lease = await client.acquire('route-smart');
  const r = await completion(lease.fetch(baseFetch));
  assert.equal(r.status, 409);
  assert.equal(seen.length, 2, 'sent, then sent once more');
  assert.equal(grants, 2, 'one renewal');
});

test('stopped at the moment of the grant: the lease is given back and the stop reason is thrown', async () => {
  const gate = memoryGate();
  const controller = new AbortController();
  const grantThenStop = async (url, init) => { const r = await gate.fetch(url, init); if (init?.method === 'POST') controller.abort(new Error('stopped by the user')); return r; };
  const client = createGateClient({ baseUrl: GATE_URL, fetch: grantThenStop, log: () => {} });
  await assert.rejects(client.acquire('route-smart', { signal: controller.signal }), /stopped by the user/);
  assert.equal(gate.grants.length, 1);
  assert.deepEqual(gate.released, gate.grants, 'the lease that arrived after the stop was released');
  assert.equal(client.waiting(), 0);
});

test('releaseAll gives back every lease still held, once, and does not wait on a gate that does not answer', async () => {
  const gate = memoryGate();
  const client = createGateClient({ baseUrl: GATE_URL, fetch: gate.fetch, log: () => {} });
  const a = await client.acquire('route-smart'), b = await client.acquire('route-code');
  await b.release();
  assert.equal(await client.releaseAll(), 1);
  assert.deepEqual(gate.released.sort(), [a.token, b.token].sort());
  assert.equal(await client.releaseAll(), 0, 'nothing is left to give back');
  let calls = 0;
  const silent = async (url, init = {}) => {
    if (init.method === 'DELETE') { calls++; return new Promise(() => {}); }
    return gate.fetch(url, init);
  };
  const stuck = createGateClient({ baseUrl: GATE_URL, fetch: silent, log: () => {} });
  await stuck.acquire('route-smart');
  const started = Date.now();
  assert.equal(await stuck.releaseAll({ timeoutMs: 50 }), 1);
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 2000, 'bounded by the timeout');
});

test('a request to another address than the gate goes without a lease, said once per address', async () => {
  const lines = [], sent = [];
  const gate = memoryGate();
  const client = createGateClient({ baseUrl: GATE_URL, fetch: gate.fetch, log: (l) => lines.push(l) });
  const lease = await client.acquire('route-smart');
  const send = lease.fetch(async (url, init) => { sent.push({ url, init }); return new Response('{}'); });
  await send('http://other.invalid:9000/v1/chat/completions?x=secret', { method: 'POST', body: '{}' });
  await send('http://other.invalid:9000/v1/models', { method: 'POST', body: '{}' });
  await send('http://third.invalid:9000/v1/models', { method: 'POST', body: '{}' });
  assert.equal(sent.length, 3);
  const notes = lines.filter((l) => l.includes('lease-not-attached'));
  assert.equal(notes.length, 2, 'once for each address');
  assert.ok(notes.every((l) => !l.includes('secret') && !l.includes('/v1/')), 'the address only: no path, no query');
});

test('the warning for a missing admin token names the key, says what stops working, and holds no value', () => {
  const text = adminTokenWarning();
  assert.match(text, /INFERENCE_GATE_ADMIN_TOKEN is not set/);
  assert.match(text, /memory watchdog/);
  assert.match(text, /unload anyway/);
  assert.equal(/[0-9a-f]{16,}/i.test(text), false);
});
