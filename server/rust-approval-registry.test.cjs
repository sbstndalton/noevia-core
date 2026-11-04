'use strict';
// Port contract 2026-11-04 S9: Node's approval gate is a client of the Rust front's registry. The
// #2282 bridge tests (owner, generation, kind, disabled account) moved with the state: the front
// pins them (noevia-rs tests/tool_approvals.rs, approval_registry.rs). Here: Node scopes every op
// to its user, cannot answer a question itself, opens before it waits, fails closed, and a turn
// that stops drops its wait so the question is withdrawn rather than declined (#679).
// Synthetic users, chats and a loopback stand-in for the front only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createApprovalRegistry, OPS } = require('./rust-approval-registry.cjs');
const { createClient } = require('./project-store-client.cjs');
const { startFakeApprovalStore } = require('../tests/server/fake-approval-store.cjs');

async function fixture(t, options = {}) {
  const store = await startFakeApprovalStore();
  t.after(() => store.close());
  const client = createClient({ port: store.port, token: store.token });
  const logs = [];
  const gate = createApprovalRegistry({ approvals: client.approvals, log: (m) => logs.push(m), ...options });
  return { store, gate, logs };
}
const binding = { user: 'owner', canonicalChatId: 'chat', scope: 'project:p', context: { canonicalChatId: 'chat', holder: { kind: 'project', id: 'p' }, generation: '0', start: '0123456789abcdef0123456789abcdef', tombstoned: false } };
const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5)); };

