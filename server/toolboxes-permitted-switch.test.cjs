'use strict';
// The toolbox ids a request carries apply the Rust port's answer (TOOLBOXES_PERMITTED_IMPL, retired in #1071), tested with a
// stand-in for the port (no dav-parse.wasm needed; tests/server/toolboxes-permitted-differential.test.cjs runs the real
// module). What is checked here is the host's side of the contract: the port decides which ids are carried; a fault, a
// refusal or a reply of another shape carries no id. (The per-turn view of permitted tools moved to the Rust front with
// sbstndalton/noevia#2202 round 2.) Synthetic accounts only.
const test = require('node:test'), assert = require('node:assert/strict');
const tp = require('./toolboxes-permitted.cjs');
const davParseWasm = require('./dav-parse-wasm.cjs');

const fault = () => { throw new davParseWasm.DavParseError('dav-parse module failed', 'trap'); };
function fakePort(answers = {}) {
  const calls = [];
  const fnOf = (name) => (...args) => { calls.push([name, args]); return (answers[name] || fault)(...args); };
  return { calls, loader: () => ({ toolboxesProjectIds: fnOf('project'), toolboxesSelectedIds: fnOf('selected'), toolboxesPermitted: fnOf('permitted') }) };
}
function quietly(fn) {
  const warn = console.warn, seen = [];
  console.warn = (m) => seen.push(String(m));
  try { return { value: fn(), seen }; } finally { console.warn = warn; }
}
test('carried ids are the port\'s string ids; a fault or a list that cannot be sent carries none', () => {
  const port = fakePort({ project: () => ({ ids: ['core', null, 'web'] }), selected: () => ({ ids: ['core', 'gmail', null] }) });
  assert.deepEqual(tp.projectToolboxIds({ toolboxes: ['core', 7, 'web'] }, ['core'], { wasmLoader: port.loader }), ['core', 'web']);
  assert.deepEqual(port.calls[0][1].slice(0, 2), [{ auto: false, docsDefaulted: false, toolboxes: ['core', null, 'web'] }, ['core']]);
  const sel = { project: null, defaultToolboxes: ['core'], connectorBoxes: new Set(['gmail']), connected: ['gmail'] };
  assert.deepEqual(tp.selectedToolboxIds(sel, { wasmLoader: port.loader }), ['core', 'gmail']);
  assert.deepEqual(port.calls[1][1].slice(3), [['gmail'], ['gmail']]);
  const { value } = quietly(() => [tp.projectToolboxIds({}, ['core'], { wasmLoader: fakePort().loader }), tp.selectedToolboxIds(sel, { wasmLoader: fakePort().loader }),
    tp.projectToolboxIds({}, 'core', { wasmLoader: port.loader }), tp.selectedToolboxIds({ ...sel, connectorBoxes: new Set([7]) }, { wasmLoader: port.loader }),
    tp.selectedToolboxIds({ ...sel, connected: 'gmail' }, { wasmLoader: port.loader })]);
  assert.deepEqual(value, [[], [], [], [], []]);
});

test('every fault is counted, logged at the 1st, 10th, 100th and 1000th time, without input, and bounded', () => {
  const lines = [];
  const warn = console.warn;
  console.warn = (m) => lines.push(String(m));
  try {
    const port = fakePort({ project: () => { throw new davParseWasm.DavParseError('x', 'count-test'); } });
    for (let i = 0; i < 1100; i++) tp.projectToolboxIds({ toolboxes: ['secret-box'] }, ['core'], { wasmLoader: port.loader });
    for (let i = 0; i < 300; i++) tp.projectToolboxIds({}, ['core'], { wasmLoader: fakePort({ project: () => { throw new davParseWasm.DavParseError('x', `bound-${i}`); } }).loader });
  } finally { console.warn = warn; }
  const counted = lines.filter((l) => l.includes('count-test'));
  assert.deepEqual(counted.map((l) => l.match(/\((\d+) times so far\)/)?.[1] ?? '1'), ['1', '10', '100', '1000']);
  assert.ok(counted.every((l) => /^\[toolboxes-permitted\] toolboxes_permitted\.wasm_fault \(count-test\); nothing was carried or permitted/.test(l) && !l.includes('secret-box')));
  assert.ok(lines.length < 260, 'a flood of distinct reasons stays bounded');
});

test('retired: the switch and the JS rules are gone', () => {
  assert.equal(davParseWasm.RETIRED_FLAGS.TOOLBOXES_PERMITTED_IMPL, 'wasm');
  assert.ok(!davParseWasm.IMPL_FLAGS.includes('TOOLBOXES_PERMITTED_IMPL'));
  for (const name of ['toolboxesPermittedImpl', 'computePermittedToolsJs', 'projectToolboxIdsJs', 'selectedToolboxIdsJs', 'mergeBox', 'computePermittedTools', 'permittedProjection', 'createTtlCache', 'createFingerprintedCache']) assert.equal(tp[name], undefined, name);
});

test('projections: what the port reads of the request', () => {
  assert.equal(tp.projectProjection(null), null);
  assert.deepEqual(tp.projectProjection({ toolsMode: 'auto', docsToolboxDefaulted: true, toolboxes: ['a', 3] }), { auto: true, docsDefaulted: true, toolboxes: ['a', null] });
  assert.deepEqual(tp.projectProjection({ toolsMode: 'AUTO', docsToolboxDefaulted: 'yes' }), { auto: false, docsDefaulted: false, toolboxes: null });
  assert.deepEqual(tp.idsProjection(['a', undefined, 5]), ['a', null, null]);
  assert.throws(() => tp.idsProjection('a'), /not a list/);
});
