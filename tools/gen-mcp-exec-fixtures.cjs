#!/usr/bin/env node
'use strict';
// Regenerates the differential fixtures for the MCP tool executor (sbstndalton/noevia#2218):
//   node tools/gen-mcp-exec-fixtures.cjs > tests/fixtures/mcp-exec.v1.json
// Expectations come from the frozen Node executor (tests/server/oracle/mcp-exec.cjs, core mcp-wiring.cjs as it was) run
// over the real mcp.cjs transport against synthetic MCP servers on 127.0.0.1. The same file is committed byte for byte in
// sbstndalton/noevia-rs (bins/noevia-server/tests/fixtures/mcp-exec.v1.json), whose executor replays every step; noevia-core
// CI compares it with a fresh run (server/mcp-exec-oracle.test.cjs). Every server, credential and result below is synthetic.
//
// A scenario is { id, servers, env?, directory?, origins?, storage?, keys?, oauth?, steps[] }. A step is
//   { call: { name, args?, server?, offers[], caller?, workspace?, editTarget?, internalAuth? }, mcp: <fake behaviour>,
//     expect: { text } | { throws }, requests: [ what the synthetic server saw ], broker?: [ what the credential fakes saw ] }
// Request ids come from a process-wide counter, so "request <n>" and "reply id <n>" are written "request N" / "reply id N"; a replay
// writes them the same way before it compares.
// Placeholders: $FAKE (the synthetic server's /mcp address), $ORIGIN (its origin), $DEAD (an address that refuses connections).
// Fake behaviour: { sid, init: 'ok'|{http:{status,body}}, call: one reply or a list consumed per tools/call, del: 200|405 }.

const http = require('node:http');
const { AsyncLocalStorage } = require('node:async_hooks');

// mcp.cjs judges a reply with the dav-parse module (mcp-frame). The fixtures must not depend on a built module, so
// the module's contract (tests/fixtures/mcp-frame.v1.json) is served here from the JS reference it is tested against.
const { parseRpcBodyJs } = require('../tests/server/oracle/mcp.cjs');
const wasmPath = require.resolve('../server/dav-parse-wasm.cjs');
require.cache[wasmPath] = { id: wasmPath, filename: wasmPath, loaded: true, exports: { mcpRpcBody(sse, text, expectedId) {
  if (!sse) {
    let msg;
    try { msg = JSON.parse(text); } catch { return { kind: 'invalid' }; }
    const mismatch = msg && Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== expectedId;
    return { kind: mismatch ? 'mismatch' : 'reply', text };
  }
  try { return { kind: 'reply', text: JSON.stringify(parseRpcBodyJs('text/event-stream', text, expectedId)) }; } catch (err) {
    return { kind: /other traffic/.test(err.message) ? 'other' : 'none' };
  }
} } };

const mcp = require('../server/mcp.cjs');
const { reduceToolResult } = require('../server/tool-result-reduce.cjs');
const { createMcpWiring, createCredentialOriginCheck } = require('../tests/server/oracle/mcp-exec.cjs');

const SEEN_HEADERS = ['authorization', 'x-api-key', 'x-cowork-user-id', 'mcp-session-id', 'mcp-protocol-version', 'content-type', 'accept'];

function rpcReply(id, result) { return JSON.stringify({ jsonrpc: '2.0', id, result }); }

