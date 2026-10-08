'use strict';
// ROLE_CONTEXT_IMPL: the switch and its fail-closed paths, with a stand-in for the Rust port (no
// dav-parse.wasm needed; tests/server/role-context-differential.test.cjs runs the real module).
// The JS projection is handed out only when the port returns the byte-identical one; anything else
// refuses the context through RoleContextLeakError, the error every caller already maps to
// "context refused, not sent". Synthetic state only.
const test = require('node:test'), assert = require('node:assert/strict');
const rc = require('./role-context.cjs');
const davParseWasm = require('./dav-parse-wasm.cjs');

const { projectRoleContext, projectSharedDossier, roleContextImpl, RoleContextLeakError, RoleContextError } = rc;

const state = () => ({
  taskId: 'task-7', tenantId: 'tenant-a', request: 'Tidy the notes; key sk-test0000aaaa1111bbbb.',
  roleSystemPrompts: { planner: 'You plan.', executor: 'You execute.' },
  diary: ['DIARY-CANARY-0001 private'],
});

/** A port that answers as the JS does (from the JS itself), with `over` replacing either call. */
function fakePort(over = {}) {
  const calls = [];
  const port = {
    roleContextProject: (role, s) => {
      calls.push(['project', role]);
      const r = projectRoleContext(role, s, { impl: 'js' });
      return { value: JSON.parse(JSON.stringify(r.projection)), redactions: r.meta.redactions };
    },
    roleContextDossier: (roles, s) => {
      calls.push(['dossier', roles]);
      const r = projectSharedDossier(s, { roles, impl: 'js' });
      return { value: JSON.parse(JSON.stringify(r.dossier)), redactions: r.meta.redactions };
    },
    ...over,
  };
  return { loader: () => port, calls };
}
const wasm = (port) => ({ impl: 'wasm', wasmLoader: port.loader });

function quietly(fn) {
  const warn = console.warn, seen = [];
  console.warn = (m) => seen.push(String(m));
  try { return { value: fn(), seen }; } finally { console.warn = warn; }
}
function refusedWith(fn, classes) {
  const { seen } = quietly(() => assert.throws(fn, (err) => err instanceof RoleContextLeakError && assert.deepEqual(err.classes, classes) === undefined));
  return seen;
}

test('ROLE_CONTEXT_IMPL: default js, wasm when set, anything else js with one warning', () => {
  const { seen } = quietly(() => {
    assert.equal(roleContextImpl({}), 'js');
    assert.equal(roleContextImpl({ ROLE_CONTEXT_IMPL: '' }), 'js');
    assert.equal(roleContextImpl({ ROLE_CONTEXT_IMPL: ' WASM ' }), 'wasm');
    assert.equal(roleContextImpl({ ROLE_CONTEXT_IMPL: 'js' }), 'js');
    assert.equal(roleContextImpl({ ROLE_CONTEXT_IMPL: 'rust' }), 'js');
    assert.equal(roleContextImpl({ ROLE_CONTEXT_IMPL: 'rust' }), 'js');
  });
  assert.deepEqual(seen, ['[role-context] ROLE_CONTEXT_IMPL="rust" is not js or wasm; using js']);
  assert.ok(davParseWasm.IMPL_FLAGS.includes('ROLE_CONTEXT_IMPL'), 'a missing or tampered module stops startup');
});

test('js (the default) never asks the port; the env handed in picks wasm', () => {
  const port = fakePort();
  const r = projectRoleContext('planner', state(), { env: {}, wasmLoader: port.loader });
  assert.equal(r.projection.request, 'Tidy the notes; key [redacted credential].');
  projectSharedDossier(state(), { env: {}, wasmLoader: port.loader });
  assert.deepEqual(port.calls, []);
  const viaEnv = fakePort();
  projectRoleContext('planner', state(), { env: { ROLE_CONTEXT_IMPL: 'wasm' }, wasmLoader: viaEnv.loader });
  projectSharedDossier(state(), { roles: ['planner'], env: { ROLE_CONTEXT_IMPL: 'wasm' }, wasmLoader: viaEnv.loader });
  assert.deepEqual(viaEnv.calls, [['project', 'planner'], ['dossier', ['planner']]]);
});

test('wasm: an agreeing port leaves the JS answer exactly as it is', () => {
  const port = fakePort();
  for (const role of ['planner', 'executor', 'auditor', 'reviewer']) {
    const js = projectRoleContext(role, state(), { impl: 'js' });
    const both = projectRoleContext(role, state(), wasm(port));
    assert.deepEqual(both, js, role);
    assert.ok(Object.isFrozen(both.projection));
  }
  const d = projectSharedDossier(state(), wasm(port));
  assert.deepEqual(d, projectSharedDossier(state(), { impl: 'js' }));
});

