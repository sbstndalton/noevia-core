'use strict';
// #697 native move (rust-budget-watch.cjs): the differential oracle for the Rust front's watchdog. Core's real
// watch (inference-budget-watch.cjs) runs here wired exactly as index.cjs wired it before the move: the real
// llama.cpp manager (listModels, emergencyUnload, quarantine), the real fetchJson, the real sysfs and
// model-manager readers. Synthetic HTTP servers stand in for the router and the model manager, and two temp
// files for the GPU counters; no engine and no model is ever involved. Every tick's answer, the requests it
// made, the quarantine hand-offs and the log lines are compared against tests/fixtures/budget-watch-node.v1.json,
// which noevia-rs replays against its native watch (bins/noevia-server/tests/budget_watch.rs).
//
// NOEVIA_REGEN_BUDGET_WATCH_FIXTURE=1 rewrites the fixture from this module's behaviour.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createInferenceBudgetWatch, gpuMemoryFiles, readGpuMemory, engineReaderFromModelLoader, loadedFromListing } = require('./inference-budget-watch.cjs');
const { createModelManager } = require('./model-manager.cjs');
const { fetchJson } = require('./http.cjs');

const FIXTURE = path.join(__dirname, '..', 'tests', 'fixtures', 'budget-watch-node.v1.json');
const GIB = 1024 ** 3;
const bytes = (gib) => String(Math.round(gib * GIB));
const listing = (rows) => ({ status: 200, body: { data: rows.map(([id, value]) => ({ id, status: { value } })) } });
const llama = (container, shared = 0, vram = 0, extra = {}) => ({ name: 'cowork-llama-1', stats: { ok: true, container: { mem_used_gb: container + 4, mem_anon_gb: container }, gpu: { shared_used_gb: shared, vram_used_gb: vram } }, ...extra });
const backends = (...list) => ({ status: 200, body: { backends: list } });
const NONE = backends();
const CHAT = listing([['chat', 'loaded'], ['embed', 'unloaded']]);
const IDLE = listing([['chat', 'unloaded']]);

// A step is one tick; unset fields keep the previous step's values.
const STEP0 = { advanceMs: 0, budget: 12, held: false, gtt: bytes(0), vram: bytes(0), backends: NONE, listing: CHAT, unload: {} };

