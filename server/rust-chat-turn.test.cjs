'use strict';
// Chat port S5: POST /api/chat is the Rust front's relay. Node refuses the public POST before the gate and
// authentication, and runs the unchanged pipeline only for the front's loopback /internal/chat/turn (and answers
// its gate probe /internal/chat/gate). The second half drives the real chat loop (createChatHandler) behind the
// bridge on a real socket, with a scripted synthetic model: the stream's bytes, its keep-alive comments and the
// front closing the socket mid-reply (#679). Synthetic data only; no model runs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('./http.cjs');
const turn = require('./rust-chat-turn.cjs');

const SECRET = 'synthetic-front-secret-0123456789abcdef';
const USER_ID = 'synthetic-user-a';

function request({ url = turn.TURN_PATH, method = 'POST', peer = '127.0.0.1', headers = {} } = {}) {
  return { method, url, socket: { remoteAddress: peer }, headers: { 'x-noevia-store-token': SECRET, [turn.USER_HEADER]: USER_ID, ...headers } };
}
function sink() {
  const sent = [];
  return { sent, json: (_res, status, body) => sent.push({ status, body }) };
}

test('the public POST is refused before the gate; a relayed turn, other methods and spellings are not', () => {
  assert.deepEqual([...turn.OWNED_ROUTES], ['POST /api/chat']);
  const { sent, json } = sink();
  const url = (pathname) => () => ({ pathname });
  assert.equal(turn.refuseOwned({ method: 'POST', headers: {} }, {}, { json, parseRequestUrl: url('/api/chat') }), true);
  assert.deepEqual(sent.pop(), { status: 503, body: turn.ROUTE_REFUSAL });
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
    assert.equal(turn.refuseOwned({ method, headers: {} }, {}, { json, parseRequestUrl: url('/api/chat') }), false, method);
  }
  for (const pathname of ['/api/chat/', '/api/chats', '/api/chatx', '/api/chat-framing/suggest']) assert.equal(turn.owned('POST', pathname), false, pathname);
  assert.equal(turn.refuseOwned({ method: 'POST', headers: {} }, {}, { json, parseRequestUrl: () => null }), false);
  // The relay itself is the one POST /api/chat that passes.
  const req = request();
  assert.equal(turn.createTurnBridge({ secret: SECRET, json }).accept(req, {}), 'turn');
  assert.equal(turn.refuseOwned(req, {}, { json, parseRequestUrl: url('/api/chat') }), false);
  assert.equal(sent.length, 0);
});

test('only the front reaches the relay: anything else is the 404 of an unknown path', () => {
  const { sent, json } = sink();
  const bridge = turn.createTurnBridge({ secret: SECRET, json });
  const refused = [
    request({ headers: { 'x-noevia-store-token': 'wrong' } }),
    request({ headers: { 'x-noevia-store-token': undefined } }),
    request({ peer: '10.0.0.7' }),
    // A request the front proxies carries the client's address; it is never the front's own call.
    request({ headers: { 'x-noevia-client-ip': '203.0.113.9' } }),
    request({ headers: { 'x-forwarded-for': '203.0.113.9' } }),
    request({ method: 'GET' }),
    request({ url: turn.GATE_PATH, method: 'PUT' }),
  ];
  for (const req of refused) {
    assert.equal(bridge.accept(req, {}), 'done');
    assert.deepEqual(sent.pop(), { status: 404, body: { error: 'Not found' } });
    assert.equal(req.url === turn.PATH, false, 'not rewritten');
    assert.equal(turn.relayedUser(req), null);
  }
  assert.equal(turn.createTurnBridge({ secret: '', json }).accept(request(), {}), 'done', 'an empty secret trusts nobody');
  assert.equal(sent.pop().status, 404);
  const noUser = request({ headers: { [turn.USER_HEADER]: '' } });
  assert.equal(bridge.accept(noUser, {}), 'done');
  assert.deepEqual(sent.pop(), { status: 400, body: { error: 'A user is required.' } });
  for (const url of ['/api/chat', '/internal/chat', '/internal/chat/turn/', '/internal/chat-framing/suggest']) {
    assert.equal(bridge.accept(request({ url }), {}), null, url);
  }
  assert.equal(sent.length, 0);
});

