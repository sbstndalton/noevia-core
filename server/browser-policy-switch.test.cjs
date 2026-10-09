'use strict';
// BROWSER_POLICY_IMPL: the switch and its strict paths, with a stand-in for the Rust port (no
// dav-parse.wasm needed; tests/server/browser-policy-differential.test.cjs runs the real module).
// What the JS blocks stays blocked without asking the port. Otherwise an action is allowed only if
// both allow it, asks if either asks, is blocked if either blocks, and an unknown, fault, bad reply
// or any disagreement asks at least. checkNavigation and substituteSecrets have no approval step:
// there a disagreement or fault refuses. The port never receives a secret value. Synthetic only.
const test = require('node:test'), assert = require('node:assert/strict');
const bp = require('./browser-policy.cjs');
const davParseWasm = require('./dav-parse-wasm.cjs');

const PAGE = { origin: 'https://shop.example.com', allowedDomains: ['example.com'] };
const SECRETS = { gh: { value: 'ghp_synthetic_value_1234', domains: ['github.com'] }, other: { value: 'second-synthetic-value', domains: ['example.com'] } };
const fault = () => { throw new davParseWasm.DavParseError('dav-parse module failed', 'trap'); };

/** A stand-in port: every browserPolicy* call is recorded and answered by `answers[name]`. */
function fakePort(answers = {}) {
  const calls = [];
  const fn = (name) => (...args) => { calls.push([name, args]); return (answers[name] || fault)(...args); };
  return {
    calls,
    loader: () => ({ browserPolicyClassify: fn('classify'), browserPolicyNavigation: fn('navigation'), browserPolicySubstitute: fn('substitute') }),
  };
}
const wasm = (port) => ({ impl: 'wasm', wasmLoader: port.loader });
function quietly(fn) {
  const warn = console.warn, seen = [];
  console.warn = (m) => seen.push(String(m));
  try { return { value: fn(), seen }; } finally { console.warn = warn; }
}

