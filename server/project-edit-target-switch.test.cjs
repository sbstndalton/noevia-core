'use strict';
// PROJECT_EDIT_TARGET_IMPL with a stand-in port: the switch's reading, and that the port can only
// make planEdit (and so the chat loop's approval card and the Project documents edit tools) refuse
// more: a mismatch, a fault, a bad reply or an unprojectable project refuses the edit with a
// model-readable error, never plans another file or path. All projects are synthetic.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// classify from the upload-sniff test oracle, so no WebAssembly module is needed here.
require('./upload-sniff.cjs').classify = require(path.join(__dirname, '..', 'tests', 'server', 'oracle', 'upload-sniff.cjs')).classifyJs;
const et = require('./project-edit-target.cjs');

const WASM = { PROJECT_EDIT_TARGET_IMPL: 'wasm' };
const F = 'noevia projects/Alpha';

function quietly(fn) {
  const warn = console.warn, seen = [];
  console.warn = (m) => seen.push(String(m));
  try { return { value: fn(), seen }; } finally { console.warn = warn; }
}
/** A port that answers as the JS does, with `over` replacing its answer. */
function standIn(over, calls = []) {
  return () => ({
    projectEditTarget(input) {
      calls.push(input);
      if (over) return over(input);
      const [, , , index] = input;
      return { plan: 'see below', index };
    },
  });
}
/** The JS's own plan, as the port gives it. */
const faithful = (project, raw, account) => () => {
  const p = et.planEditJs(project, raw, { storageAccount: account });
  return { plan: { write: p.writeName, target: p.target, adopt: p.adopt } };
};
const projects = {
  upload: { projectFolder: F, files: [{ name: `${F}/Text/notes.md`, source: F, attachment: { id: 'a', state: 'ready', group: 'Text' }, content: 'x' }] },
  local: { files: [{ name: 'local.md', content: 'x' }] },
  adopt: { projectFolder: F, files: [{ name: 'plain.md', content: 'x' }, { name: `${F}/Text/other.md` }] },
};

test('PROJECT_EDIT_TARGET_IMPL: js by default, wasm read trimmed and case-folded, anything else js with one warning', () => {
  assert.equal(et.projectEditTargetImpl({}), 'js');
  assert.equal(et.projectEditTargetImpl({ PROJECT_EDIT_TARGET_IMPL: '' }), 'js');
  assert.equal(et.projectEditTargetImpl({ PROJECT_EDIT_TARGET_IMPL: ' WASM ' }), 'wasm');
  assert.equal(et.projectEditTargetImpl({ PROJECT_EDIT_TARGET_IMPL: 'js' }), 'js');
  const r = quietly(() => [et.projectEditTargetImpl({ PROJECT_EDIT_TARGET_IMPL: 'rust' }), et.projectEditTargetImpl({ PROJECT_EDIT_TARGET_IMPL: 'rust' })]);
  assert.deepEqual(r.value, ['js', 'js']);
  assert.equal(r.seen.length, 1);
  assert.match(r.seen[0], /PROJECT_EDIT_TARGET_IMPL="rust" is not js or wasm; using js/);
});

test('js (the default) never loads the port', () => {
  const loader = () => { throw new Error('must not load'); };
  for (const env of [{}, { PROJECT_EDIT_TARGET_IMPL: 'js' }]) {
    const p = et.planEdit(projects.upload, 'notes.md', { env, wasmLoader: loader });
    assert.equal(p.target, `${F}/Text/notes.md`);
  }
});

test('wasm: the plan stands when the port gives the identical one, for every kind of editable file', () => {
  for (const [kind, raw, account] of [['upload', 'notes.md', null], ['local', 'local.md', null], ['adopt', 'plain.md', 'acct-1']]) {
    const calls = [];
    const p = et.planEdit(projects[kind], raw, { env: WASM, storageAccount: account, wasmLoader: standIn(faithful(projects[kind], raw, account), calls) });
    assert.deepEqual(p, et.planEditJs(projects[kind], raw, { storageAccount: account }), kind);
    assert.equal(calls.length, 1);
  }
  // The request is editTargetInput: folders, connected, the index, every name, the file's projection.
  const calls = [];
  et.planEdit(projects.adopt, 'plain.md', { env: WASM, storageAccount: 'acct-1', wasmLoader: standIn(faithful(projects.adopt, 'plain.md', 'acct-1'), calls) });
  assert.deepEqual(calls[0], [F, null, true, 0, ['plain.md', `${F}/Text/other.md`], [null, null, false]]);
});

test('wasm: a JS refusal is thrown as is and the port is not asked', () => {
  const calls = [];
  const project = { files: [{ name: 'a.md', source: 'Attached folder' }, { name: 'doc.pdf', document: { state: 'ready' } }] };
  for (const raw of ['a.md', 'doc.pdf', 'missing.md', '../x']) {
    let js;
    try { et.planEditJs(project, raw); } catch (err) { js = err.message; }
    assert.throws(() => et.planEdit(project, raw, { env: WASM, wasmLoader: standIn(null, calls) }), { message: js });
  }
  assert.equal(calls.length, 0);
});

