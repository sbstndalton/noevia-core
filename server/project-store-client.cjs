'use strict';
// sbstndalton/noevia#1264 (option 2 of the lead's 2026-10-16 decision): Node no longer writes
// projects.json or free-chats.json itself and no longer takes their flock with a blocking
// spawnSync(flock). Each save reads the file and its
// version from the Rust front's internal store (noevia-rs bins/noevia-server src/project_store.rs:
// 127.0.0.1:NOEVIA_PROJECT_STORE_PORT, secret NOEVIA_PROJECT_STORE_TOKEN), merges this process's
// changes into it exactly as before (rust-projects.cjs merge / mergeFreeChats), and asks Rust to
// write the result only if the file is still at that version (compare-and-swap). A 409 hands back
// the current file and the merge runs again, at most MAX_ATTEMPTS times. Rust writes atomically
// under the same lock its own routes take, so it is the single writer of both files.
//
// Everything here is async (fetch with a timeout): nothing blocks the event loop. Permanent: the
// NOEVIA_RUST_PROJECT_STORE switch is retired and not read, and so are NOEVIA_RUST_PROJECTS and the
// supervisor's confirmations (sbstndalton/noevia#1071): the web supervisor always starts a front
// that serves the store and hands both processes its port and a secret made for that start.
// index.cjs refuses to start without them; Node has no other way to save either file.

const MAX_ATTEMPTS = 8;
// sbstndalton/noevia#1071 slice 6 (and #2161's explicit markers): this core deletes chats only
// through the store's chat/delete. noevia deploy/tools/assemble-release.sh pairs it with a front
// whose store carries "noevia-chat-delete-store/1" (and refuses the reverse pairings). Keep the
// quoted literal: the release check reads it from this file.
const CHAT_DELETE_CLIENT_MARKER = 'noevia-chat-delete-client/1';
// Release pairing requires foundation + generation-aware Node enforcement.
const CHAT_MOVE_CLIENT_MARKER = 'noevia-chat-move-client/1';
const RESEARCH_JOBS_CLIENT_MARKER = 'noevia-research-jobs-client/1';
const TIMEOUT_MS = 10000;
// sbstndalton/noevia#2190 round 5: a ChatGPT session may refresh upstream and a model list may
// fetch the catalogue after a refresh (the broker's 15 s each).
const CHATGPT_WAIT_MS = 45000;
const REPLY_CAP = 2 * 32 * 1024 * 1024 + 64 * 1024;
const FILES = new Set(['projects.json', 'free-chats.json']);

