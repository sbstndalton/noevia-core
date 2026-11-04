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

test('chat port S8: the S6 gate probe and hold are gone; the front takes an admission lease instead', () => {
  const { sent, json } = sink();
  const bridge = turn.createTurnBridge({ secret: SECRET, json });
  for (const url of ['/internal/chat/gate', '/internal/chat/gate?hold=1', '/internal/chat/gate?route=diary-local-exchange&hold=1']) {
    const r = request({ url, headers: { [turn.USER_HEADER]: undefined } });
    assert.equal(bridge.accept(r, {}), null, url);
    assert.equal(r.url, url, 'not rewritten');
  }
  assert.equal(sent.length, 0);
  assert.equal(turn.GATE_PATH, undefined);
  assert.equal(edge.createLeases, undefined);
  assert.equal(edge.LEASE_HEADER, undefined);
});

test('index.cjs: a call the front\'s admission lease covers enters no gate; no llm: limiter', () => {
  const source = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  const top = source.slice(source.indexOf('async function handleRequest(req,res) {'));
  const at = (needle) => { const i = top.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  assert.ok(at("inferenceAdmission.covers(req,require('./rust-chat-admission.cjs').gateRoute(relay,pathname))") < at('enterChatInference('));
  assert.match(top, /try \{if\(inference&&!frontAdmitted\)leave=await chatAdmission\.enterChatInference\(/);
  assert.equal(/chatEdge\.leases|relay==='gate'/.test(top), false);
  assert.match(source, /^const chatEdge = require\('\.\/rust-chat-edge\.cjs'\);$/m);
  assert.equal(/llmRateLimit|createRateLimiter|rateLimited:|markGateRefused/.test(source), false);
  for (const route of ['routes/chat.cjs', 'routes/diary.cjs']) {
    assert.equal(/rateLimited|429/.test(fs.readFileSync(path.join(__dirname, route), 'utf8')), false, route);
  }
});
