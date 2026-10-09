'use strict';
// CODE_ACTIONS_IMPL: the switch and its fail-closed paths, with a stand-in for the Rust port (no
// dav-parse.wasm needed; tests/server/code-actions-differential.test.cjs runs the real module).
// The JS answer is returned as is only when the port's reply is byte-identical: a call is
// auto-allowed, stands, or is answered with an allow option only when both say so. A refusal, a
// fault, a bad reply or a disagreement makes classify stricter (approval 'always', never simple or
// standing, union of classes and paths), decide at least 'ask' ('deny' when either denies), and
// pickOption 'cancelled'. Synthetic calls only.
const test = require('node:test'), assert = require('node:assert/strict');
const ca = require('./code-actions.cjs');
const davParseWasm = require('./dav-parse-wasm.cjs');

const JS = { impl: 'js' };
const text = (v) => JSON.stringify(v);
/** A port that answers as the JS does, with `over` replacing any call. */
function fakePort(over = {}) {
  const calls = [];
  const port = {
    codeActionsClassify: (p) => { calls.push(['classify', p]); return { text: null, reply: null, ...over.classifyAs?.(p) }; },
    codeActionsDecide: (...a) => { calls.push(['decide', a]); return over.decide ? over.decide(...a) : null; },
    codeActionsPick: (...a) => { calls.push(['pick', a]); return over.pick ? over.pick(...a) : null; },
  };
  return { loader: () => port, calls };
}
const agreeing = (call) => fakePort({
  classifyAs: () => { const js = ca.classifyJs(call); return { text: text(js), reply: js }; },
  decide: () => null,
});
const wasm = (port) => ({ impl: 'wasm', wasmLoader: port.loader });
const fault = () => { throw new davParseWasm.DavParseError('dav-parse module failed', 'trap'); };
function quietly(fn) {
  const warn = console.warn, seen = [];
  console.warn = (m) => seen.push(String(m));
  try { return { value: fn(), seen }; } finally { console.warn = warn; }
}

const cmd = (command, extra = {}) => ({ kind: 'execute', rawInput: { command }, ...extra });
const read = { kind: 'read', rawInput: { path: 'src/a.js' }, locations: [{ path: 'src/a.js' }] };
const fetchCall = cmd('curl -q https://api.example.com/x');

