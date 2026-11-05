'use strict';
// Row A: POST /api/models/load and /unload are the Rust front's. A public request that reaches Core is refused
// before any engine step, the front's invalidation drops the shared model reads, and the recorded Node oracle
// (tests/fixtures/model-load-node.v1.json) stays the frozen contract the front replays.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { LOAD_MARKER, PATH, ROUTE_REFUSAL, owned, refuseOwned, createInvalidateBridge } = require('./rust-model-load.cjs');

const SECRET = 'synthetic-front-secret-0123456789';
const parseRequestUrl = (req) => { try { return new URL(req.url, 'http://x'); } catch { return null; } };

function exchange() {
  const sent = [];
  return { sent, json: (_res, status, body) => sent.push({ status, body }) };
}
function request(method, url, headers = {}, remote = '127.0.0.1') {
  const req = new EventEmitter();
  Object.assign(req, { method, url, headers, socket: { remoteAddress: remote } });
  return req;
}

test('the public load and unload POSTs are refused with 503 and the owned code; other methods and paths pass', () => {
  for (const p of ['/api/models/load', '/api/models/unload']) {
    const x = exchange();
    assert.equal(refuseOwned(request('POST', p), {}, { parseRequestUrl, json: x.json }), true);
    assert.deepEqual(x.sent, [{ status: 503, body: ROUTE_REFUSAL }]);
    assert.equal(refuseOwned(request('GET', p), {}, { parseRequestUrl, json: x.json }), false);
  }
  assert.equal(owned('POST', '/api/models/delete'), false);
  assert.equal(owned('POST', '/api/models/load/'), false);
  assert.equal(LOAD_MARKER, 'noevia-model-load-owner/1');
});

test('the invalidation drops the scan cache and the shared reads, for the trusted front only', async () => {
  const counts = { scan: 0, reads: 0 };
  const service = { modelScanCache: { clear: () => { counts.scan++; } }, invalidateModelReads: () => { counts.reads++; } };
  const bridge = createInvalidateBridge({ secret: SECRET, json: exchange().json, readJson: async () => ({}), service });
  const x = exchange();
  const ok = createInvalidateBridge({ secret: SECRET, json: x.json, readJson: async () => ({}), service });
  assert.equal(await ok(request('POST', PATH, { 'x-noevia-store-token': SECRET }), {}), true);
  assert.deepEqual(x.sent, [{ status: 200, body: { ok: true } }]);
  assert.deepEqual(counts, { scan: 1, reads: 1 });
  for (const [req] of [
    [request('POST', PATH, {})],
    [request('POST', PATH, { 'x-noevia-store-token': 'wrong' })],
    [request('GET', PATH, { 'x-noevia-store-token': SECRET })],
    [request('POST', PATH, { 'x-noevia-store-token': SECRET, 'x-forwarded-for': '1.2.3.4' })],
  ]) {
    const y = exchange();
    const b = createInvalidateBridge({ secret: SECRET, json: y.json, readJson: async () => ({}), service });
    assert.equal(await b(req, {}), true);
    assert.equal(y.sent[0].status, 404);
  }
  const z = exchange();
  const bad = createInvalidateBridge({ secret: SECRET, json: z.json, readJson: async () => ({ extra: 1 }), service });
  assert.equal(await bad(request('POST', PATH, { 'x-noevia-store-token': SECRET }), {}), true);
  assert.equal(z.sent[0].status, 400);
  assert.deepEqual(counts, { scan: 1, reads: 1 }, 'only the trusted, well-formed ask invalidates');
  assert.equal(await bridge(request('POST', '/internal/other'), {}), false);
});

test('the recorded Node oracle is intact and covers every outcome class the front replays', () => {
  const file = path.join(__dirname, '..', 'tests', 'fixtures', 'model-load-node.v1.json');
  const oracle = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(oracle.version, 1);
  assert.equal(oracle.core, '088d880');
  assert.match(oracle.node, /^v22\./);
  const names = new Set(oracle.scenarios.map((s) => s.name));
  assert.equal(names.size, oracle.scenarios.length);
  assert.equal(oracle.scenarios.length, 41);
  const statuses = new Set(oracle.scenarios.map((s) => s.expect.status));
  for (const s of [200, 400, 403, 404, 409, 500, 502, 503]) assert.ok(statuses.has(s), `status ${s}`);
  for (const s of oracle.scenarios.filter((x) => x.acquire)) assert.ok(s.lease && Number.isInteger(s.lease.status), s.name);
});

test('the admission lease refusal now carries the gate\'s retryable flag the public load answer needs', async () => {
  const { createAdmissionRoutes } = require('./inference-admission-lease.cjs');
  const { GateError } = require('./inference-gate-client.cjs');
  const x = exchange();
  const routes = createAdmissionRoutes({
    authority: { current: () => ({ epoch: "e".repeat(32), incarnation: 1 }) },
    secret: SECRET, json: x.json, readJson: async () => ({ model: 'm' }),
    modelManager: { enterInference: () => () => {}, acquireLease: async () => { throw new GateError({ code: 'inference_queue_full', status: 503, retryable: true, message: 'Synthetic queue full.' }); } },
  });
  const res = new EventEmitter(); res.writableEnded = false; res.destroy = () => {};
  await routes.handle(request('PUT', '/internal/inference-admission/lease/' + 'a'.repeat(32), { 'x-noevia-store-token': SECRET, 'x-noevia-admission-epoch': 'e'.repeat(32), 'x-noevia-admission-incarnation': '1' }), res);
  assert.deepEqual(x.sent, [{ status: 503, body: { error: 'Synthetic queue full.', code: 'inference_queue_full', retryable: true } }]);
});
