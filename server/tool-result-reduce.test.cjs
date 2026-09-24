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

test('a reduced listing never exceeds the cap, including its own note', () => {
  // Found against the deployed container, not in a fixture: a 400-record
  // Nextcloud-shaped listing reduced to 8,037 characters against the 8,000
  // cap. The fitting loop measured the legend and the rows but not the
  // "showing N of M" note, which exists only when records are dropped — so
  // the cap was exceeded in precisely the case it was there to enforce.
  const rows = Array.from({ length: 400 }, (_, i) => ({
    path: `/Documents/Projects/folder-${i}/report-${i}.md`,
    fileid: 100000 + i,
    mtime: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T04:00:00Z`,
    size: 1000 + i * 37,
    mime: 'text/markdown',
    owner: 'sebastian',
    trashed: null,
    comment: '',
  }));
  const out = reduceToolResult(JSON.stringify(rows));
  assert.equal(out.reduced, true);
  assert.match(out.note, /omitted to fit/);
  assert.ok(out.text.length <= DEFAULT_MAX_CHARS,
    `reduced to ${out.text.length} characters, over the ${DEFAULT_MAX_CHARS} cap`);
});

test('the cap holds across a range of row counts and widths', () => {
  for (const count of [12, 40, 137, 400, 1500]) {
    for (const width of [40, 200]) {
      const rows = Array.from({ length: count }, (_, i) => ({
        id: i, name: 'x'.repeat(width), tag: 'row',
      }));
      const out = reduceToolResult(JSON.stringify(rows), { maxChars: 8000 });
      assert.ok(out.text.length <= 8000,
        `count=${count} width=${width} produced ${out.text.length}`);
    }
  }
});

test('fitting a long listing is linear and matches a re-render-everything reference', () => {
  // The fit used to re-tabulate the surviving rows on every step (quadratic; a
  // 500-record listing took ~50 ms of the reply's own time). It now renders once
  // and drops lines. The reference below is the old shape: for a given `kept`,
  // the body is exactly the header plus the first `kept` rendered rows.
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: i, title: `Row ${i}`, content: 'x'.repeat(20 + (i % 9) * 7), empty: null }));
  const out = reduceToolResult(JSON.stringify(rows), { maxChars: 8000 });
  const kept = Number(/showing (\d+) of 500/.exec(out.note)[1]);
  const lines = out.text.split('\n');
  assert.equal(lines.length, 2 + 1 + kept, 'legend, note, header, then exactly the kept rows');
  assert.deepEqual(lines.slice(3).map((l) => l.split('\t')[0]), rows.slice(0, kept).map((r) => String(r.id)));
  assert.ok(out.text.length <= 8000);
  // The old loop stopped at the FIRST kept that fits, so one more row cannot fit.
  const oneMore = out.text.length + lines[lines.length - 1].length + 1;
  assert.ok(oneMore > 8000, 'kept is the largest count that fits');
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) reduceToolResult(JSON.stringify(rows), { maxChars: 8000 });
  assert.ok((performance.now() - t0) / 20 < 10, 'well under the old 40-50 ms');
});

// #145: rows with thousands of distinct keys must not blow the cap through the legend or header.
test('an 8 MB listing of rows with thousands of distinct keys still fits the cap', () => {
  const rows = [];
  let size = 2;
  for (let r = 0; size < 8 * 1024 * 1024; r++) {
    const row = {};
    for (let k = 0; k < 400; k++) row[`key_${r}_${k}_${'x'.repeat(20)}`] = k % 2 ? `value-${r}-${k}` : '';
    const s = JSON.stringify(row); rows.push(s); size += s.length + 1;
  }
  const text = `[${rows.join(',')}]`;
  assert.ok(text.length >= 8 * 1024 * 1024);
  for (const maxChars of [DEFAULT_MAX_CHARS, 2000]) {
    const out = reduceToolResult(text, { maxChars });
    assert.ok(out.reduced);
    assert.ok(out.text.length <= maxChars, `${out.text.length} > ${maxChars}`);
    assert.match(out.text, /more|not shown|truncated/, 'the cut is stated, not silent');
    for (const line of out.note.split('\n')) assert.ok(out.text.includes(line), 'every note survives the cut');
  }
});

test('the omitted-keys legend is capped with a count of the rest', () => {
  const rows = Array.from({ length: 3 }, (_, i) => {
    const row = { id: i, name: `n${i}`.repeat(400) };
    for (let k = 0; k < 500; k++) row[`empty_${k}`] = '';
    return row;
  });
  const out = reduceToolResult(JSON.stringify(rows), { maxChars: 4000 });
  assert.ok(out.text.length <= 4000);
  assert.match(out.text, /500 column\(s\) omitted/);
  assert.match(out.text, /… \d+ more/);
  assert.ok(!out.text.includes('empty_499'));
});

test('when even one record overflows, the text is hard-sliced keeping the trailing note', () => {
  const rows = Array.from({ length: 2 }, (_, i) => ({ id: i, body: 'b'.repeat(1000) }));
  const out = reduceToolResult(JSON.stringify(rows), { maxChars: 400 });
  assert.ok(out.text.length <= 400, String(out.text.length));
  assert.match(out.text, /\[truncated: [^\]]*\]$/);
});
