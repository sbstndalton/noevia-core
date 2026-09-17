'use strict';

// ── noevia's own capabilities, offered over MCP ──────────────────────────
//
// Small models do not follow bespoke prompting reliably, but they do call
// tools. Exposing the Diary and project documents through the SAME MCP path
// already used for Nextcloud and Tavily means one mechanism, one permission
// gate and one curation story, rather than a second private convention that
// every model would have to be taught.
//
// It runs IN PROCESS on a second listener bound to 127.0.0.1, started only
// when MCP_INTERNAL_PORT is set, and never published in compose `ports:`.
// This mirrors the optional-listener pattern COWORK_DAV_PORT already uses.
//
// Why not a fourth container: it would need its own copy of authService,
// workspace, the diary tenant header, the per-user rag indexes and
// ownsFile() — the tenancy logic duplicated into a second trust domain, and a
// fourth image through the Unraid release flow. In process, handlers run
// inside the EXISTING requestScope AsyncLocalStorage, so all of that behaves
// identically with nothing re-implemented.
//
// Still only the three JSON-RPC calls mcp.cjs speaks: initialize, tools/list,
// tools/call. See AGENTS.md, "do not vendor an agent framework".

const crypto = require('crypto');
const http = require('http');

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'noevia-internal', version: '1' };
const TOKEN_VERSION = 1;
const TOKEN_TTL_MS = 30 * 1000;
const MAX_BODY_BYTES = 256 * 1024;

// ── Capability tokens ────────────────────────────────────────────────────
//
// Not a static bearer. The caller is this same process, so a shared secret
// would prove nothing; what the token has to carry is WHICH user and project
// the call is acting for, bound so the call cannot claim a different one.
//
// Nothing in a tool schema names a user, tenant, workspace or project, so
// there is nothing for a prompt-injected argument to set. uid/pid come only
// from requestScope at mint time and are covered by the HMAC. The handler
// reads them from the verified token and never from params.arguments.
//
// `w` is the write capability, and is 1 only when the approval gate has
// already resolved `approve` — see mcpInternalAuth in index.cjs. The server
// keeps its own write set and refuses a write presented with w:0, so a tool
// mistakenly listed under a box's `reads` still fails closed.

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }

function sign(key, payloadB64) {
  return crypto.createHmac('sha256', key).update(payloadB64).digest();
}

/** Mint a token. `uid`/`pid` null means a discovery-only token, which may
 *  answer initialize and tools/list and can never call a tool. */
function mintToken(key, { uid = null, pid = null, cid = null, w = 0, discovery = false, ttlMs = TOKEN_TTL_MS, now = Date.now() } = {}) {
  const payload = {
    v: TOKEN_VERSION,
    uid: uid || null,
    pid: pid || null,
    cid: cid || null,
    jti: crypto.randomUUID(),
    exp: now + ttlMs,
    w: w ? 1 : 0,
    d: discovery ? 1 : 0,
  };
  const body = b64u(JSON.stringify(payload));
  return `${body}.${b64u(sign(key, body))}`;
}

/** Verify signature, version and expiry. Does NOT consume the jti — see
 *  consumeCall. Returns { ok, claims } or { ok:false, reason }. */
function verifyToken(key, token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 4096) return { ok: false, reason: 'malformed' };
  const dot = token.indexOf('.');
  if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return { ok: false, reason: 'malformed' };
  const body = token.slice(0, dot);
  let given;
  try { given = Buffer.from(token.slice(dot + 1), 'base64url'); } catch { return { ok: false, reason: 'malformed' }; }
  const expected = sign(key, body);
  // Length check first: timingSafeEqual throws on a mismatch, and the length
  // of an HMAC is not a secret.
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad signature' };
  }
  let claims;
  try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return { ok: false, reason: 'malformed' }; }
  if (!claims || claims.v !== TOKEN_VERSION) return { ok: false, reason: 'version' };
  if (typeof claims.exp !== 'number' || claims.exp <= now) return { ok: false, reason: 'expired' };
  if (typeof claims.jti !== 'string' || !claims.jti) return { ok: false, reason: 'malformed' };
  return { ok: true, claims };
}

/** Single-use replay guard for tools/call only.
 *
 *  It cannot cover every request: mcp.cjs opens a session first, so one minted
 *  token legitimately carries initialize, notifications/initialized and then
 *  tools/call. Consuming on the first request would break the client. What
 *  actually needs protecting is the effect — a captured token must not be able
 *  to run the write a second time — so the jti is consumed by tools/call. */
function createReplayGuard({ now = () => Date.now() } = {}) {
  const used = new Map(); // jti -> exp
  return {
    consume(claims) {
      const t = now();
      if (used.size > 4096) for (const [k, exp] of used) if (exp <= t) used.delete(k);
      if (used.has(claims.jti)) return false;
      used.set(claims.jti, claims.exp);
      return true;
    },
    get size() { return used.size; },
  };
}

// ── Catalogue ────────────────────────────────────────────────────────────
//
// Static: the same tools for everyone, so discovery leaks nothing and can run
// outside any user scope. What differs per call is who the call acts AS, and
// that lives in the token, not the catalogue.

/** `definitions` is { name: { description, schema, write, handler } }. */
function catalogueOf(definitions) {
  return Object.entries(definitions).map(([name, d]) => ({
    name,
    description: d.description,
    inputSchema: d.schema || { type: 'object', properties: {}, required: [] },
    annotations: { readOnlyHint: !d.write },
  }));
}

