'use strict';
// The code-net guard's Rust authority (#1071). CODE_NET_GUARD_IMPL is retired and the JavaScript that
// read COWORK_CODE_NET_ADDR, kept a lookup's addresses and decided requests is gone: the crate's
// answer is the answer, and every failure to get a usable one refuses. These are the fail-closed
// paths, with a stand-in for the Rust port (no dav-parse.wasm needed; the differential and frozen
// tests run the real module). `ran` counts every stand-in port call that executed, so a test cannot
// pass because the fault it injects was never reached; test.after asserts the total.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), net = require('node:net'), path = require('node:path');
const codeNetGuard = require('./code-net-guard.cjs');
const { createCodeNetGuard } = codeNetGuard;
const davParseWasm = require('./dav-parse-wasm.cjs');

const CODE_ADDR = '172.30.0.2';
const OTHER = '172.18.0.5';
const EXPECTED_PORT_CALLS = 130; // the stand-in port calls the tests below make

let ran = 0;
test.after(() => assert.equal(ran, EXPECTED_PORT_CALLS, 'every stand-in port call this file relies on ran'));

const isIp = (text) => net.isIP(text) !== 0;
/** A port that answers as the crate would for plain input, with `over` replacing any of its three calls. */
function fakePort(over = {}) {
  const calls = [];
  const base = {
    codeNetSpec: (raw) => { const lit = [], hosts = []; for (const e of raw.split(/[\s,]+/).filter(Boolean)) (isIp(e) ? lit : hosts).push(e.toLowerCase()); return { literals: [...new Set(lit)], hosts }; },
    codeNetResolved: (texts) => texts.map((t) => t.trim().toLowerCase()).filter(isIp),
    codeNetRefuses: (addresses, local) => addresses.includes(local),
  };
  const port = {};
  for (const [name, fn] of Object.entries(base)) {
    const impl = over[name] || fn;
    port[name] = (...args) => { ran++; calls.push([name, ...args]); return impl(...args); };
  }
  return { loader: () => port, calls, count: (name) => calls.filter((c) => c[0] === name).length };
}
const fail = (reason) => () => { throw Object.assign(Error('port fault'), { reason }); };
const guard = (spec, port, extra = {}) => createCodeNetGuard({ spec, wasmLoader: port.loader, lookup: async () => [CODE_ADDR], ...extra });
const faults = (logs) => logs.filter((e) => e.event === 'codenet.wasm_fault');

