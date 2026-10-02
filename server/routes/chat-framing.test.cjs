'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatFramingRoutes } = require('./chat-framing.cjs');

function harness({ suggest = async () => ({ frame: null, reason: 'disabled' }), body = {} } = {}) {
  const calls = [], saved = [];
  const routes = createChatFramingRoutes({
    json: (res, status, payload) => { res.status = status; res.body = payload; },
    readJson: async () => body,
    framing: { suggest: async (args) => { calls.push(args); return suggest(args); } },
    settings: { get: () => ({ framingRouterModel: '', framingReasonerModel: '' }), save: (v) => { saved.push(v); return v; } },
    workspace: () => ({ projects: [{ id: 'mine', name: 'Mine' }], chats: [{ id: 'c1', title: 'T' }] }),
  });
  return { routes, calls, saved };
}
const user = { user: { id: 'u1', role: 'member' } }, admin = { user: { id: 'a1', role: 'admin' } };

test('suggest returns the frame and offers only the caller workspace', async () => {
  const frame = { kind: 'idea', projectId: null, tags: [], links: [], confirmed: false, source: 'suggested' };
  const { routes, calls } = harness({ suggest: async () => ({ frame, reason: null }), body: { message: 'hello', chatId: 'c9', projects: [{ id: 'injected' }] } });
  const res = {};
  assert.equal(await routes({ method: 'POST' }, res, { path: '/api/chat-framing/suggest', authn: user }), true);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.frame, frame);
  assert.deepEqual(calls[0].projects, [{ id: 'mine', name: 'Mine' }]);
  assert.equal(calls[0].chatId, 'c9');
});

test('suggest validates method, auth and body', async () => {
  const { routes, calls } = harness({ body: {} });
  let res = {};
  await routes({ method: 'GET' }, res, { path: '/api/chat-framing/suggest', authn: user }); assert.equal(res.status, 405);
  res = {}; await routes({ method: 'POST' }, res, { path: '/api/chat-framing/suggest', authn: null }); assert.equal(res.status, 401);
  res = {}; await routes({ method: 'POST' }, res, { path: '/api/chat-framing/suggest', authn: user }); assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('admin settings are admin-only; other paths fall through', async () => {
  const { routes, saved } = harness({ body: { framingRouterModel: 'r' } });
  let res = {};
  await routes({ method: 'PUT' }, res, { path: '/api/admin/framing-settings', authn: user }); assert.equal(res.status, 403);
  res = {}; await routes({ method: 'PUT' }, res, { path: '/api/admin/framing-settings', authn: admin }); assert.equal(res.status, 200);
  assert.deepEqual(saved, [{ framingRouterModel: 'r' }]);
  assert.equal(await routes({ method: 'GET' }, {}, { path: '/api/other', authn: user }), false);
});

test('framing preferences: signed-in only, GET and PUT, invalid values refused (#738)', async () => {
  let stored = { autoAccept: false };
  const sent = [];
  let body = {};
  const routes = createChatFramingRoutes({
    json: (res, status, payload) => { sent.push({ status, payload }); },
    readJson: async () => body,
    framing: { suggest: async () => ({ frame: null }) }, settings: { get: () => ({}), save: (v) => v }, workspace: () => ({ projects: [], chats: [] }),
    preferences: { get: () => stored, save: (v) => { if (typeof v?.autoAccept !== 'boolean') throw Object.assign(Error('autoAccept must be true or false'), { status: 400 }); stored = { autoAccept: v.autoAccept }; return stored; } },
  });
  const call = (method, authn = user) => routes({ method }, {}, { path: '/api/chat-framing/preferences', authn });
  assert.equal(await call('GET', null), true);
  assert.equal(sent.pop().status, 401);
  await call('GET');
  assert.deepEqual(sent.pop(), { status: 200, payload: { autoAccept: false } });
  body = { autoAccept: true };
  await call('PUT');
  assert.deepEqual(sent.pop(), { status: 200, payload: { autoAccept: true } });
  body = { autoAccept: 'yes' };
  await call('PUT');
  assert.deepEqual(sent.pop(), { status: 400, payload: { error: 'autoAccept must be true or false' } });
  await call('DELETE');
  assert.equal(sent.pop().status, 405);
  assert.deepEqual(stored, { autoAccept: true });
});
