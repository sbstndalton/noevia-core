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

test('a gate refusal is marked only where the front counted the call', () => {
  const marked = (relay, pathname) => { const h = {}; edge.markGateRefused({ setHeader: (k, v) => { h[k] = v; } }, relay, pathname); return h; };
  assert.deepEqual(marked('turn', '/api/chat'), { 'x-noevia-gate-refused': '1' });
  assert.deepEqual(marked('gate', '/api/chat'), { 'x-noevia-gate-refused': '1' });
  assert.deepEqual(marked(null, '/api/diary/local-exchange'), { 'x-noevia-gate-refused': '1' });
  assert.deepEqual(marked(null, '/api/diary/file'), {});
  assert.deepEqual(marked(null, '/api/chat'), {});
});

test('index.cjs: the mark precedes both gate refusals, and no llm: limiter is built or passed', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  const top = source.slice(source.indexOf('async function handleRequest(req,res) {'));
  const at = (needle) => { const i = top.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  assert.ok(at('catch(error){') < at('chatEdge.markGateRefused(res,relay,pathname);'));
  assert.ok(at('chatEdge.markGateRefused(res,relay,pathname);') < at("if(pathname==='/api/chat'&&status===503)"));
  assert.match(source, /^const chatEdge = require\('\.\/rust-chat-edge\.cjs'\);$/m);
  assert.equal(/llmRateLimit|createRateLimiter|rateLimited:/.test(source), false);
  for (const route of ['routes/chat.cjs', 'routes/diary.cjs']) {
    assert.equal(/rateLimited|429/.test(fs.readFileSync(path.join(__dirname, route), 'utf8')), false, route);
  }
});
