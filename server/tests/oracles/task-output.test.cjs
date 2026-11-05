'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCodeHarness } = require('../../code-harness.cjs');
async function capture(actions) {
  const events = [];
  const workspace = { branch: 'synthetic', path: '/synthetic/tree', home: '/synthetic/home', baseSha: 'a'.repeat(40) };
  const harness = createCodeHarness({ jobs: { append() {} }, workspaces: { owner: null, release: () => ({ status: 'released', headSha: 'b'.repeat(40) }), headSha: () => null },
    askApproval: async () => 'deny', engine: () => ({ baseUrl: 'http://engine.invalid/v1', model: 'synthetic' }),
    pinConfig: () => ({ file: 'opencode.json', permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' }, model: 'local/synthetic', endpoint: 'http://engine.invalid/v1' }), now: () => 1234 });
  const controller = new AbortController();
  const ctx = { signal: controller.signal, checkpoint() {}, progress() {}, event: (kind, data) => { if (kind === 'assistant.output') events.push(JSON.parse(JSON.stringify(data))); } };
  await harness.runExecutor(ctx, { taskId: '11111111-1111-4111-8111-111111111111', workspace, grant: null }, {
    prompt: 'synthetic', capabilities: [], connect: async ({ handlers }) => ({ agent: { name: 'synthetic', version: '1', protocolVersion: 1 },
      prompt: async () => { for (const action of actions) {
        if (action.kind === 'message') handlers.sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: action.text } });
        else handlers.sessionUpdate({ sessionUpdate: action.kind === 'tool' ? 'tool_call' : 'tool_call_update', toolCallId: 'synthetic', kind: 'read' });
      } return { stopReason: 'end_turn' }; } }) });
  return events;
}
test('executor output oracle captures UTF16 boundaries batching tool breaks and caps', async () => {
  const inputs = [
    [{ kind: 'message', text: 'hello' }],
    [{ kind: 'message', text: '\ud83d' }, { kind: 'message', text: '\ude00' }],
    [{ kind: 'message', text: '\ud83d' }, { kind: 'tool' }, { kind: 'message', text: 'after' }],
    [{ kind: 'message', text: 'x'.repeat(32769) }],
    [{ kind: 'message', text: '😀'.repeat(9000) }],
    Array.from({ length: 70 }, () => [{ kind: 'message', text: 'x' }, { kind: 'tool' }]).flat(),
    [{ kind: 'message', text: 'before' }, { kind: 'update' }, { kind: 'message', text: '' }, { kind: 'message', text: 'after' }],
  ];
  const cases = [];
  for (const actions of inputs) cases.push({ actions, expected: await capture(actions) });
  assert.equal(cases[1].expected[0].text, '😀');
  assert.equal(cases[2].expected[0].text, '�');
  assert.equal(cases[3].expected.at(-1).truncated, true);
  assert.ok(cases[5].expected.length <= 64);
  if (process.env.TASK_OUTPUT_EVIDENCE) require('node:fs').writeFileSync(require('node:path').join(process.env.TASK_OUTPUT_EVIDENCE, 'task-output-node.json'), JSON.stringify({ cases }, null, 2) + '\n');
});