function writeToolNames(definitions) {
  return new Set(Object.entries(definitions).filter(([, d]) => d.write).map(([name]) => name));
}

// ── JSON-RPC ─────────────────────────────────────────────────────────────

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function rpcOk(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/** Text result, in the shape resultToText expects. */
function textResult(text, isError = false) {
  return { content: [{ type: 'text', text: String(text) }], ...(isError ? { isError: true } : {}) };
}

/** `runAs(userId, fn)` establishes the request scope for a call.
 *
 *  This is not a convenience. The handlers reach the workspace through the
 *  same ambient AsyncLocalStorage the HTTP routes use, so WITHOUT this they
 *  would run in whatever scope happened to be active on the event loop — the
 *  token's uid would be decoration and the process's current request would
 *  silently decide whose files were read. Establishing the scope FROM the
 *  verified token is what makes the token authoritative. */
function createHandler({ key, definitions, guard = createReplayGuard(), now = () => Date.now(), runAs = null }) {
  const writes = writeToolNames(definitions);
  const catalogue = catalogueOf(definitions);

  return async function handle(message, token) {
    const id = message && message.id;
    const method = message && message.method;

    const verdict = verifyToken(key, token, now());
    if (!verdict.ok) return { status: 401, body: rpcError(id, -32001, `unauthorized: ${verdict.reason}`) };
    const claims = verdict.claims;

    if (method === 'initialize') {
      return { status: 200, body: rpcOk(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO }) };
    }
    if (method === 'notifications/initialized') return { status: 202, body: null };
    if (method === 'tools/list') {
      return { status: 200, body: rpcOk(id, { tools: catalogue }) };
    }
    if (method !== 'tools/call') return { status: 200, body: rpcError(id, -32601, `method not found: ${method}`) };

    // A discovery token exists so the catalogue can be listed with no user in
    // scope. It must never be able to act.
    if (claims.d) return { status: 403, body: rpcError(id, -32002, 'this token may list tools but not call them') };
    if (!claims.uid) return { status: 403, body: rpcError(id, -32002, 'no user is in scope for this call') };

    const params = (message && message.params) || {};
    const name = typeof params.name === 'string' ? params.name : '';
    const definition = Object.prototype.hasOwnProperty.call(definitions, name) ? definitions[name] : null;
    if (!definition) return { status: 200, body: rpcOk(id, textResult(`ERROR: unknown tool "${name}"`, true)) };

    // Defence in depth. The approval gate in index.cjs is what actually asks
    // the human; this refuses to act on a write the gate never blessed, so a
    // tool wrongly listed as a read is an error rather than an unreviewed
    // change.
    if (writes.has(name) && !claims.w) {
      return { status: 403, body: rpcError(id, -32003, `"${name}" changes data and was not approved`) };
    }
    if (!guard.consume(claims)) {
      return { status: 401, body: rpcError(id, -32004, 'this authorization has already been used') };
    }

    // arguments carry only what the tool schema declares. Identity is taken
    // from the verified token, never from here.
    const args = (params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)) ? params.arguments : {};
    const ctx = { userId: claims.uid, projectId: claims.pid, chatId: claims.cid };
    const invoke = () => definition.handler(args, ctx);
    try {
      const text = runAs ? await runAs(claims.uid, invoke) : await invoke();
      return { status: 200, body: rpcOk(id, textResult(text == null ? '' : text)) };
    } catch (err) {
      // Never interpolate the token: mcp.cjs folds response bodies into thrown
      // error messages, which reach logs and the model.
      return { status: 200, body: rpcOk(id, textResult(`ERROR: ${String((err && err.message) || err).slice(0, 300)}`, true)) };
    }
  };
}

// ── Listener ─────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Start the loopback listener. Returns the http.Server, or null when no port
 *  is configured — the default, in which case nothing binds at all. */
function startInternalServer({ port, key, definitions, runAs = null, path: rpcPath = '/mcp', host = '127.0.0.1', log = console }) {
  const handle = createHandler({ key, definitions, runAs });
  const server = http.createServer((req, res) => {
    const reply = (status, body) => {
      const payload = body === null ? '' : JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
      res.end(payload);
    };
    if (req.method !== 'POST' || (req.url || '').split('?')[0] !== rpcPath) return reply(404, { error: 'not found' });
    readBody(req).then(async (raw) => {
      let message;
      try { message = JSON.parse(raw); } catch { return reply(400, rpcError(null, -32700, 'parse error')); }
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const out = await handle(message, token);
      reply(out.status, out.body);
    }).catch(() => reply(400, rpcError(null, -32600, 'invalid request')));
  });
  // Loopback only, and asserted here as well as in the parser: this listener
  // answers to a capability token, not to a session cookie, so it must never
  // be reachable from off-box.
  server.listen(port, host, () => {
    log.log(`noevia internal MCP on http://${host}:${port}${rpcPath} (loopback only, never published)`);
  });
  return server;
}

module.exports = {
  mintToken, verifyToken, createReplayGuard, createHandler, startInternalServer,
  catalogueOf, writeToolNames, textResult,
  PROTOCOL_VERSION, TOKEN_TTL_MS, SERVER_INFO,
};
