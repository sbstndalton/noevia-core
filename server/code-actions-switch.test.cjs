'use strict';
// Code actions are always the Rust port (CODE_ACTIONS_IMPL retired, #1071). This file pins how the functions code-harness.cjs
// calls use the port's answers, with a stand-in for the port (no dav-parse.wasm needed; tests/server/code-actions-differential.test.cjs
// runs the real module against the frozen JS answers). The port decides alone. A refusal, a fault or a bad reply is the strict
// result, which is what the wasm composition did before #1071: classify gives the unverified classification (the riskiest kind, never
// allowed, never stood behind), decide applies the crate's two deny rules itself (the floor) and then asks a person with no standing
// approval, pickOption cancels. Synthetic calls only.
const test = require('node:test'), assert = require('node:assert/strict');
const ca = require('./code-actions.cjs');
const davParseWasm = require('./dav-parse-wasm.cjs');

const CALL = { kind: 'execute', title: 'secret title', rawInput: { command: 'ls -la' }, locations: [{ path: '/work/a' }] };
const REPLY = { action: 'execute_command', approval: 'always', command: 'ls -la', paths: ['/work/a'], readable: true, actions: ['execute_command'], simple: true, standable: true };
const refuse = (reason) => () => { throw new davParseWasm.DavParseError('code actions input refused by dav-parse', reason); };

/** A stand-in port: every codeActions* call is recorded and answered by `answers[name]` (a trap by default). */
function fakePort(answers = {}) {
  const calls = [];
  const fn = (name) => (...args) => { calls.push([name, args]); return (answers[name] || refuse('trap'))(...args); };
  return { calls, wasmLoader: () => ({ codeActionsClassify: fn('classify'), codeActionsDecide: fn('decide'), codeActionsPick: fn('pick') }) };
}
const reply = (r) => () => ({ text: JSON.stringify(r), reply: r });
function quietly(fn) {
  const warn = console.warn, seen = [];
  console.warn = (m) => seen.push(String(m));
  try { return { value: fn(), seen }; } finally { console.warn = warn; }
}

test('the module exports what code-harness and its tests use, and the projections: no JS classifier, switch or word list remains', () => {
  assert.deepEqual(Object.keys(ca).sort(), ['ACTIONS', 'COMMAND_KEYS', 'UNVERIFIED_ASK', 'classify', 'classifyInput', 'commandOf', 'decide', 'decideInput', 'pickInput', 'pickOption']);
});

test('the retired switch changes nothing: the port is asked whatever CODE_ACTIONS_IMPL says', () => {
  const saved = process.env.CODE_ACTIONS_IMPL;
  try {
    for (const value of [undefined, '', 'js', 'wasm', 'on']) {
      if (value === undefined) delete process.env.CODE_ACTIONS_IMPL; else process.env.CODE_ACTIONS_IMPL = value;
      const port = fakePort({ classify: reply(REPLY) });
      assert.deepEqual(ca.classify(CALL, port), REPLY, String(value));
      assert.equal(port.calls.length, 1, String(value));
    }
  } finally { if (saved === undefined) delete process.env.CODE_ACTIONS_IMPL; else process.env.CODE_ACTIONS_IMPL = saved; }
  assert.ok(!davParseWasm.IMPL_FLAGS.includes('CODE_ACTIONS_IMPL'));
  assert.equal(davParseWasm.RETIRED_FLAGS.CODE_ACTIONS_IMPL, 'wasm');
});

test('classify: the port\'s classification is the answer, and it is sent only what the classifier reads', () => {
  const port = fakePort({ classify: reply(REPLY) });
  assert.deepEqual(ca.classify(CALL, port), REPLY);
  assert.deepEqual(port.calls, [['classify', [{ kind: 'execute', rawInput: { command: 'ls -la', noeviaOutsideWorkspace: false }, locations: ['/work/a'] }]]]);
  assert.ok(!JSON.stringify(port.calls).includes('secret title'), 'the title is not sent');
});