test('a trusted turn becomes POST /api/chat with the client headers back and the secret gone', () => {
  const { sent, json } = sink();
  const bridge = turn.createTurnBridge({ secret: SECRET, json });
  const req = request({ url: `${turn.TURN_PATH}?x=1`, headers: {
    cookie: 'cowork_session=s; cowork_csrf=c', 'x-csrf-token': 'c', origin: 'http://front.test',
    [turn.RELAY_CLIENT_HEADER]: '203.0.113.9', [turn.RELAY_FORWARDED_HEADER]: '203.0.113.9',
  } });
  assert.equal(bridge.accept(req, {}), 'turn');
  assert.equal(req.url, '/api/chat');
  assert.equal(turn.relayedUser(req), USER_ID);
  assert.deepEqual(req.headers, {
    cookie: 'cowork_session=s; cowork_csrf=c', 'x-csrf-token': 'c', origin: 'http://front.test',
    'x-noevia-client-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9',
  });
  // Without a forwarded address, none is invented.
  const bare = request();
  bridge.accept(bare, {});
  assert.deepEqual(bare.headers, {});
  // The gate probe carries no user.
  const probe = request({ url: turn.GATE_PATH, headers: { [turn.USER_HEADER]: undefined } });
  assert.equal(bridge.accept(probe, {}), 'gate');
  assert.equal(probe.url, '/api/chat');
  assert.equal(turn.relayedUser(probe), null);
  assert.equal(sent.length, 0);
});

test('index.cjs: the relay is accepted before the gate, refused direct turns take no gate, the user is bound', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  const top = source.slice(source.indexOf('async function handleRequest(req,res) {'));
  const at = (needle) => { const i = top.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  assert.ok(at('chatTurnBridge.accept(req,res)') < at('enterChatInference('));
  assert.match(top, /const chatTurnOwned=!relay && require\('\.\/rust-chat-turn\.cjs'\)\.owned\(req\.method,pathname\);/);
  assert.match(top, /\(pathname==='\/api\/chat' && !chatTurnOwned\)/);
  assert.ok(at("if(relay==='gate'){if(leave)leave();res.statusCode=204;res.end();return;}") < at("if(leave){res.once('finish',leave)"));
  const inner = source.slice(source.indexOf('async function handleRequestInner(req, res) {'), source.indexOf('async function handleRequestScoped('));
  assert.match(inner, /if \(require\('\.\/rust-chat-turn\.cjs'\)\.refuseOwned\(req, res, \{ parseRequestUrl, json \}\)\) return;/);
  assert.ok(inner.indexOf("rust-chat-turn.cjs').refuseOwned") < inner.indexOf('requestAuth.authenticate(req)'));
  assert.match(inner, /const preAuth = requestAuth\.authenticate\(req\);\n.*\n  const relayUser = require\('\.\/rust-chat-turn\.cjs'\)\.relayedUser\(req\);\n  if \(relayUser && \(!preAuth \|\| preAuth\.user\.id !== relayUser\)\) return unauthorized\(res\);/);
  assert.match(source, /const chatTurnBridge = require\('\.\/rust-chat-turn\.cjs'\)\.createTurnBridge\(\{\n  secret: FRONT_SECRET, json,\n\}\);/);
});

// --- The real chat loop behind the bridge, on a socket. ---------------------------------------------------------
const WASM = fs.existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) || process.env.DAV_PARSE_WASM_REQUIRED === '1';
const skip = WASM ? false : 'dav-parse.wasm not built (provider egress is Rust-only since #1071)';

const sse = (obj) => Buffer.from(`data: ${JSON.stringify(obj)}\n\n`);
const say = (text) => sse({ choices: [{ delta: { content: text } }] });
const STALL = Symbol('stall');
const USER_MSG = { role: 'user', content: 'Write a four-line poem about tea.' };