test('wasm: a different plan, a refusal, a fault or a bad reply refuses the edit (logged once per reason, name-free)', () => {
  const p = et.planEditJs(projects.adopt, 'plain.md', { storageAccount: 'acct-1' });
  const answers = [
    () => ({ plan: { write: p.writeName, target: 'noevia projects/Other/Text/plain.md', adopt: true } }),
    () => ({ plan: { write: 'other.md', target: p.target, adopt: true } }),
    () => ({ plan: { write: p.writeName, target: p.target, adopt: false } }),
    () => ({ refused: 'taken' }),
    () => ({ refused: 'taken' }),
    () => { throw Object.assign(new Error('module missing'), { reason: 'missing' }); },
    () => { throw new TypeError('boom'); },
    () => null,
    () => ({}),
  ];
  const r = quietly(() => answers.map((a) => {
    assert.throws(() => et.planEdit(projects.adopt, 'plain.md', { env: WASM, storageAccount: 'acct-1', wasmLoader: standIn(a) }),
      { message: '"plain.md" could not be confirmed as a file that can be edited in place, so nothing was changed. Ask again, or use project_create_file to write a new file.' });
    return true;
  }));
  assert.equal(r.value.length, answers.length);
  assert.deepEqual(r.seen, [
    '[project-edit-target] project_edit_target.impl_mismatch (plan); the edit was refused',
    '[project-edit-target] project_edit_target.impl_mismatch (taken); the edit was refused',
    '[project-edit-target] project_edit_target.wasm_fault (missing); the edit was refused',
    '[project-edit-target] project_edit_target.wasm_fault (unexpected); the edit was refused',
    '[project-edit-target] project_edit_target.impl_mismatch (reply); the edit was refused',
  ]);
  for (const line of r.seen) assert.ok(!line.includes('plain.md'));
});

test('wasm: a project the port cannot be given (a folder or source that is not a string) is refused without asking', () => {
  const calls = [];
  for (const project of [{ reservedFolder: 5, files: [{ name: 'a.md' }] }, { projectFolder: ['x'], files: [{ name: 'a.md' }] }]) {
    assert.ok(et.planEditJs(project, 'a.md'));
    const r = quietly(() => assert.throws(() => et.planEdit(project, 'a.md', { env: WASM, wasmLoader: standIn(null, calls) }), /could not be confirmed/));
    assert.ok(r.seen.length <= 1);
  }
  assert.equal(calls.length, 0);
  // Falsy non-strings are no folder or source at all, as in the JS.
  assert.deepEqual(et.editTargetInput({ projectFolder: '', reservedFolder: 0, files: [{ name: 'a.md', source: false, attachment: { state: 5 } }] },
    { name: 'a.md' }, null), null);
  const project = { projectFolder: '', reservedFolder: 0, files: [null, { name: 7 }, { name: 'a.md', source: false, attachment: { state: 5, group: 'Text' }, document: '' }] };
  assert.deepEqual(et.editTargetInput(project, project.files[2], ''), [null, null, false, 2, [null, null, 'a.md'], [null, [null, 'Text'], false]]);
});

test('resolveEditTarget (the chat loop) under wasm: the card gets the error, never a path the port did not confirm', () => {
  const r = quietly(() => et.resolveEditTarget(projects.adopt, JSON.stringify({ name: 'plain.md' }), { storageAccount: 'acct-1', env: WASM, wasmLoader: standIn(() => ({ refused: 'not_text' })) }));
  assert.ok(r.value.error && /could not be confirmed/.test(r.value.error));
  assert.equal(r.value.path, undefined);
  const ok = et.resolveEditTarget(projects.adopt, JSON.stringify({ name: 'plain.md' }), { storageAccount: 'acct-1', env: WASM, wasmLoader: standIn(faithful(projects.adopt, 'plain.md', 'acct-1')) });
  assert.deepEqual(ok, { path: `${F}/Text/plain.md`, account: 'acct-1' });
});

test('the switch is read from process.env by default, so every caller (chat loop, edit tools) is switched', () => {
  const davParseWasm = require('./dav-parse-wasm.cjs');
  const saved = { env: process.env.PROJECT_EDIT_TARGET_IMPL, fn: davParseWasm.projectEditTarget };
  const calls = [];
  davParseWasm.projectEditTarget = (input) => { calls.push(input); return { refused: 'partial' }; };
  process.env.PROJECT_EDIT_TARGET_IMPL = 'wasm';
  try {
    const r = quietly(() => et.resolveEditTarget(projects.local, JSON.stringify({ name: 'local.md' })));
    assert.match(r.value.error, /could not be confirmed/);
    assert.equal(calls.length, 1);
  } finally {
    davParseWasm.projectEditTarget = saved.fn;
    if (saved.env === undefined) delete process.env.PROJECT_EDIT_TARGET_IMPL; else process.env.PROJECT_EDIT_TARGET_IMPL = saved.env;
  }
});