/** Whether the environment hands over the Rust store (see the header): its port and secret. */
function enabledFrom(env = process.env, warn = console.warn) {
  const port = Number(env.NOEVIA_PROJECT_STORE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(env.NOEVIA_PROJECT_STORE_TOKEN || '').length < 32) {
    warn('The Rust project store is not configured: NOEVIA_PROJECT_STORE_PORT or NOEVIA_PROJECT_STORE_TOKEN is missing or invalid (the web supervisor sets both).');
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
  async function call(op, payload, wait = timeoutMs) {
    let res;
    try {
      res = await fetchImpl(`http://127.0.0.1:${port}/v1/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-noevia-store-token': token },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(wait),
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
  async function researchCall(op, user, payload) {
    const request = () => call(`research-jobs/${op}`, { user, ...payload });
    const mutating = !['read', 'list', 'recover'].includes(op);
    let response;
    for (let attempt = 0; attempt < (mutating ? 2 : 1); attempt++) {
      try { response = await request(); }
      catch (error) { if (!mutating || attempt) throw error; continue; }
      const { status, body } = response;
      const valid = status === 200 && body && typeof body === 'object'
        && (op !== 'start' || (typeof body.id === 'string' && typeof body.run === 'string'))
        && (op !== 'recover' || Number.isSafeInteger(body.count))
        && (op !== 'list' || Array.isArray(body.jobs))
        && (op !== 'read' || (body.id === payload.id && body.projectId === payload.projectId && body.kind === 'deep_research'))
        && (op !== 'cancel' || (body.id === payload.id && body.projectId === payload.projectId && body.kind === 'deep_research' && ['running', 'completed', 'failed', 'cancelled', 'interrupted'].includes(body.status)))
        && (!['abandon','event','finish','report','prepare','artifact','clear'].includes(op) || body.ok === true);
      if (valid) return body;
      if (mutating && attempt === 0 && (status === 200 || status >= 500)) continue;
      break;
    }
    const { status, body } = response;
    if (status === 404 && op === 'read') return null;
    const message = status === 409 ? (body?.error || 'Research job changed; refresh and retry.')
      : status === 404 ? 'No such research job.'
      : status === 410 ? 'account no longer exists'
      : status === 400 ? 'Invalid research job request.'
      : 'The research job store is unavailable; retry shortly.';
    throw Object.assign(Error(message), { status: [400,404,409,410].includes(status) ? status : 503 });
  }
  // Dedicated bounded context exchange over the existing private store capability. Never
  // reuse the project-file 32 MiB reply cap or export the token back into process.env.
  async function featureContext(body, { timeoutMs = 2500 } = {}) {
    const unavailable = () => Object.assign(new Error('Feature runtime context is unavailable.'), { status: 503, code: 'FEATURE_RUNTIME_CONTEXT_UNAVAILABLE' });
    if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 32768
      || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2500
      || !Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== 'string' || token.length < 32) throw unavailable();
    const abort = new AbortController();
    const deadline = require('node:perf_hooks').performance.now() + timeoutMs;
    let timer, reader, timedOut = false;
    const expired = new Promise((_, reject) => { timer = setTimeout(() => {
      timedOut = true; abort.abort(); reader?.cancel().catch(() => {}); reject(unavailable());
    }, timeoutMs); });
    try {
      const fetched = Promise.resolve().then(() => fetchImpl(`http://127.0.0.1:${port}/v1/features/context`, {
        method: 'POST', redirect: 'error', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-noevia-store-token': token },
        body, signal: abort.signal,
      })).then(response => {
        if (timedOut) { response?.body?.cancel?.().catch(() => {}); throw unavailable(); }
        return response;
      });
      const response = await Promise.race([fetched, expired]);
      if (!response?.body || typeof response.body.getReader !== 'function') throw unavailable();
      reader = response.body.getReader();
      const chunks = []; let size = 0;
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), expired]);
        if (timedOut || require('node:perf_hooks').performance.now() >= deadline) throw unavailable();
        if (done) break;
        size += value.byteLength;
        if (size > 2048) throw unavailable();
        chunks.push(Buffer.from(value));
      }
      if (timedOut || require('node:perf_hooks').performance.now() >= deadline || response.status !== 200 || response.headers.get('cache-control') !== 'no-store') throw unavailable();
      return Buffer.concat(chunks, size).toString('utf8');
    } catch { throw unavailable(); }
    finally {
      clearTimeout(timer); abort.abort();
      if (reader) { reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }
  return {
    featureContext,
    researchJobsFor(user) {
      return {
        recover: (owner) => researchCall('recover', user, owner),
        start: (owner, projectId, request, question, mode, questions) => researchCall('start', user, { ...owner, projectId, request, question, mode, questions }),
        abandon: (owner, request) => researchCall('abandon', user, { ...owner, request }),
        event: (owner, id, run, n, kind, data) => researchCall('event', user, { ...owner, id, run, n, kind, data }),
        cancel: (owner, projectId, id, run) => researchCall('cancel', user, { ...owner, projectId, id, run }),
        finish: (owner, id, run, ok, result, error) => researchCall('finish', user, { ...owner, id, run, ok, result, error }),
        report: (owner, id, run, result) => researchCall('report', user, { ...owner, id, run, result }),
        prepare: (owner, projectId, id, run, name, hash, bytes, target) => researchCall('prepare', user, { ...owner, projectId, id, run, name, hash, bytes, target }),
        artifact: (owner, projectId, id, run, name, hash, bytes) => researchCall('artifact', user, { ...owner, projectId, id, run, name, hash, bytes }),
        clear: (owner, projectId, id, run, name, hash) => researchCall('clear', user, { ...owner, projectId, id, run, name, hash }),
        read: (projectId, id) => researchCall('read', user, { projectId, id }),
        list: (projectId) => researchCall('list', user, { projectId }).then((body) => body.jobs),
      };
    },
    async grantContext(user, chat) {
      const { status, body } = await call('chat/grant-context', { user, chat });
      if (status !== 200) throw moveFailure(status, body);
      return require('./chat-grant-context.cjs').validate(chat, body);
    },
    async chatMove(user, chat, projectId, patch = {}) {
      const payload = { user, chat, projectId };
      if (Object.hasOwn(patch, 'frame')) payload.frame = patch.frame;
      const { status, body } = await call('chat/move', payload);
      const grants = require('./chat-grant-context.cjs');
      const from = grants.holder(body?.from), to = grants.holder(body?.to);
      if (status !== 200) throw moveFailure(status, body);
      if (!from || from.kind === 'absent' || !to || to.kind === 'absent' || !grants.decimal(body?.generation) ||
          !grants.sameHolder(to, projectId === null ? { kind: 'free' } : { kind: 'project', id: projectId })) throw failure(500, null);
      return { status: 200, from: from.kind === 'free' ? null : from.id, generation: body.generation };
    },
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
    // sbstndalton/noevia#1071 slice 4: a chat's transcript (history-<id>.json), which the Rust store
    // alone writes (noevia-rs crates/server-projects transcript). Node never writes the file and has
    // no fallback: an unreachable or refusing store is an error here, never a local write.
    /** { history, revision, exists }. */
    async historyRead(user, chat) {
      const { status, body } = await call('history/read', { user, chat });
      if (status === 200 && body && typeof body.revision === 'string') return { history: body.history, revision: body.revision, exists: body.exists === true };
      throw historyFailure(status, body);
    },
    /** Saves `history` (the store keeps the last 5,000 entries, sanitised) if the transcript is at
     *  `baseRevision` (or absent, `ifAbsent`; neither: unconditionally). `supersedePartial`: the
     *  client's own save, which replaces a saved partial reply unless its reply still runs.
     *  { ok: true, revision } | { conflict: true, history, revision, exists, proposedRevision } |
     *  { deleted: true } (the chat is tombstoned: nothing written). `origin`: who asks (originOf). */
    async historyWrite(user, chat, history, { baseRevision, ifAbsent = false, supersedePartial = false, origin } = {}) {
      const payload = { user, chat, history, origin: originOf(origin) };
      if (typeof baseRevision === 'string') payload.baseRevision = baseRevision;
      if (ifAbsent) payload.ifAbsent = true;
      if (supersedePartial) payload.supersedePartial = true;
      const { status, body } = await call('history/write', payload);
      if (status === 200 && body && typeof body.revision === 'string') return { ok: true, revision: body.revision };
      if (status === 409 && body && typeof body.revision === 'string') {
        return { conflict: true, history: body.history, revision: body.revision, exists: body.exists === true, proposedRevision: body.proposedRevision };
      }
      if (status === 410 && body && body.code === 'CHAT_DELETED') return { deleted: true };
      throw historyFailure(status, body);
    },
    /** chat-interrupted-turn.cjs: `entry` after the user message `message` if that is still last, in
     *  one hold of the store's lock. 'saved' | 'not-last' | 'no-user-message' | 'deleted'. */
    async historyAppendIfLast(user, chat, message, entry, { origin } = {}) {
      const { status, body } = await call('history/append-if-last', { user, chat, message, entry, origin: originOf(origin) });
      if (status === 200 && body && HISTORY_OUTCOMES.has(body.outcome)) return body.outcome;
      throw historyFailure(status, body);
    },
    /** Removes the transcript only if it is exactly what saving `history` would have written. */
    async historyRemoveIf(user, chat, history, { origin } = {}) {
      const { status, body } = await call('history/remove-if', { user, chat, history, origin: originOf(origin) });
      if (status === 200 && body && typeof body.removed === 'boolean') return body.removed;
      throw historyFailure(status, body);
    },
    /** sbstndalton/noevia#1071 slice 6: a chat's whole delete, one store operation under the
     *  transcript lock (noevia-rs crates/server-projects chat_delete): the tombstone, the list
     *  without the chat (written by the store), then the transcript, context meter, brain note and
     *  saved partial reply. `kind`: 'free', 'project' (with `projectId`) or 'unlisted' (a deleted
     *  project's chat, which no list holds any more). { deleted, swept, leftovers }: `deleted`
     *  taken out of its list now; `swept` already deleted and in no list, its leftover files
     *  removed; neither: no such chat. A failed list save takes the tombstone back and removes
     *  nothing (failure()); 'unlisted' for a chat a list still holds is { listed: true }. Node
     *  never removes those files itself. */
    async chatDelete(user, chat, { kind, projectId, origin = 'remove' } = {}) {
      const payload = { user, chat, kind, origin: originOf(origin) };
      if (kind === 'project') payload.projectId = projectId;
      const { status, body } = await call('chat/delete', payload);
      if (status === 200 && body && typeof body.deleted === 'boolean') return { deleted: body.deleted, swept: body.swept === true, leftovers: Number(body.leftovers) || 0 };
      if (status === 409 && body && body.code === 'CHAT_LISTED') return { deleted: false, swept: false, leftovers: 0, listed: true };
      throw historyFailure(status, body);
    },
    /** sbstndalton/noevia#2190 round 4: the legacy WebDAV storage setup, saved by the Rust front (the
     *  only writer of storage_connections) only while the account has no row or a local one.
     *  { saved }. Throws the store's failure otherwise. */
    async storageLegacyWebdav(user, { baseUrl = '', username = '', secret = '', corpusRoot = '' } = {}) {
      const { status, body } = await call('storage/legacy-webdav', { user, baseUrl: String(baseUrl), username: String(username), secret: String(secret), corpusRoot: String(corpusRoot) });
      if (status === 200 && body && typeof body.saved === 'boolean') return { saved: body.saved };
      throw failure(status, body);
    },
    /** sbstndalton/noevia#2190 round 5: Sign in with ChatGPT's token broker (the Rust front,
     *  chatgpt_oauth_routes.rs). Each answers { ok: true, ... } or { ok: false, status, error, code }
     *  (the broker's refusal, written for people). A session may refresh and a catalogue read may
     *  fetch upstream (15 s each), so these wait longer than the file operations.
     *  `session` hands out an access token, never a refresh token. */
    async chatgptSession(user, rejected = null) {
      const { status, body } = await call('chatgpt/session', { user, ...(rejected ? { rejected: String(rejected) } : {}) }, CHATGPT_WAIT_MS);
      if (status === 200 && body && typeof body.accessToken === 'string' && typeof body.generation === 'string') {
        return { ok: true, session: { accessToken: body.accessToken, accountId: String(body.accountId ?? ''), fedRamp: body.fedRamp === true,
          expiresAt: Number.isFinite(body.expiresAt) ? body.expiresAt : null, generation: body.generation } };
      }
      return chatgptRefusal(status, body);
    },
    async chatgptReject(user, generation) {
      const { status, body } = await call('chatgpt/reject', { user, generation: String(generation || '') }, CHATGPT_WAIT_MS);
      return status === 200 && body ? { ok: true, marked: body.marked === true } : chatgptRefusal(status, body);
    },
    async chatgptCatalogue(user) {
      const { status, body } = await call('chatgpt/catalogue', { user }, CHATGPT_WAIT_MS);
      return status === 200 && body && Array.isArray(body.models) ? { ok: true, models: body.models } : chatgptRefusal(status, body);
    },
    async chatgptDisconnect(user) {
      const { status, body } = await call('chatgpt/disconnect', { user }, CHATGPT_WAIT_MS);
      return status === 200 && body?.ok === true ? { ok: true } : chatgptRefusal(status, body);
    },
    async chatgptForget(user) {
      const { status, body } = await call('chatgpt/forget', { user }, CHATGPT_WAIT_MS);
      return status === 200 && body?.ok === true ? { ok: true } : chatgptRefusal(status, body);
    },
    /** sbstndalton/noevia#2190 round 7: Google Drive's token broker (the Rust front, gdrive.rs and
     *  connector_routes.rs). `admin` is the authenticated account's role (the backup slot doubles as
     *  an administrator's Drive). Each answers { ok: true, ... } or { ok: false, status, error, code }.
     *  `session` hands out an access token, never a refresh token. */
    async gdriveSession(user, admin, rejected = null) {
      const { status, body } = await call('gdrive/session', { user, admin: admin === true, ...(rejected ? { rejected: String(rejected) } : {}) }, CHATGPT_WAIT_MS);
      if (status === 200 && body && typeof body.accessToken === 'string' && typeof body.generation === 'string') {
        return { ok: true, session: { accessToken: body.accessToken, expiresAt: Number.isFinite(body.expiresAt) ? body.expiresAt : null, generation: body.generation } };
      }
      return chatgptRefusal(status, body);
    },
    async gdriveReject(user, admin, generation) {
      const { status, body } = await call('gdrive/reject', { user, admin: admin === true, generation: String(generation || '') }, CHATGPT_WAIT_MS);
      return status === 200 && body ? { ok: true, dropped: body.dropped === true } : chatgptRefusal(status, body);
    },
    async gdriveDisconnect(user, admin) {
      const { status, body } = await call('gdrive/disconnect', { user, admin: admin === true }, CHATGPT_WAIT_MS);
      return status === 200 && body?.ok === true ? { ok: true } : chatgptRefusal(status, body);
    },
    async gdriveForget(user) {
      const { status, body } = await call('gdrive/forget', { user }, CHATGPT_WAIT_MS);
      return status === 200 && body?.ok === true ? { ok: true } : chatgptRefusal(status, body);
    },
    /** secrets:rotate (round 7 review): the front re-seals every account's token file under the current
     *  secrets.key, under its own fence. { ok: true, counts: { current, rotated, empty, failed } } or a refusal
     *  (a 404 is an older front without the op). Counts only: no name, id or token. */
    async gdriveReseal() {
      const { status, body } = await call('gdrive/reseal', {}, CHATGPT_WAIT_MS);
      const n = (k) => (Number.isInteger(body?.[k]) && body[k] >= 0 ? body[k] : null);
      if (status === 200 && body && ['current', 'rotated', 'empty', 'failed'].every((k) => n(k) !== null)) {
        return { ok: true, counts: { current: body.current, rotated: body.rotated, empty: body.empty, failed: body.failed } };
      }
      return chatgptRefusal(status, body);
    },
    /** The Google Drive half of GET /api/connectors, as the front would answer it. */
    async gdriveView(user, admin) {
      const { status, body } = await call('gdrive/view', { user, admin: admin === true }, CHATGPT_WAIT_MS);
      return status === 200 && body && body.id === 'gdrive' ? { ok: true, view: body } : chatgptRefusal(status, body);
    },
    /** The one write of tool_policies, on Node's behalf (the Nextcloud permissions: Node knows the live
     *  MCP tools and which of them write). `writes[i]` is whether `tools[i]` is a write. 400 carries the
     *  words core always showed. */
    async toolPolicySet(user, tools, writes, mode) {
      const { status, body } = await call('gdrive/policy', { user, tools: [].concat(tools), writes: [].concat(writes).map((w) => w === true), mode }, CHATGPT_WAIT_MS);
      if (status === 200 && body?.ok === true) return { ok: true };
      if (status === 400 && body && typeof body.error === 'string') return { ok: false, status: 400, error: body.error };
      return chatgptRefusal(status, body);
    },
    /** sbstndalton/noevia#2153: the user's chat change journal after `after` (chat-change-journal.cjs):
     *  { entries, oldestSeq, latestSeq, more, start }, or { unsupported: true } from a store
     *  without the op (404: an older Rust front). */
    async changesRead(user, after = 0) {
      const { status, body } = await call('changes/read', { user, after });
      if (status === 200 && body && Array.isArray(body.entries)) return body;
      if (status === 404) return { unsupported: true };
      throw historyFailure(status, body);
    },
  };
}

