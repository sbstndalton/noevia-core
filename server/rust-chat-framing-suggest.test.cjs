'use strict';
// Chat port S4: POST /api/chat-framing/suggest is the Rust front's. Node refuses the public POST before
// authentication (other methods keep the gate and the signed-in 405) and answers only the front's loopback
// call, as the user it names. The decision service is faked throughout: no model runs. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const http = require('./http.cjs');
const { OWNED_ROUTES, ROUTE_REFUSAL, BRIDGE_PATH, MESSAGE_CAP, owned, refuseOwned, createSuggestBridge } = require('./rust-chat-framing-suggest.cjs');

const SECRET = 'synthetic-front-secret-0123456789abcdef';
const USER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

/** A request as the front's loopback call makes it (or as something else would). */
function request({ body = '', method = 'POST', url = BRIDGE_PATH, peer = '127.0.0.1', headers = {} } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  return Object.assign(req, { method, url, socket: { remoteAddress: peer }, headers: { 'x-noevia-store-token': SECRET, ...headers } });
}

/** A response capturing what http.cjs json() writes: status, headers and the exact body bytes. */
function response() {
  const res = { statusCode: 200, headers: {}, chunks: [] };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.writeHead = (status, h = {}) => { res.statusCode = status; for (const [k, v] of Object.entries(h)) res.setHeader(k, v); return res; };
  res.end = (chunk) => { if (chunk !== undefined) res.chunks.push(Buffer.from(chunk)); res.ended = true; };
  res.text = () => Buffer.concat(res.chunks).toString('utf8');
  return res;
}

function harness({ suggest = async (args) => ({ frame: null, reason: 'disabled', seen: args }), workspace } = {}) {
  const calls = [], scopes = [];
  let current = null;
  const lists = { [USER]: { projects: [{ id: 'mine', name: 'Mine' }], chats: [{ id: 'c1', title: 'T' }] } };
  const bridge = createSuggestBridge({
    secret: SECRET, json: http.json, readJson: http.readJson, log: () => {},
    asUser: async (userId, fn) => { scopes.push(userId); const saved = current; current = userId; try { return await fn(); } finally { current = saved; } },
    workspace: workspace || (() => lists[current] || { projects: [], chats: [] }),
    framing: { suggest: async (args) => { calls.push({ ...args, as: current }); return suggest(args); } },
  });
  return { bridge, calls, scopes };
}

test('the public POST is refused before authentication; other methods and spellings are not', () => {
  assert.deepEqual([...OWNED_ROUTES], ['POST /api/chat-framing/suggest']);
  const sent = [];
  const json = (_res, status, body) => sent.push({ status, body });
  const url = (pathname) => () => ({ pathname });
  assert.equal(refuseOwned({ method: 'POST', headers: {} }, {}, { json, parseRequestUrl: url('/api/chat-framing/suggest') }), true);
  assert.deepEqual(sent.pop(), { status: 503, body: ROUTE_REFUSAL });
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
    assert.equal(refuseOwned({ method, headers: {} }, {}, { json, parseRequestUrl: url('/api/chat-framing/suggest') }), false, method);
  }
  for (const pathname of ['/api/chat-framing/suggest/', '/api/chat-framing/suggestx', '/api/chat-framing/preferences']) {
    assert.equal(owned('POST', pathname), false, pathname);
  }
  assert.equal(refuseOwned({ method: 'POST', headers: {} }, {}, { json, parseRequestUrl: () => null }), false);
  assert.equal(sent.length, 0);
  // In index.cjs: before authentication and the workspace load, beside the other framing refusal.
  const source = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  const start = source.indexOf('async function handleRequestInner');
  const refusal = source.indexOf("require('./rust-chat-framing-suggest.cjs').refuseOwned(", start);
  const bridge = source.indexOf('await chatFramingSuggestBridge(req, res)', start);
  assert.ok(refusal > start && bridge > refusal);
  assert.ok(bridge < source.indexOf('const preAuth = requestAuth.authenticate(req)', start));
  assert.ok(bridge < source.indexOf('workspaceStore.get(', start));
});

