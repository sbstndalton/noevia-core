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
// and a chat's transcript (sbstndalton/noevia#1071 slice 4; noevia-rs crates/server-projects
// transcript.rs), `chat` reduced to [A-Za-z0-9_-], the revision sha256 hex of JSON.stringify(history):
//
//   POST /v1/history/read  { user, chat }                 -> 200 { history, revision, exists }
//   POST /v1/history/write { user, chat, history, baseRevision?, ifAbsent?, supersedePartial? }
//        -> 200 { revision } | 409 { history, revision, exists, proposedRevision }
//         | 410 { error, code: 'CHAT_DELETED' } (tombstoned)
//   POST /v1/history/append-if-last { user, chat, message, entry } -> 200 { outcome, revision? }
//   POST /v1/history/remove-if { user, chat, history }    -> 200 { removed }
//
// What is written is the last 5,000 entries through core's own sanitizeHistory, as the Rust store
// does; a client save (`supersedePartial`) removes the chat's saved partial unless its running
// marker names this process's start (chat-partial.cjs START_ID).
//
// `failNext(status, body, { url, times })` makes the next request(s) answer that status and body
// instead (default: the next /v1/write, once), e.g. 503 { code: 'PROJECTS_BUSY' } as the real store
// does when its lock times out. No file locking, no 32 MB cap (one Node process per data dir in a
// test). Synthetic data only.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const FILES = new Set(['projects.json', 'free-chats.json']);
const HISTORY_OPS = new Set(['/v1/history/read', '/v1/history/write', '/v1/history/append-if-last', '/v1/history/remove-if']);
const HISTORY_CAP = 5000;
const server = (m) => require(path.join(__dirname, '..', '..', 'server', m));
const revisionOf = (history) => sha(JSON.stringify(history));
let tmpSeq = 0;

