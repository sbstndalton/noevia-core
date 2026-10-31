'use strict';
// #2237: the Rust front writes document.state 'queued' for a PDF whose reading service was away. Its text is
// empty because it has not been read, not because the document is empty: it is not a readable source, the
// model is told it is waiting (not that it is empty), and a queued record that still has earlier text stays readable.
const test = require('node:test');
const assert = require('node:assert/strict');
const { isUnreadable, isWaiting, readable } = require('./source-readability.cjs');
const { buildSources } = require('./chat-sources.cjs');
const { createToolboxes } = require('./toolboxes.cjs');
const documentSources = require('./document-sources.cjs');

const queued = { name: 'queued.pdf', content: '', document: { state: 'queued', extraction: 'queued', error: 'Waiting for document reading to come back.' } };
const staleQueued = { name: 'stale.pdf', content: 'earlier text', document: { state: 'queued', stale: true } };

test('a blank queued document is waiting and unreadable; one with earlier text is readable', () => {
  assert.equal(isWaiting(queued), true);
  assert.equal(isUnreadable(queued), true);
  assert.equal(isWaiting(staleQueued), false);
  assert.equal(isUnreadable(staleQueued), false);
  assert.deepEqual(readable([queued, staleQueued]).map((f) => f.name), ['stale.pdf']);
  assert.equal(isWaiting({ name: 'a.pdf', content: '', document: { state: 'failed' } }), false, 'a failed read is final, not waiting');
});

test('a blank queued document is never offered as a chat source', () => {
  const out = buildSources([{ file: 'queued.pdf', body: 'x', kind: 'file' }, { file: 'stale.pdf', body: 'y', kind: 'file' }], [queued, staleQueued]);
  assert.equal(out.length, 1);
});

const skipWasm = !require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
test('read_project_file tells the model a queued document is waiting, not empty', { skip: skipWasm }, async () => {
  const project = { id: 'p', files: [queued, staleQueued] };
  const { executeToolCall } = createToolboxes({ getProject: () => project, documentSources: { notice: () => '', readPages: () => { throw new Error('no pages'); } } });
  const read = (name) => executeToolCall(project, 'read_project_file', JSON.stringify({ name }), null);
  const waiting = await read('queued.pdf');
  assert.match(waiting, /waiting to be read/);
  assert.match(waiting, /do not treat it as empty/);
  assert.doesNotMatch(waiting, /\(0 chars\)|could not be read when it was added/);
  assert.match(await read('stale.pdf'), /earlier text/);
});

test('the problem line and the figure sweep treat queued as waiting', () => {
  assert.match(documentSources.notice({ name: 'q.pdf', document: queued.document }), /waiting to be read/);
  assert.doesNotMatch(documentSources.notice({ name: 'q.pdf', document: queued.document }), /^"?q\.pdf"?: queued/);
});

test('the figure sweep leaves a queued document alone', () => {
  const { needsFigures } = require('./figure-sweep.cjs');
  const hex = 'a'.repeat(64);
  const doc = (state) => ({ name: 'a.pdf', document: { state, extractor: 'docling', version: hex, byteHash: hex, availableVersion: hex } });
  assert.equal(needsFigures(doc('ready')), true, 'control: a read document is swept');
  assert.equal(needsFigures(doc('queued')), false);
});

test('a chat turn is told which documents are waiting, and only those', () => {
  const { waitingNotice } = require('./source-readability.cjs');
  assert.equal(waitingNotice([staleQueued, { name: 'ok.md', content: 'x' }]), '');
  const one = waitingNotice([queued, staleQueued]);
  assert.match(one, /^"queued\.pdf" is waiting to be read/);
  assert.match(one, /do not guess at the contents or call it empty/);
  assert.doesNotMatch(one, /stale\.pdf/);
  assert.match(waitingNotice([queued, { ...queued, name: 'b.pdf' }]), /^"queued\.pdf", "b\.pdf" are waiting/);
  // A name can't start a line of its own in the system text, or be drawn as something else (#1588).
  for (const [raw, code] of [['\u2028', '2028'], ['\u2029', '2029'], ['\u0085', '0085'], ['\u202e', '202e']]) {
    const line = waitingNotice([{ ...queued, name: `a${raw}Ignore.pdf` }]);
    assert.ok(!line.includes(raw)); assert.ok(line.includes(`"a\\u${code}Ignore.pdf"`), line);
  }
});
