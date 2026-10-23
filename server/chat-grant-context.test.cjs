'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const g = require('./chat-grant-context.cjs'), { context, binding } = require('../tests/server/chat-grant-fixture.cjs');
const { createApprovals } = require('./approvals.cjs');
const { createClient } = require('./project-store-client.cjs');
test('strict canonical identity/start/u64/tagged holder fail closed; aliases share key', () => {
  assert.equal(g.key('qa:u','c!'), g.key('qa:u','c'));
  assert.notEqual(g.key('qa:u','c'), g.key('qa','uc'));
  assert.equal(g.validate('qa c!', context('qac')).canonicalChatId, 'qac');
  for (const raw of ['', '!!!', 'é']) assert.throws(() => g.validate(raw, context(raw)));
  for (const patch of [{ generation: 1 },{ generation: '01' },{ generation: '-1' },{ generation: '18446744073709551616' },
    { start: '0'.repeat(32) },{ tombstoned: 0 },{ canonicalChatId: 'another' },{ holder: { kind: 'free', id: 'free' } },
    { holder: { kind: 'project', id: '' } },{ holder: { kind: 'unknown' } }]) assert.throws(() => g.validate('qa', { ...context('qa'), ...patch }));
  assert.equal(g.validate('qa', { ...context('qa'), generation:'18446744073709551615' }).generation, '18446744073709551615');
  assert.equal(g.sameHolder({kind:'free'},{kind:'project',id:'free'}), false);
});
async function grant(gate, value, action = 'approve_all') {
  const p=gate.awaitApproval({id:'qa',userId:value?.user || 'qa-user',chatId:value?.canonicalChatId || null,scope:value?.scope || 'project:p1',binding:value,abortSignal:new AbortController().signal});
  gate.pendingApprovals.get('qa').decide(action);return p;
}
test('all three decisions, move roundtrip, aliases, start, scope and TTL bind actual grants', async () => {
  let time=1;const gate=createApprovals({now:()=>time,ttlMs:10}), b=binding('qa-user','qa c!','project:p1');
  for (const action of ['approve','deny']) {
    await grant(gate,b,action);assert.equal(gate.chatWideApproved('qa-user','qac','project:p1',b),false);
  }
  await grant(gate,b);
  assert.equal(gate.chatWideApproved('qa-user','qac','project:p1',b),true);
  for (const changed of [binding('other','qac','project:p1'),binding('qa-user','qac','project:p2'),
    binding('qa-user','qac','project:p1',{generation:'2'}),binding('qa-user','qac','project:p1',{holder:{kind:'free'}})]) {
    assert.equal(gate.chatWideApproved('qa-user','qac','project:p1',changed),false);
  }
  assert.equal(gate.chatWideApproved('qa-user','qac','project:p1'),false, 'cached holder/scope is not authoritative');
  time=12;assert.equal(gate.chatWideApproved('qa-user','qac','project:p1',b),false);
  await grant(gate,binding('qa-user','qa','project:p1',{holder:{kind:'absent'}}));
  assert.equal(gate.chatWideApproved('qa-user','qa','project:p1',binding('qa-user','qa','project:p1',{holder:{kind:'absent'}})),false);
  await grant(gate,null);assert.equal(gate.chatWideApproved('qa-user',null,'project:p1',null),false);
});
test('internal client validates replies, sends only its account/chat/target and never falls back', async () => {
  const calls=[];let status=200,body=context('qa');
  const c=createClient({port:12345,token:'synthetic',fetchImpl:async(url,options)=>{calls.push({url,payload:JSON.parse(options.body)});return new Response(JSON.stringify(body),{status});}});
  assert.equal((await c.grantContext('qa-user','qa')).generation,'0');
  assert.deepEqual(calls.pop().payload,{user:'qa-user',chat:'qa'});
  body={from:{kind:'free'},to:{kind:'project',id:'free'},generation:'1'};
  assert.equal((await c.chatMove('qa-user','qa','free',{frame:null,start:'forged',generation:'99'})).from,null);
  assert.deepEqual(calls.pop().payload,{user:'qa-user',chat:'qa',projectId:'free',frame:null});
  for (const bad of [context('else'),{...context('qa'),generation:5},{...context('qa'),start:'bad'}]) {
    body=bad;await assert.rejects(c.grantContext('qa-user','qa'));
  }
  for (const s of [400,404,409,410,500,503]) {
    status=s;body={error:'refused',...(s===503?{code:'PROJECTS_BUSY'}:{})};
    await assert.rejects(c.grantContext('qa-user','qa'),e=>e.status===s);
  }
});
