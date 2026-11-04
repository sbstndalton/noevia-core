'use strict';
// #2282: the public decision route is the front's. The pending-state bridge this file also tested
// (owner, generation, kind, disabled account) is gone with port contract S9: the state itself is the
// front's now, and those rules are pinned there (noevia-rs tests/tool_approvals.rs) and on Node's
// side of the new wait (rust-approval-registry.test.cjs).
const test = require('node:test');
const assert = require('node:assert/strict');
const { owned, refuseOwned } = require('./rust-tool-approvals.cjs');
test('only the exact public POST is refused before Node auth; other methods stay unowned', () => {
  assert.equal(owned('POST','/api/tool-approvals/a'),true);
  for (const [m,p] of [['GET','/api/tool-approvals/a'],['POST','/api/tool-approvals/'],['POST','/api/tool-approvals/a/b']]) assert.equal(owned(m,p),false);
  const res={}; assert.equal(refuseOwned({method:'POST'},res,{parseRequestUrl:()=>({pathname:'/api/tool-approvals/a'}),json:(r,status,body)=>Object.assign(r,{status,body})}),true);
  assert.equal(res.status,503); assert.equal(res.body.code,'RUST_TOOL_APPROVALS_OWNED');
});
