'use strict';
// rust-chat-mirror-v1 + rust-chat-mirror-exec-v1: the Rust front tails the chat change journal and runs the Diary
// mirror and chat brain schedules and their work; this process answers only the engine seam (loopback, per-start
// secret) and nudges the front. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { RUST_CHAT_MIRROR_OWNED, RUST_CHAT_MIRROR_EXEC_OWNED, ENGINE_PATH, TOUCH_EVERY_MS, createEngineSeam, createScheduleClient } = require('./rust-chat-mirror.cjs');

const SECRET = 'synthetic-store-secret-0123456789abcdef';
const json = (res, status, body) => { res.status = status; res.body = body; };
const request = (url, { method = 'POST', body, headers = { 'x-noevia-store-token': SECRET }, remote = '127.0.0.1' } = {}) => {
  const { Readable } = require('node:stream');
  const req = Readable.from([Buffer.from(JSON.stringify(body ?? {}))]);
  Object.assign(req, { url, method, headers, socket: { remoteAddress: remote } });
  return req;
};
const readJson = async (req) => { const chunks = []; for await (const c of req) chunks.push(c); return JSON.parse(Buffer.concat(chunks).toString('utf8')); };

function seam(over = {}) {
  const calls = [];
  const handle = createEngineSeam({
    secret: SECRET, json, readJson, log: () => {},
    loaded: () => { calls.push(['loaded']); return over.loaded === undefined ? 'qa-answer' : over.loaded; },
    admit: async (model, ctx) => { calls.push(['admit', model, ctx]); return over.refusal ?? null; },
    complete: async (req) => { calls.push(['complete', req.model, req.schema, req.messages, req.signal instanceof AbortSignal]); if (over.fail) throw Object.assign(new Error('secret detail'), { status: 500 }); return 'QA content'; },
    record: (entry) => calls.push(['record', entry]),
    ...over.deps,
  });
  return { calls, call: async (req) => { const res = { writeHead(s) { res.status = s; }, end() {} }; const handled = await handle(req, res); return { handled, ...res }; } };
}

test('the engine seam answers the loaded model, the admission and the call, and builds no prompt itself', async () => {
  let { calls, call } = seam();
  let r = await call(request(ENGINE_PATH, { body: { op: 'loaded' } }));
  assert.deepEqual([r.handled, r.status, r.body], [true, 200, { model: 'qa-answer' }]);
  r = await seam({ loaded: '' }).call(request(ENGINE_PATH, { body: { op: 'loaded' } }));
  assert.deepEqual(r.body, { model: null });
  r = await call(request(ENGINE_PATH, { body: { op: 'admit', model: 'qa-reasoner', answerModel: 'qa-answer' } }));
  assert.deepEqual([r.status, r.body], [200, { refusal: null }]);
  r = await seam({ refusal: 'budget' }).call(request(ENGINE_PATH, { body: { op: 'admit', model: 'qa-reasoner', answerModel: null } }));
  assert.deepEqual([r.status, r.body], [200, { refusal: 'budget' }]);
  const schema = { type: 'object' }, messages = [{ role: 'system', content: 'from the front' }];
  r = await call(request(ENGINE_PATH, { body: { op: 'complete', model: 'qa-reasoner', schema, messages } }));
  assert.deepEqual([r.status, r.body], [200, { content: 'QA content' }]);
  assert.deepEqual(calls, [['loaded'], ['admit', 'qa-reasoner', { answerModel: 'qa-answer', answerIsLocal: true }], ['complete', 'qa-reasoner', schema, messages, true]]);
  r = await call(request(ENGINE_PATH, { body: { op: 'record', entry: { event: 'brain.built', ms: 3 } } }));
  assert.equal(r.status, 204);
  assert.deepEqual(calls.at(-1), ['record', { event: 'brain.built', ms: 3 }]);
});

