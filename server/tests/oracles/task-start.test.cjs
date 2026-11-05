'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { capture, fixture } = require('./task-start.cjs');
test('code start oracle records normalization and ordered refusals without executing engines', async () => {
  const value = await fixture();
  assert.equal(value.cases.length, 60);
  if (process.env.TASK_START_FIXTURE) require('node:fs').writeFileSync(process.env.TASK_START_FIXTURE, JSON.stringify(value, null, 2) + '\n');
  assert.deepEqual(value.cases[0].expected, { status: 400, error: 'Choose a repository the operator registered on this server.' });
  assert.equal(value.cases[2].expected.execution.prompt, 'task');
  assert.deepEqual(value.cases[7].expected.execution.capabilities, ['edit_file']);
  assert.deepEqual(value.cases[7].expected.execution.domains, ['example.com', 'a..com', 'a.co']);
  assert.deepEqual(await capture({ network: 'ready', body: { repository: 'repo', prompt: 'task' }, active: true }), { status: 409, error: 'This project already has a task running.' });
});