async function startFake() {
  const state = { behaviour: {}, log: [], calls: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const headers = {};
      for (const h of SEEN_HEADERS) if (req.headers[h] !== undefined) headers[h] = req.headers[h];
      if (req.method === 'DELETE') {
        state.log.push({ m: 'DELETE', headers });
        res.statusCode = state.behaviour.del || 200; res.end();
        return;
      }
      let msg = {};
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not ours */ }
      const entry = { m: 'POST', rpc: msg.method, headers };
      if (msg.method === 'tools/call') { entry.tool = msg.params && msg.params.name; entry.args = msg.params && msg.params.arguments; }
      state.log.push(entry);
      const b = state.behaviour;
      if (msg.method === 'initialize') {
        if (b.init && b.init.http) { res.statusCode = b.init.http.status; res.end(b.init.http.body || ''); return; }
        if (b.sid) res.setHeader('mcp-session-id', b.sid);
        res.setHeader('content-type', 'application/json');
        res.end(rpcReply(msg.id, { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'synthetic', version: '1' } }));
        return;
      }
      if (msg.method === 'notifications/initialized') { res.statusCode = 202; res.end(); return; }
      if (msg.method !== 'tools/call') { res.statusCode = 400; res.end(); return; }
      const list = Array.isArray(b.call) ? b.call : [b.call || { result: { content: [{ type: 'text', text: 'ok' }] } }];
      const c = list[Math.min(state.calls++, list.length - 1)];
      if (c.http) {
        res.statusCode = c.http.status;
        if (c.http.retryAfter !== undefined) res.setHeader('retry-after', c.http.retryAfter);
        res.end(c.http.body || '');
      } else if (c.rpcError) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: c.rpcError }));
      } else if (c.sse) {
        res.setHeader('content-type', 'text/event-stream');
        res.end(`event: message\ndata: ${rpcReply(msg.id, c.sse)}\n\n`);
      } else if (c.sseOther) {
        res.setHeader('content-type', 'text/event-stream');
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'sampling/createMessage', params: {} })}\n\n`);
      } else if (c.mismatch) {
        res.setHeader('content-type', 'application/json');
        res.end(rpcReply(msg.id + 1000, { content: [{ type: 'text', text: 'wrong id' }] }));
      } else if (c.badJson) {
        res.setHeader('content-type', 'application/json');
        res.end('{"jsonrpc":');
      } else if (c.huge) {
        res.setHeader('content-type', 'application/json');
        res.end(`{"jsonrpc":"2.0","id":${msg.id},"result":{"content":[{"type":"text","text":"${'x'.repeat(9 * 1024 * 1024)}"}]}}`);
      } else if (c.redirect) {
        res.statusCode = 302; res.setHeader('location', 'http://127.0.0.1:1/elsewhere'); res.end();
      } else {
        res.setHeader('content-type', 'application/json');
        res.end(rpcReply(msg.id, c.result));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { url: `${origin}/mcp`, origin, state, close: () => { server.closeAllConnections(); server.close(); } };
}

const subst = (value, map) => JSON.parse(JSON.stringify(value === undefined ? null : value), (_, v) => (typeof v === 'string'
  ? Object.entries(map).reduce((acc, [from, to]) => acc.split(from).join(to), v) : v));

/** A step is run against a fresh wiring built from the scenario, but the rate limiter and the credential fakes live across steps. */
async function run(scenario, fake) {
  const map = { $FAKE: fake.url, $ORIGIN: fake.origin, $DEAD: 'http://127.0.0.1:1/mcp' };
  const servers = subst(scenario.servers, map).filter((s) => !s.directory);
  const directoryServers = subst(scenario.servers, map).filter((s) => s.directory);
  const store = new AsyncLocalStorage();
  const brokerLog = [];
  const oauthQueue = [...(scenario.oauth || [])];
  const keysQueue = Array.isArray(scenario.keys) ? [...scenario.keys] : [scenario.keys === undefined ? null : scenario.keys];
  const transient = () => Object.assign(new Error('The sign-in to this server could not be refreshed right now.'), { transient: true, status: 503 });
  const wiring = createMcpWiring({
    servers, mcp, bindBoxes: () => [], scope: store,
    directoryMcp: { asServers: () => directoryServers, boxFor: () => ({}), headersFor: (id) => (scenario.shared || {})[id] || {}, signal: () => 'static' },
    mcpOAuth: {
      connected: () => true,
      async session(userId, serverId, rejected) {
        if (!userId) return null; // rust-mcp-credentials.cjs: no account, no sign-in
        brokerLog.push(['session', userId, serverId, rejected]);
        const next = oauthQueue.length > 1 ? oauthQueue.shift() : oauthQueue[0];
        if (next && next.transient) throw transient();
        return next || null;
      },
      async tokenFor() { return null; },
      async reject(userId, serverId, generation) { brokerLog.push(['reject', userId, serverId, generation]); return true; },
    },
    mcpKeys: {
      hasKey: () => true,
      async headers(userId, serverId) {
        if (!userId) return null; // rust-mcp-credentials.cjs: no account, no key
        brokerLog.push(['key', userId, serverId]);
        const next = keysQueue.length > 1 ? keysQueue.shift() : keysQueue[0];
        if (next === 'transient') throw transient();
        return next || null;
      },
    },
    directoryUrlAllowed: async () => scenario.directoryAllowed !== false,
    credentialOriginAllowed: createCredentialOriginCheck(subst(scenario.origins || [], map).join(',')),
    storageFor: () => subst(scenario.storage || { kind: 'local' }, map),
    isWriteTool: () => false,
    internal: { mintToken: () => 'INTERNAL-TOKEN' },
    internalKey: Buffer.alloc(32, 1),
    reduceToolResult, resultCap: 8000,
    env: scenario.env || {},
    logger: { log() {}, warn() {} },
    directoryCheckMs: 0,
  });
  const out = [];
  for (const step of scenario.steps) {
    fake.state.behaviour = step.mcp || {};
    fake.state.calls = 0;
    fake.state.log.length = 0;
    brokerLog.length = 0;
    const call = step.call;
    // What the caller says offers the name becomes the discovery state the Node executor routes by.
    wiring.state.offers = new Map(); wiring.state.tools = new Map();
    const ids = [...call.offers];
    if (ids.length) {
      wiring.state.offers.set(call.name, new Map(ids.map((id) => [id, { tool: { function: { name: call.name } }, readOnly: false, serverId: id }])));
      wiring.state.tools.set(call.name, { tool: { function: { name: call.name } }, readOnly: false, serverId: ids[0] });
    }
    const scoped = {
      ...(call.workspace ? { workspace: { userId: call.workspace } } : {}),
      ...(call.caller ? { authn: { user: { id: call.caller } } } : {}),
      ...(call.editTarget ? { internalEditTarget: 'f.md' } : {}),
    };
    const args = call.args === undefined ? undefined : subst(call.args, map);
    let expect;
    if (step.operator) {
      try { expect = { text: await store.run(scoped, () => wiring.executeOperatorToolCall(call.name, args)) }; } catch (e) { expect = { throws: e.publicMessage || e.message }; }
    } else {
      expect = { text: await store.run(scoped, () => wiring.executeMcpToolCall(call.name, args, undefined, call.server === undefined ? undefined : call.server)) };
    }
    if (expect.text !== undefined) expect.text = expect.text.replace(/request \d+/g, 'request N').replace(/reply id \d+/g, 'reply id N');
    out.push({ call: step.call, ...(step.operator ? { operator: true } : {}), mcp: step.mcp || {}, expect, requests: fake.state.log.map((r) => ({ ...r })), broker: brokerLog.map((r) => [...r]) });
  }
  return out;
}

const OK = {};
const HELLO = { result: { content: [{ type: 'text', text: 'hello' }] } };
const text = (t) => ({ call: [{ result: { content: [{ type: 'text', text: t }] } }] });
const srv = (id, auth, more = {}) => ({ id, url: '$FAKE', auth, ...more });
const call = (name, more = {}) => ({ name, args: { q: 'x' }, offers: ['s'], caller: 'u1', workspace: 'u1', ...more });
const step = (c, mcpB, extra = {}) => ({ call: c, mcp: mcpB, ...extra });

const records = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i, path: `/Documents/file-${i}.md`, etag: `e${i}`, note: '', tags: [], size: 100 + i, mime: 'text/markdown' })));
const nested = JSON.stringify({ a: { b: '', c: 'y'.repeat(400), d: [] }, list: Array.from({ length: 300 }, (_, i) => ({ k: i, v: 'z'.repeat(30) })) });

const SCENARIOS = [
  // ── routing (#865)
  { id: 'route-unknown-name', servers: [srv('s', 'none')], steps: [step(call('nothing', { offers: [] }), OK)] },
  { id: 'route-unknown-on-server', servers: [srv('s', 'none'), srv('t', 'none')], steps: [step(call('t1', { server: 'zz', offers: ['s'] }), OK)] },
  { id: 'route-ambiguous', servers: [srv('s', 'none'), srv('t', 'none')], steps: [step(call('t1', { offers: ['s', 't'] }), OK)] },
  { id: 'route-named-server-wins-the-tie', servers: [srv('s', 'none'), srv('t', 'none')], steps: [step(call('t1', { server: 't', offers: ['s', 't'] }), OK)] },
  { id: 'route-server-no-longer-configured', servers: [srv('t', 'none')], steps: [step(call('t1', { offers: ['gone'] }), OK)] },
  // ── an approved project-file edit goes only to noevia's own server
  { id: 'edit-target-refused-elsewhere', servers: [srv('s', 'none')], steps: [step(call('project_edit', { editTarget: true }), OK)] },
  { id: 'edit-target-allowed-on-internal', servers: [srv('s', 'internal')], steps: [step(call('project_edit', { editTarget: true, internalAuth: 'Bearer INTERNAL-TOKEN' }), OK)] },
  // ── credentials by mode
  { id: 'auth-none', servers: [srv('s', 'none')], steps: [step(call('t1'), OK)] },
  { id: 'auth-bearer', servers: [srv('s', 'bearer', { tokenEnv: 'SYNTH_TOKEN' })], env: { SYNTH_TOKEN: 'tok-1' }, steps: [step(call('t1'), OK)] },
  { id: 'auth-bearer-missing', servers: [srv('s', 'bearer', { tokenEnv: 'SYNTH_TOKEN' })], env: {}, steps: [step(call('t1'), OK)] },
  { id: 'auth-internal', servers: [srv('s', 'internal')], steps: [step(call('t1', { internalAuth: 'Bearer INTERNAL-TOKEN' }), OK)] },
  { id: 'auth-internal-without-a-session', servers: [srv('s', 'internal')], steps: [step(call('t1', { workspace: null }), OK)] },
  { id: 'auth-nextcloud', servers: [srv('s', 'nextcloud')], origins: ['$ORIGIN'], storage: { kind: 'nextcloud', baseUrl: '$ORIGIN', username: 'alice', secret: 'app-pass' }, steps: [step(call('t1'), OK)] },
  { id: 'auth-nextcloud-webdav-kind', servers: [srv('s', 'nextcloud')], origins: ['$ORIGIN/'], storage: { kind: 'webdav', baseUrl: '$ORIGIN/dav', username: 'alice', secret: 'app-pass' }, steps: [step(call('t1'), OK)] },
  { id: 'auth-nextcloud-origin-not-listed', servers: [srv('s', 'nextcloud')], origins: ['https://other.example'], storage: { kind: 'nextcloud', baseUrl: '$ORIGIN', username: 'alice', secret: 'app-pass' }, steps: [step(call('t1'), OK)] },
  { id: 'auth-nextcloud-not-connected', servers: [srv('s', 'nextcloud')], origins: ['$ORIGIN'], storage: { kind: 'local' }, steps: [step(call('t1'), OK)] },
  { id: 'auth-nextcloud-no-secret', servers: [srv('s', 'nextcloud')], origins: ['$ORIGIN'], storage: { kind: 'nextcloud', baseUrl: '$ORIGIN', username: 'alice', secret: '' }, steps: [step(call('t1'), OK)] },
  { id: 'auth-nextcloud-no-workspace', servers: [srv('s', 'nextcloud')], origins: ['$ORIGIN'], storage: { kind: 'nextcloud', baseUrl: '$ORIGIN', username: 'alice', secret: 'p' }, steps: [step(call('t1', { workspace: null }), OK)] },
  { id: 'auth-directory-shared-key', servers: [srv('dir-x', 'directory', { directory: true, title: 'Dir X' })], shared: { 'dir-x': { 'X-Api-Key': 'shared-1' } }, steps: [step(call('t1', { offers: ['dir-x'] }), OK)] },
  { id: 'auth-directory-no-key', servers: [srv('dir-x', 'none', { directory: true, title: 'Dir X' })], steps: [step(call('t1', { offers: ['dir-x'] }), OK)] },
  { id: 'directory-address-no-longer-public', servers: [srv('dir-x', 'none', { directory: true, title: 'Dir X' })], directoryAllowed: false, steps: [step(call('t1', { offers: ['dir-x'] }), OK)] },
  { id: 'auth-personal-key', servers: [srv('dir-p', 'personal', { directory: true, title: 'Dir P' })], keys: { 'X-Api-Key': 'mine' }, steps: [step(call('t1', { offers: ['dir-p'] }), OK)] },
  { id: 'auth-personal-no-key', servers: [srv('dir-p', 'personal', { directory: true, title: 'Dir P' })], keys: null, steps: [step(call('t1', { offers: ['dir-p'] }), OK)] },
  { id: 'auth-personal-broker-cannot-say', servers: [srv('dir-p', 'personal', { directory: true, title: 'Dir P' })], keys: 'transient', steps: [step(call('t1', { offers: ['dir-p'] }), OK)] },
  { id: 'auth-personal-without-an-account', servers: [srv('dir-p', 'personal', { directory: true, title: 'Dir P' })], keys: { 'X-Api-Key': 'mine' }, steps: [step(call('t1', { offers: ['dir-p'], caller: null }), OK)] },
  { id: 'auth-oauth-token', servers: [srv('dir-o', 'oauth', { directory: true, title: 'Dir O' })], oauth: [{ accessToken: 'acc-1', generation: 'g1' }], steps: [step(call('t1', { offers: ['dir-o'] }), OK)] },
  { id: 'auth-oauth-signed-out', servers: [srv('dir-o', 'oauth', { directory: true, title: 'Dir O' })], oauth: [null], steps: [step(call('t1', { offers: ['dir-o'] }), OK)] },
  { id: 'auth-oauth-broker-cannot-say', servers: [srv('dir-o', 'oauth', { directory: true, title: 'Dir O' })], oauth: [{ transient: true }], steps: [step(call('t1', { offers: ['dir-o'] }), OK)] },
  // ── one retry after a refused sign-in
  { id: 'oauth-refused-then-new-token', servers: [srv('dir-o', 'oauth', { directory: true, title: 'Dir O' })], oauth: [{ accessToken: 'acc-1', generation: 'g1' }, { accessToken: 'acc-2', generation: 'g2' }], steps: [step(call('t1', { offers: ['dir-o'] }), { call: [{ http: { status: 401, body: 'nope' } }, HELLO] })] },
  { id: 'oauth-refused-twice-marks-the-new-sign-in', servers: [srv('dir-o', 'oauth', { directory: true, title: 'Dir O' })], oauth: [{ accessToken: 'acc-1', generation: 'g1' }, { accessToken: 'acc-2', generation: 'g2' }], steps: [step(call('t1', { offers: ['dir-o'] }), { call: [{ http: { status: 401, body: 'nope' } }, { http: { status: 401, body: 'still' } }] })] },
  { id: 'oauth-refused-same-token-marks-it', servers: [srv('dir-o', 'oauth', { directory: true, title: 'Dir O' })], oauth: [{ accessToken: 'acc-1', generation: 'g1' }], steps: [step(call('t1', { offers: ['dir-o'] }), { call: [{ http: { status: 401, body: 'nope' } }] })] },
  { id: 'oauth-refused-broker-cannot-say-leaves-401', servers: [srv('dir-o', 'oauth', { directory: true, title: 'Dir O' })], oauth: [{ accessToken: 'acc-1', generation: 'g1' }, { transient: true }], steps: [step(call('t1', { offers: ['dir-o'] }), { call: [{ http: { status: 401, body: 'nope' } }] })] },
  { id: 'oauth-refused-no-sign-in-left', servers: [srv('dir-o', 'oauth', { directory: true, title: 'Dir O' })], oauth: [{ accessToken: 'acc-1', generation: 'g1' }, null], steps: [step(call('t1', { offers: ['dir-o'] }), { call: [{ http: { status: 401, body: 'nope' } }] })] },
  { id: 'non-oauth-401-is-just-an-error', servers: [srv('s', 'none')], steps: [step(call('t1'), { call: [{ http: { status: 401, body: 'nope' } }] })] },
  // ── the 429 wait (#1693, #1701)
  { id: 'rate-limit-http-429-then-cooling-then-other-account', servers: [srv('s', 'nextcloud')], origins: ['$ORIGIN'], storage: { kind: 'nextcloud', baseUrl: '$ORIGIN', username: 'a', secret: 'p' }, steps: [
    step(call('t1'), { call: [{ http: { status: 429, body: 'slow down', retryAfter: '7' } }] }),
    step(call('t1'), OK),
    step(call('t1', { caller: 'u2', workspace: 'u2' }), OK)] },
  { id: 'rate-limit-http-429-without-retry-after', servers: [srv('s', 'none')], steps: [step(call('t1'), { call: [{ http: { status: 429, body: 'x' } }] }), step(call('t1'), OK)] },
  { id: 'rate-limit-http-429-retry-after-capped-below-a-second', servers: [srv('s', 'none')], steps: [step(call('t1'), { call: [{ http: { status: 429, body: 'x', retryAfter: '0.2' } }] }), step(call('t1'), OK)] },
  { id: 'rate-limit-tool-error-text', servers: [srv('s', 'none')], steps: [step(call('t1'), { call: [{ result: { isError: true, content: [{ type: 'text', text: 'Rate limit exceeded for this key' }] } }] }), step(call('t1'), OK)] },
  { id: 'a-tool-error-that-is-not-a-rate-limit', servers: [srv('s', 'none')], steps: [step(call('t1'), { call: [{ result: { isError: true, content: [{ type: 'text', text: 'file not found' }] } }] }), step(call('t1'), OK)] },
  { id: 'a-success-clears-the-wait-of-a-text-error', servers: [srv('s', 'none')], steps: [step(call('t1'), OK), step(call('t1'), OK)] },
  // ── transport failures
  { id: 'http-500-is-a-neutral-line', servers: [srv('s', 'none')], steps: [step(call('t1'), { call: [{ http: { status: 500, body: 'secret internal detail' } }] })] },
  { id: 'http-500-at-initialize', servers: [srv('s', 'none')], steps: [step(call('t1'), { init: { http: { status: 503, body: 'down' } } })] },
  { id: 'json-rpc-error', servers: [srv('s', 'none')], steps: [step(call('t1'), { call: [{ rpcError: { code: -32000, message: 'boom' } }] })] },
  { id: 'reply-id-mismatch', servers: [srv('s', 'none')], steps: [step(call('t1'), { call: [{ mismatch: true }] })] },
  { id: 'reply-is-not-json', servers: [srv('s', 'none')], steps: [step(call('t1'), { call: [{ badJson: true }] })] },
  { id: 'reply-over-the-body-cap', servers: [srv('s', 'none')], steps: [step(call('t1'), { call: [{ huge: true }] })] },
  { id: 'redirect-is-an-error', servers: [srv('s', 'none')], steps: [step(call('t1'), { call: [{ redirect: true }] })] },
  { id: 'server-unreachable', servers: [srv('s', 'none', { url: '$DEAD' })], steps: [step(call('t1'), OK)] },
  { id: 'event-stream-reply', servers: [srv('s', 'none')], steps: [step(call('t1'), { call: [{ sse: HELLO.result }] })] },
  { id: 'event-stream-with-other-traffic-only', servers: [srv('s', 'none')], steps: [step(call('t1'), { call: [{ sseOther: true }] })] },
  { id: 'session-is-echoed-and-closed', servers: [srv('s', 'none')], steps: [step(call('t1'), { sid: 'SESSION-1', call: [HELLO] })] },
  { id: 'session-close-refused-does-not-matter', servers: [srv('s', 'none')], steps: [step(call('t1'), { sid: 'SESSION-1', del: 405, call: [HELLO] })] },
  { id: 'session-closed-after-a-failed-call', servers: [srv('s', 'none')], steps: [step(call('t1'), { sid: 'SESSION-1', call: [{ http: { status: 500, body: 'x' } }] })] },
  { id: 'a-credential-header-cannot-take-over-the-session', servers: [srv('dir-x', 'directory', { directory: true, title: 'D' })], shared: { 'dir-x': { 'Mcp-Session-Id': 'evil', Accept: 'text/plain', 'X-Api-Key': 'k' } }, steps: [step(call('t1', { offers: ['dir-x'] }), { sid: 'SESSION-1', call: [HELLO] })] },
  // ── what the model is given
  { id: 'result-no-output', servers: [srv('s', 'none')], steps: [step(call('t1'), { call: [{ result: { content: [] } }] })] },
  { id: 'result-null', servers: [srv('s', 'none')], steps: [step(call('t1'), { call: [{ result: null }] })] },
  { id: 'result-tool-error', servers: [srv('s', 'none')], steps: [step(call('t1'), { call: [{ result: { isError: true, content: [{ type: 'text', text: 'bad input' }] } }] })] },
  { id: 'result-tool-error-without-detail', servers: [srv('s', 'none')], steps: [step(call('t1'), { call: [{ result: { isError: true, content: [] } }] })] },
  { id: 'result-structured-content', servers: [srv('s', 'none')], steps: [step(call('t1'), { call: [{ result: { content: [], structuredContent: { ok: true, rows: [1, 2] } } }] })] },
  { id: 'result-other-content-kinds', servers: [srv('s', 'none')], steps: [step(call('t1'), { call: [{ result: { content: [{ type: 'image', data: 'AAAA' }, { type: 'text', text: ' after ' }, null, { type: 'resource' }, { type: 'text' }] } }] })] },
  { id: 'result-content-not-iterable', servers: [srv('s', 'none')], steps: [step(call('t1'), { call: [{ result: { content: { type: 'text' } } }] })] },
  { id: 'result-long-prose-is-cut', servers: [srv('s', 'none')], steps: [step(call('t1'), text('p '.repeat(6000)))] },
  { id: 'result-uniform-records-are-tabulated', servers: [srv('s', 'none')], steps: [step(call('t1'), text(records(400)))] },
  { id: 'result-nested-json-is-compacted', servers: [srv('s', 'none')], steps: [step(call('t1'), text(nested))] },
  { id: 'result-multibyte-text-measured-in-utf16', servers: [srv('s', 'none')], steps: [step(call('t1'), text('😀'.repeat(6000)))] },
  // ── arguments
  { id: 'arguments-null-become-an-empty-object', servers: [srv('s', 'none')], steps: [step(call('t1', { args: null }), OK), step(call('t1', { args: undefined }), OK)] },
  { id: 'arguments-pass-through-unchanged', servers: [srv('s', 'none')], steps: [step(call('t1', { args: { n: 1.5, s: 'é', nested: { a: [1, null, 'x'] }, big: 12345678901234567890 } }), OK)] },
  // ── deep research's fixed callers (#865, #891)
  { id: 'operator-one-server', servers: [srv('s', 'none')], steps: [step(call('tavily_search', { offers: ['s'] }), OK, { operator: true })] },
  { id: 'operator-ignores-a-directory-twin', servers: [srv('s', 'none'), srv('dir-x', 'none', { directory: true, title: 'D' })], steps: [step(call('tavily_search', { offers: ['dir-x', 's'] }), OK, { operator: true })] },
  { id: 'operator-none-offers-it', servers: [srv('dir-x', 'none', { directory: true, title: 'D' })], steps: [step(call('tavily_search', { offers: ['dir-x'] }), OK, { operator: true })] },
  { id: 'operator-two-servers-is-ambiguous', servers: [srv('s', 'none'), srv('t', 'none')], steps: [step(call('tavily_search', { offers: ['s', 't'] }), OK, { operator: true })] },
  { id: 'operator-nobody-offers-it', servers: [srv('s', 'none')], steps: [step(call('tavily_search', { offers: [] }), OK, { operator: true })] },
];

(async () => {
  const fake = await startFake();
  const cases = [];
  for (const scenario of SCENARIOS) {
    const { steps, ...rest } = scenario;
    const ran = await run(scenario, fake);
    cases.push({ ...rest, steps: ran });
  }
  fake.close();
  process.stdout.write(`${JSON.stringify({ version: 1, cases }, null, 1)}\n`);
})().catch((err) => { console.error(err); process.exit(1); });
