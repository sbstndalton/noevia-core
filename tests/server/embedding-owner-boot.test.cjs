'use strict';
// The real server (server/index.cjs) boots paired with the Rust front that owns the embedding background
// (rust-embedding-background.cjs createOwner) and answers that owner's trusted route. index.cjs once handed
// createOwner process.env after clientFromEnv had deleted NOEVIA_PROJECT_STORE_TOKEN from it (#1916), so every
// real boot exited 1 ("Embedding background requires a coherent paired front and current start") and the route's
// secret was empty. The unit tests build the owner by hand, so only a booted server shows it.
// Synthetic only: a stand-in front binary that answers `--features` with the embedding capability, a fake
// llama.cpp router, a Diary that answers 503 and the stand-in project store. Needs server/wasm/dav-parse.wasm
// (or DAV_PARSE_WASM) and better-sqlite3; skipped without them unless DAV_PARSE_WASM_REQUIRED=1 (CI sets it).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http'), crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { startProjectStore, syntheticFrontBin } = require('./project-store-server.cjs');
const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const { PROTOCOL } = require('../../server/rust-embedding-background.cjs');

const serverRequire = require('node:module').createRequire(path.join(__dirname, '..', '..', 'server', 'package.json'));
const noSqlite = (() => { try { serverRequire.resolve('better-sqlite3'); return false; } catch { return 'better-sqlite3 not installed here'; } })();
const skipWasm = noSqlite || (!fs.existsSync(process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built');
const SERVER = path.join(__dirname, '..', '..', 'server', 'index.cjs');
const OWNER_ROUTE = '/internal/embedding-worker-owner';

// A fake llama.cpp router with no models; it only keeps the manager's boot calls answered.
function fakeRouter() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const p = new URL(req.url, 'http://router').pathname;
      res.writeHead(p.startsWith('/gate/') ? 404 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(p === '/models' ? { data: [] } : {}));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
function fakeDiary() {
  const server = http.createServer((req, res) => { req.resume(); res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"detail":"synthetic diary"}'); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// One loopback request from a short-lived helper process: tests/hermetic-network.cjs refuses connections to ports
// this process did not open, and the booted server is a child process.
const CLIENT = `const http = require('node:http');
const [base, method, p, headers] = process.argv.slice(1);
const req = http.request(base + p, { method, headers: JSON.parse(headers), agent: false, timeout: 30000 }, (res) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => process.stdout.write(JSON.stringify({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') })));
});
req.on('timeout', () => req.destroy(new Error('request timed out')));
req.on('error', (e) => { process.stderr.write(String(e.code || e.message)); process.exit(2); });
req.end();`;
function request(base, method, p, headers = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['-e', CLIENT, base, method, p, JSON.stringify(headers)], { env: { PATH: process.env.PATH }, timeout: 40000 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(stderr || err.message), { code: stderr || err.code }));
      else resolve(JSON.parse(stdout));
    });
  });
}

async function boot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'embedding-owner-boot-'));
  const dataDir = path.join(root, 'data'), modelsDir = path.join(root, 'models');
  fs.mkdirSync(dataDir); fs.mkdirSync(modelsDir);
  const ini = path.join(root, 'models.ini');
  fs.writeFileSync(ini, 'version = 1\n');
  // The paired front as the supervisor installs it: `noevia-server --features` lists the embedding capability.
  const front = syntheticFrontBin(root);
  const router = await fakeRouter(), diary = await fakeDiary(), store = await startProjectStore(dataDir);
  const port = await new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const base = `http://127.0.0.1:${port}`;
  const start = crypto.randomBytes(16).toString('hex');
  const env = {
    PATH: process.env.PATH, NODE_ENV: 'production', TZ: 'UTC', LANG: 'C.UTF-8',
    UI_PORT: String(port), UI_HOST: '127.0.0.1', UI_DATA_DIR: dataDir, PUBLIC_ORIGIN: base,
    INFERENCE_BASE_URL: `http://127.0.0.1:${router.port}`, DIARY_BASE_URL: `http://127.0.0.1:${diary.port}`,
    MODEL_LOADER_URL: '', MCP_SERVERS: '', COWORK_DECISION_URL: '', COWORK_SYSTEM_ONE_URL: '', DIARY_BACKUP_WORKER_INTERVAL_MS: '3600000',
    MODEL_MANAGER_KIND: 'llamacpp', MODEL_MANAGER_BASE_URL: `http://127.0.0.1:${router.port}`,
    LLAMACPP_PRESET_PATH: ini, LLAMACPP_MODELS_PATH: modelsDir,
    NOEVIA_SERVER_BIN: front, NOEVIA_PROJECT_STORE_PORT: String(store.port), NOEVIA_PROJECT_STORE_TOKEN: store.token, NOEVIA_START_ID: start,
    ...(process.env.DAV_PARSE_WASM ? { DAV_PARSE_WASM: process.env.DAV_PARSE_WASM } : {}),
    ...(process.env.DAV_PARSE_WASM_REQUIRED ? { DAV_PARSE_WASM_REQUIRED: process.env.DAV_PARSE_WASM_REQUIRED } : {}),
  };
  const child = spawn(process.execPath, [SERVER], { env, cwd: path.dirname(SERVER), stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [], started = Date.now();
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    router.server.close(); diary.server.close(); await store.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  });
  let last = 'no request made';
  for (;;) {
    assert.equal(child.exitCode, null, `the server must not exit during boot:\n${log.join('').slice(-1500)}`);
    assert.ok(Date.now() - started < 60000, `the server did not become ready in 60 s; last poll: ${last}\n${log.join('').slice(-1500)}`);
    try {
      const r = await request(base, 'GET', '/api/ready');
      last = `${r.status} ${r.text.slice(0, 200)}`;
      if (r.status === 200 && JSON.parse(r.text).ready) break;
    } catch (e) { last = `${e?.message} ${e?.code || ''}`; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { base, token: store.token, start, running: () => child.exitCode === null, log: () => log.join('') };
}

test('a paired real boot becomes ready and its embedding owner trusts only the front\'s token', { skip: skipWasm }, async (t) => {
  const s = await boot(t);
  assert.ok(s.running());
  const owned = await request(s.base, 'GET', OWNER_ROUTE, { 'x-noevia-store-token': s.token });
  assert.equal(owned.status, 200, `${owned.text.slice(0, 300)}\n${s.log().slice(-800)}`);
  assert.deepEqual(JSON.parse(owned.text), { protocol: PROTOCOL, start: s.start, nodeWorkersStopped: true });
  for (const [what, headers] of [['no token', {}], ['a wrong token', { 'x-noevia-store-token': `${s.token}x` }], ['an empty token', { 'x-noevia-store-token': '' }],
    ['a forwarded request', { 'x-noevia-store-token': s.token, 'x-forwarded-for': '203.0.113.9' }]]) {
    const r = await request(s.base, 'GET', OWNER_ROUTE, headers);
    assert.equal(r.status, 404, what);
  }
  assert.ok(s.running());
});
