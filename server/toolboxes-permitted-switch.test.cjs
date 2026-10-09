'use strict';
// TOOLBOXES_PERMITTED_IMPL: the switch and its strict paths, with a stand-in for the Rust port (no
// dav-parse.wasm needed; tests/server/toolboxes-permitted-differential.test.cjs runs the real
// module). The port can only offer less: a box id is carried only if both carry it, a box is
// available or active only if both say so, a tool's permission is the stricter one; a fault or a
// reply of another shape carries no box and shows everything unavailable. The callbacks are
// recorded during the JS run, never called twice. Synthetic accounts and boxes only.
const test = require('node:test'), assert = require('node:assert/strict');
const tp = require('./toolboxes-permitted.cjs');
const davParseWasm = require('./dav-parse-wasm.cjs');

const WASM = { TOOLBOXES_PERMITTED_IMPL: 'wasm' };
const fault = () => { throw new davParseWasm.DavParseError('dav-parse module failed', 'trap'); };
function fakePort(answers = {}) {
  const calls = [];
  const fnOf = (name) => (...args) => { calls.push([name, args]); return (answers[name] || fault)(...args); };
  return { calls, loader: () => ({ toolboxesProjectIds: fnOf('project'), toolboxesSelectedIds: fnOf('selected'), toolboxesPermitted: fnOf('permitted') }) };
}
const wasm = (port) => ({ env: WASM, wasmLoader: port.loader });
function quietly(fn) {
  const warn = console.warn, seen = [];
  console.warn = (m) => seen.push(String(m));
  try { return { value: fn(), seen }; } finally { console.warn = warn; }
}
const tool = (name) => ({ type: 'function', function: { name, description: `${name} (synthetic)` } });
function input(over = {}) {
  const counts = { ready: 0, write: 0, policy: 0 };
  return {
    counts,
    input: {
      user: { id: 'u1', role: 'admin' }, project: { id: 'p1', toolboxes: ['core', 'web'] }, mode: 'cowork',
      boxes: [{ id: 'core', label: 'Core', tools: [tool('read_file'), tool('write_file')] }, { id: 'web', label: 'Web', tools: [tool('web_search')] },
        { id: 'sso', label: 'SSO', tools: [tool('sso_read')] }],
      manifest: [{ id: 'down' }], defaultToolboxes: ['core'], connectorBoxes: new Set(['gmail']), connected: [], oauthServerIds: new Set(['sso']),
      accountReady: () => { counts.ready++; return true; }, isWriteTool: (n) => { counts.write++; return n === 'write_file'; },
      policyMode: (_u, t) => { counts.policy++; return t === 'web_search' ? 'ask' : 'allow'; },
      diaryEnabled: true, harnessEnabled: true, repositories: ['r1'], ...over,
    },
  };
}
const asPort = (boxes) => ({ boxes: boxes.map((b) => ({ id: typeof b.id === 'string' ? b.id : null, state: b.state, reasonCode: b.reasonCode, active: b.active,
  tools: b.tools.map((t) => ({ permission: t.permission, reasonCode: t.reasonCode })) })) });

