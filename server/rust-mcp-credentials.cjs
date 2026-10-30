'use strict';
// sbstndalton/noevia#2202: the Rust front is the broker of every MCP server credential an account
// holds (noevia-rs bins/noevia-server mcp_broker.rs, mcp_routes.rs, capability
// rust-mcp-credentials): the OAuth sign-ins (discovery, registration, PKCE, the callback, the
// single-flight refresh, the disconnect and the revoke) and each account's own API keys for a
// directory server. It answers
//   GET /api/mcp-keys/servers, PUT|DELETE /api/mcp-keys/{id},
//   GET /api/mcp-oauth/servers, POST /api/mcp-oauth/{id}/connect, DELETE /api/mcp-oauth/{id},
//   GET /api/mcp-oauth/callback
// and is the only writer of mcp_oauth_tokens, mcp_oauth_clients and directory_mcp_user_keys (and, since round 2,
// of directory_mcp_servers: rust-mcp-directory.cjs). Node
// refuses exactly those methods on those paths before authentication (a stale route table cannot
// make two processes answer), and its database guard (rust-auth.cjs FRONT_TABLES) refuses every
// Node write of the three tables, even inside exempt(): there is no allowance, because the secrets
// rotation re-seals them through the broker too (resealMcpCredentials, below).
//
// What stays here is the MCP client itself (a chat's live session, mcp.cjs): it asks the broker over
// the internal store for the minimum one call needs - an access token, or the account's key headers
// - per call, and holds neither past the request. A refresh token never leaves the broker.
//
// The server list a chat turn needs, and "is this account ready for this server?", are re-read from
// the file the broker publishes after every change (mcp-credential-state.json, no secret in it) with
// shared-reread.cjs createReread: a changed signal reloads, a file that cannot be read means nobody
// is ready (fails closed) and is never served from an older read.
const path = require('node:path');

const ROUTES = Object.freeze([
  ['GET', /^\/api\/mcp-keys\/servers$/],
  ['PUT', /^\/api\/mcp-keys\/[a-z0-9-]+$/],
  ['DELETE', /^\/api\/mcp-keys\/[a-z0-9-]+$/],
  ['GET', /^\/api\/mcp-oauth\/servers$/],
  ['POST', /^\/api\/mcp-oauth\/[a-z0-9-]+\/connect$/],
  ['DELETE', /^\/api\/mcp-oauth\/[a-z0-9-]+$/],
  ['GET', /^\/api\/mcp-oauth\/callback$/],
]);
const ROUTE_REFUSAL = Object.freeze({ error: 'MCP server keys and sign-ins are owned by the Rust front.', code: 'RUST_MCP_CREDENTIALS_OWNED' });
// directory_mcp_servers is the directory itself (rust-mcp-directory.cjs): the rows, and the administrators' shared key slot.
const TABLES = Object.freeze(['mcp_oauth_tokens', 'mcp_oauth_clients', 'directory_mcp_user_keys', 'directory_mcp_servers']);
/** The file the broker rewrites (atomically, 0600) whenever who-is-ready changes. */
const STATE_FILE = 'mcp-credential-state.json';
const SCHEMA = `CREATE TABLE IF NOT EXISTS mcp_oauth_clients(server_id TEXT PRIMARY KEY, data_enc TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS mcp_oauth_tokens(user_id TEXT NOT NULL, server_id TEXT NOT NULL, data_enc TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, server_id));
  CREATE TABLE IF NOT EXISTS directory_mcp_user_keys(user_id TEXT NOT NULL, server_id TEXT NOT NULL, headers_enc TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, server_id));`;

/** Whether `method` on this pathname is the broker's. The patterns are anchored, as core's were: a
 *  trailing slash, an upper-case id or a longer path is not one of them. */
function owned(method, pathname) {
  return ROUTES.some(([m, re]) => m === method && re.test(pathname));
}

function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

/** Node is the schema migrator: the tables exist whichever process writes them (directory-mcp.cjs `migrate` makes
 *  directory_mcp_servers). */
function ensureSchema(db) {
  db.exec(SCHEMA);
}

const EMPTY_STATE = Object.freeze({ oauth: Object.freeze({}), keys: Object.freeze({}), ok: false });