/** The transcript ops (see the header) for a user directory that exists. */
function historyOp(url, body, dir) {
  const chat = typeof body.chat === 'string' ? body.chat.replace(/[^a-zA-Z0-9_-]/g, '') : '';
  if (!chat) return [400, { error: typeof body.chat === 'string' ? 'invalid chat id' : 'user and chat required' }];
  const file = path.join(dir, `history-${chat}.json`);
  const parsed = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; } };
  const current = () => {
    const v = parsed();
    const history = (v && typeof v === 'object' && !Array.isArray(v) ? v.history : undefined) || [];
    return { history, revision: revisionOf(history), exists: fs.existsSync(file) };
  };
  const tombstoned = () => server('chat-lists.cjs').readTombstones(dir).has(chat);
  const bounded = (list) => server('chat-sources.cjs').sanitizeHistory(list.slice(-HISTORY_CAP));
  const write = (next) => {
    const tmp = `${file}.${process.pid}.${tmpSeq++}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ history: next }, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  };
  if (url === '/v1/history/read') return [200, current()];
  if (url === '/v1/history/append-if-last') {
    if (typeof body.message !== 'string' || !body.entry || typeof body.entry !== 'object' || Array.isArray(body.entry)) return [400, { error: 'message and entry required' }];
    if (tombstoned()) return [200, { outcome: 'deleted' }];
    const history = parsed()?.history;
    if (!Array.isArray(history)) return [200, { outcome: 'no-user-message' }];
    const last = history[history.length - 1];
    if (!last || last.role !== 'user' || last.content !== body.message) return [200, { outcome: 'not-last' }];
    const next = bounded([...history, body.entry]);
    write(next);
    return [200, { outcome: 'saved', revision: revisionOf(next) }];
  }
  if (!Array.isArray(body.history)) return [400, { error: 'history must be a list' }];
  let next;
  try { next = bounded(body.history); } catch { return [400, { error: 'invalid history' }]; }
  const proposed = revisionOf(next);
  if (url === '/v1/history/remove-if') {
    const now = current();
    if (!now.exists || now.revision !== proposed) return [200, { removed: false }];
    fs.rmSync(file, { force: true });
    return [200, { removed: true }];
  }
  if (tombstoned()) return [410, { error: 'This chat was deleted.', code: 'CHAT_DELETED' }];
  const now = current();
  const holds = typeof body.baseRevision === 'string' ? body.baseRevision === now.revision : body.ifAbsent === true ? !now.exists : true;
  if (!holds) return [409, { ...now, proposedRevision: proposed }];
  write(next);
  if (body.supersedePartial === true) {
    const partial = server('chat-partial.cjs');
    const saved = partial.readPartial(dir, chat);
    if (!(saved && saved.running && saved.running.start === partial.START_ID)) fs.rmSync(partial.fileFor(dir, chat), { force: true });
  }
  return [200, { revision: proposed }];
}
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
function createHandler(dataDir, token, writes = [], failures = []) {
  return (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        if (req.method !== 'POST' || !(['/v1/read', '/v1/write'].includes(req.url) || HISTORY_OPS.has(req.url))) return send(res, 404, { error: 'not found' });
        if (req.headers['x-noevia-store-token'] !== token) return send(res, 401, { error: 'unauthorised' });
        const planned = failures.find((f) => f.url === req.url && f.times > 0);
        if (planned) { planned.times -= 1; return send(res, planned.status, planned.body); }
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, { error: 'invalid JSON' }); }
        if (!body || typeof body.user !== 'string') return send(res, 400, { error: 'user required' });
        if (!HISTORY_OPS.has(req.url) && !FILES.has(body.file)) return send(res, 400, { error: 'file must be projects.json or free-chats.json' });
        if (!USER.test(body.user)) return send(res, 400, { error: 'invalid user' });
        const dir = path.join(dataDir, 'users', body.user);
        if (!fs.existsSync(dir)) return send(res, 410, { error: 'account no longer exists' });
        if (HISTORY_OPS.has(req.url)) {
          const [status, answer] = historyOp(req.url, body, dir);
          return send(res, status, answer);
        }
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
  const failures = [];
  const server = http.createServer(createHandler(dataDir, token, writes, failures));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const failNext = (status, body, { url = '/v1/write', times = 1 } = {}) => { failures.push({ status, body, url, times }); };
  const clearFailures = () => { failures.length = 0; };
  return { port: server.address().port, token, server, writes, failNext, clearFailures, close: () => new Promise((r) => server.close(() => r())) };
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
  const failures = [];
  const server = http.createServer(createHandler(dataDir, token, writes, failures));
  const failNext = (status, body, { url = '/v1/write', times = 1 } = {}) => { failures.push({ status, body, url, times }); };
  server.on('error', (e) => { console.error(`project store stand-in on ${port}: ${e.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1');
  server.unref();
  return { port, writes, server, failNext };
}

/** For unit tests that hand a workspace its `transcripts` directly (workspace.cjs gets them from
 *  project-store-client.cjs transcriptsFor): the same ops over `dir` in process, answered as that
 *  client answers them. `calls` records each op. */
function localTranscripts(dir, calls = []) {
  const run = (url, body) => {
    calls.push({ url, body });
    if (!fs.existsSync(dir)) throw Object.assign(new Error('account no longer exists'), { status: 410 });
    const [status, answer] = historyOp(url, body, dir);
    if (status === 400) throw Object.assign(new Error(answer.error), { status: 400 });
    return { status, answer };
  };
  return {
    calls,
    read: async (chat) => run('/v1/history/read', { chat }).answer,
    write: async (chat, history, { baseRevision, ifAbsent = false, supersedePartial = false } = {}) => {
      const { status, answer } = run('/v1/history/write', { chat, history, baseRevision, ifAbsent, supersedePartial });
      if (status === 200) return { ok: true, revision: answer.revision };
      if (status === 409) return { conflict: true, ...answer };
      return { deleted: true };
    },
    appendIfLast: async (chat, message, entry) => run('/v1/history/append-if-last', { chat, message, entry }).answer.outcome,
    removeIf: async (chat, history) => run('/v1/history/remove-if', { chat, history }).answer.removed,
  };
}

module.exports = { startProjectStore, installProjectStore, createHandler, freePortSync, localTranscripts, historyOp };