test('TOOLBOXES_PERMITTED_IMPL: default js, wasm when set, anything else js with one warning', () => {
  const { seen } = quietly(() => {
    assert.equal(tp.toolboxesPermittedImpl({}), 'js');
    assert.equal(tp.toolboxesPermittedImpl({ TOOLBOXES_PERMITTED_IMPL: ' Wasm' }), 'wasm');
    assert.equal(tp.toolboxesPermittedImpl({ TOOLBOXES_PERMITTED_IMPL: 'yes' }), 'js');
    assert.equal(tp.toolboxesPermittedImpl({ TOOLBOXES_PERMITTED_IMPL: 'yes' }), 'js');
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /TOOLBOXES_PERMITTED_IMPL="yes" is not js or wasm; using js/);
  assert.ok(davParseWasm.IMPL_FLAGS.includes('TOOLBOXES_PERMITTED_IMPL'));
});

test('under js the port is never asked, and the two-argument callers read process.env', () => {
  const port = fakePort();
  const opts = { env: {}, wasmLoader: port.loader };
  assert.deepEqual(tp.projectToolboxIds({ toolboxes: ['a'] }, ['core'], opts), ['a']);
  assert.deepEqual(tp.selectedToolboxIds({ project: null, defaultToolboxes: ['core'], connectorBoxes: new Set(), connected: ['gmail'] }, opts), ['core', 'gmail']);
  tp.computePermittedTools(input().input, opts);
  assert.deepEqual(port.calls, []);
  const saved = process.env.TOOLBOXES_PERMITTED_IMPL;
  try {
    delete process.env.TOOLBOXES_PERMITTED_IMPL;
    assert.deepEqual(tp.projectToolboxIds(null, ['core']), ['core']);
  } finally { if (saved === undefined) delete process.env.TOOLBOXES_PERMITTED_IMPL; else process.env.TOOLBOXES_PERMITTED_IMPL = saved; }
});

test('carried ids: the JS list when the port agrees, only the shared string ids otherwise, none on a fault', () => {
  const project = { toolboxes: ['core', 'web', 7, 'notes'] };
  let port = fakePort({ project: () => ({ ids: ['core', 'web', null, 'notes'] }) });
  const js = tp.projectToolboxIdsJs(project, ['core']);
  assert.equal(tp.projectToolboxIds(project, ['core'], wasm(port)), js, 'the JS list itself');
  assert.deepEqual(port.calls[0][1], [{ auto: false, docsDefaulted: false, toolboxes: ['core', 'web', null, 'notes'] }, ['core'], 'project-docs']);
  port = fakePort({ project: () => ({ ids: ['core', 'extra'] }) });
  assert.deepEqual(quietly(() => tp.projectToolboxIds(project, ['core'], wasm(port))).value, ['core']);
  port = fakePort();
  assert.deepEqual(quietly(() => tp.projectToolboxIds(project, ['core'], wasm(port))).value, []);
  // selectedToolboxIds: a connector the port does not carry is dropped; a fault carries nothing.
  const sel = { project: null, defaultToolboxes: ['core', 'gmail'], connectorBoxes: new Set(['gmail']), connected: ['gmail'] };
  port = fakePort({ selected: () => ({ ids: ['core'] }) });
  assert.deepEqual(quietly(() => tp.selectedToolboxIds(sel, wasm(port))).value, ['core']);
  port = fakePort({ selected: () => ({ ids: ['core', 'gmail', 'gmail'] }) });
  assert.deepEqual(quietly(() => tp.selectedToolboxIds(sel, wasm(port))).value, ['core', 'gmail']);
  port = fakePort({ selected: () => ({ ids: ['gmail'] }) });
  const { value, seen } = quietly(() => tp.selectedToolboxIds(sel, wasm(port)));
  assert.deepEqual(value, ['gmail']);
  assert.ok(seen.every((l) => !l.includes('core')), 'warnings (once per reason) carry no ids');
  port = fakePort();
  assert.deepEqual(quietly(() => tp.selectedToolboxIds(sel, wasm(port))).value, []);
});

test('catalogue: agreement returns the JS answer; callbacks are not called twice', () => {
  const plain = input();
  const js = tp.computePermittedToolsJs(plain.input);
  const once = { ...plain.counts };
  const w = input();
  const port = fakePort({ permitted: (proj) => {
    assert.deepEqual(proj.boxes, [{ id: 'core', ready: null, tools: [{ write: false, policy: 'other' }, { write: true, policy: 'other' }] },
      { id: 'web', ready: null, tools: [{ write: false, policy: 'ask' }] }, { id: 'sso', ready: true, tools: [{ write: false, policy: 'other' }] }]);
    return asPort(js);
  } });
  assert.deepEqual(tp.computePermittedTools(w.input, wasm(port)), js);
  assert.deepEqual(w.counts, once);
});

test('catalogue: the stricter of the two for each box and tool, with the port reason', () => {
  const { input: i } = input();
  const js = tp.computePermittedToolsJs(i);
  const answer = asPort(js);
  answer.boxes[0].tools[0] = { permission: 'unavailable', reasonCode: 'blocked' }; // stricter tool
  answer.boxes[1] = { ...answer.boxes[1], state: 'unavailable', reasonCode: 'signIn', active: false,
    tools: [{ permission: 'unavailable', reasonCode: 'signIn' }] }; // stricter box
  answer.boxes[2].tools[0] = { permission: 'allowed', reasonCode: null }; // not more permissive
  answer.boxes[3] = { ...answer.boxes[3], state: 'available', reasonCode: null }; // 'down' is unavailable: stays
  answer.boxes[4].tools[1] = { permission: 'needs-approval', reasonCode: 'weird' };
  const port = fakePort({ permitted: () => answer });
  const out = quietly(() => tp.computePermittedTools(i, wasm(port))).value;
  assert.equal(out[0].tools[0].permission, 'unavailable');
  assert.equal(out[0].tools[0].reason, tp.REASONS.blocked);
  assert.equal(out[1].state, 'unavailable');
  assert.equal(out[1].reasonCode, 'signIn');
  assert.equal(out[1].active, false);
  assert.equal(out[1].tools[0].permission, 'unavailable');
  assert.deepEqual(out[2], js[2]);
  assert.deepEqual(out[3], js[3]);
  assert.deepEqual(out[4], js[4]);
  const RANK = { allowed: 0, 'needs-approval': 1, unavailable: 2 };
  for (const [k, b] of out.entries()) {
    assert.ok(b.state === 'unavailable' || js[k].state === 'available');
    assert.ok(!b.active || js[k].active);
    for (const [n, t] of b.tools.entries()) assert.ok(RANK[t.permission] >= RANK[js[k].tools[n].permission]);
  }
});

test('catalogue: a fault or another shape shows everything unavailable', () => {
  const { input: i } = input();
  const js = tp.computePermittedToolsJs(i);
  const shapes = [() => { throw new davParseWasm.DavParseError('x', 'trap'); }, () => ({ boxes: asPort(js).boxes.slice(1) }),
    () => { const a = asPort(js); a.boxes[0].tools.pop(); return a; }, () => { const a = asPort(js); a.boxes[0].id = 'other'; return a; }];
  for (const answer of shapes) {
    const out = quietly(() => tp.computePermittedTools(i, wasm(fakePort({ permitted: answer })))).value;
    assert.equal(out.length, js.length);
    for (const b of out) {
      assert.equal(b.state, 'unavailable');
      assert.equal(b.active, false);
      assert.equal(b.reasonCode, 'unchecked');
      assert.ok(b.tools.every((t) => t.permission === 'unavailable' && t.reasonCode === 'unchecked'));
    }
  }
  // A box id that is not a string cannot be projected: a fault too.
  const odd = input({ boxes: [{ id: 5, tools: [] }] }).input;
  const out = quietly(() => tp.computePermittedTools(odd, wasm(fakePort({ permitted: () => ({ boxes: [] }) })))).value;
  assert.ok(out.every((b) => b.state === 'unavailable'));
});
