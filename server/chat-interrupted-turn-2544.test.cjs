'use strict';
// #2544: the turn record kept tool steps in an Array indexed by the provider's own tool-call index, so an index such
// as 4294967294 made it sparse with a length of about 4.3 billion and every listing (the 4 s partial save, the
// interrupted-turn save) walked the holes and stalled the process. The steps are now a Map with the Array's rules.
// Synthetic events only.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTurnRecord } = require('./chat-interrupted-turn.cjs');

const record = (events) => {
  const r = createTurnRecord({ now: () => 1794571200000 });
  for (const ev of events) r.observe(ev);
  return r;
};

test('#2544: a huge tool-call index is listed in index order without walking holes', () => {
  const started = process.hrtime.bigint();
  const r = record([
    { type: 'tool', index: 4294967294, name: 'qa_last', args: '{}' },
    { type: 'tool', index: 0, name: 'qa_first', args: '{"q":1}' },
    { type: 'tool_result', index: 4294967294, name: 'qa_last', text: 'QA done' },
  ]);
  const entry = r.assistantEntry();
  r.partialEntry();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 1000, `listing took ${ms} ms`);
  assert.deepEqual(entry.toolCalls.map((c) => [c.name, c.status]), [['qa_first', 'stopped'], ['qa_last', 'done']]);
});

test('#2544: an index past the largest array index is a property, never listed or counted (as in an Array)', () => {
  const r = record([
    { type: 'tool', index: 4294967294, name: 'qa_last' },
    { type: 'tool', index: 4294967295, name: 'qa_property' },
    { type: 'tool', index: 1e21, name: 'qa_far' },
    // No index: the next element after the largest one, which is itself past the largest index (a property).
    { type: 'tool', name: 'qa_unindexed' },
  ]);
  assert.deepEqual(r.assistantEntry().toolCalls.map((c) => c.name), ['qa_last']);
});

test('#2544: steps without an index follow the Array rules (length, last element, first by name)', () => {
  const r = record([
    { type: 'tool', name: 'qa_a', args: '1' }, // at 0
    { type: 'tool', index: 3, name: 'qa_b', args: '2' }, // length 4
    { type: 'tool', name: 'qa_c', args: '3' }, // at 4
    { type: 'tool_pending', name: 'qa_c', args: '3' }, // at length - 1 = 4
    { type: 'tool_result', name: 'qa_b', text: 'QA b' }, // first by name: 3
    { type: 'tool_result', name: 'qa_missing', text: 'QA m' }, // none: at length = 5
  ]);
  assert.deepEqual(r.assistantEntry().toolCalls.map((c) => [c.name, c.status, c.args]), [
    ['qa_a', 'stopped', '1'], ['qa_b', 'done', '2'], ['qa_c', 'stopped', '3'], ['qa_missing', 'done', ''],
  ]);
});
