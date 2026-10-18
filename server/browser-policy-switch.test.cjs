'use strict';
// Browser policy is always the Rust port (BROWSER_POLICY_IMPL retired, #1071). This file pins how the functions the
// executor calls use the port's answers, with a stand-in for the port (no dav-parse.wasm needed;
// tests/server/browser-policy-differential.test.cjs runs the real module against the frozen JS answers). The port
// decides alone. An unknown, a fault or a bad reply asks (any action but a navigation) or refuses (a navigation,
// checkNavigation, substituteSecrets, which have no approval step). The port never receives a secret value, and the
// values are typed only for the placeholders it named, in its order. Synthetic only.
const test = require('node:test'), assert = require('node:assert/strict');
const bp = require('./browser-policy.cjs');
const davParseWasm = require('./dav-parse-wasm.cjs');

const PAGE = { origin: 'https://shop.example.com', allowedDomains: ['example.com'] };
const SECRETS = { gh: { value: 'ghp_synthetic_value_1234', domains: ['github.com'] }, other: { value: 'second-synthetic-value', domains: ['example.com'] } };
const fault = () => { throw new davParseWasm.DavParseError('dav-parse module failed', 'trap'); };

/** A stand-in port: every browserPolicy* call is recorded and answered by `answers[name]` (a fault by default). */
function fakePort(answers = {}) {
  const calls = [];
  const fn = (name) => (...args) => { calls.push([name, args]); return (answers[name] || fault)(...args); };
  return {
    calls,
    wasmLoader: () => ({ browserPolicyClassify: fn('classify'), browserPolicyNavigation: fn('navigation'), browserPolicySubstitute: fn('substitute') }),
  };
}
function quietly(fn) {
  const warn = console.warn, seen = [];
  console.warn = (m) => seen.push(String(m));
  try { return { value: fn(), seen }; } finally { console.warn = warn; }
}

test('the module exports the functions the executor calls, maskSecrets and the projections: no JS rule, word list or switch remains', () => {
  assert.deepEqual(Object.keys(bp).sort(), ['actionProjection', 'checkNavigation', 'classifyAction', 'domainsProjection', 'elementProjection', 'maskSecrets',
    'pageProjection', 'secretsProjection', 'substituteSecrets']);
});

test('the retired switch changes nothing: the port is asked whatever BROWSER_POLICY_IMPL says', () => {
  const saved = process.env.BROWSER_POLICY_IMPL;
  try {
    for (const value of [undefined, '', 'js', 'wasm', 'on']) {
      if (value === undefined) delete process.env.BROWSER_POLICY_IMPL; else process.env.BROWSER_POLICY_IMPL = value;
      const port = fakePort({ classify: () => ({ status: 'allow', reason: '' }) });
      assert.equal(bp.classifyAction({ type: 'click', element: { tag: 'a', text: 'Home' } }, PAGE, port).status, 'allow', String(value));
      assert.equal(port.calls.length, 1, String(value));
    }
  } finally { if (saved === undefined) delete process.env.BROWSER_POLICY_IMPL; else process.env.BROWSER_POLICY_IMPL = saved; }
  assert.ok(!davParseWasm.IMPL_FLAGS.includes('BROWSER_POLICY_IMPL'));
  assert.equal(davParseWasm.RETIRED_FLAGS.BROWSER_POLICY_IMPL, 'wasm');
});

test('classify: the port\'s answer is the answer, text included', () => {
  const click = { type: 'click', element: { tag: 'a', text: 'Home' } };
  const ask = (answer, action = click) => quietly(() => bp.classifyAction(action, PAGE, fakePort({ classify: answer }))).value;
  for (const reply of [{ status: 'allow', reason: '' }, { status: 'needs_approval', reason: 'Submits a form.' }, { status: 'blocked', reason: 'Local addresses are not opened.' }]) {
    assert.deepEqual(ask(() => reply), reply);
  }
});

