'use strict';
// #223: the real server (server/index.cjs) boots when an autoconfig evaluator path faults, logs the boot-time
// fault once, and the routes that need the evaluator refuse per request (never permit) while everything
// unrelated keeps working. Four runs of the same synthetic server, differing only in the injected fault:
//   none          control: the normal path
//   memory-limit  parseMemoryLimit throws (the boot-time read in index.cjs)
//   ctx-candidates the CTX_CANDIDATES getter throws (read on first use by calibration)
//   evaluator     every evaluator call faults (davParseWasm.llamacppAutoconfig)
// The fault is injected by a --require preload in the child only. The child gets a clean environment with only
// loopback upstreams (a fake llama.cpp router, a Diary that answers 503) and the stand-in project store.
// Self-contained on purpose: the web image build runs tests/ without tools/. Synthetic data only.
// Needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it unless DAV_PARSE_WASM_REQUIRED=1.
// Each guarded step counts ran++ and test.after asserts the total.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');
const { startProjectStore } = require('./project-store-server.cjs');
const davParseWasm = require('../../server/dav-parse-wasm.cjs');

const serverRequire = require('node:module').createRequire(path.join(__dirname, '..', '..', 'server', 'package.json'));
const noSqlite = (() => { try { serverRequire.resolve('better-sqlite3'); return false; } catch { return 'better-sqlite3 not installed here'; } })();
const skipWasm = noSqlite || (!fs.existsSync(process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built');
const SERVER = path.join(__dirname, '..', '..', 'server', 'index.cjs');
const SERVER_DIR = path.dirname(SERVER);
const BOOT_FAULT = /could not be evaluated at startup/;
const EXPECTED_RAN = 32;

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
      // No inference gate in front of this router (noevia#2115): like the router, it answers its endpoints 404.
      if (p.startsWith('/gate/')) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 404, message: 'File Not Found', type: 'not_found_error' } })); return; }
      if (p === '/models/load') state.small = 'loaded';
      if (p === '/models/unload') state.small = 'unloaded';
      const body = p === '/models' ? { data: [{ id: 'small', status: { value: state.small }, meta: { n_ctx_train: 8192 } }] } : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: server.address().port })));
}

// One loopback request, made by a short-lived helper process with a clean environment. The test workers run
// under tests/hermetic-network.cjs, which refuses a connection to any port this process did not open itself;
// the booted server is a child process, so its port is not one of them. The helper is not under that guard.
const CLIENT = `const http = require('node:http');
const [base, method, p, headers, body] = process.argv.slice(1);
const req = http.request(base + p, { method, headers: JSON.parse(headers), agent: false, timeout: 30000 }, (res) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => process.stdout.write(JSON.stringify({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') })));
});
req.on('timeout', () => req.destroy(new Error('request timed out')));
req.on('error', (e) => { process.stderr.write(String(e.code || e.message)); process.exit(2); });
req.end(body || undefined);`;
function request(base, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', CLIENT, base, method, p, JSON.stringify(headers), body ?? ''], { env: { PATH: process.env.PATH }, timeout: 40000, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(stderr || err.message), { code: stderr || err.code }));
      else resolve(JSON.parse(stdout));
    });
  });
}