test('CODE_NET_GUARD_IMPL is retired and no JavaScript reading is left to fall back to', async () => {
  assert.deepEqual(Object.keys(codeNetGuard), ['createCodeNetGuard'], 'no parseCodeNetSpec, normalizeAddress, *Js or switch export');
  assert.ok(!davParseWasm.IMPL_FLAGS.includes('CODE_NET_GUARD_IMPL'));
  assert.equal(davParseWasm.RETIRED_FLAGS.CODE_NET_GUARD_IMPL, 'wasm');
  const warned = [];
  const log = { warn: (m) => warned.push(m) };
  assert.deepEqual(davParseWasm.warnRetiredFlags({ CODE_NET_GUARD_IMPL: 'wasm' }, log), []);
  assert.deepEqual(davParseWasm.warnRetiredFlags({}, log), []);
  assert.deepEqual(davParseWasm.warnRetiredFlags({ CODE_NET_GUARD_IMPL: 'js' }, log), ['CODE_NET_GUARD_IMPL']);
  assert.deepEqual(warned, ['CODE_NET_GUARD_IMPL is retired; Rust is always used']);
  // The source holds no reading of its own: no IP test, no address normaliser, no oracle load.
  const src = fs.readFileSync(path.join(__dirname, 'code-net-guard.cjs'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  for (const gone of [/isIP/, /normalizeAddress/, /parseCodeNetSpec/, /node:net/, /\.toLowerCase\(/, /\.trim\(/, /reference/]) assert.doesNotMatch(code, gone);
  // `env` and `impl` are not options any more; whatever an old caller passes, the port is asked.
  for (const [env, impl] of [[{}, undefined], [{ CODE_NET_GUARD_IMPL: 'js' }, 'js'], [{ CODE_NET_GUARD_IMPL: 'wasm' }, 'wasm']]) {
    const port = fakePort();
    const g = createCodeNetGuard({ spec: CODE_ADDR, env, impl, wasmLoader: port.loader });
    assert.equal(await g.refuses(CODE_ADDR), true);
    assert.equal(await g.refuses(OTHER), false);
    assert.deepEqual(port.calls.map((c) => c[0]), ['codeNetSpec', 'codeNetRefuses', 'codeNetRefuses']);
  }
  const saved = process.env.CODE_NET_GUARD_IMPL;
  process.env.CODE_NET_GUARD_IMPL = 'js';
  try {
    const port = fakePort({ codeNetRefuses: () => true });
    assert.equal(await createCodeNetGuard({ spec: CODE_ADDR, wasmLoader: port.loader }).refuses(OTHER), true, 'a port refusal stands with the old =js in the environment');
    assert.equal(port.count('codeNetRefuses'), 1);
  } finally { if (saved === undefined) delete process.env.CODE_NET_GUARD_IMPL; else process.env.CODE_NET_GUARD_IMPL = saved; }
});

test('the crate is the only authority: it can refuse and it can serve, and it is shown the spelling it was given', async () => {
  const lax = fakePort({ codeNetRefuses: () => false });
  const permissive = guard('egress', lax);
  assert.equal(await permissive.refuses(CODE_ADDR), false, 'no second opinion over a crate that says no');
  assert.deepEqual(lax.calls.filter((c) => c[0] === 'codeNetRefuses'), [['codeNetRefuses', [CODE_ADDR], CODE_ADDR]]);
  const strict = fakePort({ codeNetRefuses: () => true });
  const refusing = guard('egress', strict);
  assert.equal(await refusing.refuses(OTHER), true);
  // The crate normalises; the host hands it the raw text (and the guarded addresses it returned).
  const spy = fakePort({ codeNetRefuses: (addresses, local) => addresses.includes(local.trim().toLowerCase()) });
  const g = guard(`${CODE_ADDR}`, spy);
  assert.equal(await g.refuses(' 172.30.0.2 '), true);
  assert.deepEqual(spy.calls.filter((c) => c[0] === 'codeNetRefuses'), [['codeNetRefuses', [CODE_ADDR], ' 172.30.0.2 ']]);
  for (const x of [permissive, refusing, g]) x.stop();
});

test('a fault, a refusal or a wrong-shape reply on a request refuses that request, once logged per reason', async () => {
  const logs = [];
  const perRequest = fakePort({ codeNetRefuses: fail('trap') });
  const g = guard(CODE_ADDR, perRequest, { log: (e) => logs.push(e) });
  assert.equal(await g.refuses(OTHER), true);
  assert.equal(await g.refuses(OTHER), true);
  assert.equal(perRequest.count('codeNetRefuses'), 2, 'the crate was asked both times');
  assert.deepEqual(faults(logs).map((e) => [e.where, e.reason]), [['request', 'trap']], 'one log line for a repeated fault');
  const refusal = guard(CODE_ADDR, fakePort({ codeNetRefuses: fail('ambiguous') }));
  assert.equal(await refusal.refuses(OTHER), true);
  for (const bad of ['no', 'true', undefined, 0, 1, null, {}, [], [true]]) {
    const replyLogs = [];
    const port = fakePort({ codeNetRefuses: () => bad });
    assert.equal(await guard(CODE_ADDR, port, { log: (e) => replyLogs.push(e) }).refuses(OTHER), true, `reply ${JSON.stringify(bad)}`);
    assert.equal(port.count('codeNetRefuses'), 1);
    assert.deepEqual(faults(replyLogs).map((e) => [e.where, e.reason]), [['request', 'reply']]);
  }
  // The module itself disappearing at request time is a fault too.
  let calls = 0;
  const flaky = createCodeNetGuard({ spec: CODE_ADDR, wasmLoader: () => { if (calls++ === 0) return fakePort().loader(); throw Object.assign(Error('gone'), { reason: 'missing' }); } });
  assert.equal(await flaky.refuses(OTHER), true);
  // A local address that will not turn into text is unsendable: refused, and the crate is not asked.
  const hostileLogs = [];
  const port = fakePort();
  const hostile = guard(CODE_ADDR, port, { log: (e) => hostileLogs.push(e) });
  assert.equal(await hostile.refuses({ toString() { throw Error('no text'); } }), true);
  assert.equal(port.count('codeNetRefuses'), 0);
  assert.deepEqual(faults(hostileLogs).map((e) => [e.where, e.reason]), [['request', 'unexpected']]);
});

test('what the crate is sent for a local address: strings as they are, other values as text, nothing as null', async () => {
  const port = fakePort();
  const g = guard(CODE_ADDR, port);
  const asText = { toString() { return CODE_ADDR; } };
  assert.equal(await g.refuses(asText), true, 'an object that spells the guarded address is that address');
  for (const nothing of [undefined, null, 0, false, NaN]) assert.equal(await g.refuses(nothing), false);
  assert.equal(await g.refuses(''), false);
  assert.equal(await g.refuses(5), false);
  assert.deepEqual(port.calls.filter((c) => c[0] === 'codeNetRefuses').map((c) => c[2]), [CODE_ADDR, null, null, null, null, null, '', '5']);
  g.stop();
});

test('a fault reading a lookup refuses every request from then on, whatever was learned before', async () => {
  const resolveLogs = [];
  const looked = [];
  const broken = fakePort({ codeNetResolved: fail('ambiguous') });
  const g = guard('egress,web', broken, { log: (e) => resolveLogs.push(e), lookup: async (host) => { looked.push(host); return [CODE_ADDR]; } });
  await g.ready;
  assert.equal(await g.refuses(OTHER), true, 'the crate no longer knows what to refuse');
  assert.equal(await g.refuses(undefined), true);
  assert.equal(broken.count('codeNetRefuses'), 0, 'refused without asking the crate');
  assert.deepEqual(looked, ['egress'], 'nothing left to resolve');
  assert.deepEqual(faults(resolveLogs).map((e) => [e.where, e.reason]), [['resolve', 'ambiguous']]);
  assert.ok(!resolveLogs.some((e) => e.event === 'codenet.guarding'), 'a broken guard does not claim to be guarding');
  g.stop();
  // A reply that is not a list of address texts is a fault, not an address.
  for (const bad of ['x', null, undefined, {}, [1], [CODE_ADDR, null], [[CODE_ADDR]]]) {
    const logs = [];
    const port = fakePort({ codeNetResolved: () => bad });
    const wrong = guard('egress', port, { log: (e) => logs.push(e) });
    await wrong.ready;
    assert.equal(await wrong.refuses(OTHER), true, `reply ${JSON.stringify(bad)}`);
    assert.equal(port.count('codeNetResolved'), 1);
    assert.deepEqual(faults(logs).map((e) => [e.where, e.reason]), [['resolve', 'reply']]);
  }
  // Answers that will not turn into text are unsendable: refuse everything, the crate is not asked.
  for (const answers of [[{ get address() { throw Error('no address'); } }], [{ address: { toString() { throw Error('no text'); } } }]]) {
    const logs = [];
    const port = fakePort();
    const unsendable = guard('egress', port, { log: (e) => logs.push(e), lookup: async () => answers });
    await unsendable.ready;
    assert.equal(await unsendable.refuses(OTHER), true);
    assert.equal(port.count('codeNetResolved'), 0);
    assert.deepEqual(faults(logs).map((e) => [e.where, e.reason]), [['resolve', 'unexpected']]);
  }
  // Unset spec: nothing is checked (and the crate is only asked to read the empty spec).
  const quiet = fakePort({ codeNetRefuses: fail('trap') });
  const off = guard('', quiet);
  assert.equal(off.enabled, false);
  assert.equal(await off.refuses(CODE_ADDR), false);
  assert.deepEqual(quiet.calls.map((c) => c[0]), ['codeNetSpec']);
});

test('what the crate is sent for a lookup: every answer read once and turned into text', async () => {
  let reads = 0;
  const answers = [CODE_ADDR, { address: ' fd00::2 ', family: 6 }, { get address() { reads++; return ['172.30.0.3']; } }, null, undefined, { family: 4 }, 7, { address: 5 }, { address: false }];
  const port = fakePort();
  const g = guard('egress', port, { lookup: async () => answers });
  await g.ready;
  assert.equal(reads, 1, 'the address is read once');
  assert.deepEqual(port.calls.find((c) => c[0] === 'codeNetResolved')[1], [CODE_ADDR, ' fd00::2 ', '172.30.0.3', '', '', '', '', '5', '']);
  assert.equal(await g.refuses('fd00::2'), true);
  assert.equal(await g.refuses('172.30.0.3'), true);
  // One answer that is not an array is a one-answer lookup.
  const single = fakePort();
  const g2 = guard('egress', single, { lookup: async () => ({ address: CODE_ADDR }) });
  await g2.ready;
  assert.deepEqual(single.calls.find((c) => c[0] === 'codeNetResolved')[1], [CODE_ADDR]);
  assert.equal(await g2.refuses(CODE_ADDR), true);
  g.stop(); g2.stop();
});

test('a name that does not resolve, or resolves to no address, fails open, is logged, and is retried until it does', async () => {
  let asks = 0;
  const logs = [];
  const port = fakePort({ codeNetResolved: (texts) => (++asks < 3 ? [] : texts) });
  const g = guard('egress', port, { retryMs: 5, log: (e) => logs.push(e) });
  assert.equal(await g.refuses(CODE_ADDR), false, 'unknown address: the UI is not taken down');
  assert.ok(logs.some((e) => e.event === 'codenet.resolve_failed' && e.host === 'egress' && e.reason === 'no address'));
  for (let i = 0; i < 50 && !(await g.refuses(CODE_ADDR)); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(await g.refuses(CODE_ADDR), true, 'refused once the retry resolved it');
  assert.equal(port.count('codeNetResolved'), 3);
  assert.equal(faults(logs).length, 0, 'an empty answer is not a fault');
  g.stop();
  // A lookup that errors or never answers is the same, and the crate is not asked about it.
  for (const lookup of [async () => { throw Error('getaddrinfo ENOTFOUND egress'); }, () => new Promise(() => {})]) {
    const lookups = [];
    const quiet = fakePort();
    const unresolved = guard('egress', quiet, { lookup, resolveTimeoutMs: 5, retryMs: 60_000, log: (e) => lookups.push(e) });
    const keepAlive = setInterval(() => {}, 20); // the guard's own timers are unref'd; the test must outlive the 5 ms timeout
    try { await unresolved.ready; } finally { clearInterval(keepAlive); }
    assert.equal(await unresolved.refuses(CODE_ADDR), false);
    assert.equal(quiet.count('codeNetResolved'), 0);
    assert.ok(lookups.some((e) => e.event === 'codenet.resolve_failed'));
    unresolved.stop();
  }
});

test('the spec is the crate\'s reading, and a malformed one, a refusal, a fault or a wrong shape stops startup', () => {
  assert.throws(() => guard('egress', fakePort({ codeNetSpec: fail('ambiguous') })), /Rust port refused COWORK_CODE_NET_ADDR \(ambiguous\)/);
  assert.throws(() => guard('egress', fakePort({ codeNetSpec: fail('missing') })), /\(missing\)/);
  assert.throws(() => guard('egress', fakePort({ codeNetSpec: () => { throw Error('no reason'); } })), /\(unexpected\)/);
  assert.throws(() => guard('a_b', fakePort({ codeNetSpec: () => ({ malformed: 'a_b' }) })), /COWORK_CODE_NET_ADDR should list IP addresses or host names, not "a_b"/);
  for (const bad of [undefined, null, 'egress', 5, {}, { literals: [] }, { hosts: [] }, { literals: 'x', hosts: [] }, { literals: [], hosts: 'x' }, { literals: [1], hosts: [] },
    { literals: [], hosts: [null] }, { malformed: '' }, { malformed: 5 }, { malformed: null }]) {
    assert.throws(() => guard('egress', fakePort({ codeNetSpec: () => bad })), /unexpected shape|should list/, JSON.stringify(bad));
  }
  // A spec with content that the crate reads as nothing would leave the guard off: refuse to start.
  for (const content of ['egress', CODE_ADDR, ' , egress,', 'a_b']) {
    assert.throws(() => guard(content, fakePort({ codeNetSpec: () => ({ literals: [], hosts: [] }) })), /read no address or host name/, content);
  }
  // Only white space and commas is genuinely empty: the guard is off, as for an unset spec.
  for (const empty of ['', ' ', ',', ' , ,'+String.fromCharCode(9, 10)]) assert.equal(guard(empty, fakePort({ codeNetSpec: () => ({ literals: [], hosts: [] }) })).enabled, false, JSON.stringify(empty));
  // The crate is always asked, and is handed the spec as text; an unset spec is the empty text.
  const port = fakePort();
  guard(undefined, port);
  guard({ toString() { return ` ${CODE_ADDR} `; } }, port).stop();
  guard(0, port);
  assert.deepEqual(port.calls.filter((c) => c[0] === 'codeNetSpec').map((c) => c[1]), ['', ` ${CODE_ADDR} `, '']);
  assert.throws(() => guard({ toString() { throw Error('no text'); } }, fakePort()), /Rust port refused COWORK_CODE_NET_ADDR \(unexpected\)/);
  // A missing or tampered module stops startup, even for an unset spec.
  const tampered = () => { throw new davParseWasm.DavParseError('dav-parse module sha256 is not the pinned one', 'checksum'); };
  assert.throws(() => createCodeNetGuard({ spec: '', wasmLoader: tampered }), /Rust port refused COWORK_CODE_NET_ADDR \(checksum\)/);
});

test('input the crate cannot be sent refuses: more guarded addresses than one call takes', async () => {
  // dav-parse-wasm.cjs checks the list before it reaches the module, so this needs no .wasm file.
  const logs = [];
  const port = fakePort({ codeNetRefuses: (addresses, local) => davParseWasm.codeNetRefuses(addresses, local) });
  const many = (n, base) => Array.from({ length: n }, (_, i) => `10.${base}.${Math.floor(i / 250)}.${(i % 250) + 1}`);
  const lookups = { one: many(600, 1), two: many(600, 2) };
  const g = guard('one,two', port, { log: (e) => logs.push(e), lookup: async (host) => lookups[host], });
  await g.ready;
  assert.equal(await g.refuses(OTHER), true, 'refused, not served unchecked');
  assert.equal(port.count('codeNetRefuses'), 1);
  assert.deepEqual(faults(logs).map((e) => [e.where, e.reason]), [['request', 'input']]);
  g.stop();
});

test('a guard whose first resolution rejects destroys the request: it is neither served nor answered', async () => {
  // A throwing log inside the failed-lookup handler makes `ready` reject.
  const port = fakePort();
  const g = guard('egress', port, { lookup: async () => { throw Error('lookup failed'); }, log: () => { throw Error('log failed'); } });
  g.ready.catch(() => {});
  let destroyed = 0, status = null, served = false;
  const res = { writeHead(s) { status = s; }, end() {}, destroy() { destroyed++; } };
  await g.wrap(() => { served = true; })({ socket: { localAddress: CODE_ADDR }, headers: {} }, res);
  assert.equal(destroyed, 1, 'the request is destroyed');
  assert.equal(served, false, 'the handler is not called');
  assert.equal(status, null, 'and no response is written');
  assert.equal(port.count('codeNetRefuses'), 0, 'the crate was never asked');
  await assert.rejects(g.ready, /log failed/);
});

test('the 403 path is unchanged when a request is refused by a fault, and a served request reaches the handler', async () => {
  const g = guard(CODE_ADDR, fakePort({ codeNetRefuses: fail('trap') }));
  let status = null, served = false;
  const res = { writeHead(s) { status = s; }, end() {}, destroy() {} };
  await g.wrap(() => { served = true; })({ socket: { localAddress: OTHER }, headers: {} }, res);
  assert.equal(status, 403);
  assert.equal(served, false);
  const ok = guard(CODE_ADDR, fakePort());
  let reached = false;
  await ok.wrap(() => { reached = true; })({ socket: { localAddress: OTHER }, headers: {} }, { writeHead() { assert.fail('no 403'); }, end() {}, destroy() {} });
  assert.equal(reached, true);
  g.stop(); ok.stop();
});