test('classify: an unknown, a fault or a bad reply asks, and for a navigation it blocks', () => {
  const click = { type: 'click', element: { tag: 'a', text: 'Home' } };
  const nav = { type: 'navigate', url: 'https://example.com/x' };
  const ask = (answer, action) => quietly(() => bp.classifyAction(action, PAGE, fakePort({ classify: answer }))).value;
  for (const answer of [() => ({ status: null, reason: '' }), fault, () => { throw new TypeError('bad'); }]) {
    const v = ask(answer, click);
    assert.equal(v.status, 'needs_approval');
    assert.match(v.reason, /could not be double-checked, so it asks first/);
    const n = ask(answer, nav);
    assert.equal(n.status, 'blocked');
    assert.match(n.reason, /could not be double-checked, so it is not opened/);
  }
});

test('classify: the port gets projections of what the rules read, and never a typed value', () => {
  const port = fakePort({ classify: () => ({ status: 'allow', reason: 'Nothing is sent until a submit, which asks.' }) });
  quietly(() => bp.classifyAction({ type: 'type', text: 'hunter2-synthetic', value: 'x', element: { tag: 'input', type: 'password', name: 'Password', inForm: 1, value: 0 } }, PAGE, port));
  const [[name, [action, element, page]]] = port.calls;
  assert.equal(name, 'classify');
  assert.deepEqual(action, { type: 'type', url: null, method: null, key: null });
  assert.deepEqual(element, { tag: 'input', type: 'password', role: '', name: 'Password', text: '', value: '', inForm: true });
  assert.deepEqual(page, { origin: 'https://shop.example.com', allowedDomains: [] });
  assert.ok(!JSON.stringify(port.calls).includes('hunter2'));
  // navigate: url and method as the rules read them; origin null for a truthy non-string.
  const nav = fakePort({ classify: () => ({ status: 'allow', reason: '' }) });
  quietly(() => bp.classifyAction({ type: 'navigate', url: 'https://example.com/' }, { origin: {}, allowedDomains: ['example.com', , 7] }, nav));
  assert.deepEqual(nav.calls[0][1], [{ type: 'navigate', url: 'https://example.com/', method: 'GET', key: null },
    { tag: '', type: '', role: '', name: '', text: '', value: '', inForm: false }, { origin: null, allowedDomains: ['example.com', '7'] }]);
});

test('classify: a projection that cannot be built is a fault (asks), not a throw', () => {
  const port = fakePort({ classify: () => ({ status: 'allow', reason: '' }) });
  const key = { toString() { throw Error('no'); } };
  const v = quietly(() => bp.classifyAction({ type: 'press', key, element: { tag: 'div' } }, PAGE, port)).value;
  assert.equal(v.status, 'needs_approval');
  assert.deepEqual(port.calls, [], 'the port was not reached');
  const nav = quietly(() => bp.classifyAction({ type: 'navigate', url: { toString() { throw Error('no'); } } }, PAGE, port)).value;
  assert.equal(nav.status, 'blocked');
});

test('checkNavigation: the port\'s answer is the answer; a fault or a bad reply refuses', () => {
  const ask = (answer) => quietly(() => bp.checkNavigation('https://example.com/x', ['example.com'], fakePort({ navigation: answer }))).value;
  assert.deepEqual(ask(() => ({ ok: true, origin: 'https://example.com' })), { ok: true, origin: 'https://example.com' });
  assert.deepEqual(ask(() => ({ ok: false, reason: 'Local addresses are not opened.' })), { ok: false, reason: 'Local addresses are not opened.' });
  for (const answer of [fault, () => { throw new TypeError('bad'); }]) {
    const v = ask(answer);
    assert.equal(v.ok, false);
    assert.match(v.reason, /could not be double-checked/);
  }
  // The port is sent the string url and the domains as strings.
  const port = fakePort({ navigation: () => ({ ok: false, reason: 'x' }) });
  quietly(() => bp.checkNavigation(new URL('https://example.com/y'), ['example.com', 7], port));
  assert.deepEqual(port.calls[0][1], ['https://example.com/y', ['example.com', '7']]);
});