/** A broker refusal ({ error, code, status }) or an unusable answer, as { ok: false, ... }. */
function chatgptRefusal(status, body) {
  // Only the broker's own refusals carry their status; anything else (the store's 401 for a wrong
  // secret, a 404 from an older front, a 5xx) is "try again", never its raw text.
  if (!body || !Number.isInteger(body.status) || typeof body.error !== 'string') return { ok: false, status: 503 };
  return { ok: false, status: body.status, error: body.error, code: typeof body.code === 'string' ? body.code : undefined };
}

function moveFailure(status, body) {
  if ([400, 404, 409].includes(status)) return Object.assign(new Error(body?.error || 'The chat or destination is unavailable.'), { status, ...(typeof body?.code === 'string' ? { code: body.code } : {}) });
  return failure(status, body);
}

const HISTORY_OUTCOMES = new Set(['saved', 'not-last', 'no-user-message', 'deleted']);

/** sbstndalton/noevia#2153: who asks for a transcript change, journalled on its entry by the Rust
 *  store (journal.rs Origin), which refuses any other value. The chat change journal builds a
 *  chat's brain only for `history` (the user's own save, the history POST); `import` and `remove`
 *  are the conversation import publishing and taking back, `turn` an interrupted reply's append.
 *  Anything unnamed is sent as `other`. An older store ignores the field (mirror-only entries). */
