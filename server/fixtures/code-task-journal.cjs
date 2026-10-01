'use strict';
// A synthetic Code-task journal (#701) in the exact shape jobs.cjs appends, used to pin the
// flag-off (no lifecycle authority) derived job and public view byte-for-byte. Invented data
// only: no real Diary prompts or corpus. Several payloads deliberately carry lifecycle-looking
// keys (`type: 'task.stage'`, `lifecycle`, `revision`, `stages`) that must stay inert.
const ID = '00000000-0000-4000-8000-000000000701';
const SHA = 'a'.repeat(40), BASE = 'b'.repeat(40);
const rows = [
  ['job.created', { kind: 'code', projectId: 'p-synthetic', parentId: null, capabilities: ['read', 'edit', 'execute'] }],
  ['job.started', {}],
  ['step.started', { id: 'harness.config', title: 'Pin the harness configuration' }],
  ['step.completed', { id: 'harness.config' }],
  ['checkpoint.created', { branch: 'noevia/task-synthetic', task: 'Rename the widget helper', baseSha: BASE, headSha: SHA, identityHash: 'c'.repeat(64), meta: { harness: 'fake' } }],
  ['plan.proposed', { question: null, subQuestions: ['Find the helper'] }],
  ['progress', { stage: 'implementing' }],
  ['approval.requested', { action: 'edit', path: 'src/widget.js', type: 'task.stage', to: 'merged', lifecycle: 'merged', revision: { n: 9, headSha: SHA }, stages: [{ stage: 'merged' }] }],
  ['approval.decided', { decision: 'approve', action: 'edit', type: 'task.revision', lifecycle: 'reviewing' }],
  ['tool.started', { id: 'call-1', name: 'task.stage', kind: 'edit' }],
  ['tool.completed', { id: 'call-1', failed: false, exitCode: 0 }],
  ['assistant.output', { text: 'Done. lifecycle=merged', truncated: false }],
  ['review.requested', { revision: 1, headSha: SHA, baseSha: BASE, files: 1 }],
  ['job.completed', { result: { summary: 'ok', lifecycle: 'merged', revision: { n: 3, headSha: SHA }, stages: [{ stage: 'merged' }], type: 'task.stage' } }],
];
const events = rows.map(([type, data], i) => ({ job: ID, seq: i + 1, type, at: 1700000000000 + i * 1000, data }));
module.exports = { ID, SHA, BASE, events };
