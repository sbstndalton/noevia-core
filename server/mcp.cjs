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

// Pull the JSON-RPC payload out of a response that may be either plain JSON
// or an SSE stream carrying one message.
function parseRpcBody(contentType, text) {
  if (String(contentType || '').includes('text/event-stream')) {
    // Take the LAST data: line — a server may emit progress notifications
    // before the actual result.
    let found = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      try {
        const msg = JSON.parse(payload);
        if (msg && Object.prototype.hasOwnProperty.call(msg, 'id')) found = msg;
      } catch { /* a partial or non-JSON frame; keep looking */ }
    }
    if (!found) throw new Error('MCP: no JSON-RPC message in event stream');
    return found;
  }
  return JSON.parse(text);
}

// One JSON-RPC round trip. `session` is mutated to carry the id the server
// hands out at initialize.
async function rpc(baseUrl, session, body, { headers = {}, timeoutMs = 30000, notify = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Must advertise BOTH: the server picks the stream form at will.
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        ...(session.id ? { 'mcp-session-id': session.id } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error', // same policy as the provider routes: no inward bounces
    });
    const sid = res.headers.get('mcp-session-id');
    if (sid) session.id = sid;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`MCP ${res.status}: ${detail.slice(0, 200)}`);
    }
    // Notifications have no id and the server answers 202 with an empty body.
    if (notify) return null;
    const text = await res.text();
    const msg = parseRpcBody(res.headers.get('content-type'), text);
    if (msg.error) throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`);
    return msg.result;
  } finally {
    clearTimeout(timer);
  }
}

// Open a session: initialize, then the required `initialized` notification.
// Returns the session object to pass back into listTools/callTool.
async function connect(baseUrl, authHeaders = {}, timeoutMs = 30000) {
  const session = { id: null };
  const info = await rpc(baseUrl, session, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
  }, { headers: authHeaders, timeoutMs });
  await rpc(baseUrl, session, { jsonrpc: '2.0', method: 'notifications/initialized' },
    { headers: authHeaders, timeoutMs, notify: true });
  return { session, serverInfo: info && info.serverInfo };
}

// tools/list, following `nextCursor` pagination to the end.
async function listTools(baseUrl, session, authHeaders = {}, timeoutMs = 60000) {
  const all = [];
  let cursor;
  for (let page = 0; page < 20; page++) { // bounded: a broken server must not spin
    const result = await rpc(baseUrl, session, {
      jsonrpc: '2.0', id: 100 + page, method: 'tools/list',
      params: cursor ? { cursor } : {},
    }, { headers: authHeaders, timeoutMs });
    for (const t of (result && result.tools) || []) all.push(t);
    cursor = result && result.nextCursor;
    if (!cursor) break;
  }
  return all;
}

async function callTool(baseUrl, session, name, args, authHeaders = {}, timeoutMs = 60000) {
  const result = await rpc(baseUrl, session, {
    jsonrpc: '2.0', id: 200, method: 'tools/call', params: { name, arguments: args || {} },
  }, { headers: authHeaders, timeoutMs });
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
          properties: schema.properties || {},
          required: schema.required || [],
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

module.exports = { connect, listTools, callTool, resultToText, convertTool, readOnlyHint, parseRpcBody, PROTOCOL_VERSION };
