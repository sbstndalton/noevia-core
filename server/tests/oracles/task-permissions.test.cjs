'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCodeHarness } = require('../../code-harness.cjs');
const options = [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }];
const taskId = '11111111-1111-4111-8111-111111111111';
async function capture(scenario) {
  const events = [], answers = [], cards = [];
  const controller = new AbortController();
  const workspace = { branch: 'synthetic', path: '/synthetic/tree', home: '/synthetic/home', baseSha: null };
  const harness = createCodeHarness({ jobs: { append() {} }, guard: { enabled: () => false },
    workspaces: { owner: null, release: () => ({ headSha: null }), headSha: () => null, contains: (_, name) => name.includes('outside') ? false : true },
    askApproval: async card => { cards.push(card);return scenario.answer; }, engine: () => ({ baseUrl: 'http://engine.invalid/v1', model: 'synthetic' }),
    pinConfig: () => ({ file: 'opencode.json', permission: {} }), now: () => 1234 });
  const ctx = { signal: controller.signal, checkpoint() {}, progress() {}, event: (type, data) => {
    if (type.startsWith('approval.')) events.push({ type, data });
  } };
  await harness.runExecutor(ctx, { taskId, workspace, grant: null }, { prompt: 'synthetic', capabilities: scenario.capabilities, domains: [],
    connect: async ({ handlers }) => ({ agent: {}, prompt: async () => {
      if (scenario.announced) handlers.sessionUpdate({ sessionUpdate: 'tool_call', ...scenario.announced });
      for (let n = 0; n < scenario.repeat; n++) answers.push(await handlers.requestPermission({ toolCall: scenario.call, options }));
      return { stopReason: 'end_turn' };
    } }) });
  return JSON.parse(JSON.stringify({ events, answers, cards }));
}
test('native session oracle captures per-action human and standing permission semantics', async () => {
  const read = { toolCallId: 'r', kind: 'read', rawInput: { path: 'source.txt' }, locations: [{ path: 'source.txt' }] };
  const edit = { toolCallId: 'e', kind: 'edit', title: 'edit', rawInput: { path: 'source.txt', content: 'synthetic' }, locations: [{ path: 'source.txt' }] };
  const remove = { toolCallId: 'd', kind: 'delete', rawInput: { path: 'source.txt' }, locations: [{ path: 'source.txt' }] };
  const inputs = [
    { call: read, capabilities: ['read_repository'], answer: 'deny', repeat: 1 },
    { call: edit, capabilities: ['read_repository'], answer: 'approve', repeat: 1 },
    ...['approve', 'approve_all', 'deny', 'timeout', 'aborted'].map(answer => ({ call: edit, capabilities: ['edit_file'], answer, repeat: 2 })),
    { call: remove, capabilities: ['delete'], answer: 'approve_all', repeat: 2 },
    { call: { ...edit, locations: [{ path: '/outside' }] }, capabilities: ['edit_file'], answer: 'approve', repeat: 1 },
    { announced: edit, call: { toolCallId: 'e' }, capabilities: ['edit_file'], answer: 'deny', repeat: 1 },
    { announced: read, call: { toolCallId: 'r', kind: 'execute', rawInput: { command: 'printf synthetic' } }, capabilities: ['read_repository', 'execute_command'], answer: 'deny', repeat: 1 },
  ];
  const cases = [];for (const input of inputs) cases.push({ input, output: await capture(input) });
  assert.equal(cases[0].output.cards.length, 0);assert.equal(cases[1].output.answers[0].optionId, 'reject');
  assert.equal(cases[3].output.cards.length, 1);assert.equal(cases[7].output.cards.length, 2);
  if (process.env.TASK_PERMISSIONS_EVIDENCE) require('node:fs').writeFileSync(require('node:path').join(process.env.TASK_PERMISSIONS_EVIDENCE, 'task-permissions-node.json'), JSON.stringify({ cases }, null, 2) + '\n');
});