test('only the front reaches the bridge: anything else is the 404 of an unknown path, nothing suggested', async () => {
  const { bridge, calls } = harness();
  const body = JSON.stringify({ user: USER, message: 'hi', chatId: null });
  for (const r of [
    request({ body, peer: '10.0.0.5' }),
    request({ body, headers: { 'x-noevia-store-token': 'wrong' } }),
    request({ body, headers: { 'x-noevia-client-ip': '203.0.113.9' } }),
    request({ body, headers: { 'x-forwarded-for': '203.0.113.9' } }),
    request({ body, method: 'GET' }),
  ]) {
    const res = response();
    assert.equal(await bridge(r, res), true);
    assert.deepEqual([res.statusCode, res.text()], [404, '{"error":"Not found"}']);
  }
  assert.equal(await bridge(request({ body, url: '/internal/chat-framing/other' }), response()), false);
  assert.equal(calls.length, 0);
});

test('the bridge refuses a body the front never sends', async () => {
  const { bridge, calls } = harness();
  const cases = [
    ['{', 400, '{"error":"invalid JSON"}'],
    ['null', 400], ['[]', 400], [JSON.stringify({ message: 'hi', chatId: null }), 400],
    [JSON.stringify({ user: USER, chatId: null }), 400],
    [JSON.stringify({ user: USER, message: 'x'.repeat(MESSAGE_CAP + 1), chatId: null }), 400],
    [JSON.stringify({ user: USER, message: 'hi', chatId: 7 }), 400],
    [JSON.stringify({ user: USER, message: 'hi' }), 400],
  ];
  for (const [body, status, text] of cases) {
    const res = response();
    await bridge(request({ body }), res);
    assert.equal(res.statusCode, status, body);
    if (text) assert.equal(res.text(), text);
  }
  assert.equal(calls.length, 0);
});

test('the suggestion runs as the named user, over that user\'s lists, and is answered as the old route answered it', async () => {
  const frame = { kind: 'idea', projectId: 'mine', tags: ['t'], links: [{ chatId: 'c1' }], confirmed: false, source: 'suggested' };
  const { bridge, calls, scopes } = harness({ suggest: async () => ({ frame, reason: null }) });
  const res = response();
  // The front already cut the message; a lone surrogate it left (a halved pair) arrives intact.
  const message = `${'m'.repeat(MESSAGE_CAP - 1)}\ud83d`;
  await bridge(request({ body: JSON.stringify({ user: USER, message, chatId: 'c9' }) }), res);
  assert.deepEqual(scopes, [USER]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].as, USER);
  assert.equal(calls[0].message, message);
  assert.equal(calls[0].chatId, 'c9');
  assert.deepEqual(calls[0].projects, [{ id: 'mine', name: 'Mine' }]);
  assert.deepEqual(calls[0].chats, [{ id: 'c1', title: 'T' }]);
  // Byte for byte what routes/chat-framing.cjs sent: http.cjs json(res, 200, result).
  const old = response();
  http.json(old, 200, { frame, reason: null });
  assert.equal(res.statusCode, 200);
  assert.equal(res.text(), old.text());
  assert.deepEqual(res.headers, old.headers);
  // A null chat id is passed on as null.
  await bridge(request({ body: JSON.stringify({ user: USER, message: 'hi', chatId: null }) }), response());
  assert.equal(calls[1].chatId, null);
});

test('a workspace that cannot be read is the old 200 error answer; a failing suggestion is a 502 the front fails open on', async () => {
  const unreadable = harness({ workspace: () => { throw new Error('ENOENT'); } });
  let res = response();
  await unreadable.bridge(request({ body: JSON.stringify({ user: USER, message: 'hi', chatId: null }) }), res);
  assert.deepEqual([res.statusCode, res.text()], [200, '{"frame":null,"reason":"error"}']);
  assert.equal(unreadable.calls.length, 0);
  const failing = harness({ suggest: async () => { throw new Error('decision service unavailable'); } });
  res = response();
  await failing.bridge(request({ body: JSON.stringify({ user: USER, message: 'hi', chatId: null }) }), res);
  assert.equal(res.statusCode, 502);
});

test('index.cjs no longer counts the suggestion budget or reaches the decision from the public route', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.equal(source.includes('chat-frame:'), false, 'the chat-frame: budget is the front\'s');
  assert.match(source, /createChatFramingRoutes\(\{ json, readJson, settings: framingSettings \}\)/);
  assert.match(source, /createSuggestBridge\(\{\n  secret: FRONT_SECRET, json, readJson, framing: chatFraming,/);
});
