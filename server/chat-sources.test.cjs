'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { buildSources, sanitizeStored, sanitizeHistory, MAX_SOURCES, SNIPPET_MAX } = require('./chat-sources.cjs');

test('buildSources keeps prompt order, bounds snippets and count, and drops files outside the project', () => {
  const files = Array.from({ length: 30 }, (_, i) => ({ name: `n${i}.md`, content: '' }));
  const entries = [{ file: 'foreign.md', body: 'x', kind: 'excerpt' }, ...files.map((f) => ({ file: f.name, body: 'w '.repeat(500), kind: 'excerpt', score: 0.5 }))];
  const out = buildSources(entries, files);
  assert.equal(out.length, MAX_SOURCES);
  assert.equal(out[0].file, 'n0.md');
  assert.ok(out.every((s) => s.snippet.length <= SNIPPET_MAX));
  assert.equal(out.some((s) => s.file === 'foreign.md'), false);
  assert.deepEqual(buildSources(null, files), []);
});

test('sanitizeStored rejects malformed entries and clamps fields', () => {
  assert.equal(sanitizeStored('x'), undefined);
  assert.equal(sanitizeStored([{ snippet: 'no file' }]), undefined);
  const [s] = sanitizeStored([{ file: 'a.md', snippet: 'y'.repeat(999), score: 'high', kind: 'weird', extra: 'drop' }]);
  assert.deepEqual(Object.keys(s).sort(), ['file', 'id', 'kind', 'snippet']);
  assert.equal(s.kind, 'file');
  assert.equal(s.id, 'a.md');
});

test('sanitizeHistory leaves untouched entries alone and strips sources from user turns', () => {
  const plain = { role: 'assistant', content: 'a', reasoning: 'r' };
  const [a, b] = sanitizeHistory([plain, { role: 'user', content: 'u', sources: [{ file: 'a.md' }] }]);
  assert.equal(a, plain);
  assert.equal('sources' in b, false);
});

test('sanitizeHistory keeps only an exact skill pin on user turns (#571)', () => {
  const pin = `skill_${'0'.repeat(32)}@${'f'.repeat(64)}`;
  const out = sanitizeHistory([{ role: 'user', content: 'u', skill: pin }, { role: 'assistant', content: 'a', skill: pin }, { role: 'user', content: 'u', skill: 'skill_1@2' }]);
  assert.equal(out[0].skill, pin);
  assert.equal('skill' in out[1], false);
  assert.equal('skill' in out[2], false);
});

function load(hits, ragAvailable, extra = {}) {
  const src = fs.readFileSync(require.resolve('./rag.cjs'), 'utf8');
  const body = src.slice(src.indexOf('async function filesContext('), src.indexOf('\nmodule.exports'));
  const context = { DIRECT_INJECT_MAX: 2400, FILES_CONTEXT_MAX_CHARS: 120000, LARGE_FILE_HEAD: 24000, documentNotice: () => '',
    frameUntrusted: require('./prompt-framing.cjs').frameUntrusted, ...require('./quoted-name.cjs'), ragAvailable: () => ragAvailable, searchProject: async () => hits, ...extra };
  vm.createContext(context); vm.runInContext(body, context);
  return context;
}

test('filesContext reports retrieved excerpts (with score) and whole small files, and only files the caller may read', async () => {
  const files = [{ name: 'small.md', content: 'tiny note' }, { name: 'big.txt', content: 'Z'.repeat(5000) }];
  let placed = null;
  const text = await load([{ file: 'big.txt', body: 'EXCERPT', score: 0.7 }, { file: 'gone.md', body: 'STALE', score: 0.9 }], true)
    .filesContext('p', files, 'q small.md', 'tenant', (p) => { placed = p; });
  assert.deepEqual(Array.from(placed, (p) => [p.file, p.kind, p.score]), [['big.txt', 'excerpt', 0.7], ['small.md', 'file', undefined]]);
  assert.ok(!text.includes('STALE'));
});

test('#1457: a whole file the question does not name is injected but not reported as a source', async () => {
  const files = [{ name: 'small.md', content: 'tiny note' }, { name: 'big.txt', content: 'Z'.repeat(5000) }];
  let placed = null;
  const text = await load([], false).filesContext('p', files, 'Name three colours of the rainbow', 'tenant', (p) => { placed = p; });
  assert.match(text, /label="small\.md"/, 'still in the prompt');
  assert.equal(placed.length, 0, 'no source chip for a file the question did not name');
});

test('#1457/#1513: an unnamed file head is not a reported source but is reported as injected', async () => {
  const files = [{ name: 'small.md', content: 'tiny note' }, { name: 'big.txt', content: 'Z'.repeat(30000) }];
  let placed = null, injected = null;
  const text = await load([], false).filesContext('p', files, 'Is HERON-9001 anywhere?', 't', (p, i) => { placed = p; injected = i; });
  assert.match(text, /label="big\.txt"/, 'the head of the large file is in the prompt');
  assert.equal(placed.length, 0, 'neither file is named, so neither is a source chip');
  assert.deepEqual(Array.from(injected, (e) => [e.file, e.kind, e.body.length]), [['small.md', 'file', 9], ['big.txt', 'file', 24000]]);
  const { partialSources } = require('./source-coverage.cjs');
  assert.deepEqual(partialSources(files, injected), [{ name: 'big.txt', length: 30000, read: 24000 }], 'the head counts as read');
});