test('Node can only open, wait for, withdraw and check its own questions; it can never answer one', () => {
  assert.deepEqual([...OPS].sort(), ['cancel', 'granted', 'open', 'redeem', 'revoke', 'wait']);
  assert.equal(fs.existsSync(path.join(__dirname, 'rust-tool-approval-bridge.cjs')), false, 'the #2282 facts/resolve bridge is gone');
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.match(index, /require\('\.\/rust-approval-registry\.cjs'\)\.createApprovalRegistry\(/);
  assert.doesNotMatch(index, /require\('\.\/approvals\.cjs'\)|rust-tool-approval-bridge|\/internal\/tool-approvals/);
});

test('a write question is opened (owner, chat, scope, binding) before its wait, and its answer is the outcome', async (t) => {
  const { store, gate } = await fixture(t);
  const ctl = new AbortController();
  assert.equal(await gate.openApproval({ id: 'ap-1', userId: 'owner', chatId: 'chat', scope: 'project:p', binding, abortSignal: ctl.signal }), true);
  assert.deepEqual(store.seen[0], { op: 'open', body: { user: 'owner', id: 'ap-1', kind: 'write', chat: 'chat', scope: 'project:p', binding } });
  assert.equal(store.answer('other', 'ap-1', { outcome: 'approve' }), false, 'another account cannot answer it');
  const waiting = gate.awaitApproval({ id: 'ap-1', userId: 'owner', abortSignal: ctl.signal });
  await until(() => store.seen.length === 2);
  assert.deepEqual(store.seen[1], { op: 'wait', body: { user: 'owner', id: 'ap-1' } });
  assert.equal(store.answer('owner', 'ap-1', { outcome: 'approve' }), true);
  assert.equal(await waiting, 'approve');
  assert.equal(store.answer('owner', 'ap-1', { outcome: 'deny' }), false, 'single use');
  for (const outcome of ['deny', 'timeout']) {
    await gate.openApproval({ id: outcome, userId: 'owner' });
    store.answer('owner', outcome, { outcome });
    assert.equal(await gate.awaitApproval({ id: outcome, userId: 'owner', abortSignal: ctl.signal }), outcome);
  }
  // An answer the front never gives is no approval.
  await gate.openApproval({ id: 'odd', userId: 'owner' });
  store.answer('owner', 'odd', { outcome: 'approve_all' });
  assert.equal(await gate.awaitApproval({ id: 'odd', userId: 'owner', abortSignal: ctl.signal }), 'unavailable');
  assert.equal(await gate.openApproval({ id: 'odd', userId: 'owner' }), true, 'withdrawn ids may be asked again');
  assert.equal(await gate.openApproval({ id: 'odd', userId: 'owner' }), false, 'an open id is not replaced');
});

test('a routing question keeps its own choices and a strictly boolean remember', async (t) => {
  const { store, gate } = await fixture(t);
  const ctl = new AbortController();
  assert.equal(await gate.openRouteChoice({ id: 'r1', userId: 'owner', chatId: 'chat', scope: 'ignored', binding }), true);
  assert.deepEqual(store.seen[0].body, { user: 'owner', id: 'r1', kind: 'route', chat: 'chat', scope: null, binding: null }, 'a routing answer never carries a write grant');
  store.answer('owner', 'r1', { outcome: 'local', remember: true });
  assert.deepEqual(await gate.awaitRouteChoice({ id: 'r1', userId: 'owner', abortSignal: ctl.signal }), { choice: 'local', remember: true });
  await gate.openRouteChoice({ id: 'r2', userId: 'owner' });
  store.answer('owner', 'r2', { outcome: 'cloud', remember: 1 });
  assert.deepEqual(await gate.awaitRouteChoice({ id: 'r2', userId: 'owner', abortSignal: ctl.signal }), { choice: 'cloud', remember: false });
  await gate.openRouteChoice({ id: 'r3', userId: 'owner' });
  store.answer('owner', 'r3', { outcome: 'approve' });
  assert.deepEqual(await gate.awaitRouteChoice({ id: 'r3', userId: 'owner', abortSignal: ctl.signal }), { choice: 'timeout' });
});

test('#679: a turn that stops while the card is open drops its wait; the question is withdrawn, not declined', async (t) => {
  const { store, gate } = await fixture(t);
  const ctl = new AbortController();
  await gate.openApproval({ id: 'ap-left', userId: 'owner', chatId: 'chat', scope: 'project:p', binding });
  const waiting = gate.awaitApproval({ id: 'ap-left', userId: 'owner', abortSignal: ctl.signal });
  await until(() => store.seen.some((s) => s.op === 'wait'));
  ctl.abort();
  assert.equal(await waiting, 'aborted', 'stopped: neither declined nor timed out');
  await until(() => store.dropped.includes('ap-left'));
  assert.deepEqual(store.dropped, ['ap-left'], 'the front saw the wait dropped');
  assert.equal(store.answer('owner', 'ap-left', { outcome: 'approve' }), false, 'a late Allow has nothing to approve');
  // Stopped before the wait even started: no wait is sent, and the open question is withdrawn.
  const gone = new AbortController();
  await gate.openApproval({ id: 'ap-early', userId: 'owner' });
  gone.abort();
  assert.equal(await gate.awaitApproval({ id: 'ap-early', userId: 'owner', abortSignal: gone.signal }), 'aborted');
  assert.deepEqual(await gate.awaitRouteChoice({ id: 'ap-early', userId: 'owner', abortSignal: gone.signal }), { choice: 'aborted' });
  await until(() => !store.questions.has('ap-early'));
  assert.equal(store.questions.has('ap-early'), false);
  assert.equal(store.seen.filter((s) => s.op === 'wait' && s.body.id === 'ap-early').length, 0);
});

test('an unreachable front fails closed: nothing is asked, approved or granted', async () => {
  const logs = [];
  const client = createClient({ port: 9, token: 'synthetic-store-token-0123456789abcdef', timeoutMs: 500 });
  const gate = createApprovalRegistry({ approvals: client.approvals, log: (m) => logs.push(m) });
  const ctl = new AbortController();
  assert.equal(await gate.openApproval({ id: 'x', userId: 'owner', chatId: 'chat' }), false);
  assert.equal(await gate.awaitApproval({ id: 'x', userId: 'owner', abortSignal: ctl.signal }), 'unavailable');
  assert.deepEqual(await gate.awaitRouteChoice({ id: 'x', userId: 'owner', abortSignal: ctl.signal }), { choice: 'timeout' });
  assert.equal(await gate.chatWideApproved('owner', 'chat', 'project:p', binding), false);
  assert.equal(await gate.revokeChatGrant('owner', 'chat'), false);
  assert.ok(logs.length >= 4 && logs.every((m) => /^\[tool-approvals\] [a-z ]+ failed: [A-Z_a-z]+$/.test(m)), logs.join('\n'));
});

test('a grant is checked and revoked at the front, and never without a user, chat, scope and binding', async (t) => {
  const { store, gate } = await fixture(t);
  store.grants.set('owner\nchat', 'project:p');
  assert.ok(await gate.chatWideApproved('owner', 'chat', 'project:p', binding));
  assert.equal(await gate.chatWideApproved('owner', 'chat', 'space:free', binding), false);
  const before = store.seen.length;
  for (const args of [[null, 'chat', 'project:p', binding], ['owner', null, 'project:p', binding], ['owner', '', 'project:p', binding], ['owner', '!!', 'project:p', binding], ['owner', 'chat', '', binding], ['owner', 'chat', 'project:p', null]]) {
    assert.equal(await gate.chatWideApproved(...args), false, JSON.stringify(args));
  }
  assert.equal(store.seen.length, before, 'checked locally, nothing asked');
  assert.equal(await gate.revokeChatGrant('owner', 'chat'), true);
  assert.equal(await gate.chatWideApproved('owner', 'chat', 'project:p', binding), false);
  assert.equal(await gate.revokeChatGrant('owner', null), false);
});

test('a revoke the front did not confirm denies the grant, even after the front is back, until the retry lands', async (t) => {
  const { store, gate, logs } = await fixture(t, { revokeRetry: { firstMs: 150, maxMs: 150 } });
  store.grants.set('owner\nchat', 'project:p');
  assert.ok(await gate.chatWideApproved('owner', 'chat', 'project:p', binding));
  store.down.add('revoke');
  assert.equal(await gate.revokeChatGrant('owner', 'chat'), false, 'the front is down');
  assert.equal(gate.revokePending('owner', 'chat'), true);
  assert.equal(store.grants.has('owner\nchat'), true, 'the front still holds the grant');
  const asked = store.seen.filter((x) => x.op === 'granted').length;
  assert.equal(await gate.chatWideApproved('owner', 'chat', 'project:p', binding), false, 'denied while the front is down');
  // The front comes back (its grant still there), but the retry has not landed yet.
  store.down.delete('revoke');
  assert.equal(await gate.chatWideApproved('owner', 'chat', 'project:p', binding), false, 'denied though the front would say granted');
  assert.equal(store.seen.filter((x) => x.op === 'granted').length, asked, 'the record is read first; the front is not asked');
  assert.equal(await gate.chatWideApproved('owner', 'other-chat', 'project:p', binding), false);
  await until(() => !gate.revokePending('owner', 'chat'));
  assert.equal(gate.revokePending('owner', 'chat'), false, 'cleared once the front confirmed the retried revoke');
  assert.equal(store.grants.has('owner\nchat'), false, 'the retry revoked the grant at the front');
  assert.ok(logs.some((m) => /revoke failed/.test(m)));
});

test('retries back off, and a successful retry clears the record', async (t) => {
  const { store, gate } = await fixture(t, { revokeRetry: { firstMs: 20, maxMs: 80 } });
  store.down.add('revoke');
  await gate.revokeChatGrant('owner', 'chat');
  await until(() => store.seen.filter((x) => x.op === 'revoke').length >= 4);
  assert.equal(gate.revokePending('owner', 'chat'), true, 'still pending while every retry fails');
  store.down.delete('revoke');
  await until(() => !gate.revokePending('owner', 'chat'));
  assert.equal(gate.revokePending('owner', 'chat'), false);
  const tries = store.seen.filter((x) => x.op === 'revoke');
  assert.ok(tries.length >= 5 && tries.at(-1).down !== true, 'the last try reached the front');
  // A later grant in that chat is honoured again.
  store.grants.set('owner\nchat', 'project:p');
  assert.ok(await gate.chatWideApproved('owner', 'chat', 'project:p', binding));
});

test('a pending revoke is dropped once no grant it shadows could still be live', async (t) => {
  let clock = 1_000_000;
  const { store, gate } = await fixture(t, { now: () => clock, grantTtlMs: 1000, revokeRetry: { firstMs: 60_000, maxMs: 60_000 } });
  store.down.add('revoke');
  await gate.revokeChatGrant('owner', 'chat');
  assert.equal(gate.revokePending('owner', 'chat'), true);
  clock += 1000;
  assert.equal(gate.revokePending('owner', 'chat'), false, 'older than any grant the front can hold');
});

// Review aadda5e P1-1 / P1-2: revocation races, driven deterministically. Each call to the front is
// a deferred the test settles by hand; retries run only when the test fires them.
function controlled() {
  const calls = [];
  const approvals = (op, payload) => new Promise((resolve, reject) => {
    calls.push({ op, payload, ok: (body) => resolve({ status: 200, body }), fail: () => reject(Object.assign(new Error('down'), { code: 'PROJECTS_BUSY' })) });
  });
  const timers = [];
  const schedule = (fn, ms) => { const t = { fn, ms, cleared: false, clear() { t.cleared = true; } }; timers.push(t); return t; };
  const fire = async () => { const t = timers.find((x) => !x.cleared && !x.fired); assert.ok(t, 'a retry is scheduled'); t.fired = true; await t.fn(); };
  const live = () => timers.filter((x) => !x.cleared && !x.fired).length;
  const gate = createApprovalRegistry({ approvals, schedule, log: () => {} });
  const flush = () => new Promise((r) => setImmediate(r));
  const next = async (op) => { await flush(); const c = calls.find((x) => x.op === op && !x.taken); assert.ok(c, `a ${op} request`); c.taken = true; return c; };
  return { gate, calls, fire, live, next, flush };
}

test('P1-1: a revoke confirmed while a granted:true answer is in flight wins over that answer', async () => {
  const f = controlled();
  const check = f.gate.chatWideApproved('owner', 'chat', 'project:p', binding);
  const grantedCall = await f.next('granted');
  const revoke = f.gate.revokeChatGrant('owner', 'chat');
  (await f.next('revoke')).ok({ revoked: true });
  assert.equal(await revoke, true);
  assert.equal(f.gate.revokePending('owner', 'chat'), false, 'the revoke was confirmed');
  grantedCall.ok({ granted: true, ticket: 't-stale' }); // produced before the revoke reached the front
  assert.equal(await check, false, 'the stale answer is refused');
  // A check that starts after the revoke is answered on its own merits.
  const later = f.gate.chatWideApproved('owner', 'chat', 'project:p', binding);
  (await f.next('granted')).ok({ granted: true, ticket: 't-later' });
  assert.equal((await later).ticket, 't-later');
});

test('P1-1: a failed revoke whose retry succeeds while a granted:true answer is in flight still wins', async () => {
  const f = controlled();
  const check = f.gate.chatWideApproved('owner', 'chat', 'project:p', binding);
  const grantedCall = await f.next('granted');
  const revoke = f.gate.revokeChatGrant('owner', 'chat');
  (await f.next('revoke')).fail();
  assert.equal(await revoke, false);
  assert.equal(f.gate.revokePending('owner', 'chat'), true);
  const retry = f.fire();
  (await f.next('revoke')).ok({ revoked: true });
  await retry;
  assert.equal(f.gate.revokePending('owner', 'chat'), false, 'the retry was confirmed and cleared the record');
  grantedCall.ok({ granted: true, ticket: 't-stale' });
  assert.equal(await check, false, 'the stale answer is refused after the record is gone');
});

test('P1-2: an older explicit revoke confirmation never clears a newer failed revoke', async () => {
  const f = controlled();
  const r1 = f.gate.revokeChatGrant('owner', 'chat');
  const r1Call = await f.next('revoke');
  // Meanwhile a new approve_all grant is made at the front, then a target change revokes again.
  const r2 = f.gate.revokeChatGrant('owner', 'chat');
  (await f.next('revoke')).fail();
  assert.equal(await r2, false);
  r1Call.ok({ revoked: true }); // R1 reached the front before R2 started
  await r1;
  assert.equal(f.gate.revokePending('owner', 'chat'), true, 'R1 does not acknowledge R2');
  assert.equal(f.live(), 1, "R2's retry is still scheduled");
  assert.equal(await f.gate.chatWideApproved('owner', 'chat', 'project:p', binding), false, 'the renewed grant stays shadowed');
  const retry = f.fire();
  (await f.next('revoke')).ok({ revoked: true });
  await retry;
  assert.equal(f.gate.revokePending('owner', 'chat'), false, 'cleared by the retry that covers R2');
});

test('P1-2: an older retry never clears a newer failed revoke', async () => {
  const f = controlled();
  const r1 = f.gate.revokeChatGrant('owner', 'chat');
  (await f.next('revoke')).fail();
  await r1;
  const retry1 = f.fire(); // covers R1 only
  const retryCall = await f.next('revoke');
  const r2 = f.gate.revokeChatGrant('owner', 'chat');
  (await f.next('revoke')).fail();
  assert.equal(await r2, false);
  assert.equal(f.live(), 0, 'one try at a time: no second retry while one is in flight');
  retryCall.ok({ revoked: true });
  await retry1;
  assert.equal(f.gate.revokePending('owner', 'chat'), true, 'the R1 retry does not acknowledge R2');
  assert.equal(f.live(), 1, 'a retry covering R2 is scheduled');
  const retry2 = f.fire();
  (await f.next('revoke')).ok({ revoked: false });
  await retry2;
  assert.equal(f.gate.revokePending('owner', 'chat'), false);
  assert.equal(f.live(), 0);
});

// Re-review 1ed3a14: the front, not Node, orders grant use against every revocation. A granted:true
// answer yields only a single-use ticket; the write's redeem is what the front refuses when any
// revocation (a move, a delete, a failed move: none of them Node's) came first.
test('a front-only revoke after a granted:true answer: the ticket is refused at redeem', async (t) => {
  const { store, gate } = await fixture(t);
  store.grants.set('owner\nchat', 'project:p');
  const grant = await gate.chatWideApproved('owner', 'chat', 'project:p', binding);
  assert.match(grant.ticket, /^ticket-/);
  store.grants.delete('owner\nchat'); // the front's own move, delete or failed move; Node never hears of it
  assert.equal(await gate.redeemChatGrant('owner', 'chat', 'project:p', binding, grant), false);
  assert.deepEqual(store.seen.at(-1), { op: 'redeem', body: { user: 'owner', chat: 'chat', scope: 'project:p', binding, ticket: grant.ticket } });
});

test('a ticket redeems once; a replay is refused', async (t) => {
  const { store, gate } = await fixture(t);
  store.grants.set('owner\nchat', 'project:p');
  const grant = await gate.chatWideApproved('owner', 'chat', 'project:p', binding);
  assert.equal(await gate.redeemChatGrant('owner', 'chat', 'project:p', binding, grant), true);
  assert.equal(await gate.redeemChatGrant('owner', 'chat', 'project:p', binding, grant), false);
  for (const bad of [null, true, {}, { ticket: '' }]) {
    assert.equal(await gate.redeemChatGrant('owner', 'chat', 'project:p', binding, bad), false, JSON.stringify(bad));
  }
});

test('a front that cannot be reached at redeem is unavailable, never an approval', async (t) => {
  const { store, gate } = await fixture(t);
  store.grants.set('owner\nchat', 'project:p');
  const grant = await gate.chatWideApproved('owner', 'chat', 'project:p', binding);
  store.down.add('redeem');
  assert.equal(await gate.redeemChatGrant('owner', 'chat', 'project:p', binding, grant), 'unavailable');
  const odd = createApprovalRegistry({ approvals: async () => ({ status: 503, body: {} }) });
  assert.equal(await odd.redeemChatGrant('owner', 'chat', 'project:p', binding, grant), 'unavailable');
});

test("Node's own revoke still denies around a redeem, in either order (defence in depth)", async () => {
  const f = controlled();
  const check = f.gate.chatWideApproved('owner', 'chat', 'project:p', binding);
  (await f.next('granted')).ok({ granted: true, ticket: 't1' });
  const grant = await check;
  // Revoke first: refused without asking the front.
  const revoke = f.gate.revokeChatGrant('owner', 'chat');
  (await f.next('revoke')).ok({ revoked: true });
  await revoke;
  const before = f.calls.length;
  assert.equal(await f.gate.redeemChatGrant('owner', 'chat', 'project:p', binding, grant), false);
  assert.equal(f.calls.length, before, 'not asked');
  // Redeem in flight, then a revoke: even a front true is not accepted.
  const fresh = f.gate.chatWideApproved('owner', 'chat', 'project:p', binding);
  (await f.next('granted')).ok({ granted: true, ticket: 't2' });
  const g2 = await fresh;
  const redeem = f.gate.redeemChatGrant('owner', 'chat', 'project:p', binding, g2);
  const call = await f.next('redeem');
  const r2 = f.gate.revokeChatGrant('owner', 'chat');
  (await f.next('revoke')).ok({ revoked: true });
  await r2;
  call.ok({ redeemed: true });
  assert.equal(await redeem, false);
});
