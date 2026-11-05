'use strict';
// rust-chat-mirror-v1: the Rust front tails the chat change journal and runs the Diary mirror and chat brain
// schedules; this process keeps the two executors (loopback, per-start secret) and nudges the front. Synthetic
// data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RUST_CHAT_MIRROR_OWNED, SYNC_PATH, BRAIN_PATH, TOUCH_EVERY_MS, createExecutorBridge, createScheduleClient } = require('./rust-chat-mirror.cjs');

const SECRET = 'synthetic-store-secret-0123456789abcdef';
const json = (res, status, body) => { res.status = status; res.body = body; };
const request = (url, { method = 'POST', body, headers = { 'x-noevia-store-token': SECRET }, remote = '127.0.0.1' } = {}) => {
  const { Readable } = require('node:stream');
  const req = Readable.from([Buffer.from(JSON.stringify(body ?? {}))]);
  Object.assign(req, { url, method, headers, socket: { remoteAddress: remote } });
  return req;
};
const readJson = async (req) => { const chunks = []; for await (const c of req) chunks.push(c); return JSON.parse(Buffer.concat(chunks).toString('utf8')); };

function bridge(over = {}) {
  const calls = [];
  const handle = createExecutorBridge({
    secret: SECRET, json, readJson, log: () => {},
    mirror: { pass: async (user, chats) => { calls.push(['pass', user, chats]); return over.outcome || 'done'; } },
    brains: { run: async (user, chatId) => { calls.push(['run', user, chatId]); return over.reason || 'built'; } },
    ...over.deps,
  });
  return { calls, call: async (req) => { const res = {}; const handled = await handle(req, res); return { handled, ...res }; } };
}

test('the sync endpoint runs one pass for the user and answers the pass outcome', async () => {
  for (const outcome of ['done', 'off', 'failed']) {
    const { calls, call } = bridge({ outcome });
    const r = await call(request(SYNC_PATH, { body: { user: 'u1', chats: ['a', 'b'] } }));
    assert.deepEqual([r.handled, r.status, r.body], [true, 200, { outcome }]);
    assert.deepEqual(calls, [['pass', 'u1', ['a', 'b']]]);
  }
});

test('the brain endpoint runs one build and answers its reason', async () => {
  for (const reason of ['built', 'current', 'deadline', 'gone']) {
    const { calls, call } = bridge({ reason });
    const r = await call(request(BRAIN_PATH, { body: { user: 'u1', chatId: 'c1' } }));
    assert.deepEqual([r.handled, r.status, r.body], [true, 200, { reason }]);
    assert.deepEqual(calls, [['run', 'u1', 'c1']]);
  }
});

test('only the front is trusted: wrong or missing secret, a proxied request, a non-loopback peer and other methods are the 404 of an unknown path, and nothing runs', async () => {
  const { calls, call } = bridge();
  const bad = [
    request(SYNC_PATH, { body: { user: 'u1', chats: [] }, headers: {} }),
    request(SYNC_PATH, { body: { user: 'u1', chats: [] }, headers: { 'x-noevia-store-token': 'wrong' } }),
    request(SYNC_PATH, { body: { user: 'u1', chats: [] }, headers: { 'x-noevia-store-token': SECRET, 'x-forwarded-for': '1.2.3.4' } }),
    request(SYNC_PATH, { body: { user: 'u1', chats: [] }, headers: { 'x-noevia-store-token': SECRET, 'x-noevia-client-ip': '1.2.3.4' } }),
    request(BRAIN_PATH, { body: { user: 'u1', chatId: 'c' }, remote: '10.0.0.5' }),
    request(BRAIN_PATH, { method: 'GET', body: {} }),
  ];
  for (const req of bad) { const r = await call(req); assert.deepEqual([r.handled, r.status], [true, 404], req.url); }
  assert.deepEqual(calls, []);
  const none = createExecutorBridge({ secret: '', json, readJson, mirror: {}, brains: {} });
  const r = {}; assert.equal(await none(request(SYNC_PATH, { headers: { 'x-noevia-store-token': '' } }), r), true);
  assert.equal(r.status, 404, 'an empty secret trusts nobody');
});

test('other paths fall through; malformed bodies are 400 and run nothing', async () => {
  const { calls, call } = bridge();
  assert.equal((await call(request('/internal/chat-mirror/other'))).handled, false);
  assert.equal((await call(request('/api/chats'))).handled, false);
  for (const [url, body] of [[SYNC_PATH, { chats: [] }], [SYNC_PATH, { user: '', chats: [] }], [SYNC_PATH, { user: 'u1' }], [SYNC_PATH, { user: 'u1', chats: ['a', 5] }], [SYNC_PATH, { user: 'x'.repeat(1025), chats: [] }],
    [BRAIN_PATH, { user: 'u1' }], [BRAIN_PATH, { user: 'u1', chatId: '' }], [BRAIN_PATH, { chatId: 'c' }]]) {
    const r = await call(request(url, { body }));
    assert.deepEqual([r.handled, r.status], [true, 400], JSON.stringify(body));
  }
  assert.deepEqual(calls, []);
});

