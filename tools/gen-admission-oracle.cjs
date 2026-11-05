#!/usr/bin/env node
'use strict';
// Port contract row H: records the pre-port Node admission decisions (Core 3521cdc2's own lease route, which issued
// and timed the leases itself) over the synthetic schedules of admission-oracle-scenarios.cjs into
// tests/fixtures/inference-admission-node.v1.json. Run once at that base with Node 22:
//   node tools/gen-admission-oracle.cjs <path to the pre-port server/inference-admission-lease.cjs> > tests/fixtures/inference-admission-node.v1.json
const http = require('node:http');
const path = require('node:path');
const { holds, SCENARIOS, TTL_MS, drive } = require('./admission-oracle-scenarios.cjs');
const { json, readJson } = require('../server/http.cjs');

const SECRET = 's'.repeat(40);
const lease = require(path.resolve(process.argv[2] || path.join(__dirname, '../server/inference-admission-lease.cjs')));

async function run(scenario) {
  const log = [];
  const { options, open } = holds(scenario.spec, log);
  const routes = lease.createAdmissionRoutes({ secret: SECRET, json, readJson, ttlMs: TTL_MS, log: () => {}, ...options });
  const server = http.createServer(async (req, res) => { if (!await routes.handle(req, res)) { res.statusCode = 418; res.end(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}${lease.PREFIX}`;
  const call = async (url, method, body, signal) => {
    const r = await fetch(url, { method, signal, headers: { 'content-type': 'application/json', 'x-noevia-store-token': SECRET }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  };
  const client = {
    acquire: (body, signal) => call(base, 'POST', body, signal),
    renew: (id) => call(`${base}/${id}/renew`, 'POST'),
    release: (id) => call(`${base}/${id}`, 'DELETE'),
  };
  const steps = await drive(scenario, client, open);
  await new Promise((r) => setTimeout(r, 30));
  server.closeAllConnections();
  server.close();
  return { name: scenario.name, steps, holds: log, open: routes.leases.size() };
}

(async () => {
  const scenarios = [];
  for (const s of SCENARIOS) scenarios.push(await run(s));
  process.stdout.write(JSON.stringify({ version: 1, recordedFrom: 'core 3521cdc2 server/inference-admission-lease.cjs', node: process.version, ttlMs: TTL_MS, scenarios }, null, 1) + '\n');
})().catch((e) => { console.error(e); process.exit(1); });
