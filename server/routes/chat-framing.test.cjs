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

test('native framing preferences refuse every method before reading a body or workspace', async () => {
  const routes = createChatFramingRoutes({
    json: (res, status, body) => Object.assign(res, { status, body }),
    readJson: async () => { throw Error('must not read a native-owned body'); },
    workspace: () => { throw Error('must not construct a native-owned workspace'); },
  });
  for (const method of ['GET', 'PUT', 'POST', 'DELETE', 'HEAD', 'OPTIONS']) {
    for (const authn of [null, user, admin]) {
      const res = {};
      assert.equal(await routes({ method }, res, { path: '/api/chat-framing/preferences', authn }), true);
      assert.equal(res.status, 503);
      assert.equal(res.body.code, 'RUST_FRAMING_PREFERENCES_OWNED');
    }
  }
  assert.equal(typeof require('../chat-framing.cjs').writePreferences, 'undefined');
});


test('early native preference refusal precedes authentication and workspace construction', () => {
  const {refuseOwnedPreferences}=require('./chat-framing.cjs');
  const sent=[];const json=(_res,status,body)=>sent.push({status,body});
  for(const method of ['GET','PUT','DELETE','HEAD','OPTIONS']) {
    assert.equal(refuseOwnedPreferences({method,headers:{host:'example.test'},get body(){throw Error('body reached');}}, {},
      {json,parseRequestUrl:()=>({pathname:'/api/chat-framing/preferences'})}),true);
    assert.equal(sent.pop().body.code,'RUST_FRAMING_PREFERENCES_OWNED');
  }
  for(const pathname of ['/api/chat-framing/preferences/','/api/chat-framing/suggest','/api/admin/framing-settings']) {
    assert.equal(refuseOwnedPreferences({headers:{}},{},{json,parseRequestUrl:()=>({pathname})}),false);
  }
  assert.equal(refuseOwnedPreferences({headers:{}},{},{json,parseRequestUrl:()=>null}),false);
  const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../index.cjs'),'utf8');
  const start=source.indexOf('async function handleRequestInner');
  const early=source.indexOf('.refuseOwnedPreferences(',start);
  assert.ok(early>start && early<source.indexOf('const preAuth = requestAuth.authenticate(req)',start));
  assert.ok(early<source.indexOf('workspaceStore.get(',start));
});