test('a failed engine call is a 502 logged without detail; a throwing admission is a 500', async () => {
  const logs = [];
  const { call } = seam({ fail: true, deps: { log: (m) => logs.push(m) } });
  const r = await call(request(ENGINE_PATH, { body: { op: 'complete', model: 'm', schema: {}, messages: [] } }));
  assert.deepEqual([r.status, r.body], [502, { error: 'engine call failed' }]);
  assert.ok(logs.length === 1 && !logs[0].includes('secret detail'));
  const t = seam({ deps: { admit: async () => { throw new Error('x'); } } });
  assert.equal((await t.call(request(ENGINE_PATH, { body: { op: 'admit', model: 'm' } }))).status, 500);
});

test('only the front is trusted, other paths fall through, and malformed bodies are 400 with nothing run', async () => {
  const { calls, call } = seam();
  const bad = [
    request(ENGINE_PATH, { body: { op: 'loaded' }, headers: {} }),
    request(ENGINE_PATH, { body: { op: 'loaded' }, headers: { 'x-noevia-store-token': 'wrong' } }),
    request(ENGINE_PATH, { body: { op: 'loaded' }, headers: { 'x-noevia-store-token': SECRET, 'x-forwarded-for': '1.2.3.4' } }),
    request(ENGINE_PATH, { body: { op: 'loaded' }, remote: '10.0.0.5' }),
    request(ENGINE_PATH, { method: 'GET', body: {} }),
  ];
  for (const req of bad) { const r = await call(req); assert.deepEqual([r.handled, r.status], [true, 404]); }
  for (const gone of ['/internal/chat-mirror/sync', '/internal/chat-mirror/brain', '/api/chats']) assert.equal((await call(request(gone, { body: { user: 'u1', chats: [] } }))).handled, false, gone);
  for (const body of [{}, { op: 'nope' }, { op: 'admit' }, { op: 'admit', model: '' }, { op: 'admit', model: 'm', answerModel: 5 }, { op: 'complete', model: 'm', messages: [] },
    { op: 'complete', model: 'm', schema: {}, messages: 'x' }, { op: 'record', entry: { event: 'other' } }, { op: 'record', entry: [] }]) {
    const r = await call(request(ENGINE_PATH, { body }));
    assert.deepEqual([r.handled, r.status], [true, 400], JSON.stringify(body));
  }
  assert.deepEqual(calls, []);
  const none = createEngineSeam({ secret: '', json, readJson, loaded: () => 'x', admit: async () => null, complete: async () => '' });
  const r = {}; assert.equal(await none(request(ENGINE_PATH, { headers: { 'x-noevia-store-token': '' } }), r), true);
  assert.equal(r.status, 404, 'an empty secret trusts nobody');
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

test('the replaced Node code is gone and index.cjs is wired to the front, with the markers in code', () => {
  assert.equal(RUST_CHAT_MIRROR_OWNED, 'rust-chat-mirror-v1');
  assert.equal(RUST_CHAT_MIRROR_EXEC_OWNED, 'rust-chat-mirror-exec-v1');
  const src = fs.readFileSync(path.join(__dirname, 'rust-chat-mirror.cjs'), 'utf8');
  assert.ok(src.includes("const RUST_CHAT_MIRROR_OWNED = 'rust-chat-mirror-v1';"));
  assert.ok(src.includes("const RUST_CHAT_MIRROR_EXEC_OWNED = 'rust-chat-mirror-exec-v1';"));
  assert.match(src, /module\.exports = \{[^}]*RUST_CHAT_MIRROR_OWNED, RUST_CHAT_MIRROR_EXEC_OWNED/);
  for (const dead of ['createExecutorBridge', '/internal/chat-mirror/sync', '/internal/chat-mirror/brain']) assert.ok(!src.includes(dead), dead);
  for (const gone of ['chat-change-journal.cjs', 'chat-change-journal.test.cjs', 'chat-activity.cjs', 'chat-activity.test.cjs']) assert.ok(!fs.existsSync(path.join(__dirname, gone)), gone);
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.match(index, /require\('\.\/rust-chat-mirror\.cjs'\)\.createScheduleClient\(\{ store: PROJECT_STORE \}\)/);
  assert.match(index, /require\('\.\/rust-chat-mirror\.cjs'\)\.createEngineSeam\(\{/);
  assert.match(index, /if \(await chatMirrorEngine\(req, res\)\) return;/);
  for (const dead of ['changeJournal', 'createChangeJournalReader', 'createBrainScheduler', 'createBrainRunner', 'createBrainBuilder', 'createChatVaultMirror', 'chatVaultMirror', 'chatBrains', 'chatMirrorBridge', 'brainStore', 'createActivitySource', 'startNudges', 'writeBrain', 'removeBrain']) assert.ok(!index.includes(dead), dead);
  const first = index.indexOf('chatMirrorEngine(req, res)');
  assert.ok(first > 0 && first < index.indexOf('const preAuth = requestAuth.authenticate(req);'), 'the seam answers the front before any authentication');
  const client = fs.readFileSync(path.join(__dirname, 'project-store-client.cjs'), 'utf8');
  assert.ok(!client.includes('changesRead'));
});


// Review 2026-11-05 P2: over real HTTP, a front that disconnects while the call runs aborts it (the request's
// 'close' fired when its body was read; the response's 'close' is the one that tells), a front gone before the call
// starts never starts it, the listeners are removed when the call ends, and a call nobody ends stops at the deadline.
test('a front that goes away aborts the engine call over real HTTP; a deadline ends one nobody ends', async () => {
  const http = require('node:http');
  const { json: realJson, readJson: realReadJson } = require('./http.cjs');
  const seen = [];
  let started, release;
  const open = new Promise((r) => { started = r; });
  const handle = createEngineSeam({
    secret: SECRET, json: realJson, readJson: realReadJson, log: () => {}, completeDeadlineMs: 300,
    loaded: () => null, admit: async () => null,
    complete: ({ signal, model }) => new Promise((resolve, reject) => {
      seen.push(['start', model]);
      started();
      if (model === 'qa-done') { release = () => resolve('QA content'); return; }
      signal.addEventListener('abort', () => { seen.push(['aborted', model]); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    }),
  });
  const responses = [];
  const server = http.createServer(async (req, res) => { responses.push(res); if (!(await handle(req, res))) { res.writeHead(404); res.end(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const post = (model) => {
    const body = JSON.stringify({ op: 'complete', model, schema: { type: 'object' }, messages: [] });
    return http.request({ host: '127.0.0.1', port, path: ENGINE_PATH, method: 'POST', headers: { 'x-noevia-store-token': SECRET, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, () => {}).on('error', () => {}).end(body);
  };
  const until = async (check) => { for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(check()); };
  try {
    // Disconnect mid-call.
    const req = post('qa-gone');
    await open;
    req.destroy();
    await until(() => seen.some(([k, m]) => k === 'aborted' && m === 'qa-gone'));
    // A call nobody ends: the seam's own deadline.
    post('qa-stuck');
    await until(() => seen.some(([k, m]) => k === 'aborted' && m === 'qa-stuck'));
    // A finished call: answered, and no close listener left behind on the response.
    const done = await new Promise((resolve) => {
      const body = JSON.stringify({ op: 'complete', model: 'qa-done', schema: { type: 'object' }, messages: [] });
      const r = http.request({ host: '127.0.0.1', port, path: ENGINE_PATH, method: 'POST', headers: { 'x-noevia-store-token': SECRET, 'content-length': Buffer.byteLength(body) } }, (res) => {
        const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve([res.statusCode, JSON.parse(Buffer.concat(chunks).toString())]));
      });
      r.end(body);
      const wait = setInterval(() => { if (release) { clearInterval(wait); release(); } }, 5);
    });
    assert.deepEqual(done, [200, { content: 'QA content' }]);
    assert.equal(responses.at(-1).listenerCount('close'), 0, 'listener removed');
    assert.ok(!seen.some(([k, m]) => k === 'aborted' && m === 'qa-done'));
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('a front already gone before the call starts never starts it', async () => {
  const calls = [];
  const req = request(ENGINE_PATH, { body: { op: 'complete', model: 'm', schema: {}, messages: [] } });
  const res = { destroyed: true, writeHead() {}, end() {} };
  const handle = createEngineSeam({ secret: SECRET, json, readJson, log: () => {}, loaded: () => null, admit: async () => null,
    complete: async () => { calls.push(['complete']); return 'x'; } });
  assert.equal(await handle(req, res), true);
  assert.deepEqual(calls, []);
});