test('substituteSecrets: values go in only for the names the port allowed, in its order; the port sees names and domains, never values', () => {
  const port = fakePort({ substitute: () => ({ ok: true, used: ['gh', 'other', 'gh'] }) });
  const r = quietly(() => bp.substituteSecrets('a={{secret:gh}} b={{secret:other}} c={{secret:gh}}', SECRETS, 'https://github.com', port)).value;
  assert.deepEqual(r, { ok: true, value: 'a=ghp_synthetic_value_1234 b=second-synthetic-value c=ghp_synthetic_value_1234', used: ['gh', 'other', 'gh'] });
  assert.deepEqual(port.calls[0][1], ['a={{secret:gh}} b={{secret:other}} c={{secret:gh}}', [['gh', ['github.com']], ['other', ['example.com']]], 'https://github.com']);
  assert.ok(!JSON.stringify(port.calls).includes('ghp_synthetic') && !JSON.stringify(port.calls).includes('second-synthetic'));
  // No placeholder: nothing to type, the text comes back unchanged.
  assert.deepEqual(quietly(() => bp.substituteSecrets('plain', SECRETS, 'https://github.com', fakePort({ substitute: () => ({ ok: true, used: [] }) }))).value,
    { ok: true, value: 'plain', used: [] });
  // A value that contains a placeholder is typed as it is, not expanded again.
  const nested = { gh: { value: '{{secret:other}}', domains: ['github.com'] }, other: SECRETS.other };
  assert.equal(quietly(() => bp.substituteSecrets('{{secret:gh}}', nested, 'https://github.com', fakePort({ substitute: () => ({ ok: true, used: ['gh'] }) }))).value.value, '{{secret:other}}');
});

test('substituteSecrets: the port\'s refusal is the answer; a fault, other names or a missing secret type nothing', () => {
  const ask = (answer, text = '{{secret:gh}}', secrets = SECRETS) => quietly(() => bp.substituteSecrets(text, secrets, 'https://github.com', fakePort({ substitute: answer }))).value;
  assert.deepEqual(ask(() => ({ ok: false, reason: 'The gh secret is not for github.com.' })), { ok: false, reason: 'The gh secret is not for github.com.' });
  const refused = [fault, () => ({ ok: true, used: [] }), () => ({ ok: true, used: ['gh', 'gh'] }), () => ({ ok: true, used: ['other'] })];
  for (const answer of refused) {
    const v = ask(answer);
    assert.equal(v.ok, false);
    assert.ok(!('value' in v));
    assert.match(v.reason, /could not be double-checked/);
  }
  // The port names a secret this host does not have: nothing is typed.
  const v = ask(() => ({ ok: true, used: ['ghost'] }), '{{secret:ghost}}');
  assert.equal(v.ok, false);
  // secrets.domains that is not a list: the projection fails, nothing is typed.
  const odd = { gh: { value: 'synthetic-odd-value', domains: ['github.com'] }, weird: { value: 'zzzz', domains: 'github.com' } };
  assert.equal(ask(() => ({ ok: true, used: ['gh'] }), '{{secret:gh}}', odd).ok, false);
});

test('port warnings name the event, never the input', () => {
  const { seen } = quietly(() => {
    bp.classifyAction({ type: 'click', element: { tag: 'a', text: 'synthetic-label-text' } }, PAGE, fakePort({ classify: () => ({ status: null, reason: '' }) }));
    const once = () => { throw new davParseWasm.DavParseError('dav-parse module failed', 'warn_test'); };
    bp.checkNavigation('https://example.com/synthetic-path', ['example.com'], fakePort({ navigation: once }));
  });
  assert.ok(seen.some((l) => /browser_policy\.wasm_fault \(warn_test\)/.test(l)), seen.join('\n'));
  for (const line of seen) assert.ok(!/synthetic/.test(line), line);
});
