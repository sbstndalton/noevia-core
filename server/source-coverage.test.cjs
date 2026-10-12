const test = require('node:test'), assert = require('node:assert/strict');
const { partialSources, coverageNote, coverageWarning } = require('./source-coverage.cjs');

// A synthetic stand-in for a 2 MB text file whose end marker is on its last line.
const BIG = 'lorem ipsum '.repeat(170000) + 'LARGE FILE END MARKER: HERON-9001';
const small = { name: 'notes.md', content: 'short note' };
const big = { name: 'qa_large.txt', content: BIG };

test('#1513: a large source with only excerpts placed is reported partial, with what was read', () => {
  const placed = [{ file: 'qa_large.txt', body: 'excerpt one '.repeat(40) }, { file: 'qa_large.txt', body: 'excerpt two '.repeat(40) }];
  const partial = partialSources([small, big], placed);
  assert.equal(partial.length, 1);
  assert.equal(partial[0].name, 'qa_large.txt');
  assert.equal(partial[0].length, BIG.length);
  assert.equal(partial[0].read, placed[0].body.length + placed[1].body.length);
});

test('#1513: a large source that was not placed at all is partial with nothing read', () => {
  assert.deepEqual(partialSources([big], []), [{ name: 'qa_large.txt', length: BIG.length, read: 0 }]);
});

test('#1513: a source placed whole, and a small source, are not reported', () => {
  const whole = { name: 'mid.txt', content: 'x'.repeat(3000) };
  assert.deepEqual(partialSources([whole], [{ file: 'mid.txt', body: whole.content }]), []);
  assert.deepEqual(partialSources([small], []), [], 'a file at or under the whole-placement limit is never partial');
});

test('#1513: the model is told the source was cut and not to answer "absent" from the part read; the user sees the same numbers', () => {
  const partial = [{ name: 'qa_large.txt', length: BIG.length, read: 24000 }];
  const note = coverageNote(partial);
  assert.match(note, /Source text was truncated for this reply: "qa_large\.txt" is 2,\d{3},\d{3} characters long and this reply read only 24,000 characters/);
  assert.match(note, /Do not say that some text is absent from a file, or answer "no"/);
  assert.match(note, /read_project_file with an offset/);
  const warning = coverageWarning(partial);
  assert.match(warning, /Only part of "qa_large\.txt" was read for this reply \(24,000 of 2,\d{3},\d{3} characters\)/);
});

test('#1513: nothing is said when every source was read in full', () => {
  assert.equal(coverageNote([]), '');
  assert.equal(coverageWarning([]), '');
  assert.equal(coverageNote(undefined), '');
});
