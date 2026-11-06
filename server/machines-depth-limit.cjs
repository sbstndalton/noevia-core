'use strict';
// Stable reference-route probes for floating CI. Exact stack measurements live only in
// deploy/tools/qualify-machines-depth.sh, inside an immutable Linux image.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const nest = (n, leaf) => '['.repeat(n) + leaf + ']'.repeat(n);

async function probe(ctx, depth) {
  const { createInferenceMachines } = require('../tests/reference/inference-machines.node.cjs');
  const { createInferenceMachineRoutes, PATH } = require('../tests/reference/inference-machines-route.node.cjs');
  const raw = '{"action":"add","name":' + nest(depth, '"x"') + ',"address":"192.168.1.2"}';
  const rows = new Map();
  const machines = createInferenceMachines({ store: { get: k => rows.get(k), set: (k, v) => rows.set(k, v) }, audit() {}, log() {} });
  const ctxArg = { path: PATH, authn: { user: { id: 'synthetic', role: 'admin' } }, url: new URL('http://local' + PATH) };
  let sink = {};
  const json = (res, status, body) => { sink = { status, name: body.machine?.name, error: body.error }; if (res.end) { res.statusCode = status; res.end('{}'); } };
  const report = (extra) => process.stdout.write(JSON.stringify({ ctx, depth, ...extra }) + '\n');
  if (ctx === 'bare') {
    await null;
    try { report({ ok: String(JSON.parse(nest(depth, '"x"'))) === 'x' }); } catch { report({ ok: false }); }
  } else if (ctx === 'route') {
    const route = createInferenceMachineRoutes({ json, readJson: async () => JSON.parse(raw), machines, health: {} });
    await route({ method: 'POST' }, { setHeader() {} }, ctxArg);
    report({ ok: sink.status === 201 && sink.name === 'x' && rows.size === 1, status: sink.status, error: sink.error, writes: rows.size });
  } else {
    const http = require('node:http');
    const { readJson } = require('./http.cjs');
    const route = createInferenceMachineRoutes({ json, readJson, machines, health: {} });
    const server = http.createServer((req, res) => { route(req, res, ctxArg).catch(() => { res.statusCode = 500; res.end('{}'); }); });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    await new Promise((resolve, reject) => { const rq = http.request({ port: server.address().port, host: '127.0.0.1', method: 'POST', path: PATH, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => { res.resume(); res.on('end', resolve); }); rq.on('error', reject); rq.end(raw); });
    server.close();
    report({ ok: sink.status === 201 && sink.name === 'x' && rows.size === 1, status: sink.status, error: sink.error, writes: rows.size });
  }
}

function runProbe(ctx, depth) {
  const r = spawnSync(process.execPath, [__filename, 'probe', ctx, String(depth)], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
  const line = (r.stdout || '').trim().split('\n').filter(Boolean).pop();
  if (!line) throw new Error(`probe ${ctx} ${depth} produced no result (status ${r.status})`);
  return JSON.parse(line);
}

module.exports = { runProbe };
if (require.main === module && process.argv[2] === 'probe') {
  probe(process.argv[3], Number(process.argv[4])).catch(e => {
    process.stdout.write(JSON.stringify({ ok: false, err: e.constructor.name }) + '\n');
  });
}
