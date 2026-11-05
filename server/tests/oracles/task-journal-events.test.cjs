'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { createJobs } = require('../../jobs.cjs');
test('journal oracle captures Code plan normalization and assistant event limits', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TASK_JOURNAL_EVIDENCE || os.tmpdir(), 'journal-oracle-'));
  try {
    const jobs = createJobs({ dir, kinds: ['code'], now: () => 1234 });
    const id = jobs.create({ kind: 'code', projectId: 'project', capabilities: [] });
    jobs.append(id, 'plan.proposed', { question: 'ignored', subQuestions: ['\ud800'], truncated: false });
    jobs.append(id, 'assistant.output', { text: '😀'.repeat(400), ignored: 'not journalled' });
    for (let n = 1; n < 64; n++) jobs.append(id, 'assistant.output', { text: '' });
    assert.throws(() => jobs.append(id, 'assistant.output', { text: 'overflow' }), /Assistant output event limit reached/);
    const rows = fs.readFileSync(path.join(dir, 'jobs', `${id}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
    const plan = rows.find(row => row.type === 'plan.proposed').data;
    const output = rows.find(row => row.type === 'assistant.output').data;
    assert.deepEqual(plan, { question: null, subQuestions: ['�'], truncated: true });
    assert.equal(Buffer.byteLength(output.text), 1024);assert.equal(output.truncated, true);
    if (process.env.TASK_JOURNAL_EVIDENCE) fs.writeFileSync(path.join(process.env.TASK_JOURNAL_EVIDENCE, 'task-journal-events-node.json'), JSON.stringify({ plan, output, eventLimit: 64 }, null, 2) + '\n');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