test('BROWSER_POLICY_IMPL: default js, wasm when set, anything else js with one warning', () => {
  const { seen } = quietly(() => {
    assert.equal(bp.browserPolicyImpl({}), 'js');
    assert.equal(bp.browserPolicyImpl({ BROWSER_POLICY_IMPL: '' }), 'js');
    assert.equal(bp.browserPolicyImpl({ BROWSER_POLICY_IMPL: ' WASM ' }), 'wasm');
    assert.equal(bp.browserPolicyImpl({ BROWSER_POLICY_IMPL: 'Js' }), 'js');
    assert.equal(bp.browserPolicyImpl({ BROWSER_POLICY_IMPL: 'rust' }), 'js');
    assert.equal(bp.browserPolicyImpl({ BROWSER_POLICY_IMPL: 'rust' }), 'js');
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /BROWSER_POLICY_IMPL="rust" is not js or wasm; using js/);
  assert.ok(davParseWasm.IMPL_FLAGS.includes('BROWSER_POLICY_IMPL'), 'a missing or tampered module stops startup');
});

test('under js (the default, and an unknown value) the port is never asked', () => {
  const port = fakePort();
  for (const opts of [{ wasmLoader: port.loader, env: {} }, { wasmLoader: port.loader, env: { BROWSER_POLICY_IMPL: 'on' } }]) {
    quietly(() => {
      assert.equal(bp.classifyAction({ type: 'click', element: { tag: 'a', text: 'Home' } }, PAGE, opts).status, 'allow');
      assert.equal(bp.checkNavigation('https://example.com/', ['example.com'], opts).ok, true);
      assert.equal(bp.substituteSecrets('{{secret:gh}}', SECRETS, 'https://github.com', opts).ok, true);
    });
  }
  assert.deepEqual(port.calls, []);
});

test('the executor’s two-argument calls read the switch from process.env', () => {
  const saved = process.env.BROWSER_POLICY_IMPL;
  try {
    delete process.env.BROWSER_POLICY_IMPL;
    assert.equal(bp.classifyAction({ type: 'click', element: { tag: 'a', text: 'Home' } }, PAGE).status, 'allow');
    assert.equal(bp.checkNavigation('https://example.com/', ['example.com']).ok, true);
  } finally {
    if (saved === undefined) delete process.env.BROWSER_POLICY_IMPL; else process.env.BROWSER_POLICY_IMPL = saved;
  }
});

test('what the JS blocks stays blocked without asking the port', () => {
  const port = fakePort();
  const w = wasm(port);
  assert.equal(bp.classifyAction({ type: 'navigate', url: 'http://127.0.0.1/' }, PAGE, w).status, 'blocked');
  assert.equal(bp.classifyAction({ type: 'navigate', url: 'https://evil.example.net/' }, PAGE, w).status, 'blocked');
  assert.equal(bp.checkNavigation('javascript:alert(1)', ['example.com'], w).ok, false);
  assert.equal(bp.substituteSecrets('{{secret:gh}}', SECRETS, 'https://example.com', w).ok, false);
  assert.equal(bp.substituteSecrets('{{secret:missing}}', SECRETS, 'https://github.com', w).ok, false);
  assert.deepEqual(port.calls, []);
});

test('classify: the stricter of the two answers, and any doubt asks', () => {
  const click = { type: 'click', element: { tag: 'a', text: 'Home' } };
  const ask = (answer, action = click) => quietly(() => bp.classifyAction(action, PAGE, wasm(fakePort({ classify: answer })))).value;
  // Agreement: the JS answer.
  assert.deepEqual(ask(() => ({ status: 'allow', reason: '' })), { status: 'allow', reason: '' });
  // The port is stricter: its answer.
  assert.deepEqual(ask(() => ({ status: 'needs_approval', reason: 'Submits a form.' })), { status: 'needs_approval', reason: 'Submits a form.' });
  assert.deepEqual(ask(() => ({ status: 'blocked', reason: 'No.' })), { status: 'blocked', reason: 'No.' });
  // Unknown, fault, same status with another reason: asks.
  for (const answer of [() => ({ status: null, reason: '' }), fault, () => ({ status: 'allow', reason: 'different' })]) {
    const v = ask(answer);
    assert.equal(v.status, 'needs_approval');
    assert.match(v.reason, /could not be double-checked/);
  }
  // The JS asks, the port allows or is unsure: the JS answer (it asks).
  const pay = { type: 'click', element: { tag: 'button', text: 'Pay now' } };
  const js = bp.classifyActionJs(pay, PAGE);
  assert.equal(js.status, 'needs_approval');
  for (const answer of [() => ({ status: 'allow', reason: '' }), () => ({ status: null, reason: '' }), fault]) assert.deepEqual(ask(answer, pay), js);
  // The JS asks, the port blocks: blocked.
  assert.equal(ask(() => ({ status: 'blocked', reason: 'Port says no.' }), pay).status, 'blocked');
});

test('classify: the port gets projections of what the rules read, and never a typed value', () => {
  const port = fakePort({ classify: () => ({ status: 'allow', reason: 'Nothing is sent until a submit, which asks.' }) });
  quietly(() => bp.classifyAction({ type: 'type', text: 'hunter2-synthetic', value: 'x', element: { tag: 'input', type: 'password', name: 'Password', inForm: 1, value: 0 } }, PAGE, wasm(port)));
  const [[name, [action, element, page]]] = port.calls;
  assert.equal(name, 'classify');
  assert.deepEqual(action, { type: 'type', url: null, method: null, key: null });
  assert.deepEqual(element, { tag: 'input', type: 'password', role: '', name: 'Password', text: '', value: '', inForm: true });
  assert.deepEqual(page, { origin: 'https://shop.example.com', allowedDomains: [] });
  assert.ok(!JSON.stringify(port.calls).includes('hunter2'));
  // navigate: url and method as the JS reads them; origin null for a truthy non-string.
  const nav = fakePort({ classify: () => ({ status: 'allow', reason: '' }) });
  quietly(() => bp.classifyAction({ type: 'navigate', url: 'https://example.com/' }, { origin: {}, allowedDomains: ['example.com', , 7] }, wasm(nav)));
  assert.deepEqual(nav.calls[0][1], [{ type: 'navigate', url: 'https://example.com/', method: 'GET', key: null },
    { tag: '', type: '', role: '', name: '', text: '', value: '', inForm: false }, { origin: null, allowedDomains: ['example.com', '7'] }]);
});

test('classify: a projection that cannot be built is a fault (asks), not a throw', () => {
  const port = fakePort({ classify: () => ({ status: 'allow', reason: '' }) });
  const action = { type: 'press', key: { toString() { throw Error('no'); } }, element: { tag: 'div' } };
  // The JS reads String(action.key ?? '') too, so it throws first; an element getter that throws
  // only on the second read reaches the projection.
  assert.throws(() => bp.classifyAction(action, PAGE, wasm(port)));
  let reads = 0;
  const element = { get tag() { if (++reads > 1) throw Error('second read'); return 'a'; }, text: 'Home' };
  const v = quietly(() => bp.classifyAction({ type: 'click', element }, PAGE, wasm(port))).value;
  assert.equal(v.status, 'needs_approval');
});

test('checkNavigation: ok only when the port agrees on the origin; a fault or disagreement refuses', () => {
  const ask = (answer) => quietly(() => bp.checkNavigation('https://example.com/x', ['example.com'], wasm(fakePort({ navigation: answer })))).value;
  assert.deepEqual(ask(() => ({ ok: true, origin: 'https://example.com' })), { ok: true, origin: 'https://example.com' });
  assert.deepEqual(ask(() => ({ ok: false, reason: 'Local addresses are not opened.' })), { ok: false, reason: 'Local addresses are not opened.' });
  for (const answer of [fault, () => ({ ok: true, origin: 'https://other.example.com' })]) {
    const v = ask(answer);
    assert.equal(v.ok, false);
    assert.match(v.reason, /could not be double-checked/);
  }
});

test('substituteSecrets: ok only when the port allows the same names; it sees names and domains, never values', () => {
  const port = fakePort({ substitute: () => ({ ok: true, used: ['gh'] }) });
  const r = quietly(() => bp.substituteSecrets('t={{secret:gh}}', SECRETS, 'https://api.github.com', wasm(port))).value;
  assert.deepEqual(r, { ok: true, value: 't=ghp_synthetic_value_1234', used: ['gh'] });
  assert.deepEqual(port.calls[0][1], ['t={{secret:gh}}', [['gh', ['github.com']], ['other', ['example.com']]], 'https://api.github.com']);
  assert.ok(!JSON.stringify(port.calls).includes('ghp_synthetic') && !JSON.stringify(port.calls).includes('second-synthetic'));
  const ask = (answer) => quietly(() => bp.substituteSecrets('{{secret:gh}}', SECRETS, 'https://github.com', wasm(fakePort({ substitute: answer })))).value;
  assert.deepEqual(ask(() => ({ ok: false, reason: 'The gh secret is not for github.com.' })), { ok: false, reason: 'The gh secret is not for github.com.' });
  for (const answer of [fault, () => ({ ok: true, used: [] }), () => ({ ok: true, used: ['gh', 'gh'] })]) {
    const v = ask(answer);
    assert.equal(v.ok, false);
    assert.ok(!('value' in v));
    assert.match(v.reason, /could not be double-checked/);
  }
  // secrets.domains that is not a list: the JS throws when it reads it; a projection fault refuses.
  const odd = { gh: { value: 'synthetic-odd-value', domains: ['github.com'] }, weird: { value: 'zzzz', domains: 'github.com' } };
  const v = quietly(() => bp.substituteSecrets('{{secret:gh}}', odd, 'https://github.com', wasm(fakePort({ substitute: () => ({ ok: true, used: ['gh'] }) })))).value;
  assert.equal(v.ok, false);
});

test('port warnings name the event, never the input', () => {
  const { seen } = quietly(() => {
    bp.classifyAction({ type: 'click', element: { tag: 'a', text: 'synthetic-label-text' } }, PAGE, wasm(fakePort({ classify: () => ({ status: 'blocked', reason: 'x' }) })));
    const once = () => { throw new davParseWasm.DavParseError('dav-parse module failed', 'warn_test'); };
    bp.checkNavigation('https://example.com/synthetic-path', ['example.com'], wasm(fakePort({ navigation: once })));
  });
  assert.ok(seen.some((l) => /browser_policy\.wasm_fault \(warn_test\)/.test(l)), seen.join('\n'));
  for (const line of seen) assert.ok(!/synthetic/.test(line), line);
});
