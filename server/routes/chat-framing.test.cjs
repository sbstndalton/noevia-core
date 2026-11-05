'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatFramingRoutes } = require('./chat-framing.cjs');

function harness({ body = {} } = {}) {
  const saved = [];
  const routes = createChatFramingRoutes({
    json: (res, status, payload) => { res.status = status; res.body = payload; },
    readJson: async () => body,
    settings: { get: () => ({ framingRouterModel: '', framingReasonerModel: '' }), save: (v) => { saved.push(v); return v; } },
  });
  return { routes, saved };
}
const user = { user: { id: 'u1', role: 'member' } }, admin = { user: { id: 'a1', role: 'admin' } };

// Chat port S4: the suggestion is the Rust front's (rust-chat-framing-suggest.test.cjs has its loopback call);
// this mount keeps only the signed-in 405 of the other methods, the cheap authenticated probe tests use.
test('suggest: the other methods keep the signed-in 405; the POST is never answered here', async () => {
  const { routes } = harness({ body: { message: 'hello' } });
  for (const method of ['GET', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) {
    const res = {};
    assert.equal(await routes({ method }, res, { path: '/api/chat-framing/suggest', authn: user }), true);
    assert.deepEqual([res.status, res.body], [405, { error: 'method not allowed' }], method);
  }
  let res = {}; await routes({ method: 'POST' }, res, { path: '/api/chat-framing/suggest', authn: null }); assert.equal(res.status, 401);
  res = {}; await routes({ method: 'POST' }, res, { path: '/api/chat-framing/suggest', authn: user });
  assert.deepEqual([res.status, res.body.code], [503, 'RUST_CHAT_FRAMING_SUGGEST_OWNED']);
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, 'chat-framing.cjs'), 'utf8');
  assert.equal(/framing\.suggest\(|rateLimited/.test(source), false, 'no suggestion is made here any more');
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
