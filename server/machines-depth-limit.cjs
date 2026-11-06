'use strict';
// How deep an array can be nested in a machine name before the Node reference route fails.
//
// `String(body.name)` recurses once per array level, so V8's stack budget decides: a RangeError
// ("Maximum call stack size exceeded") is caught by the route and answered 500 "The inference
// machines could not be changed." with nothing saved. The budget depends on the call context and
// on the architecture's frame sizes, so it is measured, never assumed, and every probe runs in a
// fresh process with the default flags (what `node server/index.cjs` gets in the web image):
//
//   route  the reference route called directly           (JSON.parse in an async readJson)
//   http   the same behind a real node:http request        (JSON.parse in the 'end' callback)
//   bare   String(JSON.parse(text)) in a fresh async callback: the shallowest call stack there is
//
// Linux x64, Node v22.23.3, V8 12.4 (the cowork-web image, measured 2026-11-05):
//   route 3141, http 3085, bare 3142; every context throws at 3143.
// The native route accepts up to ARRAY_NESTING_LIMIT (the most permissive context), so it refuses
// only where every Node context throws. arm64 (a Mac) measures 2520..2626 with the same code.
//
//   node server/machines-depth-limit.cjs            prints the measured limits as JSON
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ARRAY_NESTING_LIMIT = 3142;
const MEASURED_LINUX_X64 = { route: 3141, http: 3085, bare: 3142 };
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
    const readJson = req => new Promise((resolve, reject) => { const c = []; req.on('data', d => c.push(d)); req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { reject(e); } }); req.on('error', reject); });
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

/** Largest depth (searched in [lo, hi)) at which the context still saves the request. */
function maxPass(ctx, lo = 1000, hi = 8000) {
  if (!runProbe(ctx, lo).ok) throw new Error(`${ctx} fails at ${lo}`);
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (runProbe(ctx, mid).ok) lo = mid; else hi = mid; }
  return lo;
}
const measure = () => ({ route: maxPass('route'), http: maxPass('http'), bare: maxPass('bare') });

module.exports = { ARRAY_NESTING_LIMIT, MEASURED_LINUX_X64, measure, maxPass, runProbe };
if (require.main === module) {
  if (process.argv[2] === 'probe') probe(process.argv[3], Number(process.argv[4])).catch(e => { process.stdout.write(JSON.stringify({ ok: false, err: e.constructor.name }) + '\n'); });
  else process.stdout.write(JSON.stringify({ node: process.version, arch: process.arch, platform: process.platform, ...measure() }) + '\n');
}