test('classify: a refusal, a fault or a bad reply is the unverified classification, with the command kept for the card', () => {
  const call = { kind: 'execute', rawInput: { cmd: '  curl https://example.com/x  ' } };
  const cases = [[refuse('too_large'), 'too large or complex to check'], [refuse('input'), 'its arguments have a form that cannot be checked'],
    [refuse('trap'), 'the checker did not answer'], [() => { throw new TypeError('bad'); }, 'the checker did not answer']];
  for (const [answer, why] of cases) {
    const { value: c, seen } = quietly(() => ca.classify(call, fakePort({ classify: answer })));
    assert.deepEqual(c, { action: 'external_account', approval: 'always', command: 'curl https://example.com/x', paths: [], readable: false,
      actions: ['external_account', 'execute_command'], simple: false, standable: false, unverified: true, unverifiedWhy: why });
    assert.ok(seen.every((m) => !m.includes('example.com')), 'logged without the command');
  }
  // A call that cannot even be projected is unverified too, not a throw.
  const odd = { kind: 'execute', get rawInput() { throw Error('no'); } };
  assert.equal(quietly(() => ca.classify(odd, fakePort({ classify: reply(REPLY) }))).value.unverified, true);
});

test('decide: the port\'s decision is the answer, and it is sent only what decide reads', () => {
  const port = fakePort({ decide: reply({ decision: 'ask', reason: '' }) });
  const input = { classified: REPLY, capabilities: ['execute_command'], domains: ['example.com'], inWorkspace: true };
  assert.deepEqual(ca.decide(input, port), { decision: 'ask', reason: '' });
  const [name, [classified, capabilities, domains, inWorkspace]] = port.calls[0];
  assert.equal(name, 'decide');
  assert.deepEqual(classified, { action: 'execute_command', approval: 'always', command: 'ls -la', readable: true, paths: ['/work/a'], actions: ['execute_command'], simple: true });
  assert.deepEqual([capabilities, domains, inWorkspace], [['execute_command'], ['example.com'], true]);
});

const UNREADABLE = (call = CALL) => quietly(() => ca.classify(call, fakePort({ classify: refuse('too_large') }))).value;
const NOTE = 'This action could not be checked (too large or complex to check), so a person has to approve it. The paths its command would touch are unknown, so the task\u2019s workspace limits could not be checked either.';

test('decide: an unverified command is treated as the riskiest kind with unknown paths; with the grants (or no restriction) a person is asked, saying why, not standable', () => {
  const port = fakePort({ decide: reply({ decision: 'allow', reason: 'Read-only.' }) });
  const unverified = UNREADABLE();
  assert.equal(unverified.unverified, true);
  assert.equal(unverified.action, 'external_account');
  assert.deepEqual(unverified.actions, ['external_account', 'execute_command']);
  assert.equal(unverified.standable, false);
  // No restriction on the task, and a task granted every class it is treated as: asked, never allowed.
  for (const capabilities of [[], ['edit_file', 'execute_command', 'external_account']]) {
    assert.deepEqual(ca.decide({ classified: unverified, capabilities, domains: [], inWorkspace: null }, port), { decision: 'ask', reason: NOTE, standable: false });
  }
  assert.deepEqual(port.calls, []);
});

test('decide: an unverified command in a task that was not granted a class it is treated as is denied, naming the first missing class', () => {
  const port = fakePort({ decide: reply({ decision: 'allow', reason: 'x' }) });
  for (const capabilities of [['edit_file'], ['edit_file', 'network', 'delete', 'git_push', 'execute_command']]) {
    const d = ca.decide({ classified: UNREADABLE(), capabilities, domains: ['example.com'], inWorkspace: null }, port);
    assert.equal(d.decision, 'deny');
    assert.match(d.reason, /^This task was not granted external account\. \(This command could not be checked, so it is treated as the most consequential kind of action\.\)$/);
  }
  // Granted external_account but not execute_command: the unverified execute call is denied, naming execute command.
  const d = ca.decide({ classified: UNREADABLE(), capabilities: ['edit_file', 'external_account'], domains: [], inWorkspace: null }, port);
  assert.equal(d.decision, 'deny');
  assert.match(d.reason, /^This task was not granted execute command\./);
  assert.deepEqual(port.calls, []);
});