const SCENARIOS = [
  { name: 'two strikes over the overshoot unload the model and log numbers only', steps: [
    { gtt: bytes(12), vram: bytes(0.5), backends: backends(llama(1.5)) }, {}, {} ] },
  { name: 'a single spike resets the strikes', steps: [
    { gtt: bytes(20) }, { gtt: bytes(4) }, { gtt: bytes(20) }, { gtt: bytes(12.5) } ] },
  { name: 'the cooldown is waited out while the strikes go on counting', steps: [
    { gtt: bytes(20) }, {}, {}, {}, { advanceMs: 30000 }, { advanceMs: 31000 } ] },
  { name: 'a zero overshoot unloads just over the budget', env: { INFERENCE_BUDGET_OVERSHOOT_PCT: '0' }, steps: [
    { gtt: bytes(12.5) }, {} ] },
  { name: 'an overshoot over 100 percent is capped at double the budget', env: { INFERENCE_BUDGET_OVERSHOOT_PCT: '250' }, steps: [
    { gtt: bytes(23.9) }, {}, { gtt: bytes(24.1) }, {} ] },
  { name: 'nothing measurable resets the strikes', steps: [
    { gtt: bytes(20) }, { gtt: null, backends: { status: 500, body: { error: 'down' } } }, { gtt: bytes(20), backends: NONE }, {} ] },
  { name: 'an idle baseline from an empty listing is not charged', steps: [
    { listing: IDLE, gtt: bytes(1.5), vram: bytes(0.5) }, { listing: CHAT, gtt: bytes(14) }, { gtt: bytes(15) }, {} ] },
  { name: 'an unknown listing skips the tick, keeps the strikes and takes no baseline', steps: [
    { gtt: bytes(13), vram: bytes(0.5) },
    { listing: { status: 503, body: { error: 'busy' } }, gtt: bytes(0.1), vram: bytes(0) },
    { listing: { status: 200, body: { models: [] } } },
    { listing: { status: 200, text: 'not json' } },
    { listing: { drop: true } },
    { listing: { status: 200, body: { data: [null] } } },
    { listing: CHAT, gtt: bytes(13), vram: bytes(0.5) } ] },
  { name: 'no idle baseline while the maintenance gate is held', steps: [
    { listing: IDLE, held: true, gtt: bytes(11) }, { held: false, gtt: bytes(1) }, { listing: CHAT, gtt: bytes(14) } ] },
  { name: 'no budget reads nothing', steps: [
    { budget: 0, gtt: bytes(30) }, { budget: -3 }, { budget: 12 }, {} ] },
  { name: 'engine telemetry alone counts the main engine container as anonymous memory', steps: [
    { gtt: null, backends: backends(llama(3.5, 9, 0.4), { name: 'cowork-embed-1', stats: { ok: true, container: { mem_anon_gb: 0.8 }, gpu: null } }, { name: 'cowork-llama-2', stats: { ok: false } }) },
    { backends: backends({ name: 'llama', stats: { ok: true, container: { mem_used_gb: '6.2' }, gpu: { shared_used_gb: '7', vram_used_gb: null } } }) },
    {} ] },
  { name: 'a configured engine container is the one counted', env: { INFERENCE_ENGINE_CONTAINER: ' cowork-embed-1 , other ' }, steps: [
    { gtt: bytes(1), backends: backends(llama(30), { name: 'cowork-embed-1', stats: { ok: true, container: { mem_anon_gb: 12 } } }) }, {}, {} ] },
  { name: 'without the model manager only the device is read', noLoader: true, steps: [
    { gtt: bytes(14), backends: backends(llama(30)) }, {} ] },
  { name: 'nothing loaded means nothing to unload', steps: [
    { listing: IDLE, gtt: bytes(30) }, {}, {} ] },
  { name: 'loading rows count, failures are not quarantined and an unsettled unload counts as done', steps: [
    { gtt: bytes(20), listing: listing([['chat', 'loaded'], ['vision', 'loading'], ['lost', 'loaded'], ['gone', 'unloaded'], ['odd', 'sleeping']]),
      unload: { vision: { status: 409, body: { error: { type: 'gate_error', code: 'model_in_use' } } }, lost: { drop: true } } },
    {} ] },
  { name: 'with the gate admin token the unload is forced', admin: true, steps: [
    { gtt: bytes(20), listing: listing([['chat', 'loaded'], ['vision', 'loading']]), unload: { vision: { status: 500, text: 'oops' } } }, {} ] },
  { name: 'the GPU counters are summed and a bad vram counter is skipped', steps: [
    { gtt: ` ${bytes(10)}\n`, vram: 'nan' }, { gtt: bytes(14), vram: '-5' }, {} ] },
];

function reply(res, req, spec) {
  if (!spec) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); return; }
  if (spec.drop) { req.socket.destroy(); return; }
  res.writeHead(spec.status, { 'content-type': 'application/json' });
  res.end(spec.text !== undefined ? spec.text : JSON.stringify(spec.body));
}

function server(handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => handler(req, res, raw));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

