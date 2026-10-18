'use strict';
// #1071: all selectors use Rust; no JS projection can be selected.
const test = require('node:test'), assert = require('node:assert/strict');
const rc = require('./role-context.cjs');
const dav = require('./dav-parse-wasm.cjs');
const reference = require('../tests/reference/role-context-js.cjs');
const state = { tenantId: 'tenant-a', request: 'Synthetic request' };
const plain = v => JSON.parse(JSON.stringify(v));
function port() {
  const calls = [];
  return { calls, loader: () => ({
    roleContextProject(role, input) {
      calls.push(['project', role, input]);
      const r = reference.projectRoleContext(role, input, { impl: 'js' });
      return { value: plain(r.projection), redactions: r.meta.redactions };
    },
    roleContextDossier(roles, input) {
      calls.push(['dossier', roles, input]);
      const r = reference.projectSharedDossier(input, { roles, impl: 'js' });
      return { value: plain(r.dossier), redactions: r.meta.redactions };
    },
  }) };
}
test('retired ROLE_CONTEXT_IMPL cannot select JS, including explicit impl overrides', () => {
  assert.ok(!dav.IMPL_FLAGS.includes('ROLE_CONTEXT_IMPL'));
  assert.equal(dav.RETIRED_FLAGS.ROLE_CONTEXT_IMPL, 'wasm');
  for (const value of [undefined, '', 'js', 'wasm', 'invalid']) {
    const p = port();
    const opts = { env: { ROLE_CONTEXT_IMPL: value }, impl: value, wasmLoader: p.loader };
    assert.equal(rc.roleContextImpl(opts.env), 'wasm');
    const r = rc.projectRoleContext('planner', state, opts);
    const d = rc.projectSharedDossier(state, opts);
    assert.deepEqual(p.calls.map(c => c[0]), ['project','dossier']);
    assert.deepEqual(r, reference.projectRoleContext('planner', state, {impl:'js'}));
    assert.ok(Object.isFrozen(r.projection) && Object.isFrozen(r.meta));
    assert.ok(Object.isFrozen(d.dossier) && Object.isFrozen(d.meta.roles));
  }
});
test('Rust is the authority; the host returns its response rather than rebuilding JS policy', () => {
  const r = rc.projectRoleContext('planner', state, { wasmLoader: () => ({
    roleContextProject: () => ({ value: { request: 'Rust answer', role: 'planner' }, redactions: 2 }),
  }) });
  assert.equal(r.projection.request, 'Rust answer');
  assert.equal(r.meta.redactions, 2);
});
test('known Rust refusals retain the public error codes', () => {
  for (const code of ['unknown_role','invalid_state','missing_tenant','invalid_tenant','too_large']) {
    for (const dossier of [false,true]) {
      const opts = { wasmLoader: () => ({roleContextProject: () => ({refused:code}), roleContextDossier: () => ({refused:code})}) };
      assert.throws(() => dossier ? rc.projectSharedDossier(state,opts) : rc.projectRoleContext('planner',state,opts), e => e instanceof rc.RoleContextError && e.code === code);
    }
  }
});
test('leaks, missing modules, faults and malformed replies fail closed without exposing state', () => {
  const call = answer => () => ({roleContextProject: () => answer, roleContextDossier: () => answer});
  const bad = [undefined,null,[],{}, {value:[],redactions:0}, {value:{},redactions:-1}, {value:{},redactions:0,extra:1}, {refused:'unknown'}, {leak:[]}, {leak:['diary','diary']}, {leak:['made_up']}];
  for (const answer of bad) {
    const opts = {wasmLoader:call(answer)};
    assert.throws(() => rc.projectRoleContext('planner',state,opts),rc.RoleContextLeakError);
    assert.throws(() => rc.projectSharedDossier(state,opts),rc.RoleContextLeakError);
  }
  for (const loader of [() => {throw Error('secret fault');},() => ({})]) {
    assert.throws(() => rc.projectRoleContext('planner',state,{wasmLoader:loader}),e => e instanceof rc.RoleContextLeakError && !e.message.includes('secret'));
  }
  assert.throws(() => rc.projectRoleContext('planner',state,{wasmLoader:call({leak:['diary']})}),e => e instanceof rc.RoleContextLeakError && assert.deepEqual(e.classes,['diary']) === undefined);
});
test('the test-only old JS oracle remains byte-identical to the reviewed original', () => {
  const fs = require('node:fs'), crypto = require('node:crypto');
  const source = fs.readFileSync(require.resolve('../tests/reference/role-context-js.cjs'));
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'),'138da30ec353452ce68c4a00d2224c7ee641460e03338329906ef9f2c7c4a2f5');
  const runtime = fs.readFileSync(require.resolve('./role-context.cjs'),'utf8');
  for (const removed of ['projectRoleContextJs','projectSharedDossierJs','guardProjection','confirmWithPort','role-context-js']) assert.ok(!runtime.includes(removed),removed);
});
