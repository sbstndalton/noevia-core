'use strict';
// Test support for sbstndalton/noevia#1071: the Rust front's project store (noevia-rs
// bins/noevia-server src/project_store.rs, crates/server-projects store_api.rs) as a loopback HTTP
// stand-in, for tests and tools that run server/index.cjs without the front. Node writes
// projects.json and free-chats.json only through that store and refuses to start without one, so
// every such run needs it. Same protocol and answers as the Rust store:
//
//   POST /v1/read  { user, file }                  -> 200 { version, text|null }
//   POST /v1/write { user, file, version, text }   -> 200 { version } | 409 { version, text }
//   header x-noevia-store-token (else 401); a missing user directory is 410 (never created);
//   the version is the SHA-256 hex of the file's bytes, '' for a missing file.
//
// No file locking (one Node process per data dir in a test). Synthetic data only.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const FILES = new Set(['projects.json', 'free-chats.json']);
const USER = /^[0-9a-f-]{36}$/i;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function snapshot(file) {
  try { const bytes = fs.readFileSync(file); return { version: sha(bytes), text: bytes.toString('utf8') }; }
  catch (e) { if (e.code === 'ENOENT') return { version: '', text: null }; throw e; }
}

function valid(file, text) {
  let v;
  try { v = JSON.parse(text); } catch { return 'text is not JSON'; }
  if (file === 'projects.json') return v && typeof v === 'object' && Array.isArray(v.projects) ? null : 'projects.json must be { "projects": [...] }';
  return Array.isArray(v) ? null : 'free-chats.json must be a list';
}

/** The request handler over `<dataDir>/users/<user>/<file>`; `writes` lists the files written. */
function createHandler(dataDir, token, writes = []) {
  return (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        if (req.method !== 'POST' || !['/v1/read', '/v1/write'].includes(req.url)) return send(res, 404, { error: 'not found' });
        if (req.headers['x-noevia-store-token'] !== token) return send(res, 401, { error: 'unauthorised' });
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        if (!body || typeof body.user !== 'string') return send(res, 400, { error: 'user required' });
        if (!FILES.has(body.file)) return send(res, 400, { error: 'file must be projects.json or free-chats.json' });
        if (!USER.test(body.user)) return send(res, 400, { error: 'invalid user' });
        const dir = path.join(dataDir, 'users', body.user);
        if (!fs.existsSync(dir)) return send(res, 410, { error: 'account no longer exists' });
        const file = path.join(dir, body.file);
        if (req.url === '/v1/read') return send(res, 200, snapshot(file));
        if (typeof body.version !== 'string' || typeof body.text !== 'string') return send(res, 400, { error: 'version and text required' });
        const why = valid(body.file, body.text);
        if (why) return send(res, 400, { error: why });
        const now = snapshot(file);
        if (now.version !== body.version) return send(res, 409, now);
        const tmp = `${file}.store-stub.tmp`;
        fs.writeFileSync(tmp, body.text, { mode: 0o600 });
        fs.renameSync(tmp, file);
        writes.push(body.file);
        return send(res, 200, { version: sha(Buffer.from(body.text, 'utf8')) });
      } catch {
        return send(res, 500, { error: 'Internal error' });
      }
    });
  };
}

/** Starts the store on 127.0.0.1 (port 0 by default); resolves { port, token, server, writes, close }. */
async function startProjectStore(dataDir, { port = 0, token = crypto.randomBytes(32).toString('hex') } = {}) {
  const writes = [];
  const server = http.createServer(createHandler(dataDir, token, writes));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { port: server.address().port, token, server, writes, close: () => new Promise((r) => server.close(() => r())) };
}

/** A free loopback port, found synchronously (a child binds port 0 and reports it). */
function freePortSync() {
  const r = spawnSync(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();})"], { encoding: 'utf8', timeout: 10000 });
  const port = Number(r.stdout);
  if (!Number.isInteger(port) || port < 1) throw new Error(`could not find a free port for the project store: ${r.stderr || r.status}`);
  return port;
}

/** For tests that load server/index.cjs in-process: sets NOEVIA_PROJECT_STORE_PORT and
 *  NOEVIA_PROJECT_STORE_TOKEN in `env` now (index.cjs reads them when it loads, and takes the
 *  secret out of the environment) and starts the store on that port, unref'd so it never keeps
 *  the test process alive. Call it before requiring index.cjs. */
function installProjectStore(dataDir, env = process.env) {
  const port = freePortSync();
  const token = crypto.randomBytes(32).toString('hex');
  env.NOEVIA_PROJECT_STORE_PORT = String(port);
  env.NOEVIA_PROJECT_STORE_TOKEN = token;
  const writes = [];
  const server = http.createServer(createHandler(dataDir, token, writes));
  server.on('error', (e) => { console.error(`project store stand-in on ${port}: ${e.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1');
  server.unref();
  return { port, writes, server };
}

module.exports = { startProjectStore, installProjectStore, createHandler, freePortSync };
