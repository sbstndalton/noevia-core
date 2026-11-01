'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolApprovalBridge, FACTS, RESOLVE } = require('./rust-tool-approval-bridge.cjs');
const { createApprovals } = require('./approvals.cjs');
const { owned, refuseOwned } = require('./rust-tool-approvals.cjs');
function fixture(gate = createApprovals()) {
  const active = new Set(['owner', 'other']);
  const handle = createToolApprovalBridge({ secret: 'synthetic-secret', pendingApprovals: gate.pendingApprovals,
    withActiveUser: (user, fn) => active.has(user) ? fn() : null,
    readJson: async req => req.body, json: (res, status, body) => Object.assign(res, { status, body }) });
  const call = async (url, body, extra = {}) => {
    const res = {}; await handle({ method: 'POST', url, body, socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-noevia-store-token': 'synthetic-secret' }, ...extra }, res); return res;
  };
  return { gate, active, call };
}
test('only the exact public POST is refused before Node auth; other methods stay unowned', () => {
  assert.equal(owned('POST','/api/tool-approvals/a'),true);
  for (const [m,p] of [['GET','/api/tool-approvals/a'],['POST','/api/tool-approvals/'],['POST','/api/tool-approvals/a/b']]) assert.equal(owned(m,p),false);
  const res={}; assert.equal(refuseOwned({method:'POST'},res,{parseRequestUrl:()=>({pathname:'/api/tool-approvals/a'}),json:(r,status,body)=>Object.assign(r,{status,body})}),true);
  assert.equal(res.status,503); assert.equal(res.body.code,'RUST_TOOL_APPROVALS_OWNED');
});
test('bridge rejects untrusted peers, forwarded callers and missing token without consuming pending state', async () => {
  const f=fixture(); let calls=0; f.gate.pendingApprovals.set('a',{userId:'owner',decide:()=>{calls++;return true;}});
  for(const extra of [{socket:{remoteAddress:'10.1.2.3'}},{headers:{'x-noevia-store-token':'synthetic-secret','x-forwarded-for':'127.0.0.1'}},{headers:{'x-noevia-store-token':'synthetic-secret','x-noevia-client-ip':'127.0.0.1'}},{headers:{}}]) assert.equal((await f.call(FACTS,{user:'owner',id:'a'},extra)).status,404);
  assert.equal(calls,0);
});
test('routing owner, generation, invalid choice and remember semantics are checked before consumption', async () => {
  const f=fixture(); const ctl=new AbortController();
  const waiting=f.gate.awaitRouteChoice({id:'a',userId:'owner',chatId:'chat',abortSignal:ctl.signal});
  try {
    assert.deepEqual((await f.call(FACTS,{user:'other',id:'a'})).body,{found:false});
    const facts=(await f.call(FACTS,{user:'owner',id:'a'})).body;
    assert.equal(facts.kind,'route'); assert.match(facts.generation,/^[0-9a-f]{32}$/);
    const input={user:'owner',id:'a',kind:'route',generation:facts.generation};
    assert.deepEqual((await f.call(RESOLVE,{...input,user:'other',decision:'cloud'})).body,{found:false});
    assert.deepEqual((await f.call(RESOLVE,{...input,decision:'approve_all'})).body,{found:true,accepted:false});
    assert.equal(f.gate.pendingApprovals.has('a'),true);
    assert.deepEqual((await f.call(RESOLVE,{...input,decision:'cloud',remember:1})).body,{found:true,accepted:true});
    assert.deepEqual(await waiting,{choice:'cloud',remember:false});
    assert.deepEqual((await f.call(RESOLVE,{...input,decision:'local'})).body,{found:false});
    assert.equal(f.gate.chatWideApproved('owner','chat','space:free'),false);
  } finally {ctl.abort();}
});
test('expiry, replacement and disabled/deleted account never resolve a stale generation', async () => {
  const f=fixture(); let calls=0;
  const pending=()=>({userId:'owner',kind:'route',decide:()=>{calls++;return true;}});
  f.gate.pendingApprovals.set('a',pending());
  const facts=(await f.call(FACTS,{user:'owner',id:'a'})).body;
  const input={user:'owner',id:'a',kind:'route',generation:facts.generation,decision:'cloud'};
  f.gate.pendingApprovals.delete('a'); assert.deepEqual((await f.call(RESOLVE,input)).body,{found:false});
  f.gate.pendingApprovals.set('a',pending()); assert.deepEqual((await f.call(RESOLVE,input)).body,{found:false});
  const fresh=(await f.call(FACTS,{user:'owner',id:'a'})).body;
  f.active.delete('owner'); assert.deepEqual((await f.call(RESOLVE,{...input,generation:fresh.generation})).body,{found:false});
  assert.equal(calls,0);
});
test('strict true route remember survives the narrow bridge', async () => {
  const f=fixture(); const ctl=new AbortController(); const waiting=f.gate.awaitRouteChoice({id:'a',userId:'owner',chatId:'chat',abortSignal:ctl.signal});
  try { const facts=(await f.call(FACTS,{user:'owner',id:'a'})).body; await f.call(RESOLVE,{...facts,user:'owner',id:'a',decision:'local',remember:true}); assert.deepEqual(await waiting,{choice:'local',remember:true}); } finally {ctl.abort();}
});
test('a real expired routing question is absent and cannot be answered later', async () => {
  const f=fixture(createApprovals({timeoutMs:5})); const ctl=new AbortController();
  const waiting=f.gate.awaitRouteChoice({id:'expires',userId:'owner',chatId:'chat',abortSignal:ctl.signal});
  const facts=(await f.call(FACTS,{user:'owner',id:'expires'})).body;
  assert.deepEqual(await waiting,{choice:'timeout'});
  assert.deepEqual((await f.call(RESOLVE,{...facts,user:'owner',id:'expires',decision:'cloud'})).body,{found:false});
});
test('bridge dependency errors produce a generic unavailable reply without consuming pending state', async () => {
  let calls=0;
  const handle=createToolApprovalBridge({secret:'synthetic',pendingApprovals:new Map([['a',{userId:'owner',decide:()=>{calls++;}}]]),
    withActiveUser:()=>{throw Error('private database detail');}, readJson:async()=>({user:'owner',id:'a'}),json:(r,status,body)=>Object.assign(r,{status,body})});
  const res={}; await handle({method:'POST',url:FACTS,socket:{remoteAddress:'::1'},headers:{'x-noevia-store-token':'synthetic'}},res);
  assert.equal(res.status,503); assert.equal(JSON.stringify(res).includes('private'),false); assert.equal(calls,0);
});
test('write gate checkpoint refusal never consumes an approval or creates a chat grant', async () => {
  const f=fixture(); const ctl=new AbortController();
  const waiting=f.gate.awaitApproval({id:'write',userId:'owner',chatId:'chat',scope:'project:p',abortSignal:ctl.signal,onDecision:()=>{throw Error('checkpoint unavailable');}});
  try {
    const facts=(await f.call(FACTS,{user:'owner',id:'write'})).body;
    assert.equal(facts.kind,'write');
    const reply=await f.call(RESOLVE,{...facts,user:'owner',id:'write',decision:'approve_all'});
    assert.equal(reply.status,503); assert.equal(f.gate.pendingApprovals.has('write'),true);
    assert.equal(f.gate.chatWideApproved('owner','chat','project:p'),false);
  } finally {ctl.abort();}
  assert.equal(await waiting,'aborted');
});
