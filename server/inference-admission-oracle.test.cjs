'use strict';
// Port contract row H: differential replay. tests/fixtures/inference-admission-node.v1.json records what Core's pre-port
// lease route (3521cdc2, which issued and timed leases itself) answered over the synthetic schedules of
// tools/admission-oracle-scenarios.cjs, and in which order it took and gave back each hold. The latch the front's
// authority now drives must answer the same schedules the same way: the same statuses and bodies (the lease is the
// front's ticket now), the same holds in the same order, and nothing left latched.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const test = require('node:test');
const { createAdmissionRoutes, PREFIX } = require('./inference-admission-lease.cjs');
const { json, readJson } = require('./http.cjs');
const { holds, SCENARIOS, TTL_MS, drive } = require('../tools/admission-oracle-scenarios.cjs');
const oracle = require('../tests/fixtures/inference-admission-node.v1.json');

const SECRET = 's'.repeat(40);
const EPOCH = 'e'.repeat(32);

for (const scenario of SCENARIOS) {
  test(`oracle: ${scenario.name}`, async (t) => {
    const recorded = oracle.scenarios.find((s) => s.name === scenario.name);
    assert.ok(recorded, 'recorded at the base');
    const log = [];
    const { options, open } = holds(scenario.spec, log);
    const authority = { current: () => ({ epoch: EPOCH, incarnation: 1 }), onChange: () => {} };
    const routes = createAdmissionRoutes({ secret: SECRET, json, readJson, ttlMs: TTL_MS, log: () => {}, authority, ...options });
    const server = http.createServer(async (req, res) => { if (!await routes.handle(req, res)) { res.statusCode = 418; res.end(); } });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}${PREFIX}`;
    const headers = { 'content-type': 'application/json', 'x-noevia-store-token': SECRET, 'x-noevia-admission-epoch': EPOCH, 'x-noevia-admission-incarnation': '1' };
    const call = async (url, method, body, signal) => {
      const r = await fetch(url, { method, signal, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : null };
    };
    const client = {
      // The front's authority issues the ticket and gives it back when its caller leaves (lib.rs Pending).
      acquire: async (body, signal) => {
        const id = crypto.randomBytes(16).toString('hex');
        signal?.addEventListener('abort', () => { void call(`${base}/${id}`, 'DELETE'); });
        const r = await call(`${base}/${id}`, 'PUT', body, signal);
        if (r.status === 201) assert.equal(r.body.lease, id, 'the latch echoes the ticket');
        return r;
      },
      renew: (id) => call(`${base}/${id}/renew`, 'POST'),
      release: (id) => call(`${base}/${id}`, 'DELETE'),
    };
    const steps = await drive(scenario, client, open);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(steps, recorded.steps);
    assert.deepEqual(log, recorded.holds);
    assert.equal(routes.latches.size(), recorded.open);
  });
}
