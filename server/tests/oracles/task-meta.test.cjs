'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const meta = require('../../code-meta.cjs');
test('coding metadata preserves missing values coercion and measurements', () => {
  const inputs = [null, false, '', {}, [], { inputTokens: null, outputTokens: '' }, { input: 3, output: 4 }, { usage: { input_tokens: '5', output_tokens: true } }, { tokenUsage: { input: -1, output: 8 } }, { noevia: { usage: { prompt: 9, completion: 2, total: 25 } } }, { used: 8012, size: 24576 }, { used: 10, size: 3 }, { context: { used: null, window: 10 } }, { _meta: { exitCode: null, noevia: { code: 8 } } }, { rawOutput: { exit_code: '2' } }, { meta: { code: false } }, { exitCode: 1.5, code: -2 }, { usage: { input: [], output: [4] } }];
  const cases = inputs.map(input => ({ input, usage: meta.readUsage(input), context: meta.readContext(input), exit: meta.readExitCode(input) }));
  assert.equal(cases[5].usage.total, 0);assert.equal(cases[10].usage, null);
  const summaries = [null, {}, { agent: { name: 'synthetic', version: '1', protocolVersion: 1 }, usage: { total: 10 }, exits: [{ exitCode: 0 }, { exitCode: 2 }, null], messageChunks: 3 }, { usage: { input: 4 }, context: { used: 8, size: 16 }, exits: Array.from({ length: 55 }, (_, i) => ({ exitCode: i % 2 })) }].map(input => ({ input, output: meta.summarize(input) }));
  if (process.env.TASK_META_EVIDENCE) require('node:fs').writeFileSync(require('node:path').join(process.env.TASK_META_EVIDENCE, 'task-meta-node.json'), JSON.stringify({ cases, summaries }, null, 2) + '\n');
});