test('CODE_ACTIONS_IMPL: default js, wasm when set, anything else js with one warning', () => {
  const { seen } = quietly(() => {
    assert.equal(ca.codeActionsImpl({}), 'js');
    assert.equal(ca.codeActionsImpl({ CODE_ACTIONS_IMPL: '' }), 'js');
    assert.equal(ca.codeActionsImpl({ CODE_ACTIONS_IMPL: ' WASM ' }), 'wasm');
    assert.equal(ca.codeActionsImpl({ CODE_ACTIONS_IMPL: 'js' }), 'js');
    assert.equal(ca.codeActionsImpl({ CODE_ACTIONS_IMPL: 'rust' }), 'js');
    assert.equal(ca.codeActionsImpl({ CODE_ACTIONS_IMPL: 'rust' }), 'js');
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /CODE_ACTIONS_IMPL="rust" is not js or wasm; using js/);
  assert.ok(davParseWasm.IMPL_FLAGS.includes('CODE_ACTIONS_IMPL'), 'a missing or tampered module stops startup');
});

test('js (the default) never asks the port', () => {
  const port = fakePort({ classifyAs: fault, decide: fault, pick: fault });
  for (const opts of [{ wasmLoader: port.loader, env: {} }, { ...JS, wasmLoader: port.loader }]) {
    assert.deepEqual(ca.classify(fetchCall, opts), ca.classifyJs(fetchCall));
    assert.deepEqual(ca.decide({ classified: ca.classifyJs(read) }, opts), { decision: 'allow', reason: 'Read-only.' });
    assert.deepEqual(ca.pickOption([{ optionId: 'a', kind: 'allow_once' }], 'allow_once', opts), { outcome: 'selected', optionId: 'a' });
  }
  assert.equal(port.calls.length, 0);
});

test('classify: an agreeing port returns the JS answer itself; the port sees only what classify reads', () => {
  const call = { kind: 'execute', title: 'secret title', content: 'x'.repeat(10_000),
    rawInput: { command: 'git push', cmd: ['ls', 1, true, null, { o: 1 }], other: 'not sent', noeviaOutsideWorkspace: 'yes' },
    locations: [{ path: '/w/a', line: 3 }, null, 'x', { path: 5 }] };
  const port = agreeing(call);
  assert.deepEqual(ca.classify(call, wasm(port)), ca.classifyJs(call));
  const [[, sent]] = port.calls;
  assert.deepEqual(sent, { kind: 'execute', rawInput: { command: 'git push', cmd: ['ls', 1, true, null, {}], noeviaOutsideWorkspace: false },
    locations: ['/w/a', null, null, null] });
});

test('classify: a refusal, fault or disagreement is never auto-allowed and never stands', () => {
  for (const call of [read, fetchCall, cmd('make build'), { kind: 'think' }]) {
    const js = ca.classifyJs(call);
    for (const classifyAs of [fault, () => ({ text: '{}', reply: { ...js, actions: ['delete'], action: 'delete', paths: ['/elsewhere'] } })]) {
      const { value: c, seen } = quietly(() => ca.classify(call, wasm(fakePort({ classifyAs }))));
      assert.equal(c.approval, 'always');
      assert.equal(c.simple, false);
      assert.equal(c.standable, false);
      assert.equal(c.unverified, true);
      assert.ok(js.actions.every((a) => c.actions.includes(a)), 'keeps every JS class');
      assert.ok(js.paths.every((p) => c.paths.includes(p)), 'keeps every JS path');
      assert.equal(c.command, js.command);
      assert.ok(seen.length <= 1);
      // decide() on it never allows, under either switch.
      for (const opts of [JS, wasm(fakePort({ decide: fault }))]) {
        const d = quietly(() => ca.decide({ classified: c, capabilities: [], domains: ['example.com'], inWorkspace: true }, opts)).value;
        assert.notEqual(d.decision, 'allow');
      }
    }
    // A disagreeing port's extra classes and paths are added, and the worse action wins.
    const c = quietly(() => ca.classify(call, wasm(fakePort({ classifyAs: () => ({ text: 'x', reply: { ...js, action: 'delete', actions: ['delete'], paths: ['/elsewhere'] } }) })))).value;
    assert.equal(c.action, 'delete');
    assert.ok(c.actions.includes('delete') && c.paths.includes('/elsewhere'));
    // Outside the workspace, the added delete path is refused outright.
    assert.equal(ca.decide({ classified: c, inWorkspace: false }, JS).decision, 'deny');
  }
});

test('classify: a JS throw is the JS throw; the port is not asked', () => {
  const port = fakePort({ classifyAs: fault });
  assert.throws(() => ca.classify(null, wasm(port)), TypeError);
  assert.equal(port.calls.length, 0);
});

test('decide: allow only when the port says the same allow; otherwise at least ask', () => {
  const classified = ca.classifyJs(fetchCall);
  const input = { classified, capabilities: [], domains: ['example.com'], inWorkspace: null };
  const js = ca.decideJs(input);
  assert.equal(js.decision, 'allow');
  const same = fakePort({ decide: () => ({ text: text(js), reply: js }) });
  assert.deepEqual(ca.decide(input, wasm(same)), js);
  assert.deepEqual(same.calls[0][1], [{ action: 'network', approval: 'capability', command: classified.command, readable: true,
    paths: [], actions: ['network'], simple: true }, [], ['example.com'], null]);
  const cases = [
    [fault, 'ask', ca.UNVERIFIED_ASK],
    [() => ({ text: text({ decision: 'allow', reason: 'other.example is on this task\u2019s allowed list.' }), reply: { decision: 'allow', reason: 'x' } }), 'ask', ca.UNVERIFIED_ASK],
    [() => ({ text: text({ decision: 'ask', reason: '' }), reply: { decision: 'ask', reason: '' } }), 'ask', ca.UNVERIFIED_ASK],
    [() => ({ text: text({ decision: 'deny', reason: 'x' }), reply: { decision: 'deny', reason: 'x' } }), 'deny', ca.UNVERIFIED_DENY],
  ];
  for (const [decide, decision, reason] of cases) {
    assert.deepEqual(quietly(() => ca.decide(input, wasm(fakePort({ decide })))).value, { decision, reason });
  }
});

test('decide: a JS ask stays ask (or becomes deny when the port denies); a JS deny never asks the port', () => {
  const ask = { classified: ca.classifyJs(cmd('make')), capabilities: [], domains: [], inWorkspace: null };
  assert.equal(ca.decideJs(ask).decision, 'ask');
  assert.deepEqual(quietly(() => ca.decide(ask, wasm(fakePort({ decide: fault })))).value, ca.decideJs(ask));
  assert.deepEqual(quietly(() => ca.decide(ask, wasm(fakePort({ decide: () => ({ text: '', reply: { decision: 'allow', reason: '' } }) })))).value, ca.decideJs(ask));
  assert.equal(quietly(() => ca.decide(ask, wasm(fakePort({ decide: () => ({ text: '', reply: { decision: 'deny', reason: '' } }) })))).value.decision, 'deny');
  const deny = { classified: ca.classifyJs({ kind: 'edit', locations: [{ path: '/etc/passwd' }] }), inWorkspace: false };
  const port = fakePort({ decide: fault });
  assert.equal(ca.decide(deny, wasm(port)).decision, 'deny');
  assert.equal(port.calls.length, 0);
});

test('decide: an input the projection cannot carry is treated as a fault (at least ask)', () => {
  const classified = ca.classifyJs(read);
  for (const input of [{ classified, capabilities: 'network' }, { classified, domains: [5] }, { classified, inWorkspace: 'no' },
    { classified: { ...classified, readable: 1 } }, { classified: { ...classified, actions: ['read_repository', 5] } }]) {
    let js;
    try { js = ca.decideJs(input); } catch { continue; }
    const port = fakePort({ decide: fault });
    const r = quietly(() => ca.decide(input, wasm(port))).value;
    assert.equal(port.calls.length, 0, 'the port is not asked');
    assert.notEqual(r.decision, 'allow', JSON.stringify(input));
    if (js.decision === 'deny') assert.equal(r.decision, 'deny');
  }
});

test('pickOption: the JS option only when the port picks the same; otherwise cancelled', () => {
  const options = [{ optionId: 'a', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }, null, { optionId: 7 }];
  const js = ca.pickOptionJs(options, 'allow_always');
  assert.deepEqual(js, { outcome: 'selected', optionId: 'a' });
  const same = fakePort({ pick: () => ({ text: text(js), reply: js }) });
  assert.deepEqual(ca.pickOption(options, 'allow_always', wasm(same)), js);
  assert.deepEqual(same.calls[0][1], [[{ optionId: 'a', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }, null, null], 'allow_always']);
  for (const pick of [fault, () => ({ text: text({ outcome: 'selected', optionId: 'zz' }), reply: {} })]) {
    for (const wanted of ['allow_always', 'reject_once']) {
      assert.deepEqual(quietly(() => ca.pickOption(options, wanted, wasm(fakePort({ pick })))).value, { outcome: 'cancelled' });
    }
  }
  // A JS cancel is final; the port is not asked.
  const port = fakePort({ pick: fault });
  assert.deepEqual(ca.pickOption([], 'allow_once', wasm(port)), { outcome: 'cancelled' });
  assert.equal(port.calls.length, 0);
});

test('process.env drives the callers: a missing module under wasm makes every call unverified, never allowed', () => {
  const saved = { impl: process.env.CODE_ACTIONS_IMPL, file: process.env.DAV_PARSE_WASM };
  process.env.CODE_ACTIONS_IMPL = 'wasm';
  process.env.DAV_PARSE_WASM = '/nonexistent/dav-parse.wasm';
  davParseWasm.reset();
  try {
    const { value, seen } = quietly(() => {
      const c = ca.classify(read);
      return { c, d: ca.decide({ classified: c }), d2: ca.decide({ classified: ca.classifyJs(read) }), p: ca.pickOption([{ optionId: 'a', kind: 'allow_once' }], 'allow_once') };
    });
    assert.equal(value.c.unverified, true);
    assert.equal(value.d.decision, 'ask');
    assert.deepEqual(value.d2, { decision: 'ask', reason: ca.UNVERIFIED_ASK });
    assert.deepEqual(value.p, { outcome: 'cancelled' });
    assert.ok(seen.length >= 1 && seen.every((m) => !m.includes('src/a.js')), 'logged without call text');
  } finally {
    if (saved.impl === undefined) delete process.env.CODE_ACTIONS_IMPL; else process.env.CODE_ACTIONS_IMPL = saved.impl;
    if (saved.file === undefined) delete process.env.DAV_PARSE_WASM; else process.env.DAV_PARSE_WASM = saved.file;
    davParseWasm.reset();
  }
});
