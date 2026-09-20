'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { reduceToolResult, DEFAULT_MAX_CHARS } = require('./tool-result-reduce.cjs');

const listing = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({
  id: i, name: `file-${i}.md`, path: `/Notes/2026/file-${i}.md`,
  mime: 'text/markdown', etag: `etag-${i}`, comment: '', tags: [],
})));

test('a result under budget is passed through untouched', () => {
  const text = listing(3);
  const out = reduceToolResult(text);
  assert.equal(out.text, text);
  assert.equal(out.reduced, false);
  assert.equal(out.note, '');
});

test('a uniform array is hoisted to a header row and fits more records than truncation would', () => {
  const text = listing(200);
  const out = reduceToolResult(text);
  assert.ok(out.reduced);
  assert.ok(out.text.length <= DEFAULT_MAX_CHARS + out.note.length + 200);
  const lines = out.text.split('\n');
  const header = lines.find((l) => l.startsWith('id\t'));
  assert.equal(header, 'id\tname\tpath\tmime\tetag');
  // Keys empty in EVERY record are dropped, and the drop is stated.
  assert.ok(out.text.includes('comment'));
  assert.ok(out.text.includes('tags'));
  assert.ok(!header.includes('comment'));
  // More records survive than a blind character truncation would have kept.
  const rowsKept = Number(/showing (\d+) of 200/.exec(out.text)[1]);
  assert.ok(rowsKept > 64, `expected to beat blind truncation, kept ${rowsKept}`);
});

test('a key that is empty in only some records is kept', () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({
    id: i, blurb: 'x'.repeat(40), note: i === 0 ? 'only here' : '',
  }));
  const out = reduceToolResult(JSON.stringify(rows));
  assert.ok(out.text.split('\n').find((l) => l.startsWith('id\t')).includes('note'));
});

test('a ragged array is compacted rather than tabulated', () => {
  const rows = Array.from({ length: 300 }, (_, i) => (i % 2 ? { a: 'y'.repeat(30) } : 'a plain string'));
  const out = reduceToolResult(JSON.stringify(rows));
  assert.ok(out.reduced);
  assert.ok(!out.text.split('\n').some((l) => l.startsWith('a\t')));
  assert.ok(out.note.length > 0);
});

test('a single large object is compacted, dropping empty fields', () => {
  const obj = { kept: 'z'.repeat(9000), empty: '', nil: null, list: [], nested: { also_empty: '', real: 1 } };
  const out = reduceToolResult(JSON.stringify(obj));
  assert.ok(out.reduced);
  assert.ok(!out.text.includes('also_empty'));
  assert.ok(out.text.includes('real'));
  assert.ok(out.text.includes('chars]'), 'the long value says how much was cut');
});

test('false and 0 are information and are not treated as empty', () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({ id: i, ok: false, count: 0, pad: 'p'.repeat(30) }));
  const header = reduceToolResult(JSON.stringify(rows)).text.split('\n').find((l) => l.startsWith('id\t'));
  assert.ok(header.includes('ok'));
  assert.ok(header.includes('count'));
});

test('non-JSON output is truncated, never silently', () => {
  const text = 'a stack trace\n'.repeat(2000);
  const out = reduceToolResult(text);
  assert.ok(out.reduced);
  assert.ok(out.text.includes(`of ${text.length} characters`));
  assert.ok(out.note.startsWith('[truncated'));
});

test('nothing is ever dropped without a reported marker', () => {
  for (const input of [listing(200), 'x'.repeat(50000), JSON.stringify({ big: 'y'.repeat(60000) })]) {
    const out = reduceToolResult(input);
    assert.ok(out.reduced, 'over-budget input must report as reduced');
    assert.ok(out.note.length > 0, 'a reduced result must carry a note');
    assert.ok(out.text.includes(out.note.split('\n')[0]), 'the note must reach the model');
  }
});

test('tabs and newlines inside values cannot forge a column or a row', () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({ id: i, name: `a\tb\nc-${i}`, pad: 'q'.repeat(30) }));
  const out = reduceToolResult(JSON.stringify(rows));
  const header = out.text.split('\n').find((l) => l.startsWith('id\t'));
  const cols = header.split('\t').length;
  for (const line of out.text.split('\n')) {
    if (!/^\d+\t/.test(line)) continue;
    assert.equal(line.split('\t').length, cols, `row has wrong column count: ${line}`);
  }
});

test('a result that is already small stays byte-identical even if it is odd JSON', () => {
  for (const text of ['', 'ERROR: the user declined to run nc_notes_create_note.', '[]', 'null']) {
    assert.deepEqual(reduceToolResult(text), { text, reduced: false, note: '' });
  }
});