test('decide: an unverified call and the workspace, in live\u2019s order: a stated path outside is denied for a write kind, before the grants; unknown paths ask and say so', () => {
  const edit = { kind: 'edit', rawInput: { path: 'x' }, locations: [{ path: '/elsewhere/a' }] };
  const c = UNREADABLE(edit);
  assert.deepEqual(c.paths, ['/elsewhere/a']);
  assert.deepEqual(c.actions, ['external_account', 'edit_file']);
  const WS = { decision: 'deny', reason: 'The path is outside this task\u2019s workspace.' };
  // Granted everything it is treated as, and a restricted task missing something: the workspace answers first.
  assert.deepEqual(ca.decide({ classified: c, capabilities: ['edit_file', 'external_account'], domains: [], inWorkspace: false }), WS);
  assert.deepEqual(ca.decide({ classified: c, capabilities: ['network'], domains: [], inWorkspace: false }), WS);
  // Inside (or unknown), the grants decide, then a person is asked.
  assert.equal(ca.decide({ classified: c, capabilities: ['network'], domains: [], inWorkspace: true }).decision, 'deny');
  assert.deepEqual(ca.decide({ classified: c, capabilities: ['edit_file', 'external_account'], domains: [], inWorkspace: true }), { decision: 'ask', reason: NOTE, standable: false });
  // An unverified command (execute kind) with a stated outside path is not a write: asked, with the workspace note.
  const cmd = UNREADABLE({ ...CALL, locations: [{ path: '/elsewhere/a' }] });
  assert.equal(ca.decide({ classified: cmd, capabilities: ['execute_command', 'external_account'], domains: [], inWorkspace: false }).decision, 'ask');
  // No stated path: nothing to be outside of.
  assert.match(ca.decide({ classified: UNREADABLE(), capabilities: [], domains: [], inWorkspace: null }).reason, /workspace limits could not be checked/);
  assert.equal(ca.decide({ classified: UNREADABLE({ kind: 'execute', rawInput: { command: 'ls' } }), capabilities: [], domains: [], inWorkspace: false }).decision, 'ask');
});

test('decide: noeviaOutsideWorkspace on an unverified command: asked (not standable) and says it reaches outside the workspace; denied without the grant', () => {
  const flagged = { kind: 'execute', rawInput: { command: 'ls', noeviaOutsideWorkspace: true } };
  const c = UNREADABLE(flagged);
  assert.equal(c.outsideWorkspace, true);
  assert.equal(c.standable, false);
  const d = ca.decide({ classified: c, capabilities: ['external_account', 'execute_command'], domains: [], inWorkspace: null });
  assert.equal(d.decision, 'ask');
  assert.equal(d.standable, false);
  assert.match(d.reason, /It reaches outside the task\u2019s workspace\./);
  assert.equal(ca.decide({ classified: c, capabilities: ['edit_file'], domains: [], inWorkspace: null }).decision, 'deny');
});

test('decide: a refusal, a fault, a bad reply or an input of the wrong shape asks a person (never allows)', () => {
  const input = { classified: REPLY, capabilities: [], domains: [], inWorkspace: null };
  for (const answer of [refuse('trap'), refuse('too_large'), refuse('ambiguous'), () => { throw new TypeError('bad'); }]) {
    assert.deepEqual(quietly(() => ca.decide(input, fakePort({ decide: answer }))).value, { decision: 'ask', reason: ca.UNVERIFIED_ASK, standable: false });
  }
  for (const bad of [undefined, {}, { classified: {} }, { classified: { ...REPLY, paths: 'x' } }, { classified: REPLY, inWorkspace: 'yes' }]) {
    assert.deepEqual(quietly(() => ca.decide(bad, fakePort({ decide: reply({ decision: 'allow', reason: '' }) }))).value, { decision: 'ask', reason: ca.UNVERIFIED_ASK, standable: false }, JSON.stringify(bad));
  }
});

