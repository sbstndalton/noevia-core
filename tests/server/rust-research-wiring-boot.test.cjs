'use strict';
// #2218 (review H1): the real server (server/index.cjs) hands the Rust front's lease route and research bridge the
// secret the supervisor gave it. index.cjs once read process.env.NOEVIA_PROJECT_STORE_TOKEN after clientFromEnv had
// deleted it, so both were built with an empty secret and answered every call, including the front's own, with the
// 404 of an unknown path. The unit tests pass a secret in by hand, so only a booted server shows it.
// One synthetic server (a fake llama.cpp router, a Diary that answers 503, the stand-in project store), then the
// front's own loopback calls with and without the token. Self-contained on purpose: the web image build runs tests/
// without tools/. Synthetic data only. Needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM) and better-sqlite3;
// skipped without them unless DAV_PARSE_WASM_REQUIRED=1 (CI sets it).
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
const EXPECTED_RAN = 5;

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

async function boot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-wiring-'));
  const dataDir = path.join(root, 'data'), modelsDir = path.join(root, 'models');
  fs.mkdirSync(dataDir); fs.mkdirSync(modelsDir);
  fs.writeFileSync(path.join(modelsDir, 'q.gguf'), gguf(HEADER));
  const ini = path.join(root, 'models.ini');
  fs.writeFileSync(ini, 'version = 1\n\n[small]\nmodel = /models/q.gguf\nctx-size = 4096\ncache-ram = 0\n');
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
    NOEVIA_START_ID: require('node:crypto').randomBytes(16).toString('hex'),
    ...(process.env.DAV_PARSE_WASM ? { DAV_PARSE_WASM: process.env.DAV_PARSE_WASM } : {}),
    ...(process.env.DAV_PARSE_WASM_REQUIRED ? { DAV_PARSE_WASM_REQUIRED: process.env.DAV_PARSE_WASM_REQUIRED } : {}),
  };
  const child = spawn(process.execPath, [SERVER], { env, cwd: SERVER_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [], started = Date.now();
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
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
    assert.equal(child.exitCode, null, `the server must not exit during boot:\n${log.join('').slice(-1500)}`);
    assert.ok(Date.now() - started < 60000, `the server did not become ready in 60 s; last poll: ${last}\n${log.join('').slice(-1500)}`);
    try {
      const r = await request(base, 'GET', '/api/ready');
      last = `${base} ${r.status} ${r.text.slice(0, 200)}`;
      if (r.status === 200 && JSON.parse(r.text).ready) break;
    } catch (e) { last = `${base} ${e?.name}: ${e?.message} ${e?.code || ''}`; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const { seedAccount } = require('./seed-account.cjs');
  const admin = seedAccount(dataDir, { username: 'synthetic-admin', publicOrigin: base });
  // The front's own call: a direct loopback request with the store token (nothing proxied, so no client address header).
  const front = async (p, body, { token = store.token, method = 'POST', headers = {} } = {}) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const res = await request(base, method, p, { headers: { ...(token === null ? {} : { 'x-noevia-store-token': token }), ...headers, ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }) }, body: payload });
    let json = null; try { json = JSON.parse(res.text); } catch { /* not JSON */ }
    return { status: res.status, json, text: res.text };
  };
  return { front, token: store.token, userId: admin.id, running: () => child.exitCode === null, log: () => log.join('') };
}

test('a booted server answers the front\'s lease and research bridge calls, and still refuses everyone else', { skip: skipWasm }, async (t) => {
  const s = await boot(t);
  ran++;
  assert.ok(s.running());
  assert.ok(s.token.length >= 16, 'the stand-in store gave the server a real token');

  // The front, with the token: the bridge answers (a 404 here is the empty-secret failure of H1).
  const avail = await s.front('/internal/research/availability', { user: s.userId });
  ran++;
  assert.equal(avail.status, 200, `${avail.text.slice(0, 300)}\n${s.log().slice(-800)}`);
  assert.ok('reason' in avail.json && 'lastLoaded' in avail.json, avail.text);
  assert.match(avail.json.reason, /web-search toolbox/, 'no search tools in this synthetic server, said plainly');

  // The lease route: the front's token gets past the check (this ask is invalid, so 400/409/503, never the 404).
  const lease = await s.front('/internal/inference-admission/lease', { not: 'a lease ask' });
  ran++;
  assert.notEqual(lease.status, 404, `${lease.text.slice(0, 300)}\n${s.log().slice(-800)}`);
  assert.notEqual(lease.json?.error, 'Not found');
  const tool = await s.front('/internal/research/tool', { user: s.userId, name: 'not_a_search_tool', args: {} });
  ran++;
  assert.equal(tool.status, 400, 'past the check, the bridge refuses any tool but the two search ones');

  // Everyone else: no token, a wrong token, a proxied request, or the secret as another header.
  for (const [what, opts] of [['no token', { token: null }], ['a wrong token', { token: `${s.token}x` }], ['an empty token', { token: '' }],
    ['a forwarded request', { headers: { 'x-forwarded-for': '203.0.113.9' } }], ['a client-address header', { headers: { 'x-noevia-client-ip': '203.0.113.9' } }]]) {
    const a = await s.front('/internal/research/availability', { user: s.userId }, opts);
    const b = await s.front('/internal/inference-admission/lease', { not: 'a lease ask' }, opts);
    assert.equal(a.status, 404, `${what}: bridge`);
    assert.equal(b.status, 404, `${what}: lease`);
  }
  ran++;
  assert.ok(s.running());
});
