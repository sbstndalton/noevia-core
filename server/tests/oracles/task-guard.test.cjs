'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../../code-tool-schemas.cjs');
test('executor guard oracle captures schema projection corrections and strike lifecycle', () => {
  const inputs = [null, {}, { kind: 'unknown' }, { kind: true }, { kind: 'execute' }, { kind: 'execute', rawInput: {} },
    ...['', 'printf synthetic', 'printf\0synthetic'].map(command => ({ kind: 'execute', rawInput: { command } })),
    { kind: 'edit', rawInput: {} }, { kind: 'edit', locations: [{ path: '' }] }, { kind: 'edit', locations: [{ path: 'a\0b' }] },
    { kind: 'edit', rawInput: { path: 'a' } }, { kind: 'read', locations: [{ path: 'a', line: 1.5 }] },
    { kind: 'fetch', rawInput: {} }, { kind: 'fetch', rawInput: { url: 'https://synthetic.invalid/' } },
    { kind: 'think', rawInput: {} }, { kind: 'read', content: 'wrong' }, { kind: 'read', rawInput: [] },
    { kind: 'move', rawInput: { path: '  ' } }, { kind: 'execute', rawInput: { command: ['printf', 'synthetic'], cwd: 'a\u007fb' } }];
  const calls = inputs.map(input => ({ input, output: guard.checkToolCall(input) }));
  const fsCalls = [];
  for (const method of ['fs/read_text_file', 'fs/write_text_file']) for (const params of [null, {}, { path: '' }, { path: 'a\0b' }, { path: 'a', line: 0, content: 'x' }, { path: 'a', line: 1.5, content: 'x' }, { path: 'a', content: 'synthetic' }, { path: 'a', content: 4 }, { path: 'a', limit: 1, content: 'x' }]) fsCalls.push({ method, params, maxBytes: 8, output: guard.checkFsCall(method, params, { maxBytes: 8 }) });
  const events = [], instance = guard.createExecutorGuard({ event: (type, data) => events.push({ type, data }), maxBytes: 8 });
  const refusals = [null, { kind: 'execute' }, { kind: 'edit' }, { kind: 'think' }].map(input => instance.permission(input, 'execute_command'));
  assert.equal(instance.blocked, true);assert.equal(instance.violations, 3);
  const blocked = instance.blockedError();
  const schemas = { tool: Object.fromEntries(guard.ACP_KINDS.map(kind => [kind, guard.toolCallSchema(kind)])), files: guard.FS_SCHEMAS };
  const output = { calls, fsCalls, strikes: { refusals, events, error: { message: blocked.message, code: blocked.code, publicMessage: blocked.publicMessage, result: blocked.result } } };
  if (process.env.TASK_GUARD_EVIDENCE) {
    const fs = require('node:fs'), path = require('node:path');
    fs.writeFileSync(path.join(process.env.TASK_GUARD_EVIDENCE, 'task-guard-node.json'), JSON.stringify(output, null, 2) + '\n');
    fs.writeFileSync(path.join(process.env.TASK_GUARD_EVIDENCE, 'task-guard-schemas.json'), JSON.stringify(schemas, null, 2) + '\n');
  }
});