test('decide keeps malformed grants non-standable while preserving certain workspace denials', () => {
  const unverified = { ...REPLY, unverified: true, unverifiedWhy: 'test', paths: [] };
  const asked = ca.decide({ classified: unverified, capabilities: 'network', inWorkspace: true });
  assert.equal(asked.decision, 'ask');
  assert.equal(asked.standable, false, 'a non-array grant value cannot establish a standing approval');

  const outsideWrite = { ...REPLY, unverified: true, action: 'edit_file', actions: ['edit_file'], paths: ['/elsewhere/a'] };
  assert.deepEqual(ca.decide({ classified: outsideWrite, capabilities: 'network', inWorkspace: false }),
    { decision: 'deny', reason: 'The path is outside this task\u2019s workspace.' },
    'a certain workspace denial still applies before malformed grants');
});

test('decide: a network call whose URL host the port cannot read exactly asks, unless the port denies it without the command', () => {
  const network = { ...REPLY, action: 'network', approval: 'capability', command: 'curl https://bücher.example/x', actions: ['network'], standable: true };
  const input = { classified: network, capabilities: [], domains: ['example.com'], inWorkspace: null };
  // The first ask is refused as ambiguous; the second (no command) is answered.
  const answers = (second) => { let n = 0; return { decide: (...a) => { if (n++ === 0) throw new davParseWasm.DavParseError('refused', 'ambiguous'); return second(...a); } }; };
  const ask = quietly(() => ca.decide(input, fakePort(answers(reply({ decision: 'ask', reason: 'Network request.' }))))).value;
  assert.deepEqual(ask, { decision: 'ask', reason: ca.UNVERIFIED_ASK, standable: false });
  // Never allowed, even if the second answer would allow.
  assert.equal(quietly(() => ca.decide(input, fakePort(answers(reply({ decision: 'allow', reason: 'x' }))))).value.decision, 'ask');
  // What the port denies without the command stays denied, with its words.
  const denied = quietly(() => ca.decide(input, fakePort(answers(reply({ decision: 'deny', reason: 'This task was not granted network.' }))))).value;
  assert.deepEqual(denied, { decision: 'deny', reason: 'This task was not granted network.' });
  // The second ask is refused too: a person is asked.
  assert.equal(quietly(() => ca.decide(input, fakePort(answers(refuse('trap'))))).value.decision, 'ask');
  // And the second ask carries no command text.
  const port = fakePort(answers(reply({ decision: 'ask', reason: '' })));
  quietly(() => ca.decide(input, port));
  assert.equal(port.calls[0][1][0].command, 'curl https://bücher.example/x');
  assert.equal(port.calls[1][1][0].command, '');
});

test('pickOption: the port\'s option is the answer; any doubt cancels', () => {
  const options = [{ optionId: 'a', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }, null, { kind: 'x' }];
  const port = fakePort({ pick: reply({ outcome: 'selected', optionId: 'a' }) });
  assert.deepEqual(ca.pickOption(options, 'allow_once', port), { outcome: 'selected', optionId: 'a' });
  assert.deepEqual(port.calls[0][1], [[{ optionId: 'a', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }, null, null], 'allow_once']);
  assert.deepEqual(ca.pickOption(options, 'reject_once', fakePort({ pick: reply({ outcome: 'cancelled' }) })), { outcome: 'cancelled' });
  for (const answer of [refuse('trap'), () => { throw new TypeError('bad'); }]) {
    assert.deepEqual(quietly(() => ca.pickOption(options, 'allow_once', fakePort({ pick: answer }))).value, { outcome: 'cancelled' });
  }
});

test('process.env with a missing module: nothing is allowed, selected or classified as safe, whatever the old switch says', () => {
  const saved = { impl: process.env.CODE_ACTIONS_IMPL, file: process.env.DAV_PARSE_WASM };
  process.env.DAV_PARSE_WASM = '/nonexistent/dav-parse.wasm';
  try {
    for (const impl of [undefined, 'js', 'wasm']) {
      if (impl === undefined) delete process.env.CODE_ACTIONS_IMPL; else process.env.CODE_ACTIONS_IMPL = impl;
      davParseWasm.reset();
      const { value } = quietly(() => {
        const c = ca.classify({ kind: 'read' });
        return { c, d: ca.decide({ classified: { action: 'read_repository', approval: 'never', command: '', readable: true, paths: [], actions: ['read_repository'], simple: true } }),
          p: ca.pickOption([{ optionId: 'a', kind: 'allow_once' }], 'allow_once') };
      });
      assert.equal(value.c.unverified, true);
      assert.equal(value.c.approval, 'always');
      assert.equal(value.d.decision, 'ask');
      assert.deepEqual(value.p, { outcome: 'cancelled' });
    }
  } finally {
    if (saved.impl === undefined) delete process.env.CODE_ACTIONS_IMPL; else process.env.CODE_ACTIONS_IMPL = saved.impl;
    if (saved.file === undefined) delete process.env.DAV_PARSE_WASM; else process.env.DAV_PARSE_WASM = saved.file;
    davParseWasm.reset();
  }
});

