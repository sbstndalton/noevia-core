'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../../code-actions.cjs');
test('native action host projection and refusal floor match Node', () => {
  const calls = [null, {}, { kind: 'read' }, { kind: 'edit', locations: [{ path: 'a' }], rawInput: { path: 'a' } },
    ...['printf synthetic', 'rm source.txt', 'git push origin main', 'curl -q https://synthetic.invalid/', 'curl -q https://127.1/', 'sh -c "printf synthetic"'].map(command => ({ kind: 'execute', rawInput: { command }, locations: [] })),
    { kind: 'execute', rawInput: { args: [{}], noeviaOutsideWorkspace: true }, locations: [{ path: 'outside' }, { path: 'outside' }] },
    { kind: 'execute', rawInput: { command: [1e20] } }, { kind: 'execute', rawInput: { args: ['printf', 'synthetic'] } }];
  const cases = [];
  for (const call of calls) for (const capabilities of [[], ['read_repository'], ['execute_command', 'network', 'external_account']]) for (const inside of [true, false, null]) {
    const classified = policy.classify(call);
    cases.push({ call, capabilities, domains: ['synthetic.invalid'], inside, classified,
      verdict: policy.decide({ classified, capabilities, domains: ['synthetic.invalid'], inWorkspace: inside }) });
  }
  const options = [null, [], [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }], [{ optionId: 'always', kind: 'allow_always' }, null], [{ optionId: 3, kind: 'allow_once' }]];
  const picks = options.flatMap(options => ['allow_once', 'allow_always', 'reject_once', 'reject_always'].map(wanted => ({ options, wanted, output: policy.pickOption(options, wanted) })));
  assert.equal(cases.length, 117);assert.ok(cases.some(row => row.classified.unverified));
  if (process.env.TASK_POLICY_EVIDENCE) require('node:fs').writeFileSync(require('node:path').join(process.env.TASK_POLICY_EVIDENCE, 'task-policy-node.json'), JSON.stringify({ cases, picks }, null, 2) + '\n');
});
