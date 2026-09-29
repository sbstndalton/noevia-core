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
    frameUntrusted: require('./prompt-framing.cjs').frameUntrusted, ragAvailable: () => ragAvailable, searchProject: async () => hits, ...extra };
  vm.createContext(context); vm.runInContext(body, context);
  return context;
}

test('filesContext reports retrieved excerpts (with score) and whole small files, and only files the caller may read', async () => {
  const files = [{ name: 'small.md', content: 'tiny note' }, { name: 'big.txt', content: 'Z'.repeat(5000) }];
  let placed = null;
  const text = await load([{ file: 'big.txt', body: 'EXCERPT', score: 0.7 }, { file: 'gone.md', body: 'STALE', score: 0.9 }], true)
    .filesContext('p', files, 'q', 'tenant', (p) => { placed = p; });
  assert.deepEqual(Array.from(placed, (p) => [p.file, p.kind, p.score]), [['big.txt', 'excerpt', 0.7], ['small.md', 'file', undefined]]);
  assert.ok(!text.includes('STALE'));
});

test('without retrieval the fallback heads that reach the prompt are reported; omitted files are not', async () => {
  const files = [{ name: 'big.txt', content: 'Z'.repeat(5000) }, { name: 'huge.txt', content: 'Y'.repeat(5000) }];
  let placed = null;
  await load([], false, { FILES_CONTEXT_MAX_CHARS: 5300 }).filesContext('p', files, 'q', 't', (p) => { placed = p; });
  assert.equal(placed.length, 1, 'the file that did not fit the prompt budget is not claimed as a source');
  assert.equal(placed[0].kind, 'file');
});

test('a throwing onSources hook never breaks the prompt', async () => {
  const text = await load([], false).filesContext('p', [{ name: 'a.md', content: 'x' }], 'q', 't', () => { throw new Error('boom'); });
  assert.match(text, /Sources attached/);
});
