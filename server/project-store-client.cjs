'use strict';
// sbstndalton/noevia#1264 (option 2 of the lead's 2026-10-16 decision): with
// NOEVIA_RUST_PROJECT_STORE=1 Node no longer writes projects.json or free-chats.json itself and no
// longer takes their flock with a blocking spawnSync(flock). Each save reads the file and its
// version from the Rust front's internal store (noevia-rs bins/noevia-server src/project_store.rs:
// 127.0.0.1:NOEVIA_PROJECT_STORE_PORT, secret NOEVIA_PROJECT_STORE_TOKEN), merges this process's
// changes into it exactly as before (rust-projects.cjs merge / mergeFreeChats), and asks Rust to
// write the result only if the file is still at that version (compare-and-swap). A 409 hands back
// the current file and the merge runs again, at most MAX_ATTEMPTS times. Rust writes atomically
// under the same lock its own routes take, so it is the single writer of both files.
//
// Everything here is async (fetch with a timeout): nothing blocks the event loop. The switch is
// read with the supervisor's confirmation (NOEVIA_RUST_PROJECT_STORE_CONFIRMED=1, once the front
// lists `project-store`), over the confirmed projects and free-chat slices; off, Node keeps the
// withFileLock path, unchanged.

const MAX_ATTEMPTS = 8;
const TIMEOUT_MS = 10000;
const REPLY_CAP = 2 * 32 * 1024 * 1024 + 64 * 1024;
const FILES = new Set(['projects.json', 'free-chats.json']);

/** Whether Node saves through the Rust store (see the header). */
function enabledFrom(env = process.env, warn = console.warn) {
  if (env.NOEVIA_RUST_PROJECT_STORE !== '1') return false;
  const rp = require('./rust-projects.cjs');
  if (!rp.freeChatsEnabledFrom(env, warn)) {
    warn('NOEVIA_RUST_PROJECT_STORE=1 is ignored: it needs the confirmed NOEVIA_RUST_PROJECTS projects and free-chat slices.');
    return false;
  }
  if (env.NOEVIA_RUST_PROJECT_STORE_CONFIRMED !== '1') {
    warn('NOEVIA_RUST_PROJECT_STORE=1 is ignored: the supervisor has not confirmed that the Rust front serves the project store (NOEVIA_RUST_PROJECT_STORE_CONFIRMED).');
    return false;
  }
  const port = Number(env.NOEVIA_PROJECT_STORE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(env.NOEVIA_PROJECT_STORE_TOKEN || '').length < 32) {
    warn('NOEVIA_RUST_PROJECT_STORE=1 is ignored: NOEVIA_PROJECT_STORE_PORT or NOEVIA_PROJECT_STORE_TOKEN is missing.');
    return false;
  }
  return true;
}

function busy() {
  return Object.assign(new Error('The project store is busy. Try again shortly.'), { status: 503, code: 'PROJECTS_BUSY' });
}

/** The store's answer as the error Node's own path would have thrown. */
function failure(status, body) {
  if (status === 503 && body && body.code === 'PROJECTS_BUSY') return busy();
  if (status === 410) return Object.assign(new Error('account no longer exists'), { status: 410 });
  return Object.assign(new Error(`project store answered ${status}${body && body.error ? `: ${String(body.error).slice(0, 200)}` : ''}`), { status: 500, code: 'PROJECT_STORE_FAILED' });
}