// Loopback stand-in for the Diary add-on: it only keeps a stray call from hanging.
function fakeDiary() {
  const server = http.createServer((req, res) => { req.resume(); res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"detail":"synthetic diary"}'); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
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
  const router = await fakeRouter(), diary = await fakeDiary(), store = await startProjectStore(dataDir);
  const port = await new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  const env = {
    PATH: process.env.PATH, NODE_ENV: 'production', TZ: 'UTC', LANG: 'C.UTF-8',
    UI_PORT: String(port), UI_HOST: '127.0.0.1', UI_DATA_DIR: dataDir, PUBLIC_ORIGIN: base,
    INFERENCE_BASE_URL: `http://127.0.0.1:${router.port}`, DIARY_BASE_URL: `http://127.0.0.1:${diary.port}`,
    MODEL_LOADER_URL: '', MCP_SERVERS: '', COWORK_DECISION_URL: '', COWORK_SYSTEM_ONE_URL: '', DIARY_BACKUP_WORKER_INTERVAL_MS: '3600000',
    MODEL_MANAGER_KIND: 'llamacpp', MODEL_MANAGER_BASE_URL: `http://127.0.0.1:${router.port}`,
    LLAMACPP_PRESET_PATH: ini, LLAMACPP_MODELS_PATH: modelsDir,
    NOEVIA_PROJECT_STORE_PORT: String(store.port), NOEVIA_PROJECT_STORE_TOKEN: store.token,
    // Core registers its feature runtime with the store under the start id both share before it is ready.
    NOEVIA_START_ID: require('node:crypto').randomBytes(16).toString('hex'),
    FAULT_223: mode, SERVER_DIR_223: SERVER_DIR,
    ...(process.env.DAV_PARSE_WASM ? { DAV_PARSE_WASM: process.env.DAV_PARSE_WASM } : {}),
    ...(process.env.DAV_PARSE_WASM_REQUIRED ? { DAV_PARSE_WASM_REQUIRED: process.env.DAV_PARSE_WASM_REQUIRED } : {}),
  };
  const child = spawn(process.execPath, ['--require', preload, SERVER], { env, cwd: SERVER_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [], started = Date.now();
  const stamp = (d) => String(d).split('\n').filter(Boolean).map((l) => `+${Date.now() - started}ms ${l}`).join('\n') + '\n';
  child.stdout.on('data', (d) => log.push(stamp(d)));
  child.stderr.on('data', (d) => log.push(stamp(d)));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(async () => {
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    router.server.close(); diary.server.close(); await store.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  });
  let last = 'no request made';
  for (;;) {
    assert.equal(child.exitCode, null, `the server must not exit during boot (${mode}):\n${log.join('').slice(-1500)}`);
    assert.ok(Date.now() - started < 60000, `the server did not become ready in 60 s (${mode}); last poll: ${last}\n${log.join('').slice(-1500)}`);
    try {
      const r = await request(base, 'GET', '/api/ready');
      last = `${base} ${r.status} ${r.text.slice(0, 200)}`;
      if (r.status === 200 && JSON.parse(r.text).ready) break;
    } catch (e) { last = `${base} ${e?.name}: ${e?.message} ${e?.code || ''}`; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const { seedAccount } = require('./seed-account.cjs'); // needs better-sqlite3, which the skip above guarantees
  const admin = seedAccount(dataDir, { username: 'synthetic-admin', publicOrigin: base });
  const call = async (method, p, body) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const res = await request(base, method, p, { headers: { ...admin.headers(base), accept: 'application/json', ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }) }, body: payload });
    let json = null; try { json = JSON.parse(res.text); } catch { /* not JSON */ }
    return { status: res.status, json, text: res.text };
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
  none: { bootFaults: 0, calibration: 202, load: 200 },
  'memory-limit': { bootFaults: 1, calibration: 202, load: 200 },
  'ctx-candidates': { bootFaults: 0, calibration: 503, load: 200 },
  evaluator: { bootFaults: 1, calibration: 503, load: 502 },
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
    // (GET /api/health, which this used, is the Rust front's since the #2190 close-out: Node refuses it.)
    const health = await s.call('GET', '/api/chats/search');
    ran++;
    assert.equal(health.status, 200);
    const refusedHealth = await s.call('GET', '/api/health');
    ran++;
    assert.equal(refusedHealth.status, 503);
    assert.equal(refusedHealth.json.code, 'RUST_HEALTH_OWNED');
    const budget = await s.call('GET', '/api/models/inference-budget');
    ran++;
    assert.equal(budget.status, 200, budget.text.slice(0, 300));
    assert.ok(budget.json.budgetGib > 0 || budget.json.budget?.budgetGib > 0 || JSON.stringify(budget.json).includes('budgetGib'), budget.text.slice(0, 300));

    // The Will-it-fit panel and the size-based suggestion are the Rust front's (#2189,
    // bins/noevia-server/tests/model_sizing.rs); Node refuses them under every fault.
    for (const p of ['/api/models/estimate?model=small', '/api/models/preset/suggest?model=small']) {
      const owned = await s.call('GET', p);
      ran++;
      assert.equal(owned.status, 503, owned.text.slice(0, 300));
      assert.equal(owned.json.code, 'RUST_MODEL_SIZING_OWNED');
    }

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
