'use strict';
// #223: the real server (server/index.cjs) boots when an autoconfig evaluator path faults, logs the boot-time
// fault once, and the routes that need the evaluator refuse per request (never permit) while everything
// unrelated keeps working. Four runs of the same synthetic server, differing only in the injected fault:
//   none          control: the normal path
//   memory-limit  parseMemoryLimit throws (the boot-time read in index.cjs)
//   ctx-candidates the CTX_CANDIDATES getter throws (read on first use by calibration)
//   evaluator     every evaluator call faults (davParseWasm.llamacppAutoconfig)
// The fault is injected by a --require preload in the child only. Loopback mocks, a fake llama.cpp router and
// the stand-in project store; net-guard.cjs refuses every other outbound connection. Synthetic data only.
// Needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it unless DAV_PARSE_WASM_REQUIRED=1.
// Each guarded step counts ran++ and test.after asserts the total.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { SERVER, GUARD, startMocks, serverEnv } = require('../../tools/contract-corpus/mocks.cjs');
const { seedAccount } = require('./seed-account.cjs');
const { startProjectStore } = require('./project-store-server.cjs');
const davParseWasm = require('../../server/dav-parse-wasm.cjs');

const skipWasm = !fs.existsSync(process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const SERVER_DIR = path.dirname(SERVER);
const BOOT_FAULT = /could not be evaluated at startup/;
const EXPECTED_RAN = 28;

let ran = 0;
test.after(() => { assert.equal(ran, skipWasm ? 0 : EXPECTED_RAN, 'every guarded step must have run'); });

function gguf(kv) {
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const str = (s) => { const b = Buffer.from(s); return Buffer.concat([u64(b.length), b]); };
  const val = (type, v) => (type === 4 ? u32(v) : str(v));
  return Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(Object.keys(kv).length), ...Object.entries(kv).map(([k, [t, v]]) => Buffer.concat([str(k), u32(t), val(t, v)]))]);
}
const HEADER = { 'general.architecture': [8, 'llama'], 'llama.context_length': [4, 8192], 'llama.embedding_length': [4, 4096], 'llama.block_count': [4, 32], 'llama.attention.head_count': [4, 32], 'llama.attention.head_count_kv': [4, 8], 'tokenizer.chat_template': [8, '{{ messages }}'] };

const PRELOAD = `'use strict';
const path = require('node:path');
const dir = process.env.SERVER_DIR_223, mode = process.env.FAULT_223;
const autoconfig = require(path.join(dir, 'llamacpp-autoconfig.cjs'));
const define = (name, descriptor) => Object.defineProperty(autoconfig, name, { configurable: true, enumerable: true, ...descriptor });
if (mode === 'memory-limit') define('parseMemoryLimit', { writable: true, value() { throw new autoconfig.AutoconfigImplError('parseMemoryLimit'); } });
if (mode === 'ctx-candidates') define('CTX_CANDIDATES', { get() { throw new autoconfig.AutoconfigImplError('CTX_CANDIDATES'); } });
if (mode === 'evaluator') {
  const wasm = require(path.join(dir, 'dav-parse-wasm.cjs'));
  wasm.llamacppAutoconfig = () => { throw new wasm.DavParseError('synthetic evaluator fault', 'trap'); };
}
`;

// A fake llama.cpp router: one model, loads and unloads on request. `calls` is what it was asked.
function fakeRouter() {
  const state = { small: 'unloaded' }, calls = [];
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://router').pathname;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      calls.push(`${req.method} ${p}`);
      if (p === '/models/load') state.small = 'loaded';
      if (p === '/models/unload') state.small = 'unloaded';
      const body = p === '/models' ? { data: [{ id: 'small', status: { value: state.small }, meta: { n_ctx_train: 8192 } }] } : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port })));
}