test('a persistent fault is logged on its first occurrence and again at the 10th, 100th and 1000th, never with the command', () => {
  const call = { kind: 'execute', rawInput: { command: 'ls secret-synthetic-path' } };
  const { seen } = quietly(() => { for (let i = 0; i < 1000; i++) ca.classify(call, fakePort({ classify: refuse('persistent_fault_test') })); });
  assert.equal(seen.length, 4, seen.join('\n'));
  assert.match(seen[0], /persistent_fault_test\); the call was handled as unverified$/);
  assert.match(seen[1], /\(10 times so far\)$/);
  assert.match(seen[2], /\(100 times so far\)$/);
  assert.match(seen[3], /\(1000 times so far\)$/);
  assert.ok(seen.every((m) => !m.includes('secret-synthetic-path')));
});

test('decide, when the crate cannot answer: the floor (the crate\u2019s two deny rules) is applied on the host before a person is asked, and the ask cannot stand', () => {
  const edit = { ...REPLY, action: 'edit_file', command: '', paths: ['/elsewhere/a'], actions: ['edit_file'] };
  const exec = { ...REPLY, action: 'execute_command', actions: ['execute_command'], paths: [] };
  const dead = (c) => ({ decide: refuse(c) });
  for (const cause of ['trap', 'too_large', 'ambiguous', 'reply', 'input']) {
    // 1. an edit or delete with paths outside the workspace
    assert.deepEqual(quietly(() => ca.decide({ classified: edit, capabilities: [], domains: [], inWorkspace: false }, fakePort(dead(cause)))).value,
      { decision: 'deny', reason: 'The path is outside this task\u2019s workspace.' }, cause);
    // 2. a restricted task missing the class (the first missing one is named); none and read never need a grant
    assert.deepEqual(quietly(() => ca.decide({ classified: { ...exec, actions: ['read_repository', 'none', 'network', 'execute_command'] }, capabilities: ['execute_command'], domains: [], inWorkspace: null }, fakePort(dead(cause)))).value,
      { decision: 'deny', reason: 'This task was not granted network.' }, cause);
    // neither rule applies: asked, and not standable
    assert.deepEqual(quietly(() => ca.decide({ classified: exec, capabilities: ['execute_command'], domains: [], inWorkspace: null }, fakePort(dead(cause)))).value,
      { decision: 'ask', reason: ca.UNVERIFIED_ASK, standable: false }, cause);
  }
  // Order, as live: the workspace before the grants; paths outside but an inside answer or no paths: no workspace denial.
  assert.equal(quietly(() => ca.decide({ classified: edit, capabilities: ['network'], domains: [], inWorkspace: false }, fakePort(dead('trap')))).value.reason, 'The path is outside this task\u2019s workspace.');
  assert.equal(quietly(() => ca.decide({ classified: { ...edit, paths: [] }, capabilities: [], domains: [], inWorkspace: false }, fakePort(dead('trap')))).value.decision, 'ask');
  assert.equal(quietly(() => ca.decide({ classified: edit, capabilities: [], domains: [], inWorkspace: true }, fakePort(dead('trap')))).value.decision, 'ask');
});

test('decide, when the floor itself cannot be computed: a person is asked, not standable', () => {
  const classified = { ...REPLY, get actions() { throw Error('no'); } };
  assert.deepEqual(quietly(() => ca.decide({ classified, capabilities: ['edit_file'], domains: [], inWorkspace: false }, fakePort({ decide: refuse('trap') }))).value,
    { decision: 'ask', reason: ca.UNVERIFIED_ASK, standable: false });
});
