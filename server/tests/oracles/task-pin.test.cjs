'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { pinFilesFor, cwdPinPaths } = require('../../code-harness-config.cjs');
const harnesses = ['opencode', 'claude-code', 'codex', 'qwen-code', 'pi', 'deepseek', 'unknown'];
function capture(input) {
  try { return { ok: true, value: pinFilesFor(input), cwdPins: cwdPinPaths(input.harness) }; }
  catch (error) { return { ok: false, status: error.status || 500, error: error.message }; }
}
test('harness pin oracle captures permission files, engine extensions and refusals', () => {
  const templates = {};
  const cases = [];
  for (const harness of harnesses) {
    const template = capture({ harness, model: '__TASK_MODEL__', engine: 'http://engine-placeholder.invalid', apiKey: '__TASK_KEY__' });
    if (template.ok) templates[harness] = template;
    for (const options of [
      { model: 'synthetic/model', engine: 'http://synthetic-engine.invalid/v1/', apiKey: 'synthetic-key', contextTokens: 16384, outputTokens: 2048 },
      { model: ' m ', engine: ' http://synthetic-engine.invalid ', apiKey: null },
      { model: '', engine: 'http://synthetic-engine.invalid' },
      { model: 'm', engine: 'invalid' },
      { model: '__proto__', engine: 'https://synthetic-engine.invalid/v1', apiKey: '', contextTokens: -1, outputTokens: 2.5 },
    ]) {
      const input = { harness, ...options };cases.push({ input, expected: capture(input) });
    }
  }
  assert.equal(cases.length, 35);
  assert.equal(cases[0].expected.value.files[0].path, 'opencode.json');
  assert.equal(cases[10].expected.ok, false);assert.equal(cases[10].expected.status, 409);
  assert.deepEqual(templates['claude-code'].cwdPins, ['.claude/settings.local.json']);
  if (process.env.TASK_PIN_EVIDENCE) {
    fs.writeFileSync(path.join(process.env.TASK_PIN_EVIDENCE, 'task-pin-templates-node.json'), JSON.stringify(templates, null, 2) + '\n');
    fs.writeFileSync(path.join(process.env.TASK_PIN_EVIDENCE, 'task-pin-node.json'), JSON.stringify({ cases }, null, 2) + '\n');
  }
});
