'use strict';

// TEST ORACLE (#1071): never required by production code (server/oracle-isolation.test.cjs
// enforces that). The JS references of MCP response framing, kept only so tools/gen-mcp-fixtures.cjs
// can regenerate tests/fixtures/mcp-frame.v1.json and the differential tests can compare them with
// dav-parse.wasm (sbstndalton/noevia-rs crates/mcp-frame). Production frames with the Rust module
// alone (server/mcp.cjs).
// Moved here unchanged from server/mcp.cjs parseRpcBodyJs, resolveSchemaRefsJs and inlineRefs.

const { MAX_SCHEMA_NODES, MAX_SCHEMA_CHARS, MAX_REF_DEPTH, MAX_NODE_DEPTH } = require('../../../server/mcp.cjs');

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
function parseRpcBodyJs(contentType, text, expectedId) {
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

function spend(budget, nodes, chars) {
  budget.nodes += nodes;
  budget.chars += chars;
  if (budget.nodes > MAX_SCHEMA_NODES) throw new Error(`schema expands past ${MAX_SCHEMA_NODES} nodes`);
  if (budget.chars > MAX_SCHEMA_CHARS) throw new Error(`schema expands past ${MAX_SCHEMA_CHARS} characters`);
}

function inlineRefs(node, defs, stack, depth, budget) {
  if (depth > MAX_NODE_DEPTH) throw new Error('schema nests deeper than we will walk');
  if (stack.length > MAX_REF_DEPTH) throw new Error('refs expand deeper than we will inline');
  spend(budget, 1, typeof node === 'string' ? node.length : 0);
  if (Array.isArray(node)) return node.map((n) => inlineRefs(n, defs, stack, depth + 1, budget));
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
    // Siblings are copied, not walked, but they are emitted once per expansion
    // all the same, so they count against the character budget.
    if (Object.keys(siblings).length) spend(budget, 0, JSON.stringify(siblings).length);
    return { ...inlineRefs(target, defs, [...stack, key], depth + 1, budget), ...siblings };
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === '$defs' || k === 'definitions') continue; // consumed by inlining
    spend(budget, 0, k.length);
    out[k] = inlineRefs(v, defs, stack, depth + 1, budget);
  }
  return out;
}

function resolveSchemaRefsJs(schema) {
  const defs = { ...(schema.$defs || {}), ...(schema.definitions || {}) };
  return inlineRefs(schema, defs, [], 0, { nodes: 0, chars: 0 });
}

module.exports = { parseRpcBodyJs, resolveSchemaRefsJs };
