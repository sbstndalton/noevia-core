'use strict';
// The approval route with a fake gate: a decision reaches only the pending write of the
// account that owns it, and every other id answers the same 404. The gate is approvals.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createApprovalRoutes } = require('./approvals.cjs');

function fixture({ userId = 'u1' } = {}) {
  const sent = [], decisions = [];
  const pendingApprovals = new Map([['req-1', { userId: 'u1', decide: (d) => { decisions.push(d); return ['approve', 'deny', 'approve_all'].includes(d); } }]]);
  const routes = createApprovalRoutes({
    json: (res, status, body) => { sent.push({ status, body }); },
    readBody: async (req) => { let s = ''; for await (const c of req) s += c; return s; },
    pendingApprovals,
    requestScope: { getStore: () => (userId ? { workspace: { userId } } : undefined) },
  });
  const call = (method, path, body) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
    req.method = method;
    return routes(req, {}, { path, authn: { user: { id: userId || 'anon' } } });
  };
  return { call, sent, decisions };
}

test('the owner can approve, deny or approve for the chat; anything else is refused', async () => {
  const f = fixture();
  assert.equal(await f.call('GET', '/api/tool-approvals/req-1'), false);
  assert.equal(await f.call('POST', '/api/tool-approvals'), false);
  await f.call('POST', '/api/tool-approvals/req-1', '{');
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: 'invalid JSON' } });
  await f.call('POST', '/api/tool-approvals/req-1', { decision: 'maybe' });
  assert.deepEqual(f.sent.pop(), { status: 400, body: { error: "decision must be 'approve', 'deny' or 'approve_all'" } });
  for (const decision of ['approve', 'deny', 'approve_all']) {
    await f.call('POST', '/api/tool-approvals/req-1', { decision });
    assert.deepEqual(f.sent.pop(), { status: 200, body: { ok: true } });
  }
  assert.deepEqual(f.decisions, ['maybe', 'approve', 'deny', 'approve_all']);
});

test('a stale id, another account and a missing scope all get the same answer', async () => {
  const f = fixture();
  await f.call('POST', '/api/tool-approvals/req-9', { decision: 'approve' });
  assert.deepEqual(f.sent.pop(), { status: 404, body: { error: 'no such pending approval' } });
  const other = fixture({ userId: 'u2' });
  await other.call('POST', '/api/tool-approvals/req-1', { decision: 'approve' });
  assert.deepEqual(other.sent.pop(), { status: 404, body: { error: 'no such pending approval' } });
  assert.equal(other.decisions.length, 0, 'the write stays pending for its owner');
  const unscoped = fixture({ userId: null });
  await unscoped.call('POST', '/api/tool-approvals/req-1', { decision: 'approve' });
  assert.deepEqual(unscoped.sent.pop(), { status: 404, body: { error: 'no such pending approval' } });
});
