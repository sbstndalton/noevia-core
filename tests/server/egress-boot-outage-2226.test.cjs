'use strict';
// #2226: the real server (server/index.cjs) starts and serves with native egress configured and nothing listening.
// An outage refuses network grants only, and the egress status says so; web used to exit here and rely on its restart
// policy. A bad profile still stops the boot (code-egress.cjs), which is a configuration error and not an outage.
// Synthetic data only. Needs better-sqlite3 and server/wasm/dav-parse.wasm, as the other booted-server tests do.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');
const { startProjectStore } = require('./project-store-server.cjs');
const davParseWasm = require('../../server/dav-parse-wasm.cjs');

const serverRequire = require('node:module').createRequire(path.join(__dirname, '..', '..', 'server', 'package.json'));
const noSqlite = (() => { try { serverRequire.resolve('better-sqlite3'); return false; } catch { return 'better-sqlite3 not installed here'; } })();
const skip = noSqlite || (!fs.existsSync(process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse wasm not built here');
const SERVER = path.join(__dirname, '..', '..', 'server', 'index.cjs');

// The worker's network guard refuses ports this process did not open; a clean helper process asks instead.
const CLIENT = `require('node:http').get(process.argv[1],{agent:false,timeout:4000},(r)=>{let t='';r.on('data',(c)=>t+=c);r.on('end',()=>process.stdout.write(t));}).on('error',()=>process.exit(2));`;
const ask = (url) => new Promise((resolve) => execFile(process.execPath, ['-e', CLIENT, url], { env: { PATH: process.env.PATH }, timeout: 8000 }, (err, out) => resolve(err ? '' : out)));
const freePort = () => new Promise((resolve) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

test('web becomes ready with native egress down, and reports the outage', { skip }, async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'egress-boot-')));
  const dataDir = path.join(root, 'data'), keyDir = path.join(root, 'key');
  fs.mkdirSync(dataDir); fs.mkdirSync(keyDir);
  const uid = process.getuid(), gid = process.getgid() || 1; fs.chownSync(keyDir, uid, gid); fs.chmodSync(keyDir, 0o750);
  const store = await startProjectStore(dataDir), port = await freePort(), egressPort = await freePort();
  const child = spawn(process.execPath, [SERVER], { cwd: path.dirname(SERVER), stdio: ['ignore', 'pipe', 'pipe'], env: {
    PATH: process.env.PATH, NODE_ENV: 'production', TZ: 'UTC', LANG: 'C.UTF-8',
    UI_PORT: String(port), UI_HOST: '127.0.0.1', UI_DATA_DIR: dataDir, PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    INFERENCE_BASE_URL: 'http://127.0.0.1:1', DIARY_BASE_URL: 'http://127.0.0.1:1', MODEL_LOADER_URL: '', MCP_SERVERS: '', COWORK_DECISION_URL: '', COWORK_SYSTEM_ONE_URL: '', MODEL_MANAGER_KIND: 'none',
    NOEVIA_PROJECT_STORE_PORT: String(store.port), NOEVIA_PROJECT_STORE_TOKEN: store.token, NOEVIA_START_ID: require('node:crypto').randomBytes(16).toString('hex'),
    CODE_EGRESS_PORT: String(egressPort), CODE_EGRESS_IMPL: 'rust', CODE_EGRESS_RUST_HOST: '127.0.0.1', CODE_EGRESS_CONTROL_KEY_FILE: path.join(keyDir, 'current.key'), CODE_EGRESS_KEY_UID: String(uid), CODE_EGRESS_KEY_GID: String(gid),
    ...(process.env.DAV_PARSE_WASM ? { DAV_PARSE_WASM: process.env.DAV_PARSE_WASM } : {}),
  } });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(async () => {
    child.kill('SIGTERM'); await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
    await store.close?.(); fs.rmSync(root, { recursive: true, force: true });
  });
  const started = Date.now();
  for (;;) {
    assert.equal(child.exitCode, null, `the server must not exit on an egress outage:\n${log.slice(-1500)}`);
    assert.ok(Date.now() - started < 60000, `not ready in 60 s:\n${log.slice(-1500)}`);
    if ((await ask(`http://127.0.0.1:${port}/api/ready`)).includes('"ready":true') && log.includes('egress.control_unavailable')) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(!log.includes('egress.control_ready'), 'nothing is listening, so nothing can have proved Ready');
  assert.equal(fs.statSync(path.join(keyDir, 'current.key')).mode & 0o7777, 0o440, 'the key is published for the proxy to find when it arrives');
});