async function run(scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-watch-oracle-'));
  const gttFile = path.join(dir, 'mem_info_gtt_used'), vramFile = path.join(dir, 'mem_info_vram_used');
  fs.writeFileSync(gttFile, '0'); fs.writeFileSync(vramFile, '0');
  let cur = { ...STEP0 };
  let requests = [], unloads = [];
  const router = await server((req, res, raw) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p.startsWith('/gate/')) return reply(res, req, null);
    requests.push(`${req.method} ${p}`);
    if (req.method === 'GET' && p === '/models') return reply(res, req, cur.listing);
    if (req.method === 'POST' && p === '/models/unload') {
      let body = null; try { body = JSON.parse(raw); } catch {}
      unloads.push({ body, admin: req.headers['x-noevia-gate-admin'] || null, authorization: req.headers.authorization || null });
      return reply(res, req, cur.unload[body?.model] || { status: 200, body: { success: true } });
    }
    return reply(res, req, null);
  });
  const loader = await server((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    requests.push(`${req.method} ${p} token=${req.headers['x-model-loader-token'] || ''}`);
    if (req.method === 'GET' && p === '/api/v1/backends') return reply(res, req, cur.backends);
    return reply(res, req, null);
  });
  try {
    const env = { INFERENCE_GTT_USED_PATH: gttFile, ...(scenario.noLoader ? {} : { MODEL_LOADER_URL: `http://127.0.0.1:${loader.address().port}/`, MODEL_LOADER_TOKEN: 'synthetic-loader-token' }), ...(scenario.env || {}) };
    const manager = createModelManager({ kind: 'llamacpp', baseUrl: `http://127.0.0.1:${router.address().port}/v1`, apiKey: 'synthetic-key', fetchJson, gateAdminToken: scenario.admin ? 'synthetic-admin' : null });
    const files = gpuMemoryFiles(env);
    let clock = 1000, quarantined = [], logs = [];
    // index.cjs before the move, line for line (budgetGib and baselineAllowed read the step).
    const watch = createInferenceBudgetWatch({
      env,
      budgetGib: () => cur.budget,
      readGpu: () => readGpuMemory(files),
      readEngine: engineReaderFromModelLoader({ env, fetchJson }),
      listLoaded: async () => loadedFromListing(await manager.listModels()),
      unload: (model) => manager.emergencyUnload(model),
      onUnloaded: (model, budgetGib) => { quarantined.push([model, budgetGib]); manager.quarantine?.(model, budgetGib); },
      baselineAllowed: () => !cur.held,
      log: (line) => logs.push(line),
      now: () => clock,
    });
    const steps = [], expect = [];
    for (const delta of scenario.steps) {
      cur = { ...cur, ...delta };
      steps.push({ ...cur });
      clock += cur.advanceMs;
      if (cur.gtt === null) fs.rmSync(gttFile, { force: true }); else fs.writeFileSync(gttFile, cur.gtt);
      if (cur.vram === null) fs.rmSync(vramFile, { force: true }); else fs.writeFileSync(vramFile, cur.vram);
      requests = []; unloads = []; quarantined = []; logs = [];
      const result = await watch.tick();
      expect.push({ result, requests: [...requests].sort(), unloads, quarantined, log: logs });
      cur = { ...cur, advanceMs: 0 };
    }
    return { name: scenario.name, env: scenario.env || {}, admin: scenario.admin === true, noLoader: scenario.noLoader === true, steps, expect };
  } finally {
    router.close(); loader.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('#697 the native watchdog fixture is what Core\'s real watch does, tick for tick', async () => {
  const actual = { version: 1, source: 'server/inference-budget-watch.cjs via inference-budget-watch-oracle.test.cjs', gib: GIB, scenarios: [] };
  for (const s of SCENARIOS) actual.scenarios.push(await run(s));
  if (process.env.NOEVIA_REGEN_BUDGET_WATCH_FIXTURE === '1') fs.writeFileSync(FIXTURE, JSON.stringify(actual, null, 2) + '\n');
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(fixture, actual);
});

test('#697 the fixture covers every state, both unload forms, the quarantine and the log line', () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const ticks = fixture.scenarios.flatMap((s) => s.expect);
  for (const state of ['no-budget', 'unavailable', 'models-unknown', 'ok', 'over', 'unloaded']) {
    assert.ok(ticks.some((t) => t.result?.state === state), state);
  }
  assert.ok(ticks.some((t) => t.unloads.some((u) => u.admin === 'synthetic-admin' && u.body.force === true)));
  assert.ok(ticks.some((t) => t.unloads.some((u) => u.admin === null && !('force' in u.body))));
  assert.ok(ticks.some((t) => t.quarantined.length > 0));
  assert.ok(ticks.some((t) => t.log.length === 1 && t.log[0].startsWith('[inference-budget] {"event":"unload"')));
});