test('without retrieval the fallback heads that reach the prompt are reported; omitted files are not', async () => {
  const files = [{ name: 'big.txt', content: 'Z'.repeat(5000) }, { name: 'huge.txt', content: 'Y'.repeat(5000) }];
  let placed = null;
  await load([], false, { FILES_CONTEXT_MAX_CHARS: 5300 }).filesContext('p', files, 'q big.txt huge.txt', 't', (p) => { placed = p; });
  assert.equal(placed.length, 1, 'the file that did not fit the prompt budget is not claimed as a source');
  assert.equal(placed[0].kind, 'file');
});

test('a throwing onSources hook never breaks the prompt', async () => {
  const text = await load([], false).filesContext('p', [{ name: 'a.md', content: 'x' }], 'q', 't', () => { throw new Error('boom'); });
  assert.match(text, /Sources attached/);
});

test('#1616: skill pins and sources inside stored alternatives are cleaned by the same rules as the turn itself', () => {
  const pin = `skill_${'1'.repeat(32)}@${'e'.repeat(64)}`;
  const long = 'z'.repeat(999);
  const bad = { id: 'x', file: 'a.md', snippet: long, kind: 'weird', score: 'high', extra: 'drop' };
  const [turn] = sanitizeHistory([{
    role: 'user', content: 'q', skill: pin,
    answers: [{ content: 'a1', sources: [bad], skill: pin }, { content: 'a2', sources: 'junk' }],
    answer: 0,
    branches: [
      { content: 'v0', skill: { label: 'not a pin' }, sources: [bad], answers: [{ content: 'va', sources: [bad, { snippet: 'no file' }] }], answer: 0,
        tail: [
          { role: 'user', content: 't-u', skill: 'skill_1@2', sources: [bad] },
          { role: 'assistant', content: 't-a', skill: pin, sources: [bad, { snippet: 'no file' }], answers: [{ content: 'ta1', sources: [bad] }], answer: 0 },
        ] },
      { content: 'v1', skill: pin, tail: [] },
    ],
    branch: 1,
  }]);
  assert.equal(turn.skill, pin);
  assert.equal(turn.answers[0].sources.length, 1);
  assert.equal(turn.answers[0].sources[0].snippet.length <= SNIPPET_MAX, true, 'answer sources are re-bounded');
  assert.deepEqual(Object.keys(turn.answers[0].sources[0]).sort(), ['file', 'id', 'kind', 'snippet']);
  assert.equal('skill' in turn.answers[0], false, 'a pin is never kept on an assistant reply');
  assert.equal('sources' in turn.answers[1], false);
  const [v0, v1] = turn.branches;
  assert.equal('skill' in v0, false, 'a malformed pin on a version is dropped');
  assert.equal('sources' in v0, false, 'sources are never kept on a user version');
  assert.equal(v1.skill, pin, 'an exact pin on a version stays');
  assert.equal(v0.answers[0].sources.length, 1);
  assert.equal(v0.answers[0].sources[0].file, 'a.md');
  const [tu, ta] = v0.tail;
  assert.equal('skill' in tu, false);
  assert.equal('sources' in tu, false);
  assert.equal('skill' in ta, false);
  assert.equal(ta.sources.length, 1);
  assert.equal(ta.sources[0].snippet.length <= SNIPPET_MAX, true);
  assert.equal(ta.answers[0].sources[0].snippet.length <= SNIPPET_MAX, true);
});

test('#1616: a tail without variants of its own is cleaned too, and a clean history is returned untouched', () => {
  const pin = `skill_${'2'.repeat(32)}@${'d'.repeat(64)}`;
  const [turn] = sanitizeHistory([{ role: 'user', content: 'q', branches: [{ content: 'v', tail: [{ role: 'user', content: 'u', skill: 'bad' }] }], branch: 0 }]);
  assert.equal('skill' in turn.branches[0].tail[0], false);
  const clean = { role: 'user', content: 'q', skill: pin, answers: [{ content: 'a' }], answer: 0, branches: [{ content: 'v', skill: pin, tail: [{ role: 'assistant', content: 'r' }] }], branch: 0 };
  assert.equal(sanitizeHistory([clean])[0], clean);
});

test('an excerpt cut from a document page reports that page (#1866)', () => {
  const files = [{ name: 'report.pdf', content: '' }, { name: 'notes.md', content: '' }];
  const out = buildSources([
    { file: 'report.pdf', body: '[Page 7]\nSynthetic quarterly figures.', kind: 'excerpt', score: 0.8 },
    { file: 'report.pdf', body: 'No marker here. [Page 9] mid-text is not a page.', kind: 'excerpt' },
    { file: 'notes.md', body: '[Page 3]\nA whole file is not a page citation.', kind: 'file' },
    { file: 'report.pdf', body: '[Page 0]\nout of range', kind: 'excerpt' },
    { file: 'report.pdf', body: '[Page 99999999]\ntoo many digits', kind: 'excerpt' },
  ], files);
  assert.equal(out[0].page, 7);
  assert.match(out[0].snippet, /Synthetic quarterly figures/);
  assert.equal('page' in out[1], false);
  assert.equal('page' in out[2], false);
  assert.equal('page' in out[3], false);
  assert.equal('page' in out[4], false);
});

test('a stored page survives only as a plain page number on an excerpt (#1866)', () => {
  const stored = sanitizeStored([
    { file: 'a.pdf', snippet: 's', kind: 'excerpt', page: 4 },
    { file: 'b.pdf', snippet: 's', kind: 'excerpt', page: '4' },
    { file: 'c.pdf', snippet: 's', kind: 'excerpt', page: 2.5 },
    { file: 'd.pdf', snippet: 's', kind: 'excerpt', page: -1 },
    { file: 'e.pdf', snippet: 's', kind: 'file', page: 4 },
  ]);
  assert.equal(stored[0].page, 4);
  for (const s of stored.slice(1)) assert.equal('page' in s, false);
});