/** The published readiness, validated; throws (so the re-reader falls back) on anything else. */
function parseState(text) {
  const doc = JSON.parse(text);
  if (!doc || doc.version !== 1 || typeof doc.oauth !== 'object' || !doc.oauth || typeof doc.keys !== 'object' || !doc.keys) throw new Error('unexpected readiness file');
  return Object.freeze({ oauth: doc.oauth, keys: doc.keys, ok: true });
}

function unavailable() {
  return Object.assign(new Error('MCP sign-ins and keys are unavailable right now. Try again in a moment.'), { status: 503 });
}

/** The broker could not be asked, or could not say right now (down, busy, its refresh at the service failed
 *  just now). NOT "sign in first": the sign-in or key may be perfectly good, and a caller that tells the
 *  person to sign in again sends them to redo something that was fine. `transient` marks it for callers. */
function brokerUnavailable(r) {
  return Object.assign(new Error(typeof r?.error === 'string' && r.error ? r.error : 'Your sign-in or key could not be checked right now. Try again in a moment.'), { status: 503, code: 'MCP_BROKER_UNAVAILABLE', transient: true });
}

/** What the broker says when the account has to (re)do something: no sign-in or key, or one that no longer works. */
const needsSignIn = (r) => !!r && r.ok === false && r.status === 401 && (r.code === 'disconnected' || r.code === 'reconnect');

/** A broker call, with the caller's signal: its failure is `brokerUnavailable`, and a Stop (the signal) stays a Stop. */
async function ask(call, signal) {
  try { return await call(); }
  catch (e) {
    if (signal && signal.aborted) throw Object.assign(new Error('The request was stopped.'), { name: 'AbortError', code: 'ABORT_ERR', cause: e });
    throw brokerUnavailable();
  }
}

/** A broker refusal as the error a Node route or tool call would have thrown. */
function refusalError(r) {
  if (!r || r.ok !== false || !Number.isInteger(r.status) || typeof r.error !== 'string') return unavailable();
  return Object.assign(new Error(r.error), { status: r.status, code: r.code, ...(r.needsClient ? { needsClient: true, issuer: r.issuer } : {}) });
}

/**
 * Node's side of the broker.
 * @param {object} o
 * @param {object} o.broker   project-store-client.cjs (mcpSession, mcpKey, mcpReject, mcpStart, ...)
 * @param {string} o.dataDir  UI_DATA_DIR, where the broker publishes the readiness file
 */