/** The bridge, refuseOwned and routes/chat.cjs in index.cjs's order, around the real createChatHandler. */
async function relayServer(t, turns) {
  const { createChatHandler } = require('./chat.cjs');
  const { localTranscripts } = require('../tests/server/project-store-server.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-s5-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ws = { userId: USER_ID, dir: root, assetDir: () => '/synthetic-only', historyPath: (id) => path.join(root, `history-${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.json`), transcripts: localTranscripts(root) };
  const state = { aborted: 0, release: null };
  const fetch = async (_url, init) => {
    const chunks = turns.shift() || [say('SYNTHETIC-DONE')];
    return { ok: true, body: (async function* () {
      for (const chunk of chunks) {
        if (chunk === STALL) {
          await new Promise((resolve) => { state.release = resolve; init.signal?.addEventListener('abort', resolve, { once: true }); });
          if (init.signal?.aborted) { state.aborted += 1; throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }
          continue;
        }
        yield chunk;
      }
    })() };
  };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'),
    authService: { audit() {}, diaryEnabled: () => true },
    crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 40, STORED_HISTORY_CAP: 5000, DEFAULT_PROVIDER_ID: 'default', createToolExchange: require('./tool-exchange.cjs').createToolExchange,
    currentWorkspace: () => ws,
    getProject: () => ({ id: 'synthetic-project', model: 'answer-model', assets: [] }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://fixture.invalid' }),
    providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: require('./vision.cjs').createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true,
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [],
    CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' },
    requestScope: { getStore: () => ({ workspace: { userId: USER_ID } }) },
    resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (text) => ({ text: String(text) }),
    diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: http.json, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], executeToolCall: async () => 'unused',
    grantContext: async (raw) => require('../tests/server/chat-grant-fixture.cjs').context(raw, { holder: { kind: 'absent' } }), chatWideApproved: () => false,
    awaitApproval: () => new Promise(() => {}), recordUsage() {}, recordToolUse() {}, writeTargetFor: async () => null,
  });
  const chatRoutes = require('./routes/chat.cjs').createChatRoutes({
    json: http.json, readBody: http.readBody, bodyCap: 32 * 1024 * 1024, rateLimited: () => false, diaryEnabled: () => true, handleChat,
  });
  const bridge = turn.createTurnBridge({ secret: SECRET, json: http.json });
  const server = require('node:http').createServer(async (req, res) => {
    const relay = bridge.accept(req, res);
    if (relay === 'done') return;
    if (relay === 'gate') { res.statusCode = 204; res.end(); return; }
    if (turn.refuseOwned(req, res, { parseRequestUrl: http.parseRequestUrl, json: http.json })) return;
    const user = turn.relayedUser(req);
    if (!(await chatRoutes(req, res, { path: new URL(req.url, 'http://x').pathname, authn: user ? { user: { id: user } } : null }))) http.json(res, 404, { error: 'not found' });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { port: server.address().port, ws, state };
}

/** The front's side: one raw request; every chunk with its arrival time, and the socket to drop. */
function relay(port, { url = turn.TURN_PATH, body, headers = {} }) {
  const socket = net.connect(port, '127.0.0.1');
  const got = { bytes: Buffer.alloc(0), chunks: [], ended: false };
  socket.on('data', (d) => { got.bytes = Buffer.concat([got.bytes, d]); got.chunks.push({ at: Date.now(), text: String(d) }); });
  socket.on('end', () => { got.ended = true; });
  socket.on('close', () => { got.closed = true; });
  const head = { host: '127.0.0.1', 'x-noevia-store-token': SECRET, [turn.USER_HEADER]: USER_ID, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close', ...headers };
  socket.write(`POST ${url} HTTP/1.1\r\n${Object.entries(head).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n${body}`);
  return { socket, got };
}
const until = async (check, ms, what) => {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) assert.fail(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 20)); }
};
const store = (ws, id, history) => fs.writeFileSync(ws.historyPath(id), JSON.stringify({ history }));
const stored = (ws, id) => JSON.parse(fs.readFileSync(ws.historyPath(id), 'utf8')).history;
const turnBody = JSON.stringify({ projectId: 'synthetic-project', spaceId: 'synthetic-project', chatId: 'chat-s5', message: USER_MSG.content });

