'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { readUsage, readExitCode, readAgent, codingIdentity, summarize } = require('./code-meta.cjs');

test('token usage is read from the spellings a harness might plausibly use', () => {
  assert.deepEqual(readUsage({ usage: { inputTokens: 10, outputTokens: 5 } }), { input: 10, output: 5, total: 15 });
  assert.deepEqual(readUsage({ tokenUsage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }), { input: 3, output: 4, total: 7 });
  assert.deepEqual(readUsage({ inputTokens: 1, outputTokens: 2 }), { input: 1, output: 2, total: 3 });
  assert.deepEqual(readUsage({ noevia: { usage: { input: 8, output: 1 } } }), { input: 8, output: 1, total: 9 });
});

test('usage that is absent or nonsense reads as absent, never as zero', () => {
  for (const meta of [null, undefined, {}, { usage: {} }, 'nope', { usage: { inputTokens: -5 } }, { usage: { inputTokens: 'lots' } }]) {
    assert.equal(readUsage(meta), null, JSON.stringify(meta));
  }
  // A harness reporting only one side still reports that side, and cannot invent the total.
  assert.deepEqual(readUsage({ usage: { outputTokens: 4 } }), { input: null, output: 4, total: null });
});

test('an exit code of zero is an answer, and a missing one is not a zero', () => {
  assert.equal(readExitCode({ exitCode: 0 }), 0);
  assert.equal(readExitCode({ _meta: { exit_code: 1 } }), 1);
  assert.equal(readExitCode({ rawOutput: { exitStatus: 127 } }), 127);
  assert.equal(readExitCode({ _meta: { noevia: { code: 2 } } }), 2);
  assert.equal(readExitCode({}), null);
  assert.equal(readExitCode({ exitCode: 'ok' }), null);
  assert.equal(readExitCode(null), null);
});

test('the agent names itself, or it does not', () => {
  assert.deepEqual(readAgent({ agentInfo: { name: 'opencode', version: '1.18.31' }, protocolVersion: 1 }),
    { name: 'opencode', version: '1.18.31', protocolVersion: 1 });
  assert.deepEqual(readAgent({}), { name: null, version: null, protocolVersion: null });
  assert.deepEqual(readAgent(null), { name: null, version: null, protocolVersion: null });
  assert.equal(readAgent({ agentInfo: { name: 'x'.repeat(200) } }).name.length, 80);
});

test('the identity changes when anything that changes the meaning of a result changes', () => {
  const base = { harness: 'opencode', harnessVersion: '1.18.31', model: 'Qwen3.5-4B', capabilities: ['edit_file'] };
  const a = codingIdentity(base);
  assert.equal(codingIdentity({ ...base }).identityHash, a.identityHash, 'same configuration, same hash');
  assert.equal(codingIdentity({ ...base, capabilities: ['edit_file'] }).identityHash, a.identityHash);
  for (const change of [{ harnessVersion: '1.19.0' }, { model: 'Ornith-1.5-9B' }, { harness: 'claude-code' },
    { capabilities: ['edit_file', 'git_push'] }, { promptPreparation: 'local' }, { sandbox: 'sandbox' }]) {
    assert.notEqual(codingIdentity({ ...base, ...change }).identityHash, a.identityHash, JSON.stringify(change));
  }
  // Capability order is not a configuration change.
  assert.equal(codingIdentity({ ...base, capabilities: ['git_push', 'edit_file'] }).identityHash,
    codingIdentity({ ...base, capabilities: ['edit_file', 'git_push'] }).identityHash);
});

test('a summary names what the harness did not say, instead of defaulting it', () => {
  const bare = summarize({});
  assert.equal(bare.usage, null);
  assert.equal(bare.harnessVersion, null);
  assert.deepEqual(bare.limitations, [
    'The harness did not report its version, so this cannot be scoped to one.',
    'The harness did not report token usage.',
    'No command exit codes were reported.',
  ]);

  const full = summarize({ agent: { name: 'opencode', version: '1.18.31', protocolVersion: 1 },
    usage: { input: 10, output: 5, total: 15 },
    exits: [{ id: '1', name: 'npm test', exitCode: 0 }, { id: '2', name: 'npm run lint', exitCode: 1 }], turns: 3 });
  assert.deepEqual(full.limitations, []);
  assert.equal(full.commands, 2);
  assert.equal(full.failedCommands, 1);
  assert.equal(full.turns, 3);
  assert.equal(full.harnessVersion, '1.18.31');
});

test('a partial report keeps what it has and still says what is missing', () => {
  const partial = summarize({ agent: { name: 'opencode', version: '1.18.31' }, usage: { input: 5, output: null, total: null } });
  assert.equal(partial.usage, null, 'a usage with no total is not a usage');
  assert.equal(partial.harnessVersion, '1.18.31');
  assert.equal(partial.limitations.length, 2);
  assert.ok(partial.limitations.every((l) => !/version/.test(l)));
});

test('the exit-code list is bounded in the summary', () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ id: String(i), name: 'cmd', exitCode: 0 }));
  const out = summarize({ exits: many });
  assert.equal(out.commands, 80);
  assert.equal(out.exitCodes.length, 50);
});
