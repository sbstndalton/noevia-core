'use strict';

// ── Minimal MCP client (streamable-http) ─────────────────────────────────
//
// noevia speaks MCP so a user can point it at their own server instead of us
// hand-implementing dozens of Nextcloud endpoints. This is deliberately a few
// hundred lines rather than the official SDK: the repo is a zero-dependency
// proxy and the surface we need is three calls — initialize, tools/list,
// tools/call. See MASTER-PROMPT "Do not vendor an agent framework".
//
// Transport is streamable-http, not stdio: both noevia and the MCP server run
// as containers, and spawning subprocesses across that boundary is the wrong
// shape.
//
// Two things the spec allows that a naive client gets wrong, and both were
// observed against cbcoutinho/nextcloud-mcp-server on 2026-09-08:
//
//  1. A JSON-RPC response may come back as `text/event-stream` rather than
//     `application/json` — even for a plain request/response call. The body
//     then arrives as `event: message` / `data: {…}` lines and must be
//     unwrapped. This server does exactly that for every call.
//  2. `initialize` returns an `mcp-session-id` HEADER which every subsequent
//     request must echo, along with `MCP-Protocol-Version`. Omit it and the
//     server rejects the call.

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'noevia', version: '1' };
// A remote MCP server is not trusted infrastructure: nothing stops it from
// streaming an unbounded body instead of a JSON-RPC reply, and `await
// res.text()` would buffer all of it before the 30-60s request timeout ever
// fires. Cap how much of any response body noevia will read into memory.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

// Read a response body up to `capBytes`, aborting the underlying request (via
// `controller`) and throwing a clear error the moment the cap is exceeded,
// rather than buffering an unbounded stream. Falls back to res.text() when a
// body reader isn't available (e.g. in tests using a plain Response-like
// object without a streamable body).
async function readBodyCapped(res, controller, capBytes = MAX_RESPONSE_BYTES) {
  if (!res.body || typeof res.body.getReader !== 'function') return await res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '', total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > capBytes) {
        controller.abort();
        try { await reader.cancel(); } catch { /* already aborted */ }
        throw new Error(`MCP: response body exceeded the ${Math.round(capBytes / (1024 * 1024))} MB limit`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    try { reader.releaseLock(); } catch { /* stream already errored/canceled */ }
  }
}

// Every request gets its own id, so a reply can be matched to it. These used
// to be constants (1, 100+page, 200), which was survivable only because the
// reply was identified by position rather than by id — see below.
let nextRequestId = 0;
function requestId() { return ++nextRequestId; }

// Pull the JSON-RPC payload out of a response that may be either plain JSON
// or an SSE stream carrying one message.
//
// This used to take the LAST frame carrying an `id`, on the reasoning that a
// server may emit progress notifications first. Notifications have no `id`, so
// that worked — by luck. A server REQUEST has an id: a spec-compliant server
// doing sampling or elicitation emits one on this stream before the result,
// and its payload would have been handed back to the model as the tool result.
// Matching on the id we actually sent is the fix, and it is also what lets the
// ids above stop being constants.
function parseRpcBody(contentType, text, expectedId) {
  if (String(contentType || '').includes('text/event-stream')) {
    let found = null;
    let sawOtherId = false;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        const msg = JSON.parse(payload);
        if (!msg || !Object.prototype.hasOwnProperty.call(msg, 'id')) continue; // a notification
        // A response carries `result` or `error`; a server-initiated request
        // carries `method`. Both have an id, so check both.
        if (msg.id === expectedId && !msg.method) found = msg;
        else sawOtherId = true;
      } catch { /* a partial or non-JSON frame; keep looking */ }
    }
    if (!found) {
      throw new Error(sawOtherId
        ? `MCP: no reply to request ${expectedId} in event stream (the server sent other traffic; noevia does not implement server-initiated requests)`
        : 'MCP: no JSON-RPC message in event stream');
    }
    return found;
  }
  const msg = JSON.parse(text);
  if (msg && Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== expectedId) {
    throw new Error(`MCP: reply id ${msg.id} does not match request ${expectedId}`);
  }
  return msg;
}