test('an executor that throws is a 500 the front counts as a failed pass, and is logged without detail', async () => {
  const logs = [];
  const { call } = bridge({ deps: { mirror: { pass: async () => { throw Object.assign(new Error('secret detail'), { code: 'EBOOM' }); } }, log: (m) => logs.push(m) } });
  const r = await call(request(SYNC_PATH, { body: { user: 'u1', chats: [] } }));
  assert.deepEqual([r.status, r.body], [500, { error: 'executor failed' }]);
  assert.ok(logs.length === 1 && !logs[0].includes('secret detail'));
});

test('schedule client: nudges go to the front; touch is sent at most once per account per half minute; failures are logged once and never throw', async () => {
  const sent = [];
  let clock = 1000; let down = false; const logs = [];
  const store = {
    chatMirrorSchedule: async (...a) => { if (down) throw Object.assign(new Error('busy'), { status: 503 }); sent.push(['schedule', ...a]); },
    chatMirrorTouch: async (...a) => { if (down) throw Object.assign(new Error('busy'), { status: 503 }); sent.push(['touch', ...a]); },
  };
  const client = createScheduleClient({ store, log: (m) => logs.push(m), now: () => clock });
  client.schedule('u1', null);
  client.schedule('u1', 'c1', { immediate: true });
  client.schedule('', 'c1'); client.schedule(undefined, 'c1');
  client.touch('u1'); client.touch('u1'); client.touch('u2');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [['schedule', 'u1', null, false], ['schedule', 'u1', 'c1', true], ['touch', 'u1'], ['touch', 'u2']]);
  clock += TOUCH_EVERY_MS - 1; client.touch('u1'); await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 4);
  clock += 1; client.touch('u1'); await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 5, 'after the interval the next request is sent');
  down = true;
  for (let i = 0; i < 3; i++) client.schedule('u1', `c${i}`);
  await new Promise((r) => setImmediate(r));
  assert.equal(logs.length, 1, 'logged once per run of failures');
  down = false; client.schedule('u1', 'x'); await new Promise((r) => setImmediate(r));
  down = true; client.schedule('u1', 'y'); await new Promise((r) => setImmediate(r));
  assert.equal(logs.length, 2, 'a new run of failures logs again');
  const thrower = createScheduleClient({ store: { chatMirrorSchedule: () => { throw new Error('sync throw'); }, chatMirrorTouch: () => { throw new Error('sync throw'); } }, log: () => {} });
  assert.doesNotThrow(() => { thrower.schedule('u1', null); thrower.touch('u9'); });
});

test('the replaced Node code is gone and index.cjs is wired to the front\'s schedule, with the marker in code', () => {
  assert.equal(RUST_CHAT_MIRROR_OWNED, 'rust-chat-mirror-v1');
  const src = fs.readFileSync(path.join(__dirname, 'rust-chat-mirror.cjs'), 'utf8');
  assert.ok(src.includes("const RUST_CHAT_MIRROR_OWNED = 'rust-chat-mirror-v1';"));
  assert.match(src, /module\.exports = \{[^}]*RUST_CHAT_MIRROR_OWNED/);
  for (const gone of ['chat-change-journal.cjs', 'chat-change-journal.test.cjs', 'chat-activity.cjs', 'chat-activity.test.cjs']) assert.ok(!fs.existsSync(path.join(__dirname, gone)), gone);
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.match(index, /require\('\.\/rust-chat-mirror\.cjs'\)\.createScheduleClient\(\{ store: PROJECT_STORE \}\)/);
  assert.match(index, /require\('\.\/rust-chat-mirror\.cjs'\)\.createExecutorBridge\(\{ secret: FRONT_SECRET, json, readJson, mirror: chatVaultMirror, brains: chatBrains \}\)/);
  assert.match(index, /if \(await chatMirrorBridge\(req, res\)\) return;/);
  for (const dead of ['changeJournal', 'createChangeJournalReader', 'createBrainScheduler', 'chatVaultMirror.schedule', 'chatBrains.schedule', 'createActivitySource', 'startNudges']) assert.ok(!index.includes(dead), dead);
  const first = index.indexOf('chatMirrorBridge(req, res)');
  assert.ok(first > 0 && first < index.indexOf('const preAuth = requestAuth.authenticate(req);'), 'the executors answer the front before any authentication');
  const client = fs.readFileSync(path.join(__dirname, 'project-store-client.cjs'), 'utf8');
  assert.ok(!client.includes('changesRead'));
});