test('a relayed turn streams the loop\'s SSE bytes; a direct POST is refused', { skip }, async (t) => {
  const s = await relayServer(t, [[say('Hello'), say(' there.')]]);
  store(s.ws, 'chat-s5', [USER_MSG]);
  const { got } = relay(s.port, { body: turnBody });
  await until(() => got.ended, 10000, 'the stream ends');
  const text = got.bytes.toString('utf8');
  const [head, payload] = [text.slice(0, text.indexOf('\r\n\r\n')), text.slice(text.indexOf('\r\n\r\n') + 4)];
  assert.match(head, /^HTTP\/1\.1 200 OK\r\n/);
  assert.match(head, /\r\nContent-Type: text\/event-stream\r\n/);
  assert.match(head, /\r\nCache-Control: no-cache, no-transform\r\n/);
  assert.match(head, /\r\nX-Accel-Buffering: no\r\n/);
  const events = payload.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  assert.equal(events[0].type, 'meta');
  assert.ok(events.some((e) => e.type === 'delta' && e.text === 'Hello'));
  assert.equal(events.filter((e) => e.type === 'done').length, 1);
  // The same body straight at the public path: refused, the loop never runs.
  const direct = relay(s.port, { url: '/api/chat', body: turnBody, headers: { 'x-noevia-store-token': '', [turn.USER_HEADER]: '' } });
  await until(() => direct.got.ended, 5000, 'the refusal');
  const refusal = direct.got.bytes.toString('utf8');
  assert.match(refusal, /^HTTP\/1\.1 503 /);
  assert.ok(refusal.includes(JSON.stringify(turn.ROUTE_REFUSAL)), refusal);
});

test('keep-alive comments reach the front at most 5.5 s apart, and the front leaving saves the interrupted turn (#679)', { skip, timeout: 30000 }, async (t) => {
  const s = await relayServer(t, [[say('Steam rises slowly,'), say(' amber'), STALL, say(' never seen')]]);
  store(s.ws, 'chat-s5', [USER_MSG]);
  const { socket, got } = relay(s.port, { body: turnBody });
  await until(() => got.bytes.includes('Steam rises slowly,'), 10000, 'the first delta');
  // Two beats while the model is silent (the heartbeat runs from the headers on, every 5 s).
  await until(() => (got.bytes.toString().match(/: keep-alive\n\n/g) || []).length >= 2, 12000, 'two keep-alive comments');
  const beats = got.chunks.filter((c) => c.text.includes(': keep-alive\n\n')).map((c) => c.at);
  let last = got.chunks[0].at; // the headers
  for (const at of beats) {
    assert.ok(at - last <= 5500, `keep-alive gap ${at - last} ms`);
    last = at;
  }
  // The front closes the bridge socket (the client left): the loop aborts and the reply is kept as stopped.
  socket.destroy();
  await until(() => s.state.aborted === 1, 1000, 'the model request aborted within 1 s');
  await until(() => stored(s.ws, 'chat-s5').length === 2, 2000, 'the interrupted turn saved');
  const history = stored(s.ws, 'chat-s5');
  assert.deepEqual(history[0], USER_MSG);
  assert.equal(history[1].role, 'assistant');
  assert.equal(history[1].content, 'Steam rises slowly, amber');
});

