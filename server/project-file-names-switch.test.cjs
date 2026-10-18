'use strict';
// The project file-name resolver is always the Rust port (PROJECT_FILE_NAMES_IMPL retired, #1071).
// This file pins how the adapter turns the port's answers into results, with a stand-in for the
// port (no dav-parse.wasm needed; tests/server/project-file-names-differential.test.cjs runs the
// real module against the frozen answers), and that every doubt resolves nothing: a refusal, a
// fault, a bad reply or a retired switch value changes nothing (code 'unverified'), and the callers
// (project-edit-target planEdit) then change nothing. Synthetic project files only.
const test = require('node:test'), assert = require('node:assert/strict');
const pf = require('./project-file-names.cjs');
const davParseWasm = require('./dav-parse-wasm.cjs');

const project = { files: [null, { name: 'noevia projects/P/Text/notes.md' }, { name: 5 }, { name: 'a.md' }, { name: 'x/b.md' }, { name: 'y/b.md' }] };
const fault = () => { throw new davParseWasm.DavParseError('dav-parse module failed', 'trap'); };
function fakePort(answer) {
  const calls = [];
  return { calls, wasmLoader: () => ({ projectFileNames: (names, raw) => { calls.push([names, raw]); return answer(names, raw); } }) };
}
function quietly(fn) {
  const warn = console.warn, seen = [];
  console.warn = (m) => seen.push(String(m));
  try { return { value: fn(), seen }; } finally { console.warn = warn; }
}

test('the module exports only the resolver: no JS resolver, validator or switch remains', () => {
  assert.deepEqual(Object.keys(pf), ['resolveProjectFile']);
});

test('a file is the project\'s own object the port names; the port is sent the string names, in order, and the raw argument', () => {
  const port = fakePort(() => ({ file: 0 }));
  const r = pf.resolveProjectFile(project, ' notes.md ', port);
  assert.equal(r.file, project.files[1]);
  assert.deepEqual(port.calls, [[['noevia projects/P/Text/notes.md', 'a.md', 'x/b.md', 'y/b.md'], ' notes.md ']]);
  assert.equal(pf.resolveProjectFile(project, 'a.md', fakePort(() => ({ file: 1 }))).file, project.files[3]);
  assert.equal(pf.resolveProjectFile(project, 'a.md', fakePort(() => ({ file: 3 }))).file, project.files[5]);
});

test('the port\'s refusal codes become the model-readable errors', () => {
  const invalid = pf.resolveProjectFile(project, '../a.md', fakePort(() => ({ code: 'invalid', reason: 'a file name cannot contain empty, "." or ".." parts' })));
  assert.deepEqual(invalid, { code: 'invalid', error: '"../a.md" is not a usable project file name: a file name cannot contain empty, "." or ".." parts. Use a name exactly as listed.' });
  const missing = pf.resolveProjectFile(project, 'zzz', fakePort(() => ({ code: 'missing' })));
  assert.deepEqual(missing, { code: 'missing', error: 'no project file named "zzz". Available: noevia projects/P/Text/notes.md, a.md, x/b.md, y/b.md' });
  const ambiguous = pf.resolveProjectFile(project, 'b.md', fakePort(() => ({ code: 'ambiguous', candidates: [2, 3] })));
  assert.deepEqual(ambiguous, { code: 'ambiguous', candidates: ['x/b.md', 'y/b.md'],
    error: '"b.md" matches more than one project file: x/b.md, y/b.md. Pass the full name exactly as listed.' });
  assert.deepEqual(pf.resolveProjectFile(null, 'a.md', fakePort(() => ({ code: 'missing' }))),
    { code: 'missing', error: 'no project file named "a.md". Available: (none attached)' });
  // A non-string argument is shown as text; a long one is cut to 200 characters.
  assert.equal(pf.resolveProjectFile(project, undefined, fakePort(() => ({ code: 'invalid', reason: 'a file name is required' }))).error,
    '"" is not a usable project file name: a file name is required. Use a name exactly as listed.');
  assert.ok(pf.resolveProjectFile(project, 'x'.repeat(5000), fakePort(() => ({ code: 'missing' }))).error.startsWith(`no project file named "${'x'.repeat(200)}". Available:`));
});

test('every doubt resolves nothing: refusal, fault, bad reply, an input too large', () => {
  const tooLarge = () => { throw new davParseWasm.DavParseError('project file names input is too large', 'too_large'); };
  const refused = () => { throw new davParseWasm.DavParseError('refused', 'ambiguous'); };
  for (const answer of [fault, tooLarge, refused, () => { throw new Error('unexpected'); }]) {
    const { value: r, seen } = quietly(() => pf.resolveProjectFile(project, 'notes.md', fakePort(answer)));
    assert.equal(r.file, undefined);
    assert.equal(r.code, 'unverified');
    assert.match(r.error, /^"notes\.md" could not be confirmed as exactly one project file, so nothing was read or changed/);
    assert.ok(seen.length <= 1, 'logged at most once (an earlier test may have logged this reason already)');
    assert.ok(seen.every((m) => !m.includes('notes')), 'logged without names');
  }
  // The same reason is logged once.
  const again = quietly(() => pf.resolveProjectFile(project, 'notes.md', fakePort(fault)));
  assert.deepEqual(again.seen, []);
});

test('the retired switch changes nothing: the port is asked whatever PROJECT_FILE_NAMES_IMPL says', () => {
  const saved = process.env.PROJECT_FILE_NAMES_IMPL;
  try {
    for (const value of [undefined, '', 'js', 'wasm', 'on']) {
      if (value === undefined) delete process.env.PROJECT_FILE_NAMES_IMPL; else process.env.PROJECT_FILE_NAMES_IMPL = value;
      const port = fakePort(() => ({ file: 1 }));
      assert.equal(pf.resolveProjectFile(project, 'a.md', port).file, project.files[3], String(value));
      assert.equal(port.calls.length, 1, String(value));
    }
  } finally { if (saved === undefined) delete process.env.PROJECT_FILE_NAMES_IMPL; else process.env.PROJECT_FILE_NAMES_IMPL = saved; }
  assert.ok(!davParseWasm.IMPL_FLAGS.includes('PROJECT_FILE_NAMES_IMPL'));
  assert.equal(davParseWasm.RETIRED_FLAGS.PROJECT_FILE_NAMES_IMPL, 'wasm');
});

test('process.env drives planEdit: with a missing module nothing is edited, with or without the old switch', () => {
  const { planEdit } = require('./project-edit-target.cjs');
  const saved = { impl: process.env.PROJECT_FILE_NAMES_IMPL, file: process.env.DAV_PARSE_WASM };
  process.env.DAV_PARSE_WASM = '/nonexistent/dav-parse.wasm';
  try {
    for (const impl of [undefined, 'js', 'wasm']) {
      if (impl === undefined) delete process.env.PROJECT_FILE_NAMES_IMPL; else process.env.PROJECT_FILE_NAMES_IMPL = impl;
      davParseWasm.reset();
      const p = { id: 'p1', files: [{ name: 'a.md' }] };
      const { seen } = quietly(() => assert.throws(() => planEdit(p, 'a.md'), /could not be confirmed as exactly one project file/));
      assert.ok(seen.length >= 1 || impl !== undefined);
    }
  } finally {
    if (saved.impl === undefined) delete process.env.PROJECT_FILE_NAMES_IMPL; else process.env.PROJECT_FILE_NAMES_IMPL = saved.impl;
    if (saved.file === undefined) delete process.env.DAV_PARSE_WASM; else process.env.DAV_PARSE_WASM = saved.file;
    davParseWasm.reset();
  }
});
