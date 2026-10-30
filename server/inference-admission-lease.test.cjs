'use strict';
// #2218: the Rust front's model steps enter this process's admission over real loopback HTTP: only the front may ask, a
// refusal keeps the step's own words, a caller that goes away holds nothing, and an unrenewed lease ends by itself.
const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { createAdmissionRoutes, PREFIX } = require('./inference-admission-lease.cjs');
const { json, readJson } = require('./http.cjs');

const SECRET = 's'.repeat(40);

async function serve(t, options) {
  const routes = createAdmissionRoutes({ secret: SECRET, json, readJson, admitEngineModel: async () => {}, modelManager: {}, log: () => {}, ...options });
  const server = http.createServer(async (req, res) => { if (!await routes.handle(req, res)) { res.statusCode = 418; res.end(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { routes, base: `http://127.0.0.1:${server.address().port}` };
}
const ask = (base, body, headers = { 'x-noevia-store-token': SECRET }, path = PREFIX, method = 'POST', signal) =>
  fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body), signal });
const settled = () => new Promise((r) => setTimeout(r, 30));

test('only the front may ask: a wrong secret and a proxied request get an unknown path\'s 404, and hold nothing', async (t) => {
  let entered = 0;
  const { base, routes } = await serve(t, { modelManager: { enterInference: () => { entered++; return () => {}; } } });
  for (const headers of [{}, { 'x-noevia-store-token': 'wrong' }, { 'x-noevia-store-token': SECRET, 'x-noevia-client-ip': '203.0.113.9' }, { 'x-noevia-store-token': SECRET, 'x-forwarded-for': '203.0.113.9' }]) {
    const r = await ask(base, { model: 'm' }, headers);
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: 'Not found' });
  }
  assert.equal(entered, 0);
  assert.equal(routes.leases.size(), 0);
  const noSecret = await serve(t, { secret: '' });
  assert.equal((await ask(noSecret.base, { model: 'm' }, { 'x-noevia-store-token': '' })).status, 404);
  assert.equal((await ask(base, null, undefined, '/internal/inference-admission/other', 'GET')).status, 418, 'not this route');
});

test('a lease holds maintenance and the gate; release and the renewal limit give both back', async (t) => {
  const log = [];
  const modelManager = {
    enterInference: () => { log.push('enter'); return () => log.push('leave'); },
    acquireLease: async (model, o) => { log.push(`gate ${model} ${o.maxWaitMs}`); return { headers: () => ({ 'x-noevia-lease': 'abc' }), release: async () => log.push('gate-release') }; },
  };
  const { base, routes } = await serve(t, { modelManager, ttlMs: 60 });
  const r = await ask(base, { model: 'm' });
  assert.equal(r.status, 201);
  const grant = await r.json();
  assert.match(grant.lease, /^[0-9a-f]{32}$/);
  assert.deepEqual(grant.headers, { 'x-noevia-lease': 'abc' });
  assert.equal((await ask(base, null, undefined, `${PREFIX}/${grant.lease}/renew`)).status, 200);
  const del = await ask(base, null, undefined, `${PREFIX}/${grant.lease}`, 'DELETE');
  assert.equal(del.status, 204);
  assert.deepEqual(log, ['enter', 'gate m 120000', 'gate-release', 'leave']);
  assert.equal((await ask(base, null, undefined, `${PREFIX}/${grant.lease}/renew`)).status, 404);
  assert.equal((await ask(base, null, undefined, `${PREFIX}/${grant.lease}`, 'DELETE')).status, 204, 'already ended is still done');
  // A front that died: not renewed, and it ends by itself.
  log.length = 0;
  await ask(base, { model: 'm' });
  assert.equal(routes.leases.size(), 1);
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(routes.leases.size(), 0);
  assert.deepEqual(log.slice(-2), ['gate-release', 'leave']);
});

test('without a gate the budget check still refuses, in its words, and gives the gate of maintenance back', async (t) => {
  let left = 0;
  const { base } = await serve(t, {
    modelManager: { enterInference: () => () => { left++; } },
    admitEngineModel: async () => { throw Object.assign(Error('over'), { status: 409, publicMessage: 'Over the inference budget.', code: 'overBudget' }); },
  });
  const r = await ask(base, { model: 'big' });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: 'Over the inference budget.', code: 'overBudget' });
  assert.equal(left, 1);
});

test('maintenance refuses with core\'s words: tuning\'s own 503 text, anything else busy', async (t) => {
  const refuse = (status, message) => ({ enterInference: () => { throw Object.assign(Error(message), { status }); } });
  const tuning = await serve(t, { modelManager: refuse(503, 'A model is being tuned.') });
  let r = await ask(tuning.base, { model: 'm' });
  assert.deepEqual([r.status, await r.json()], [503, { error: 'A model is being tuned.' }]);
  const other = await serve(t, { modelManager: refuse(409, 'internal words') });
  r = await ask(other.base, { model: 'm' });
  assert.deepEqual([r.status, await r.json()], [409, { error: 'The model is busy. Try again shortly.' }]);
  r = await ask(other.base, {});
  assert.equal(r.status, 400);
});

test('a caller that goes away while queued aborts the wait and holds nothing', async (t) => {
  let left = 0, aborted = false, released = 0;
  let granted;
  const modelManager = {
    enterInference: () => () => { left++; },
    acquireLease: (m, { signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { aborted = true; });
      granted = () => resolve({ headers: () => ({}), release: async () => { released++; } });
    }),
  };
  const { base, routes } = await serve(t, { modelManager });
  const controller = new AbortController();
  const pending = ask(base, { model: 'm' }, undefined, PREFIX, 'POST', controller.signal).catch(() => 'gone');
  await settled();
  controller.abort();
  assert.equal(await pending, 'gone');
  await settled();
  assert.equal(aborted, true, 'the wait saw the caller go');
  granted();
  await settled();
  assert.equal(routes.leases.size(), 0, 'a late grant is no lease');
  assert.equal(released, 1, 'and the gate gets its lease back');
  assert.equal(left, 1);
});