function createClient({ port, token, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS }) {
  async function call(op, payload) {
    let res;
    try {
      res = await fetchImpl(`http://127.0.0.1:${port}/v1/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-noevia-store-token': token },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Unreachable or too slow: as a store that could not be locked in time.
      throw Object.assign(busy(), { cause: err });
    }
    let body = null;
    // #920: bounded, like every reply read: the store's text limit (32 MiB), JSON-escaped, plus the envelope.
    try { body = await require('./http.cjs').readCappedJson(res, REPLY_CAP); } catch { /* empty, non-JSON or over the cap */ }
    return { status: res.status, body };
  }
  return {
    /** { version, text } (text null: no file). */
    async read(user, file) {
      if (!FILES.has(file)) throw new Error(`not a store file: ${file}`);
      const { status, body } = await call('read', { user, file });
      if (status !== 200 || !body || typeof body.version !== 'string') throw failure(status, body);
      return { version: body.version, text: typeof body.text === 'string' ? body.text : null };
    },
    /** { ok: true, version } or { conflict: true, version, text }. */
    async write(user, file, version, text) {
      if (!FILES.has(file)) throw new Error(`not a store file: ${file}`);
      const { status, body } = await call('write', { user, file, version, text });
      if (status === 200 && body && typeof body.version === 'string') return { ok: true, version: body.version };
      if (status === 409 && body && typeof body.version === 'string') return { conflict: true, version: body.version, text: typeof body.text === 'string' ? body.text : null };
      throw failure(status, body);
    },
  };
}

/** The client from the supervisor's environment (enabledFrom held), and the secret taken out of
 *  `env` at once (#1916), so no child process, error report or env dump can carry it on. */
function clientFromEnv(env = process.env, options = {}) {
  const token = String(env.NOEVIA_PROJECT_STORE_TOKEN || '');
  delete env.NOEVIA_PROJECT_STORE_TOKEN;
  return createClient({ port: Number(env.NOEVIA_PROJECT_STORE_PORT), token, ...options });
}

/** One workspace's saves, run one at a time in the order they were asked for (a chat's move saves
 *  the free list before the project, #1410), each file's not-yet-started save shared by the
 *  callers that ask again meanwhile (it saves the latest state). `pending()`: a promise for every
 *  save asked so far, or null when idle. */
function createQueue() {
  let tail = Promise.resolve();
  let inFlight = 0;
  const waiting = new Map();
  return {
    run(key, task) {
      if (waiting.has(key)) return waiting.get(key);
      inFlight += 1;
      // Counted down before the save's own promise settles, so a caller that awaited it never
      // sees it still in flight (a request-start refresh would be skipped).
      const p = tail.then(async () => { waiting.delete(key); try { return await task(); } finally { inFlight -= 1; } });
      waiting.set(key, p);
      tail = p.catch(() => {});
      return p;
    },
    pending() { return inFlight > 0 ? tail : null; },
  };
}

/** The answer a save failure gave on the synchronous path (http.cjs saveFailureReply): 503
 *  PROJECTS_BUSY with Retry-After: 1, 410 account no longer exists, anything else 500. */
function failureReply(err) {
  const status = Number.isInteger(err?.status) && err.status >= 401 && err.status <= 599 ? err.status : 500;
  if (status === 500) return { status, headers: {}, body: { error: 'Internal error' } };
  const body = { error: String(err.message || 'Request failed') };
  if (err.code) body.code = err.code;
  return { status, headers: status === 503 ? { 'Retry-After': '1' } : {}, body };
}

/** #1264: a response is held until the store saves its request caused (`saves`, filled by
 *  workspace.cjs onStoreSave) are written, so the next request reads its writes, and a save that
 *  fails replaces the answer with the error the synchronous path gave. Only a buffered answer
 *  (writeHead, then end) is held; one that streams (write()) is sent as it goes, and its saves'
 *  failures are logged, as for a background writer. */
function holdForStoreSaves(res, saves) {
  const writeHead = res.writeHead, write = res.write, end = res.end;
  let head = null, streaming = false, ended = false;
  const flushHead = () => { if (head) { const h = head; head = null; writeHead.apply(res, h); } };
  res.writeHead = function heldWriteHead(...args) {
    if (ended) return this;
    if (streaming) return writeHead.apply(this, args);
    head = args;
    return this;
  };
  res.write = function heldWrite(...args) { streaming = true; flushHead(); return write.apply(this, args); };
  res.end = function heldEnd(...args) {
    if (ended) return this;
    ended = true;
    if (streaming || saves.length === 0) { flushHead(); return end.apply(this, args); }
    Promise.all(saves).then(() => { flushHead(); end.apply(res, args); }, (err) => {
      head = null;
      const f = failureReply(err);
      // The security headers set before the route stay; what described the held body goes.
      for (const name of ['content-length', 'content-disposition', 'content-encoding', 'etag', 'location', 'set-cookie']) if (res.hasHeader?.(name)) res.removeHeader(name);
      writeHead.call(res, f.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...f.headers });
      end.call(res, JSON.stringify(f.body));
    });
    return this;
  };
}

module.exports = { enabledFrom, createClient, clientFromEnv, createQueue, busy, failureReply, holdForStoreSaves, MAX_ATTEMPTS, TIMEOUT_MS };