async function boot(t, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `lazy-223-${mode}-`));
  const dataDir = path.join(root, 'data'), modelsDir = path.join(root, 'models');
  fs.mkdirSync(dataDir); fs.mkdirSync(modelsDir);
  fs.writeFileSync(path.join(modelsDir, 'q.gguf'), gguf(HEADER));
  const ini = path.join(root, 'models.ini');
  fs.writeFileSync(ini, 'version = 1\n\n[small]\nmodel = /models/q.gguf\nctx-size = 4096\ncache-ram = 0\n');
  const preload = path.join(root, 'fault-preload.cjs');
  fs.writeFileSync(preload, PRELOAD);
  const mocks = await startMocks(), router = await fakeRouter(), store = await startProjectStore(dataDir);
  const port = await new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  const env = {
    ...serverEnv({ port, dataDir, origin: base, mocks }),
    MODEL_MANAGER_KIND: 'llamacpp', MODEL_MANAGER_BASE_URL: `http://127.0.0.1:${router.port}`,
    LLAMACPP_PRESET_PATH: ini, LLAMACPP_MODELS_PATH: modelsDir,
    NOEVIA_PROJECT_STORE_PORT: String(store.port), NOEVIA_PROJECT_STORE_TOKEN: store.token,
    FAULT_223: mode, SERVER_DIR_223: SERVER_DIR,
    ...(process.env.DAV_PARSE_WASM ? { DAV_PARSE_WASM: process.env.DAV_PARSE_WASM } : {}),
    ...(process.env.DAV_PARSE_WASM_REQUIRED ? { DAV_PARSE_WASM_REQUIRED: process.env.DAV_PARSE_WASM_REQUIRED } : {}),
  };
  env.NOEVIA_CORPUS_ALLOWED_PORTS = `${env.NOEVIA_CORPUS_ALLOWED_PORTS},${store.port},${router.port}`;
  const child = spawn(process.execPath, ['--require', GUARD, '--require', preload, SERVER], { env, cwd: SERVER_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    mocks.close(); router.server.close(); await store.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (let i = 0; ; i += 1) {
    assert.equal(child.exitCode, null, `the server must not exit during boot (${mode}):\n${log.join('').slice(-1500)}`);
    assert.ok(i < 150, `the server did not become ready in 30 s (${mode}):\n${log.join('').slice(-1500)}`);
    try { const r = await fetch(`${base}/api/ready`); if (r.ok && (await r.json()).ready) break; } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const admin = seedAccount(dataDir, { username: 'synthetic-admin', publicOrigin: base });
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { ...admin.headers(base), accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
  };
  return { call, router, log: () => log.join(''), bootFaults: () => log.join('').split('\n').filter((l) => BOOT_FAULT.test(l)).length, running: () => child.exitCode === null };
}

async function stopCalibration(s) {
  await s.call('POST', '/api/models/calibration/cancel', {});
  for (let i = 0; i < 200; i++) {
    const r = await s.call('GET', '/api/models/calibration?model=small');
    if (r.json?.job?.status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('the cancelled calibration did not stop');
}

// What each fault path must do to each request. `refused` means the evaluator-backed answer is withheld.
const EXPECT = {
  none: { bootFaults: 0, estimate: 200, suggest: 'values', calibration: 202, load: 200 },
  'memory-limit': { bootFaults: 1, estimate: 200, suggest: 'values', calibration: 202, load: 200 },
  'ctx-candidates': { bootFaults: 0, estimate: 200, suggest: 'values', calibration: 503, load: 200 },
  evaluator: { bootFaults: 1, estimate: 503, suggest: 'refused', calibration: 503, load: 502 },
};

for (const mode of Object.keys(EXPECT)) {
  test(`boot (${mode}): the server starts, logs a boot-time fault once, and each dependent route answers as designed`, { skip: skipWasm }, async (t) => {
    const want = EXPECT[mode];
    const s = await boot(t, mode);
    ran++;
    assert.ok(s.running(), 'the server is up');
    assert.equal(s.bootFaults(), want.bootFaults, s.log().slice(-1500));
    if (want.bootFaults) assert.match(s.log(), /Autoconfig: the container memory limit \(LLAMACPP_MEMORY_LIMIT\) could not be evaluated at startup/);

    // Unrelated routes keep working under every fault.
    const health = await s.call('GET', '/api/health');
    ran++;
    assert.equal(health.status, 200);
    const budget = await s.call('GET', '/api/models/inference-budget');
    ran++;
    assert.equal(budget.status, 200, budget.text.slice(0, 300));
    assert.ok(budget.json.budgetGib > 0 || budget.json.budget?.budgetGib > 0 || JSON.stringify(budget.json).includes('budgetGib'), budget.text.slice(0, 300));

    // The Will-it-fit panel.
    const estimate = await s.call('GET', '/api/models/estimate?model=small');
    ran++;
    assert.equal(estimate.status, want.estimate, estimate.text.slice(0, 300));
    if (want.estimate === 503) { assert.equal(estimate.json.code, 'autoconfig_impl'); assert.match(estimate.json.error, /^Estimate unavailable: /); }
    else assert.ok(estimate.json.budgetGib > 0);

    // The size-based suggestion: settings, or a refusal that carries none. Never settings from a fault.
    const suggest = await s.call('GET', '/api/models/preset/suggest?model=small');
    ran++;
    assert.equal(suggest.status, 200, suggest.text.slice(0, 300));
    if (want.suggest === 'values') assert.ok(suggest.json.values, suggest.text.slice(0, 300));
    else { assert.equal(suggest.json.values, undefined); assert.equal(suggest.json.code, 'autoconfig_impl'); }

    // Calibration: accepted on the normal path; refused with the autoconfig_impl 503 when the ladder cannot be read.
    s.router.calls.length = 0;
    const calibration = await s.call('POST', '/api/models/calibration', { model: 'small', confirmPause: true, promptBudgetSeconds: 30 });
    ran++;
    assert.equal(calibration.status, want.calibration, calibration.text.slice(0, 300));
    if (want.calibration === 503) {
      assert.equal(calibration.json.code, 'autoconfig_impl'); assert.match(calibration.json.error, /^Calibration is unavailable: /);
      assert.ok(!s.router.calls.some((c) => c === 'POST /models/load'), 'a refused calibration never asks the router to load');
    } else await stopCalibration(s);

    // A load: permitted by the normal evaluator, refused (and never sent to the router) when it faults.
    s.router.calls.length = 0;
    const load = await s.call('POST', '/api/models/load', { name: 'small' });
    ran++;
    assert.equal(load.status, want.load, load.text.slice(0, 300));
    if (want.load === 502) assert.ok(!s.router.calls.includes('POST /models/load'), `a faulted evaluator never permits a load:\n${s.router.calls.join('\n')}`);
    else assert.ok(s.router.calls.includes('POST /models/load'), s.router.calls.join('\n'));
    assert.ok(s.running(), 'the server is still up after the requests');
  });
}
