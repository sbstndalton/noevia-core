'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createApprovals } = require('./approvals.cjs');

// The gate's state, exercised without a server: every write blocks on a human
// answer, a decision is single-use, and "allow for this chat" never leaks to
// another chat or user.

function pending(gate, overrides = {}) {
  const ctrl = new AbortController();
  const p = gate.awaitApproval({ id: overrides.id || 'ap-1', userId: overrides.userId || 'u1', chatId: overrides.chatId || 'c1', abortSignal: ctrl.signal });
  return { promise: p, ctrl };
}

test('a fresh gate has nothing pending and no chat-wide grant', () => {
  const gate = createApprovals();
  assert.equal(gate.pendingApprovals.size, 0);
  assert.equal(gate.chatWideApproved('u1', 'c1'), false);
  assert.equal(gate.chatWideApproved(null, null), false);
});

test('approve and deny resolve the waiting call once and clear the id', async () => {
  const gate = createApprovals();
  const a = pending(gate, { id: 'a' });
  assert.equal(gate.pendingApprovals.get('a').userId, 'u1');
  assert.equal(gate.pendingApprovals.get('a').decide('approve'), true);
  assert.equal(await a.promise, 'approve');
  assert.equal(gate.pendingApprovals.has('a'), false);

  const b = pending(gate, { id: 'b' });
  assert.equal(gate.pendingApprovals.get('b').decide('deny'), true);
  assert.equal(await b.promise, 'deny');
  assert.equal(gate.chatWideApproved('u1', 'c1'), false, 'a single approval never widens');
});

test('only the three decisions are accepted', () => {
  const gate = createApprovals();
  const a = pending(gate, { id: 'a' });
  const entry = gate.pendingApprovals.get('a');
  assert.equal(entry.decide('yes'), false);
  assert.equal(entry.decide(''), false);
  assert.equal(gate.pendingApprovals.has('a'), true, 'a rejected decision leaves the approval pending');
  a.ctrl.abort();
});

test('approve_all grants this chat for this user only, and expires', async () => {
  let t = 1_000_000;
  const gate = createApprovals({ now: () => t, ttlMs: 60_000 });
  const a = pending(gate, { id: 'a', userId: 'u1', chatId: 'c1' });
  gate.pendingApprovals.get('a').decide('approve_all');
  assert.equal(await a.promise, 'approve');
  assert.equal(gate.chatWideApproved('u1', 'c1'), true);
  assert.equal(gate.chatWideApproved('u1', 'c2'), false, 'another chat still asks');
  assert.equal(gate.chatWideApproved('u2', 'c1'), false, 'another user still asks');
  t += 60_001;
  assert.equal(gate.chatWideApproved('u1', 'c1'), false, 'the grant expires with the process TTL');
});

test('a closed tab or stop is not an approval', async () => {
  const gate = createApprovals();
  const a = pending(gate, { id: 'a' });
  a.ctrl.abort();
  assert.equal(await a.promise, 'aborted');
  assert.equal(gate.pendingApprovals.size, 0);
});

test('waiting too long is a denial, never an approval', async () => {
  const gate = createApprovals({ timeoutMs: 5 });
  const a = pending(gate, { id: 'a' });
  assert.equal(await a.promise, 'timeout');
  assert.equal(gate.pendingApprovals.size, 0);
  assert.equal(gate.chatWideApproved('u1', 'c1'), false);
});

for (const action of ['approve','deny','approve_all']) test(`records original ${action} before granting`,async()=>{
  const gate=createApprovals(), recorded=[];
  const promise=gate.awaitApproval({id:'recorded',userId:'u',chatId:'c',abortSignal:new AbortController().signal,onDecision:value=>recorded.push(value)});
  gate.pendingApprovals.get('recorded').decide(action);
  assert.deepEqual(recorded,[action]);assert.equal(await promise,action==='approve_all'?'approve':action);
});
test('checkpoint failure cannot grant an approval',async()=>{
  const gate=createApprovals(),ctrl=new AbortController();
  const promise=gate.awaitApproval({id:'broken',userId:'u',chatId:'c',abortSignal:ctrl.signal,onDecision:()=>{throw Error('disk failure');}});
  assert.throws(()=>gate.pendingApprovals.get('broken').decide('approve_all'),/disk failure/);
  assert.equal(gate.chatWideApproved('u','c'),false);ctrl.abort();assert.equal(await promise,'aborted');
});
