'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createCodeHarness } = require('../../code-harness.cjs');
const { createAcpTransport } = require('../../code-acp.cjs');
const TASK = '11111111-1111-4111-8111-111111111111', SHA = 'a'.repeat(40);
async function capture(mode) {
  const dir = fs.mkdtempSync(path.join(process.env.TASK_EXECUTION_EVIDENCE || os.tmpdir(), 'execution-oracle-'));
  const cwd = path.join(dir, 'tree'), home = path.join(dir, 'home');fs.mkdirSync(cwd);fs.mkdirSync(home);
  const events = [], answers = [];let cleaned = 0, sent = null, promptId = null, stopped = false;
  const socket = new EventEmitter();socket.setEncoding = () => {};
  const emit = message => queueMicrotask(() => { if (!stopped) socket.emit('data', JSON.stringify(message) + '\n'); });
  const reply = (id, result) => emit({ jsonrpc: '2.0', id, result });
  socket.destroy = () => { if (!stopped) { stopped = true;socket.emit('close'); } };
  socket.write = line => {
    const message = JSON.parse(line);
    if (message.method === 'initialize') reply(message.id, { protocolVersion: 1, agentInfo: { name: 'synthetic-agent', version: '1' } });
    if (message.method === 'session/new') reply(message.id, mode === 'missing_session' ? {} : { sessionId: 'session' });
    if (message.method === 'session/prompt') {
      promptId = message.id;sent = message.params.prompt[0].text;
      if (mode === 'closed_prompt') return queueMicrotask(() => socket.destroy());
      if (mode === 'remote_error') return emit({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'synthetic engine refused' } });
      if (mode === 'guarded_malformed') {
        for (const [n, toolCall] of [null, { kind: 'execute' }, { kind: 'edit' }].entries()) emit({ jsonrpc: '2.0', id: 80 + n, method: 'session/request_permission', params: { toolCall, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }] } });
        return;
      }
      if (mode === 'bad_json_then_reply') queueMicrotask(() => socket.emit('data', 'not-json\n'));
      emit({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } } } });
      emit({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'usage_update', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } } } });
      reply(message.id, { stopReason: 'end_turn' });
    }
    if (message.id >= 80 && message.id <= 82 && message.result) { answers.push(message.result);if (answers.length === 3) reply(promptId, { stopReason: 'end_turn' }); }
  };
  const connect = createAcpTransport({ endpoint: 'sidecar.invalid:9000', connectFn: () => { queueMicrotask(() => socket.emit('connect'));return socket; } });
  const harness = createCodeHarness({ jobs: { append() {} }, workspaces: { owner: null, headSha: () => SHA, release: () => { cleaned++;return { headSha: SHA }; }, contains: () => true },
    askApproval: async () => 'deny', engine: () => ({ baseUrl: 'http://engine.invalid/v1', apiKey: 'synthetic-key', model: 'synthetic' }), now: () => 1234 });
  const controller = new AbortController();
  const event = (type, data) => events.push({ type, data });
  const ctx = { signal: controller.signal, checkpoint: data => event('checkpoint.created', data), progress: stage => event('progress', { stage }), event };
  let result = null, error = null;
  try { result = await harness.runExecutor(ctx, { taskId: TASK, workspace: { branch: `noevia/task-${TASK}`, path: cwd, home, baseSha: SHA }, grant: null }, {
    prompt: 'synthetic task', context: 'Reference context', connect, harness: 'opencode', capabilities: ['read_repository', 'edit_file'], domains: [], sandboxKind: 'sandbox', guarded: mode === 'guarded_malformed',
  }); } catch (caught) { error = { error: String(caught.publicMessage || caught.message).slice(0, 500), result: caught.result ?? null }; }
  const normalize = value => typeof value === 'string' ? value.replaceAll(cwd, '/synthetic/tree').replaceAll(home, '/synthetic/home') : Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, value]) => [key, normalize(value)])) : value;
  try { return normalize({ mode, events, result, error, cleaned, prompt: sent, answers }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
test('complete executor oracle captures native sidecar turn and failure contracts', async () => {
  const cases = [];for (const mode of ['happy', 'bad_json_then_reply', 'missing_session', 'closed_prompt', 'remote_error', 'guarded_malformed']) cases.push(await capture(mode));
  assert.equal(cases[0].result.meta.usage.total, 7);assert.equal(cases[2].error.error, 'The coding harness did not open a session.');assert.equal(cases[5].error.result.blocked, true);
  if (process.env.TASK_EXECUTION_EVIDENCE) fs.writeFileSync(path.join(process.env.TASK_EXECUTION_EVIDENCE, 'task-execution-node.json'), JSON.stringify({ cases }, null, 2) + '\n');
});
