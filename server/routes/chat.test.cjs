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