// --- Chat port S7: the front asks for NDJSON (rust-chat-wire.cjs) and writes the event stream itself. -------------
const chatWire = require('./rust-chat-wire.cjs');
/** The head and the de-chunked body of one raw HTTP/1.1 answer. */
function answer(bytes) {
  const text = bytes.toString('latin1');
  const at = text.indexOf('\r\n\r\n');
  const head = text.slice(0, at);
  let rest = bytes.subarray(at + 4);
  if (!/\r\ntransfer-encoding: chunked\r\n/i.test(`${head}\r\n`)) return { head, body: rest.toString('utf8') };
  const parts = [];
  for (;;) {
    const nl = rest.indexOf('\r\n');
    const size = parseInt(rest.subarray(0, nl).toString('latin1'), 16);
    if (!size) break;
    parts.push(rest.subarray(nl + 2, nl + 2 + size));
    rest = rest.subarray(nl + 2 + size + 2);
  }
  return { head, body: Buffer.concat(parts).toString('utf8') };
}
// The values that differ between two runs of the same turn (clock readings).
const TIMING = new Set(['timeToFirstToken', 'tokensPerSecond', 'elapsedMs', 'durationMs', 'updatedAt']);
const steady = (e) => JSON.parse(JSON.stringify(e, (k, v) => (TIMING.has(k) && typeof v === 'number' ? 0 : v)));

test('S7: a relayed turn that asks for NDJSON gets the same events as lines, which the front frames into the same stream', { skip }, async (t) => {
  const run = async (headers) => {
    const s = await relayServer(t, [[say('Hello'), say(' there.')]]);
    store(s.ws, 'chat-s5', [USER_MSG]);
    const { got } = relay(s.port, { body: turnBody, headers });
    await until(() => got.ended, 10000, 'the stream ends');
    return answer(got.bytes);
  };
  const sse = await run({});
  const nd = await run({ [chatWire.WIRE_HEADER]: chatWire.WIRE });
  assert.match(nd.head, /\r\nContent-Type: application\/x-ndjson\r\n/);
  assert.doesNotMatch(nd.head, /event-stream|X-Accel-Buffering/i);
  assert.match(sse.head, /\r\nContent-Type: text\/event-stream\r\n/);
  assert.ok(!nd.body.includes('keep-alive') && !nd.body.includes('data: '), nd.body);
  assert.ok(nd.body.endsWith('\n'));
  const lines = nd.body.slice(0, -1).split('\n');
  const events = lines.map((l) => JSON.parse(l));
  for (const e of events) assert.equal(typeof e, 'object');
  // §1.3: meta first, done last; the front's frames of these lines are the event stream's own frames.
  assert.equal(events[0].type, 'meta');
  assert.equal(events.at(-1).type, 'done');
  const framed = lines.map((l) => steady(JSON.parse(l))).map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const own = sse.body.split('\n\n').filter((f) => f.startsWith('data: ')).map((f) => `data: ${JSON.stringify(steady(JSON.parse(f.slice(6))))}\n\n`).join('');
  assert.equal(framed, own);
  assert.equal(sse.body.replace(/: keep-alive\n\n/g, ''), sse.body.split('\n\n').filter((f) => f.startsWith('data: ')).map((f) => `${f}\n\n`).join(''));
});

test('S7: on the NDJSON wire nothing is written while the model is silent, and the front leaving within 1 s keeps the interrupted turn (#679)', { skip, timeout: 30000 }, async (t) => {
  const s = await relayServer(t, [[say('Steam rises slowly,'), say(' amber'), STALL, say(' never seen')]]);
  store(s.ws, 'chat-s5', [USER_MSG]);
  const { socket, got } = relay(s.port, { body: turnBody, headers: { [chatWire.WIRE_HEADER]: chatWire.WIRE } });
  await until(() => got.bytes.includes('Steam rises slowly,'), 10000, 'the first delta');
  const before = got.bytes.length;
  await new Promise((r) => setTimeout(r, 6000));
  assert.equal(got.bytes.length, before, 'no keep-alive on the NDJSON wire (the front writes it)');
  assert.ok(!got.bytes.includes(': keep-alive'));
  socket.destroy();
  await until(() => s.state.aborted === 1, 1000, 'the model request aborted within 1 s');
  await until(() => stored(s.ws, 'chat-s5').length === 2, 2000, 'the interrupted turn saved');
  const history = stored(s.ws, 'chat-s5');
  assert.equal(history[1].role, 'assistant');
  assert.equal(history[1].content, 'Steam rises slowly, amber');
  assert.equal(history[1].interrupted, true);
});