// Protocol headers noevia sets itself. Credentials (user keys, directory
// headers, bearer/OAuth tokens) are merged in, but may never replace these:
// a key header named e.g. `mcp-session-id` or `Accept` would otherwise
// silently hijack the session or the transport negotiation.
const RESERVED_HEADERS = new Set(['content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id']);
function withBuiltInHeaders(extra, builtIn) {
  const out = {};
  for (const [k, v] of Object.entries(extra || {})) if (!RESERVED_HEADERS.has(String(k).toLowerCase())) out[k] = v;
  return { ...out, ...builtIn };
}

// One JSON-RPC round trip. `session` is mutated to carry the id the server
// hands out at initialize.
async function rpc(baseUrl, session, body, { headers = {}, timeoutMs = 30000, notify = false, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // `signal`, when given, is the caller's own lifetime (e.g. the chat's
  // abort signal on browser disconnect). Forwarding it means a tool call
  // stops the moment the caller goes away, instead of running up to
  // `timeoutMs` regardless.
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forwardAbort);
  }
  try {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: withBuiltInHeaders(headers, {
        'Content-Type': 'application/json',
        // Must advertise BOTH: the server picks the stream form at will.
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        ...(session.id ? { 'mcp-session-id': session.id } : {}),
      }),
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error', // same policy as the provider routes: no inward bounces
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) session.id = sid;
    if (!res.ok) {
      const detail = await readBodyCapped(res, controller).catch(() => '');
      // The snippet is for logs/operators only; `httpStatus` lets the chat
      // path hand the model a neutral message instead of the server's body.
      throw Object.assign(new Error(`MCP ${res.status}: ${detail.slice(0, 200)}`), { httpStatus: res.status });
    }
    // Notifications have no id and the server answers 202 with an empty body.
    if (notify) return null;
    const text = await readBodyCapped(res, controller);
    const msg = parseRpcBody(res.headers.get('content-type'), text, body.id);
    if (msg.error) throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`);
    return msg.result;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', forwardAbort);
  }
}

// Open a session: initialize, then the required `initialized` notification.
// Returns the session object to pass back into listTools/callTool.
// `signal`, when given, is the caller's own lifetime — e.g. the browser
// connection for the chat this tool call belongs to — so a disconnect stops
// the handshake rather than leaving it to run out its own timeout.
async function connect(baseUrl, authHeaders = {}, timeoutMs = 30000, signal) {
  const session = { id: null };
  try {
    const info = await rpc(baseUrl, session, {
      jsonrpc: '2.0', id: requestId(), method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
    }, { headers: authHeaders, timeoutMs, signal });
    await rpc(baseUrl, session, { jsonrpc: '2.0', method: 'notifications/initialized' },
      { headers: authHeaders, timeoutMs, notify: true, signal });
    return { session, serverInfo: info && info.serverInfo };
  } catch (error) {
    // Callers cannot close a session until connect returns it. The server may
    // already have issued an ID even when initialize response parsing fails.
    // Cleanup itself is deliberately NOT tied to `signal`: an aborted chat
    // still deserves its MCP session closed rather than left dangling.
    await disconnect(baseUrl, session, authHeaders, Math.min(timeoutMs, 5000), signal);
    throw error;
  }
}

// Close a session. Every connect() opened one and nothing ever closed it, so a
// server that holds per-session state accumulated one entry per tool call for
// as long as noevia ran.
//
// Deliberately NOT paired with a session cache. Reusing sessions would also
// save two round trips per call, but a session is established with a specific
// user's credentials (mcpAuthHeaders forwards per-user Nextcloud basic auth),
// so a shared cache is a cross-tenant hazard of exactly the kind AGENTS.md
// rules out. Correctness first; reuse needs a per-user key and its own tests.
//
// Best-effort by contract: the spec allows a server to refuse DELETE with 405,
// and a session that never got an id has nothing to close. A failure here must
// never surface as a tool error — the call it belongs to has already answered.
//
// `signal` is the caller's lifetime. Cleanup still runs after an abort (the
// session deserves closing), but a cancelled caller waits at most
// ABORTED_DISCONNECT_MS for it rather than the full timeout.
const ABORTED_DISCONNECT_MS = 1000;
async function disconnect(baseUrl, session, authHeaders = {}, timeoutMs = 5000, signal) {
  if (!session || !session.id) return false;
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), signal && signal.aborted ? Math.min(timeoutMs, ABORTED_DISCONNECT_MS) : timeoutMs);
  const shorten = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, ABORTED_DISCONNECT_MS)); };
  if (signal && !signal.aborted) signal.addEventListener('abort', shorten, { once: true });
  try {
    const res = await fetch(baseUrl, {
      method: 'DELETE',
      headers: withBuiltInHeaders(authHeaders, { 'MCP-Protocol-Version': PROTOCOL_VERSION, 'mcp-session-id': session.id }),
      signal: controller.signal,
      redirect: 'error',
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', shorten);
    session.id = null;
  }
}

// tools/list, following `nextCursor` pagination to the end.
// Discovery is bounded in total, not only per page (each page is still capped
// at MAX_RESPONSE_BYTES by rpc): a server that pages forever or returns huge
// definitions stops at the page or byte budget, with a warning, keeping the
// tools gathered so far. Both budgets are read per call so they are env-overridable.
function positiveEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
async function listTools(baseUrl, session, authHeaders = {}, timeoutMs = 60000, signal) {
  const maxPages = positiveEnv('MCP_LIST_TOOLS_MAX_PAGES', 20);
  const maxBytes = positiveEnv('MCP_LIST_TOOLS_MAX_BYTES', 16 * 1024 * 1024);
  const all = [];
  let bytes = 0;
  let cursor;
  for (let page = 0; ; page++) {
    if (page >= maxPages) {
      console.warn(`[mcp] tools/list for ${baseUrl} stopped after ${maxPages} pages; keeping ${all.length} tools`);
      break;
    }
    const result = await rpc(baseUrl, session, {
      jsonrpc: '2.0', id: requestId(), method: 'tools/list',
      params: cursor ? { cursor } : {},
    }, { headers: authHeaders, timeoutMs, signal });
    for (const t of (result && result.tools) || []) {
      const size = Buffer.byteLength(JSON.stringify(t) || '');
      if (bytes + size > maxBytes) {
        console.warn(`[mcp] tools/list for ${baseUrl} reached its ${maxBytes}-byte budget; keeping ${all.length} tools`);
        return all;
      }
      bytes += size;
      all.push(t);
    }
    cursor = result && result.nextCursor;
    if (!cursor) break;
  }
  return all;
}

async function callTool(baseUrl, session, name, args, authHeaders = {}, timeoutMs = 60000, signal) {
  const result = await rpc(baseUrl, session, {
    jsonrpc: '2.0', id: requestId(), method: 'tools/call', params: { name, arguments: args || {} },
  }, { headers: authHeaders, timeoutMs, signal });
  return result;
}

// Flatten an MCP tool result into the plain string the chat loop feeds back as
// a role:'tool' message. An `isError` result is still returned as text, not
// thrown: a failed tool call is information the model can act on.
function resultToText(result) {
  if (!result) return '';
  const parts = [];
  for (const c of (result.content || [])) {
    if (c && c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c && c.type) parts.push(`[${c.type} content omitted]`);
  }
  let text = parts.join('\n').trim();
  if (!text && result.structuredContent) text = JSON.stringify(result.structuredContent);
  if (result.isError) text = `ERROR from tool: ${text || '(no detail)'}`;
  return text;
}

// ── MCP → OpenAI function-calling conversion ─────────────────────────────
//
// MCP already uses JSON Schema, so this is mostly renaming inputSchema to
// parameters. It is still validated rather than assumed: a tool whose schema
// does not convert cleanly is DROPPED with a reason, never passed through
// broken, because a malformed schema makes the provider reject the whole
// request — one bad tool would take out every other tool in the box.
//
// `outputSchema` is deliberately discarded. OpenAI function calling has no
// field for it, and on the reference server it is 63% of the payload
// (431,621 chars raw vs 161,643 converted, measured 2026-09-08).
const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

// llama.cpp builds a grammar from each tool's schema and CANNOT resolve
// $ref/$defs while doing it. It does not skip the offending tool either — it
// rejects the entire request:
//
//   HTTP 400 … "Unable to generate parser for this template.
//               JSON schema conversion failed:
//               Error resolving ref #/$defs/Reminder: $defs not in {…}"
//
// So a single such tool silently breaks every other tool in the box, and the
// user sees a chat that answers nothing at all. Four tools on the reference
// server carry $defs (nc_calendar_create_event, _update_event, _create_todo,
// _update_todo), two of them in the curated calendar box — measured against
// the live endpoint 2026-09-08.
//
// Inlining is preferred to dropping: these are exactly the tools that make
// Calendar worth having. A ref that cannot be inlined — external, or circular,
// which would expand forever — drops the tool instead, which is the whole
// point of validating rather than assuming.
// Two separate limits, because they catch different things. MAX_REF_DEPTH
// bounds how many times a ref may expand into another ref — that is the one
// that stops runaway expansion, and cycles are caught by the name stack
// regardless. MAX_NODE_DEPTH only stops a hostile or absurd schema from
// blowing the JS stack, so it is generous: real schemas nest a dozen levels
// through anyOf/items/properties without anything being wrong.
const MAX_REF_DEPTH = 8;
const MAX_NODE_DEPTH = 64;

function inlineRefs(node, defs, stack, depth) {
  if (depth > MAX_NODE_DEPTH) throw new Error('schema nests deeper than we will walk');
  if (stack.length > MAX_REF_DEPTH) throw new Error('refs expand deeper than we will inline');
  if (Array.isArray(node)) return node.map((n) => inlineRefs(n, defs, stack, depth + 1));
  if (!node || typeof node !== 'object') return node;
  const ref = node.$ref;
  if (typeof ref === 'string') {
    const m = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref);
    if (!m) throw new Error(`cannot resolve non-local ref ${ref}`);
    const key = m[2];
    if (stack.includes(key)) throw new Error(`circular ref ${ref}`);
    const target = defs[key];
    if (!target) throw new Error(`ref ${ref} points at a definition that is not present`);
    // Sibling keys alongside a $ref (a description, say) are kept, with the
    // resolved body underneath them.
    const { $ref: _drop, ...siblings } = node;
    return { ...inlineRefs(target, defs, [...stack, key], depth + 1), ...siblings };
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$defs' || k === 'definitions') continue; // consumed by inlining
    out[k] = inlineRefs(v, defs, stack, depth + 1);
  }
  return out;
}

function resolveSchemaRefs(schema) {
  const defs = { ...(schema.$defs || {}), ...(schema.definitions || {}) };
  return inlineRefs(schema, defs, [], 0);
}

function convertTool(mcpTool) {
  const name = mcpTool && mcpTool.name;
  if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) {
    return { ok: false, reason: `invalid tool name ${JSON.stringify(name)}` };
  }
  const schema = mcpTool.inputSchema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { ok: false, reason: 'inputSchema missing or not an object' };
  }
  if (schema.type !== 'object') {
    // Function-calling parameters must be an object schema; a top-level array
    // or scalar has nowhere to go.
    return { ok: false, reason: `inputSchema.type is ${JSON.stringify(schema.type)}, expected "object"` };
  }
  if (schema.properties !== undefined && (typeof schema.properties !== 'object' || Array.isArray(schema.properties))) {
    return { ok: false, reason: 'inputSchema.properties is not an object' };
  }
  if (schema.required !== undefined && !Array.isArray(schema.required)) {
    return { ok: false, reason: 'inputSchema.required is not an array' };
  }
  let resolved;
  try {
    resolved = resolveSchemaRefs(schema);
  } catch (err) {
    return { ok: false, reason: `unresolvable schema: ${err.message}` };
  }
  const description = typeof mcpTool.description === 'string' && mcpTool.description
    ? mcpTool.description
    : (typeof mcpTool.title === 'string' ? mcpTool.title : '');
  return {
    ok: true,
    tool: {
      type: 'function',
      function: {
        name,
        description,
        parameters: {
          type: 'object',
          properties: resolved.properties || {},
          required: resolved.required || [],
        },
      },
    },
  };
}

// MCP carries `annotations.readOnlyHint`, but only on some tools — on the
// reference server 90 of 160 omit it entirely. So it is a useful signal and a
// useless guarantee: absent means unknown, which must be treated as a write
// when step 4 lands the permission gate.
function readOnlyHint(mcpTool) {
  const a = mcpTool && mcpTool.annotations;
  if (!a || typeof a !== 'object') return null;
  return typeof a.readOnlyHint === 'boolean' ? a.readOnlyHint : null;
}

module.exports = {
  withBuiltInHeaders, connect, disconnect, listTools, callTool, resultToText, convertTool, resolveSchemaRefs, readOnlyHint, parseRpcBody, PROTOCOL_VERSION, MAX_RESPONSE_BYTES };