test('wasm: the port can refuse a projection the JS would hand out, never widen one', () => {
  const cases = [
    [{ roleContextProject: () => ({ leak: ['diary'] }) }, ['diary']],
    [{ roleContextProject: () => ({ leak: ['credentials', 'credential_pattern'] }) }, ['credentials', 'credential_pattern']],
    [{ roleContextProject: () => ({ refused: 'too_large' }) }, ['impl_mismatch']],
    [{ roleContextProject: (role, s) => ({ value: { ...projectRoleContext(role, s, { impl: 'js' }).projection, extra: 'x' }, redactions: 1 }) }, ['impl_mismatch']],
    [{ roleContextProject: (role, s) => ({ value: { role: 'planner' }, redactions: 1 }) }, ['impl_mismatch']],
    [{ roleContextProject: (role, s) => ({ value: JSON.parse(JSON.stringify(projectRoleContext(role, s, { impl: 'js' }).projection)), redactions: 0 }) }, ['impl_mismatch']],
    [{ roleContextProject: () => undefined }, ['impl_mismatch']],
    [{ roleContextProject: () => { throw Object.assign(Error('port fault'), { reason: 'ambiguous' }); } }, ['impl_refused']],
    [{ roleContextProject: () => { throw Object.assign(Error('port fault'), { reason: 'trap' }); } }, ['impl_refused']],
  ];
  for (const [over, classes] of cases) refusedWith(() => projectRoleContext('planner', state(), wasm(fakePort(over))), classes);
  // A loader that cannot load the module refuses too.
  refusedWith(() => projectRoleContext('planner', state(), { impl: 'wasm', wasmLoader: () => { throw Object.assign(Error('no module'), { reason: 'missing' }); } }), ['impl_refused']);
});

test('wasm: the shared dossier fails closed the same way', () => {
  refusedWith(() => projectSharedDossier(state(), wasm(fakePort({ roleContextDossier: () => ({ leak: ['other_tenants'] }) }))), ['other_tenants']);
  refusedWith(() => projectSharedDossier(state(), wasm(fakePort({ roleContextDossier: () => ({ value: {}, redactions: 1 }) }))), ['impl_mismatch']);
  refusedWith(() => projectSharedDossier(state(), wasm(fakePort({ roleContextDossier: () => { throw Error('x'); } }))), ['impl_refused']);
});

test('wasm: faults and disagreements are logged once per reason, without any state text', () => {
  const port = fakePort({ roleContextProject: () => { throw Object.assign(Error('port fault'), { reason: 'reason-once-test' }); } });
  const first = refusedWith(() => projectRoleContext('planner', state(), wasm(port)), ['impl_refused']);
  const again = refusedWith(() => projectRoleContext('planner', state(), wasm(port)), ['impl_refused']);
  assert.deepEqual(first, ['[role-context] role_context.wasm_fault (reason-once-test); the context was refused']);
  assert.deepEqual(again, []);
  for (const line of first) assert.ok(!/tenant-a|DIARY|sk-test|Tidy/.test(line));
});

test('when the JS refuses, the port is not asked and the JS error stands', () => {
  const port = fakePort();
  assert.throws(() => projectRoleContext('boss', state(), wasm(port)), (e) => e instanceof RoleContextError && e.code === 'unknown_role');
  assert.throws(() => projectRoleContext('planner', { taskId: 1 }, wasm(port)), (e) => e.code === 'missing_tenant');
  assert.throws(() => projectRoleContext('planner', { ...state(), request: 'DIARY-CANARY-0001 private' }, wasm(port)), (e) => e instanceof RoleContextLeakError && e.classes.includes('diary'));
  assert.throws(() => projectSharedDossier(state(), { roles: [], ...wasm(port) }), (e) => e.code === 'unknown_role');
  assert.deepEqual(port.calls, []);
});

test('dav-parse-wasm reply shapes: anything unexpected is a fault', () => {
  const { roleContextReply } = davParseWasm;
  assert.deepEqual(roleContextReply({ projection: { a: 1 }, redactions: 0 }, 'projection'), { value: { a: 1 }, redactions: 0 });
  assert.deepEqual(roleContextReply({ refused: 'missing_tenant' }, 'projection'), { refused: 'missing_tenant' });
  assert.deepEqual(roleContextReply({ leak: ['diary', 'credential_pattern'] }, 'dossier'), { leak: ['diary', 'credential_pattern'] });
  for (const bad of [null, [], {}, { projection: [], redactions: 0 }, { projection: {}, redactions: -1 }, { projection: {}, redactions: 1.5 },
    { projection: {}, redactions: 0, extra: 1 }, { dossier: {}, redactions: 0 }, { refused: 'nope' }, { leak: [] }, { leak: ['diary', 'diary'] },
    { leak: ['made_up'] }, { leak: 'diary' }]) {
    assert.throws(() => roleContextReply(bad, 'projection'), { reason: 'reply' }, JSON.stringify(bad));
  }
});

test('dav-parse-wasm input: a state JSON cannot write is refused before the module is touched', () => {
  const cyclic = { tenantId: 't' }; cyclic.self = cyclic;
  assert.throws(() => davParseWasm.roleContextProject('planner', cyclic), { reason: 'input' });
  assert.throws(() => davParseWasm.roleContextProject('planner', { tenantId: 't', n: 1n }), { reason: 'input' });
  assert.throws(() => davParseWasm.roleContextProject('planner', { tenantId: 't', big: 'x'.repeat(davParseWasm.MAX_ROLE_CONTEXT_BYTES) }), { reason: 'too_large' });
});
