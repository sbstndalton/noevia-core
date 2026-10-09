'use strict';
// CODE_NET_GUARD_IMPL (retired in #1071: the port always joins the JS): the fail-closed paths, with a stand-in for the Rust port (no
// dav-parse.wasm needed; the differential test runs the real module). A request is served only when
// both the JS and the port say it did not arrive on the code network; any fault refuses.
const test = require('node:test'), assert = require('node:assert/strict');
const codeNetGuard = require('./code-net-guard.cjs');
const { createCodeNetGuard } = codeNetGuard;
const davParseWasm = require('./dav-parse-wasm.cjs');

const CODE_ADDR = '172.30.0.2';
const OTHER = '172.18.0.5';

/** A port that answers as the JS would, with `over` replacing any of its three calls. */
function fakePort(over = {}) {
  const calls = [];
  const port = {
    codeNetSpec: (raw) => { calls.push('spec'); const lit = [], hosts = []; for (const e of raw.split(/[\s,]+/).filter(Boolean)) (/^[\d.]+$|:/.test(e) ? lit : hosts).push(e.toLowerCase()); return { literals: [...new Set(lit)], hosts }; },
    codeNetResolved: (answers) => { calls.push('resolved'); return answers.filter(Boolean); },
    codeNetRefuses: (addresses, local) => { calls.push('refuses'); return addresses.includes(local); },
    ...over,
  };
  return { loader: () => port, calls };
}
const fail = (reason) => () => { throw Object.assign(Error('port fault'), { reason }); };
const guard = (spec, port, extra = {}) => createCodeNetGuard({ spec, wasmLoader: port.loader, lookup: async () => [CODE_ADDR], ...extra });

test('CODE_NET_GUARD_IMPL is retired: no switch, the port is always asked, an old =js changes nothing', async () => {
  assert.equal(codeNetGuard.codeNetGuardImpl, undefined);
  assert.ok(!davParseWasm.IMPL_FLAGS.includes('CODE_NET_GUARD_IMPL'));
  assert.equal(davParseWasm.RETIRED_FLAGS.CODE_NET_GUARD_IMPL, 'wasm');
  for (const [env, impl] of [[{}, undefined], [{ CODE_NET_GUARD_IMPL: 'js' }, 'js'], [{ CODE_NET_GUARD_IMPL: 'wasm' }, 'wasm']]) {
    const port = fakePort();
    // `env` and `impl` are not options any more; whatever an old caller passes, the port is asked.
    const g = createCodeNetGuard({ spec: CODE_ADDR, env, impl, wasmLoader: port.loader });
    assert.equal(await g.refuses(CODE_ADDR), true);
    assert.equal(await g.refuses(OTHER), false);
    assert.deepEqual(port.calls, ['spec', 'refuses', 'refuses']);
  }
  const saved = process.env.CODE_NET_GUARD_IMPL;
  process.env.CODE_NET_GUARD_IMPL = 'js';
  try {
    const port = fakePort({ codeNetRefuses: () => true });
    assert.equal(await createCodeNetGuard({ spec: CODE_ADDR, wasmLoader: port.loader }).refuses(OTHER), true, 'a port refusal stands even with the old =js in the environment');
  } finally { if (saved === undefined) delete process.env.CODE_NET_GUARD_IMPL; else process.env.CODE_NET_GUARD_IMPL = saved; }
});

test('served only when both serve; the port can add a refusal, never remove one', async () => {
  const logs = [];
  // The port claims nothing is the code network: the JS still refuses.
  const lax = guard('egress', fakePort({ codeNetRefuses: () => false }), { log: (e) => logs.push(e) });
  assert.equal(await lax.refuses(CODE_ADDR), true);
  assert.equal(await lax.refuses(`::ffff:${CODE_ADDR}`), true);
  assert.equal(await lax.refuses(OTHER), false);
  assert.ok(logs.some((e) => e.event === 'codenet.impl_mismatch' && e.js === true && e.port === false));
  // The port refuses something the JS serves (a stricter spelling): refused.
  const strict = guard('egress', fakePort({ codeNetRefuses: () => true }));
  assert.equal(await strict.refuses(OTHER), true);
  lax.stop(); strict.stop();
});

test('a fault on a request refuses that request; a fault reading a lookup refuses all from then on', async () => {
  const logs = [];
  const perRequest = guard(CODE_ADDR, fakePort({ codeNetRefuses: fail('trap') }), { log: (e) => logs.push(e) });
  assert.equal(await perRequest.refuses(OTHER), true);
  assert.ok(logs.some((e) => e.event === 'codenet.wasm_fault' && e.where === 'request' && e.reason === 'trap'));
  for (const bad of [() => 'no', () => undefined, () => 0, () => null]) {
    // A reply that is not a boolean is a fault here too (dav-parse-wasm.cjs checks it first).
    const g = guard(CODE_ADDR, fakePort({ codeNetRefuses: bad }));
    assert.equal(await g.refuses(OTHER), true);
  }
  const resolveLogs = [];
  const broken = guard('egress', fakePort({ codeNetResolved: fail('ambiguous') }), { log: (e) => resolveLogs.push(e) });
  await broken.ready;
  assert.equal(await broken.refuses(OTHER), true, 'the port no longer knows what to refuse');
  assert.equal(await broken.refuses(undefined), true);
  assert.ok(resolveLogs.some((e) => e.event === 'codenet.wasm_fault' && e.where === 'resolve' && e.reason === 'ambiguous'));
  // The JS's own resolution still happened (and is logged as before).
  assert.ok(resolveLogs.some((e) => e.event === 'codenet.guarding'));
  // Unset spec: nothing is checked, under either setting (both read it as empty).
  const off = guard('', fakePort({ codeNetRefuses: fail('trap') }));
  assert.equal(off.enabled, false);
  assert.equal(await off.refuses(CODE_ADDR), false);
});

test('the spec must read the same in both, or startup stops', () => {
  assert.throws(() => guard('egress', fakePort({ codeNetSpec: fail('ambiguous') })), /Rust port refused COWORK_CODE_NET_ADDR \(ambiguous\)/);
  assert.throws(() => guard('egress', fakePort({ codeNetSpec: fail('missing') })), /\(missing\)/);
  assert.throws(() => guard('egress', fakePort({ codeNetSpec: () => ({ literals: [], hosts: [] }) })), /reads COWORK_CODE_NET_ADDR differently/);
  assert.throws(() => guard(CODE_ADDR, fakePort({ codeNetSpec: () => ({ literals: [], hosts: [] }) })), /reads COWORK_CODE_NET_ADDR differently/);
  assert.throws(() => guard('egress', fakePort({ codeNetSpec: () => ({ malformed: 'egress' }) })), /reads COWORK_CODE_NET_ADDR differently/);
  // A malformed entry is the JS's own startup error, before the port is asked.
  const port = fakePort();
  assert.throws(() => guard('a_b', port), /not "a_b"/);
  assert.deepEqual(port.calls, []);
});

test('the 403 path is unchanged when refused by a fault', async () => {
  const g = guard(CODE_ADDR, fakePort({ codeNetRefuses: fail('trap') }));
  let status = null, served = false;
  const res = { writeHead(s) { status = s; }, end() {}, destroy() {} };
  await g.wrap(() => { served = true; })({ socket: { localAddress: OTHER }, headers: {} }, res);
  assert.equal(status, 403);
  assert.equal(served, false);
});