const HISTORY_ORIGINS = new Set(['history', 'import', 'turn', 'remove', 'other']);
const originOf = (origin) => (HISTORY_ORIGINS.has(origin) ? origin : 'other');

/** A transcript op's refusal: a bad request stays a 400 (the caller's input), the rest as failure(). */
function historyFailure(status, body) {
  if (status === 400) return Object.assign(new Error(body && body.error ? String(body.error).slice(0, 200) : 'bad request'), { status: 400 });
  return failure(status, body);
}

/** One account's transcripts through `client`, the user bound here (the request's own workspace
 *  makes it, workspace.cjs), so no caller names another account's. */
function transcriptsFor(client, user) {
  return {
    read: (chat) => client.historyRead(user, chat),
    write: (chat, history, options) => client.historyWrite(user, chat, history, options),
    appendIfLast: (chat, message, entry, options) => client.historyAppendIfLast(user, chat, message, entry, options),
    removeIf: (chat, history, options) => client.historyRemoveIf(user, chat, history, options),
    // sbstndalton/noevia#1071 slice 6: the chat's whole delete (project-store-client chatDelete).
    deleteChat: (chat, options) => client.chatDelete(user, chat, options),
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

module.exports = { CHAT_MOVE_CLIENT_MARKER, CHAT_DELETE_CLIENT_MARKER, RESEARCH_JOBS_CLIENT_MARKER, HISTORY_ORIGINS, enabledFrom, createClient, clientFromEnv, createQueue, busy, failureReply, holdForStoreSaves, transcriptsFor, MAX_ATTEMPTS, TIMEOUT_MS };
