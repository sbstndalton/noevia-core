'use strict';
// PROJECT_FILE_NAMES_IMPL: the switch and its fail-closed paths, with a stand-in for the Rust port
// (no dav-parse.wasm needed; tests/server/project-file-names-differential.test.cjs runs the real
// module). A name resolves only when the JS and the port resolve it to the same file; a JS refusal
// is returned without asking; any port refusal, fault, bad reply or other file resolves nothing
// (code 'unverified'), and the callers (project-edit-target planEdit) then change nothing.
// Synthetic project files only.
const test = require('node:test'), assert = require('node:assert/strict');
const pf = require('./project-file-names.cjs');
const davParseWasm = require('./dav-parse-wasm.cjs');

const project = { files: [null, { name: 'noevia projects/P/Text/notes.md' }, { name: 5 }, { name: 'a.md' }, { name: 'x/b.md' }, { name: 'y/b.md' }] };
const fault = () => { throw new davParseWasm.DavParseError('dav-parse module failed', 'trap'); };
function fakePort(answer) {
  const calls = [];
  return { calls, loader: () => ({ projectFileNames: (names, raw) => { calls.push([names, raw]); return answer(names, raw); } }) };
}
const wasm = (port) => ({ impl: 'wasm', wasmLoader: port.loader });
function quietly(fn) {
  const warn = console.warn, seen = [];
  console.warn = (m) => seen.push(String(m));
  try { return { value: fn(), seen }; } finally { console.warn = warn; }
}

test('PROJECT_FILE_NAMES_IMPL: default js, wasm when set, anything else js with one warning', () => {
  const { seen } = quietly(() => {
    assert.equal(pf.projectFileNamesImpl({}), 'js');
    assert.equal(pf.projectFileNamesImpl({ PROJECT_FILE_NAMES_IMPL: ' Wasm' }), 'wasm');
    assert.equal(pf.projectFileNamesImpl({ PROJECT_FILE_NAMES_IMPL: 'on' }), 'js');
    assert.equal(pf.projectFileNamesImpl({ PROJECT_FILE_NAMES_IMPL: 'on' }), 'js');
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /PROJECT_FILE_NAMES_IMPL="on" is not js or wasm; using js/);
  assert.ok(davParseWasm.IMPL_FLAGS.includes('PROJECT_FILE_NAMES_IMPL'), 'a missing or tampered module stops startup');
});

test('a name resolves only when the port names the same file; it is sent the string names, in order', () => {
  const port = fakePort(() => ({ file: 0 }));
  const r = pf.resolveProjectFile(project, ' notes.md ', wasm(port));
  assert.equal(r.file, project.files[1]);
  assert.deepEqual(port.calls, [[['noevia projects/P/Text/notes.md', 'a.md', 'x/b.md', 'y/b.md'], ' notes.md ']]);
  assert.equal(pf.resolveProjectFile(project, 'a.md', wasm(fakePort(() => ({ file: 1 })))).file, project.files[3]);
});

test('any doubt resolves nothing: refusal, fault, another file, a refusal code', () => {
  for (const answer of [fault, () => ({ file: 1 }), () => ({ code: 'missing' }), () => ({ code: 'ambiguous', candidates: [0, 1] }),
    () => { throw new davParseWasm.DavParseError('refused', 'ambiguous'); }]) {
    const { value: r, seen } = quietly(() => pf.resolveProjectFile(project, 'notes.md', wasm(fakePort(answer))));
    assert.equal(r.file, undefined);
    assert.equal(r.code, 'unverified');
    assert.match(r.error, /^"notes\.md" could not be confirmed as exactly one project file/);
    assert.ok(seen.every((m) => !m.includes('notes')), 'logged without names');
  }
});

test('JS refusals are returned as is, without asking the port', () => {
  const port = fakePort(fault);
  for (const raw of ['../a.md', 'b.md', 'zzz', 5, undefined]) {
    assert.deepEqual(pf.resolveProjectFile(project, raw, wasm(port)), pf.resolveProjectFileJs(project, raw));
  }
  assert.deepEqual(pf.resolveProjectFile(null, 'a.md', wasm(port)), pf.resolveProjectFileJs(null, 'a.md'));
  assert.equal(port.calls.length, 0);
});

test('js (the default) never asks the port', () => {
  const port = fakePort(fault);
  assert.equal(pf.resolveProjectFile(project, 'a.md', { wasmLoader: port.loader, env: {} }).file, project.files[3]);
  assert.equal(port.calls.length, 0);
});

test('process.env drives planEdit: under wasm with a missing module nothing is edited', () => {
  const { planEdit } = require('./project-edit-target.cjs');
  const saved = { impl: process.env.PROJECT_FILE_NAMES_IMPL, file: process.env.DAV_PARSE_WASM };
  process.env.PROJECT_FILE_NAMES_IMPL = 'wasm';
  process.env.DAV_PARSE_WASM = '/nonexistent/dav-parse.wasm';
  davParseWasm.reset();
  try {
    const p = { id: 'p1', files: [{ name: 'a.md' }] };
    const { seen } = quietly(() => assert.throws(() => planEdit(p, 'a.md'), /could not be confirmed as exactly one project file/));
    assert.ok(seen.length >= 1);
  } finally {
    if (saved.impl === undefined) delete process.env.PROJECT_FILE_NAMES_IMPL; else process.env.PROJECT_FILE_NAMES_IMPL = saved.impl;
    if (saved.file === undefined) delete process.env.DAV_PARSE_WASM; else process.env.DAV_PARSE_WASM = saved.file;
    davParseWasm.reset();
  }
});
