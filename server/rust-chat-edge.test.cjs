'use strict';
// Chat port S6: the chat edge and the `llm:` budget are the Rust front's (rust-chat-edge.cjs). This process accepts the
// front's Cowork start as a relayed turn, meets the Diary local exchange's gate probe as that route, marks a gate refusal
// the front counted, and keeps no limiter. The route checks themselves are routes/chat.test.cjs; the front's port of
// them is noevia-rs bins/noevia-server tests/chat_edge.rs against tests/chat-edge-oracle.cjs. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const turn = require('./rust-chat-turn.cjs');
const edge = require('./rust-chat-edge.cjs');

const SECRET = 'synthetic-front-secret-0123456789abcdef';
const USER_ID = 'synthetic-user-a';
const request = ({ url, method = 'POST', headers = {} } = {}) =>
  ({ method, url, socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-noevia-store-token': SECRET, [turn.USER_HEADER]: USER_ID, ...headers } });
function sink() {
  const sent = [];
  return { sent, json: (_res, status, body) => sent.push({ status, body }) };
}

test('the front\'s Cowork start is a relayed turn bound to its user; only the front reaches it', () => {
  assert.equal(edge.FRONT_CAPABILITY, 'rust-chat-edge');
  const { sent, json } = sink();
  const bridge = turn.createTurnBridge({ secret: SECRET, json });
  const req = request({ url: edge.COWORK_PATH, headers: { cookie: 'cowork_session=s' } });
  assert.equal(bridge.accept(req, {}), 'turn');
  assert.equal(req.url, '/api/chat');
  assert.equal(turn.relayedUser(req), USER_ID);
  assert.deepEqual(req.headers, { cookie: 'cowork_session=s' });
  for (const refused of [
    request({ url: edge.COWORK_PATH, headers: { 'x-noevia-store-token': 'wrong' } }),
    request({ url: edge.COWORK_PATH, method: 'GET' }),
    request({ url: edge.COWORK_PATH, headers: { 'x-forwarded-for': '203.0.113.9' } }),
  ]) {
    assert.equal(bridge.accept(refused, {}), 'done');
    assert.deepEqual(sent.pop(), { status: 404, body: { error: 'Not found' } });
    assert.equal(turn.relayedUser(refused), null);
  }
  const noUser = request({ url: edge.COWORK_PATH, headers: { [turn.USER_HEADER]: '' } });
  assert.equal(bridge.accept(noUser, {}), 'done');
  assert.deepEqual(sent.pop(), { status: 400, body: { error: 'A user is required.' } });
  assert.equal(bridge.accept(request({ url: `${edge.COWORK_PATH}/x` }), {}), null);
});

test('the gate probe meets the gate as the Diary local exchange when the front asks for that route', () => {
  const { json } = sink();
  const bridge = turn.createTurnBridge({ secret: SECRET, json });
  const diary = request({ url: `${turn.GATE_PATH}?route=${edge.DIARY_GATE_ROUTE}`, headers: { [turn.USER_HEADER]: undefined } });
  assert.equal(bridge.accept(diary, {}), 'gate');
  assert.equal(diary.url, '/api/diary/local-exchange');
  assert.equal(turn.relayedUser(diary), null);
  for (const url of [turn.GATE_PATH, `${turn.GATE_PATH}?route=other`, `${turn.GATE_PATH}?x=${edge.DIARY_GATE_ROUTE}`]) {
    const chat = request({ url });
    assert.equal(bridge.accept(chat, {}), 'gate', url);
    assert.equal(chat.url, '/api/chat', url);
  }
});

test('a gate probe asking for a hold keeps it for the front\'s call; any other probe is the S5 probe', () => {
  const { json } = sink();
  const bridge = turn.createTurnBridge({ secret: SECRET, json });
  const ask = (url) => { const r = request({ url, headers: { [turn.USER_HEADER]: undefined } }); assert.equal(bridge.accept(r, {}), 'gate', url); return [r.url, turn.relayedGate(r)]; };
  assert.deepEqual(ask(`${turn.GATE_PATH}?hold=1`), ['/api/chat', { hold: true, route: 'chat' }]);
  assert.deepEqual(ask(`${turn.GATE_PATH}?route=${edge.DIARY_GATE_ROUTE}&hold=1`), ['/api/diary/local-exchange', { hold: true, route: 'diary' }]);
  assert.deepEqual(ask(turn.GATE_PATH), ['/api/chat', { hold: false, route: 'chat' }]);
  assert.deepEqual(ask(`${turn.GATE_PATH}?hold=true`), ['/api/chat', { hold: false, route: 'chat' }]);
  const t = request({ url: turn.TURN_PATH });
  bridge.accept(t, {});
  assert.equal(turn.relayedGate(t), null, 'a turn is not a probe');
  assert.equal(turn.relayedGate({ headers: {} }), null);
});

function fakeRes() {
  const { EventEmitter } = require('node:events');
  const res = new EventEmitter();
  Object.assign(res, { head: null, body: '', writeHead(status, h) { this.head = { status, h }; }, write(c) { this.body += c; } });
  return res;
}

test('a hold answers 200 with its lease and gives the gate back when it closes, unless a call adopted it', () => {
  let n = 0;
  const leases = edge.createLeases({ newId: () => `lease-${++n}` });
  const released = [];
  // Closed without a call adopting it: the gate is given back once.
  const a = fakeRes();
  leases.hold(a, 'chat', () => released.push('a'));
  assert.deepEqual(a.head, { status: 200, h: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'x-noevia-gate-lease': 'lease-1' } });
  assert.equal(a.body, 'held\n');
  a.emit('close');
  assert.deepEqual(released, ['a']);
  assert.equal(leases.adopt({ headers: { 'x-noevia-gate-lease': 'lease-1' } }, 'chat'), null, 'unknown once closed');
  // Adopted: the call's leave is the hold's, and closing the hold no longer gives the gate back.
  const b = fakeRes();
  leases.hold(b, 'chat', () => released.push('b'));
  const wrong = { headers: { 'x-noevia-gate-lease': 'lease-2' } };
  assert.equal(leases.adopt(wrong, 'diary'), null, 'bound to its route');
  assert.deepEqual(wrong.headers, {}, 'the header is removed whatever happens');
  const call = { headers: { 'x-noevia-gate-lease': 'lease-2', cookie: 'c' } };
  const leave = leases.adopt(call, 'chat');
  assert.equal(typeof leave, 'function');
  assert.deepEqual(call.headers, { cookie: 'c' });
  assert.equal(leases.adopt({ headers: { 'x-noevia-gate-lease': 'lease-2' } }, 'chat'), null, 'single use');
  b.emit('close');
  assert.deepEqual(released, ['a']);
  leave();
  assert.deepEqual(released, ['a', 'b']);
  assert.equal(leases.size(), 0);
  assert.equal(leases.adopt({ headers: {} }, 'chat'), null);
  assert.equal(leases.adopt({ headers: { 'x-noevia-gate-lease': ['x'] } }, 'chat'), null);
});

test('index.cjs: a call adopts the front\'s hold instead of entering the gate; a hold probe keeps it; no llm: limiter', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  const top = source.slice(source.indexOf('async function handleRequest(req,res) {'));
  const at = (needle) => { const i = top.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  assert.ok(at("chatEdge.leases.adopt(req,relay==='turn'?'chat':pathname===chatEdge.LOCAL_EXCHANGE?'diary':'')") < at('enterChatInference('));
  assert.match(top, /try \{if\(adopted\)leave=adopted;else if\(inference\)leave=await chatAdmission\.enterChatInference\(/);
  assert.ok(at('return chatEdge.leases.hold(res,ask.route,leave);') < at("if(leave){res.once('finish',leave)"));
  assert.match(source, /^const chatEdge = require\('\.\/rust-chat-edge\.cjs'\);$/m);
  assert.equal(/llmRateLimit|createRateLimiter|rateLimited:|markGateRefused/.test(source), false);
  // routes/diary.cjs left this process with the local exchange (rust-diary-local-exchange.cjs).
  for (const route of ['routes/chat.cjs', 'routes/diary.cjs'].filter((r) => fs.existsSync(path.join(__dirname, r)))) {
    assert.equal(/rateLimited|429/.test(fs.readFileSync(path.join(__dirname, route), 'utf8')), false, route);
  }
});
