'use strict';
// What stands between a request and the chat loop: the rate limit, the body cap, JSON, the
// Diary gate. The loop itself is exercised in vision-routing.test.cjs and the routing tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatRoutes } = require('./chat.cjs');

function fixture({ limited = false, diary = true, raw = '{"message":"hi"}', readError = null } = {}) {
  const sent = [];
  const handled = [];
  const routes = createChatRoutes({
    json: (res, status, body) => { sent.push({ status, body }); return true; },
    readBody: async () => { if (readError) throw readError; return raw; },
    bodyCap: 1024,
    rateLimited: () => limited,
    diaryEnabled: () => diary,
    handleChat: async (_req, _res, body, authn) => { handled.push({ body, authn }); },
  });
  return { routes, sent, handled, authn: { user: { id: 'u', role: 'member' } } };
}

test('a well-formed POST reaches the loop with its parsed body and the caller', async () => {
  const f = fixture();
  assert.equal(await f.routes({ method: 'POST' }, {}, { path: '/api/chat', authn: f.authn }), true);
  assert.deepEqual(f.handled, [{ body: { message: 'hi' }, authn: f.authn }]);
  assert.equal(f.sent.length, 0);
});

test('other paths and methods are left alone', async () => {
  const f = fixture();
  assert.equal(await f.routes({ method: 'GET' }, {}, { path: '/api/chat', authn: f.authn }), false);
  assert.equal(await f.routes({ method: 'POST' }, {}, { path: '/api/chats', authn: f.authn }), false);
  assert.equal(f.handled.length, 0);
});

test('the shared endpoint is rate limited before the body is even read', async () => {
  const f = fixture({ limited: true, readError: new Error('must not be called') });
  await f.routes({ method: 'POST' }, {}, { path: '/api/chat', authn: f.authn });
  assert.equal(f.sent[0].status, 429);
  assert.equal(f.handled.length, 0);
});

test('an oversized chat is refused with advice, a bad read with 400, bad JSON with 400', async () => {
  const big = fixture({ readError: Object.assign(new Error('too big'), { status: 413 }) });
  await big.routes({ method: 'POST' }, {}, { path: '/api/chat', authn: big.authn });
  assert.equal(big.sent[0].status, 413);
  assert.match(big.sent[0].body.error, /start a new chat/);
  const broken = fixture({ readError: new Error('socket') });
  await broken.routes({ method: 'POST' }, {}, { path: '/api/chat', authn: broken.authn });
  assert.equal(broken.sent[0].status, 400);
  const junk = fixture({ raw: '{nope' });
  await junk.routes({ method: 'POST' }, {}, { path: '/api/chat', authn: junk.authn });
  assert.deepEqual(junk.sent[0], { status: 400, body: { error: 'invalid JSON' } });
});

test('the Diary space is closed to an account without the add-on', async () => {
  const f = fixture({ diary: false, raw: '{"spaceId":"diary","message":"hi"}' });
  await f.routes({ method: 'POST' }, {}, { path: '/api/chat', authn: f.authn });
  assert.equal(f.sent[0].status, 404);
  assert.equal(f.handled.length, 0);
  const ok = fixture({ diary: false, raw: '{"spaceId":"free","message":"hi"}' });
  await ok.routes({ method: 'POST' }, {}, { path: '/api/chat', authn: ok.authn });
  assert.equal(ok.handled.length, 1);
});

// ── #236: the chat request carries `mode`; Cowork is guarded here ──
function coworkFixture({ role = 'admin', harness = true, raw, startError = null } = {}) {
  const sent = [], handled = [], started = [];
  const routes = createChatRoutes({
    json: (res, status, body) => { sent.push({ status, body }); return true; },
    readBody: async () => raw,
    bodyCap: 4096, rateLimited: () => false, diaryEnabled: () => true,
    handleChat: async (_req, _res, body) => { handled.push(body); },
    harnessEnabled: () => harness,
    startCoworkTask: async (body, authn) => { if (startError) throw startError; started.push({ body, authn }); return { taskId: 't-1', branch: 'noevia/t-1' }; },
  });
  const call = () => routes({ method: 'POST' }, {}, { path: '/api/chat', authn: { user: { id: 'u', role } } });
  return { call, sent, handled, started };
}
const coworkBody = JSON.stringify({ mode: 'cowork', projectId: 'p1', repository: 'demo', message: 'fix the test' });

test('a member asking for cowork is refused with 403 and nothing starts', async () => {
  const f = coworkFixture({ role: 'member', raw: coworkBody });
  await f.call();
  assert.equal(f.sent[0].status, 403);
  assert.equal(f.started.length + f.handled.length, 0, 'a refused cowork request must not fall back to a chat turn');
});

test('cowork with the harness off is a 409 even for an admin', async () => {
  const f = coworkFixture({ harness: false, raw: coworkBody });
  await f.call();
  assert.equal(f.sent[0].status, 409);
  assert.match(f.sent[0].body.error, /harness/);
  assert.equal(f.started.length + f.handled.length, 0);
});

test('cowork outside a project is a 409', async () => {
  const f = coworkFixture({ raw: JSON.stringify({ mode: 'cowork', message: 'x' }) });
  await f.call();
  assert.equal(f.sent[0].status, 409);
  assert.equal(f.started.length, 0);
});

test('an allowed cowork request starts a code task and answers 202 instead of streaming a chat', async () => {
  const f = coworkFixture({ raw: coworkBody });
  await f.call();
  assert.equal(f.sent[0].status, 202);
  assert.deepEqual(f.sent[0].body, { mode: 'cowork', task: { taskId: 't-1', branch: 'noevia/t-1' } });
  assert.equal(f.started[0].body.repository, 'demo');
  assert.equal(f.handled.length, 0);
});

test('a code service refusal (for example a task already running) keeps its status and message', async () => {
  const f = coworkFixture({ raw: coworkBody, startError: Object.assign(Error('busy'), { status: 409, publicMessage: 'This project already has a task running.' }) });
  await f.call();
  assert.deepEqual(f.sent[0], { status: 409, body: { error: 'This project already has a task running.', mode: 'cowork' } });
});

test('chat mode and an absent mode both reach the chat loop; an unknown mode is a 400', async () => {
  for (const mode of ['chat', undefined]) {
    const f = coworkFixture({ role: 'member', harness: false, raw: JSON.stringify({ mode, message: 'hi' }) });
    await f.call();
    assert.equal(f.handled.length, 1);
  }
  const bad = coworkFixture({ raw: JSON.stringify({ mode: 'code', message: 'hi' }) });
  await bad.call();
  assert.equal(bad.sent[0].status, 400);
  assert.equal(bad.handled.length, 0);
});

test('turnToolboxes must be a short list of ids', async () => {
  for (const turnToolboxes of ['web-search', [1], Array.from({ length: 21 }, (_, i) => `b${i}`)]) {
    const f = coworkFixture({ raw: JSON.stringify({ message: 'hi', turnToolboxes }) });
    await f.call();
    assert.equal(f.sent[0].status, 400, JSON.stringify(turnToolboxes));
  }
  const ok = coworkFixture({ raw: JSON.stringify({ message: 'hi', turnToolboxes: ['web-search'] }) });
  await ok.call();
  assert.deepEqual(ok.handled[0].turnToolboxes, ['web-search']);
});
