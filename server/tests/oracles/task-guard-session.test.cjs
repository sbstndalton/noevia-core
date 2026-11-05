'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCodeHarness } = require('../../code-harness.cjs');
test('guarded executor records each refusal and returns the exact blocked outcome', async () => {
  const taskId = '11111111-1111-4111-8111-111111111111';
  const calls = [null, { kind: 'execute' }, { kind: 'edit' }, { kind: 'think' }];
  const answers = [], events = [];
  const controller = new AbortController();
  const harness = createCodeHarness({ jobs: { append() {} }, workspaces: { owner: null, release: () => ({ headSha: null }), headSha: () => null, contains: () => true },
    askApproval: async () => { throw Error('malformed calls must not ask'); },
    pinConfig: () => ({ file: 'opencode.json', permission: {} }), engine: () => ({ baseUrl: 'http://engine.invalid/v1', model: 'synthetic' }), now: () => 1234 });
  const ctx = { signal: controller.signal, checkpoint() {}, progress() {}, event: (type, data) => { if (type.startsWith('approval.') || data.id === 'executor.guard') events.push({ type, data }); } };
  let error;
  try {
    await harness.runExecutor(ctx, { taskId, workspace: { branch: 'synthetic', path: '/synthetic/tree', home: '/synthetic/home', baseSha: null }, grant: null }, {
      prompt: 'synthetic', guarded: true, capabilities: ['edit_file', 'execute_command'],
      connect: async ({ handlers }) => ({ agent: {}, prompt: async () => {
        for (const toolCall of calls) answers.push(await handlers.requestPermission({ toolCall, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }] }));
        return { stopReason: 'end_turn' };
      } }) });
  } catch (caught) { error = { message: caught.message, code: caught.code, publicMessage: caught.publicMessage, result: caught.result }; }
  assert.equal(error.code, 'blocked');assert.equal(answers.length, 4);assert.equal(error.result.violations.length, 3);
  if (process.env.TASK_GUARD_EVIDENCE) require('node:fs').writeFileSync(require('node:path').join(process.env.TASK_GUARD_EVIDENCE, 'task-guard-session-node.json'), JSON.stringify({ calls, answers, events, error }, null, 2) + '\n');
});