function createMcpCredentials({ broker, dataDir, fs = require('node:fs') }) {
  const file = path.join(dataDir, STATE_FILE);
  const { createReread, fileSignal } = require('./shared-reread.cjs');
  const state = createReread({
    signal: () => fileSignal(file, fs),
    load: () => parseState(fs.readFileSync(file, 'utf8')),
    fallback: () => EMPTY_STATE,
  });
  const ready = (kind, userId, serverId) => {
    const s = state.current();
    if (kind === 'oauth') return s.oauth?.[userId]?.[serverId];
    return Array.isArray(s.keys?.[userId]) && s.keys[userId].includes(serverId);
  };

  const oauth = {
    /** 'connected' | 'needs-reauth' | 'disconnected', from the broker's published readiness. */
    status(userId, serverId) {
      const v = userId ? ready('oauth', userId, serverId) : undefined;
      return v === 'connected' ? 'connected' : v === 'reauth' ? 'needs-reauth' : 'disconnected';
    },
    connected: (userId, serverId) => oauth.status(userId, serverId) === 'connected',
    /** One access token for this account and server, from the broker: `{ accessToken, generation, expiresAt }`,
     *  or null when the account has to sign in (none, or one that no longer works). `rejected` is the token
     *  the MCP server just answered 401 to. Never cached here. THROWS (`transient`, MCP_BROKER_UNAVAILABLE)
     *  when the broker cannot be asked or cannot say right now - "try again", not "sign in first" - and an
     *  AbortError when `signal` (the chat's Stop) fired, so Stop cancels the call promptly. */
    async session(userId, serverId, rejected = null, { signal = null } = {}) {
      if (!userId) return null;
      const r = await ask(() => broker.mcpSession(userId, serverId, rejected, { signal }), signal);
      if (r.ok) return r.session;
      if (needsSignIn(r)) return null;
      throw brokerUnavailable(r);
    },
    async tokenFor(userId, serverId, opts = {}) {
      return (await oauth.session(userId, serverId, null, opts))?.accessToken ?? null;
    },
    /** The second 401 on a fresh token: that sign-in (by its generation) needs a new one. */
    async reject(userId, serverId, generation) {
      const r = await broker.mcpReject(userId, serverId, generation).catch(() => ({ ok: false }));
      return r.ok && r.marked === true;
    },
    /** The address to send this account to; throws the broker's refusal (`needsClient`, `issuer`). */
    async start({ userId, serverId, serverUrl, challenge = '', purpose = 'connect' }) {
      const r = await broker.mcpStart({ user: userId, server: serverId, serverUrl, challenge, purpose });
      if (!r.ok) throw refusalError(r);
      return r.signIn;
    },
    async setClient({ serverId, serverUrl, clientId, clientSecret = '', challenge = '' }) {
      const r = await broker.mcpSetClient({ server: serverId, serverUrl, clientId, clientSecret, challenge });
      if (!r.ok) throw refusalError(r);
    },
    async clientInfo(serverId) {
      const r = await broker.mcpClientInfo(serverId);
      if (!r.ok) throw refusalError(r);
      return r.client;
    },
    /** A removed server takes every account's sign-in, its app and every account's key with it. */
    async forget(serverId) {
      const r = await broker.mcpForgetServer(serverId);
      if (!r.ok) throw refusalError(r);
    },
    /** A deleted account takes its own sign-ins and keys with it. */
    async forgetUser(userId) {
      const r = await broker.mcpForgetUser(userId);
      if (!r.ok) throw refusalError(r);
    },
  };

  const keys = {
    hasKey: (userId, serverId) => !!userId && ready('keys', userId, serverId),
    /** The account's own key headers for ONE call: an object, or null when it has none (or one no key opens).
     *  Throws like `oauth.session` when the broker cannot say. */
    async headers(userId, serverId, { signal = null } = {}) {
      if (!userId) return null;
      const r = await ask(() => broker.mcpKey(userId, serverId, { signal }), signal);
      if (r.ok) return r.headers;
      if (needsSignIn(r)) return null;
      throw brokerUnavailable(r);
    },
    /** The adding administrator's own key for a server they just added as personal. */
    async set(userId, serverId, headers) {
      const r = await broker.mcpKeySet(userId, serverId, headers);
      if (!r.ok) throw refusalError(r);
    },
  };

  return Object.freeze({
    oauth, keys,
    /** The readiness file's change signal (for caches that must move when a credential does). */
    signal: () => { try { return fileSignal(file, fs); } catch { return 'unreadable'; } },
  });
}

const COUNTS = ['current', 'rotated', 'upgraded', 'empty', 'failed'];
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * The broker's pass over the three tables as `{ tables, failures }` in secrets.cjs rotate()'s report
 * shape. Throws when it cannot be done (store unreachable, credential keys unavailable) or answers
 * something else. secrets-rotate.cjs awaits it before it rotates anything of its own.
 * @param {{ mcpReseal: () => Promise<object> }} broker  project-store-client.cjs
 */
async function resealMcpCredentials(broker) {
  if (!broker || typeof broker.mcpReseal !== 'function') throw new Error('the Rust front\'s MCP credential re-seal is not available');
  const body = await broker.mcpReseal();
  if (!body || body.ok !== true || !body.tables || typeof body.tables !== 'object' || !Array.isArray(body.failures)) throw new Error('the Rust front answered the MCP credential re-seal with something unexpected');
  const tables = {};
  for (const [name, counts] of Object.entries(body.tables)) {
    if (!TABLES.includes(name) || !counts || typeof counts !== 'object' || !COUNTS.every((k) => isCount(counts[k]))) throw new Error('the Rust front answered the MCP credential re-seal with something unexpected');
    tables[name] = Object.fromEntries(COUNTS.map((k) => [k, counts[k]]));
  }
  // A failure names the table and the row (account and server ids) and says why; never a credential.
  const failures = body.failures.slice(0, 1000).map((f) => ({ table: String(f && f.table), ref: Array.isArray(f && f.ref) ? f.ref.map(String).slice(0, 2) : null, error: String(f && f.error || '').slice(0, 200) }));
  return { tables, failures };
}

module.exports = { ROUTES, ROUTE_REFUSAL, TABLES, STATE_FILE, SCHEMA, owned, refuseOwned, ensureSchema, createMcpCredentials, resealMcpCredentials, parseState, EMPTY_STATE };
