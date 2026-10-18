'use strict';
// The permitted-tools view applies the Rust port's answer (TOOLBOXES_PERMITTED_IMPL, retired in #1071), tested with a
// stand-in for the port (no dav-parse.wasm needed; tests/server/toolboxes-permitted-differential.test.cjs runs the real
// module). What is checked here is the host's side of the contract and its floor: the callbacks are called once each and
// what they said is what the port is sent; the port decides which ids are carried and each box and tool; a fault, a
// refusal or a reply of another shape carries no id and shows every box and tool unavailable ('unchecked'); and under the
// port the account's own limits stay (a blocked tool is never more than unavailable, a write or an Ask tool is never
// allowed, a box that needs a connection, a sign-in or the Diary add-on is not available unless the port says so too).
// Synthetic accounts and boxes only.
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
const tool = (name) => ({ type: 'function', function: { name, description: `${name} (synthetic)` } });
function input(over = {}) {
  const counts = { ready: [], write: [], policy: [] };
  return {
    counts,
    input: {
      user: { id: 'u1', role: 'admin' }, project: { id: 'p1', toolboxes: ['core', 'web'] }, mode: 'cowork',
      boxes: [{ id: 'core', label: 'Core', source: 'builtin', tools: [tool('read_file'), tool('write_file')] }, { id: 'web', label: 'Web', tools: [tool('web_search')] },
        { id: 'sso', label: 'SSO', tools: [tool('sso_read')] }],
      manifest: [{ id: 'down' }], defaultToolboxes: ['core'], connectorBoxes: new Set(['gmail']), connected: [], oauthServerIds: new Set(['sso']),
      accountReady: (_u, id) => { counts.ready.push(id); return true; }, isWriteTool: (n) => { counts.write.push(n); return n === 'write_file'; },
      policyMode: (_u, t) => { counts.policy.push(t); return t === 'web_search' ? 'ask' : 'allow'; },
      diaryEnabled: true, harnessEnabled: true, repositories: ['r1'], ...over,
    },
  };
}
const T = (permission, reasonCode = null) => ({ permission, reasonCode });
const OPEN = { available: { state: 'available', reasonCode: null } };
/** The port's answer for input(): core, web, sso, the manifest's down, the coding harness. */
function reply(over = {}) {
  return { boxes: [
    { id: 'core', ...OPEN.available, active: true, tools: [T('allowed'), T('needs-approval')] },
    { id: 'web', ...OPEN.available, active: true, tools: [T('needs-approval')] },
    { id: 'sso', ...OPEN.available, active: false, tools: [T('allowed')] },
    { id: 'down', state: 'unavailable', reasonCode: 'notConnected', active: false, tools: [] },
    { id: 'code', ...OPEN.available, active: true, tools: [T('allowed'), T('needs-approval'), T('needs-approval')] },
  ].map((b, i) => (over[i] ? { ...b, ...over[i] } : b)) };
}
const byId = (boxes) => Object.fromEntries(boxes.map((b) => [b.id, b]));

test('the port\'s answer is the catalogue; the callbacks are called once each, in order, and the port is sent what they said', () => {
  const port = fakePort({ permitted: () => reply() });
  const { input: i, counts } = input();
  const out = tp.computePermittedTools(i, { wasmLoader: port.loader });
  assert.deepEqual(counts, { ready: ['sso'], write: ['read_file', 'write_file', 'web_search', 'sso_read'], policy: ['read_file', 'write_file', 'web_search', 'sso_read'] });
  const boxes = byId(out);
  assert.deepEqual(out.map((b) => b.id), ['core', 'web', 'sso', 'down', 'code']);
  assert.deepEqual(boxes.core.tools.map((t) => [t.name, t.write, t.permission, t.reason, t.reasonCode]), [['read_file', false, 'allowed', null, null], ['write_file', true, 'needs-approval', null, null]]);
  assert.equal(boxes.core.inApp, true);
  assert.equal(boxes.core.active, true);
  assert.equal(boxes.sso.active, false);
  assert.deepEqual([boxes.down.state, boxes.down.reasonCode, boxes.down.reason, boxes.down.inApp], ['unavailable', 'notConnected', tp.REASONS.notConnected, true]);
  assert.deepEqual([boxes.code.state, boxes.code.reason, boxes.code.tools.map((t) => t.permission)], ['available', null, ['allowed', 'needs-approval', 'needs-approval']]);
  assert.equal(boxes.web.tools[0].description, 'web_search (synthetic)');
  const [, [sent]] = port.calls[0];
  assert.deepEqual(sent.boxes, [{ id: 'core', ready: null, tools: [{ write: false, policy: 'other' }, { write: true, policy: 'other' }] },
    { id: 'web', ready: null, tools: [{ write: false, policy: 'ask' }] }, { id: 'sso', ready: true, tools: [{ write: false, policy: 'other' }] }]);
  assert.deepEqual([sent.isAdmin, sent.cowork, sent.hasRepositories, sent.manifest], [true, true, true, [{ id: 'down' }]]);
  assert.equal(port.calls.length, 1);
});

test('the port can make an answer stricter: an unavailable box with its reason, a blocked tool, an unknown code is unchecked', () => {
  const port = fakePort({ permitted: () => reply({ 1: { state: 'unavailable', reasonCode: 'signIn', active: false, tools: [T('unavailable', 'signIn')] },
    0: { tools: [T('unavailable', 'blocked'), T('needs-approval')] }, 2: { state: 'unavailable', reasonCode: 'no-such-code', tools: [T('unavailable', 'no-such-code')] },
    4: { state: 'unavailable', reasonCode: 'codeOff', active: false, tools: [T('unavailable', 'codeOff'), T('unavailable', 'codeOff'), T('unavailable', 'codeOff')] } }) });
  const boxes = byId(tp.computePermittedTools(input().input, { wasmLoader: port.loader }));
  assert.deepEqual([boxes.web.state, boxes.web.reasonCode, boxes.web.reason, boxes.web.active, boxes.web.tools[0].permission, boxes.web.tools[0].reason], ['unavailable', 'signIn', tp.REASONS.signIn, false, 'unavailable', tp.REASONS.signIn]);
  assert.deepEqual([boxes.core.tools[0].permission, boxes.core.tools[0].reason, boxes.core.tools[0].reasonCode], ['unavailable', tp.REASONS.blocked, 'blocked']);
  assert.deepEqual([boxes.sso.reasonCode, boxes.sso.reason, boxes.sso.tools[0].reasonCode], ['unchecked', tp.REASONS.unchecked, 'unchecked']);
  assert.deepEqual([boxes.code.state, boxes.code.reason, boxes.code.tools.map((t) => t.reasonCode)], ['unavailable', tp.REASONS.codeOff, ['codeOff', 'codeOff', 'codeOff']]);
});

test('the floor: the limits of the account hold even if the port says allowed and available', () => {
  const answer = { boxes: [
    { id: 'core', ...OPEN.available, active: true, tools: [T('allowed'), T('allowed')] },
    { id: 'web', ...OPEN.available, active: true, tools: [T('allowed')] },
    { id: 'sso', ...OPEN.available, active: true, tools: [T('allowed')] },
    { id: 'diary', ...OPEN.available, active: true, tools: [T('allowed')] },
    { id: 'code', ...OPEN.available, active: true, tools: [T('allowed'), T('allowed'), T('allowed')] },
  ] };
  const policy = { read_file: 'block', web_search: 'ask' };
  const { input: i } = input({
    boxes: [{ id: 'core', tools: [tool('read_file'), tool('write_file')] }, { id: 'web', tools: [tool('web_search')] }, { id: 'sso', tools: [tool('sso_read')] },
      { id: 'diary', tools: [tool('diary_read')] }],
    manifest: [], diaryEnabled: false, accountReady: () => false, policyMode: (_u, t) => policy[t] || 'allow',
  });
  const boxes = byId(tp.computePermittedTools(i, { wasmLoader: fakePort({ permitted: () => answer }).loader }));
  assert.deepEqual(boxes.core.tools.map((t) => [t.permission, t.reasonCode]), [['unavailable', 'blocked'], ['needs-approval', null]], 'Block; a write is never allowed');
  assert.deepEqual([boxes.web.tools[0].permission, boxes.web.tools[0].reasonCode], ['needs-approval', null], 'Ask');
  assert.deepEqual([boxes.sso.state, boxes.sso.reasonCode, boxes.sso.active, boxes.sso.tools[0].permission, boxes.sso.tools[0].reasonCode], ['unavailable', 'signIn', false, 'unavailable', 'signIn'], 'not signed in');
  assert.deepEqual([boxes.diary.state, boxes.diary.reasonCode, boxes.diary.tools[0].permission], ['unavailable', 'diaryOff', 'unavailable'], 'the Diary add-on is off');
});

test('the floor: a box that needs a connection is unavailable unless the port says so too', () => {
  const answer = { boxes: [{ id: 'gmail', ...OPEN.available, active: true, tools: [T('allowed')] }, { id: 'code', ...OPEN.available, active: true, tools: [T('allowed'), T('needs-approval'), T('needs-approval')] }] };
  const { input: i } = input({ boxes: [{ id: 'gmail', tools: [tool('mail_read')] }], manifest: [], oauthServerIds: new Set(), connectorBoxes: new Set(['gmail']), connected: [] });
  const boxes = byId(tp.computePermittedTools(i, { wasmLoader: fakePort({ permitted: () => answer }).loader }));
  assert.deepEqual([boxes.gmail.state, boxes.gmail.reasonCode, boxes.gmail.reason, boxes.gmail.active, boxes.gmail.tools[0].permission], ['unavailable', 'connect', tp.REASONS.connect, false, 'unavailable']);
});

test('a fault, a refusal or a reply of another shape: every box and tool unavailable (unchecked), the callbacks still called once', () => {
  const answers = [undefined, () => { throw new TypeError('unexpected'); }, () => reply({ 0: { id: 'other' } }), () => ({ boxes: reply().boxes.slice(1) }),
    () => reply({ 0: { tools: [T('allowed')] } }), () => ({ boxes: [] })];
  for (const permitted of answers) {
    const port = fakePort(permitted ? { permitted } : {});
    const { input: i, counts } = input();
    const { value: out, seen } = quietly(() => tp.computePermittedTools(i, { wasmLoader: port.loader }));
    assert.equal(counts.write.length, 4);
    assert.deepEqual(out.map((b) => b.id), ['core', 'web', 'sso', 'down', 'code']);
    for (const b of out) {
      assert.deepEqual([b.state, b.reasonCode, b.reason, b.active], ['unavailable', 'unchecked', tp.REASONS.unchecked, false], b.id);
      for (const t of b.tools) assert.deepEqual([t.permission, t.reasonCode], ['unavailable', 'unchecked']);
    }
    assert.equal(out[0].tools[0].name, 'read_file');
    assert.ok(seen.every((l) => !l.includes('read_file') && !l.includes('u1')), 'warnings carry no input');
  }
  // A box whose id is not a string cannot be sent: unchecked as well.
  const odd = input({ boxes: [{ id: 7, label: 'odd', tools: [tool('x')] }], manifest: [] });
  const out = quietly(() => tp.computePermittedTools(odd.input, { wasmLoader: fakePort({ permitted: () => reply() }).loader })).value;
  assert.deepEqual(out.map((b) => b.reasonCode), ['unchecked', 'unchecked']);
});

test('callbacks that throw are not hidden: the error reaches the caller, as before', () => {
  const { input: i } = input({ policyMode: () => { throw Error('policy store down'); } });
  assert.throws(() => tp.computePermittedTools(i, { wasmLoader: fakePort({ permitted: () => reply() }).loader }), /policy store down/);
});

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
  for (const name of ['toolboxesPermittedImpl', 'computePermittedToolsJs', 'projectToolboxIdsJs', 'selectedToolboxIdsJs', 'mergeBox']) assert.equal(tp[name], undefined, name);
});

test('projections: what the port reads of the request', () => {
  assert.equal(tp.projectProjection(null), null);
  assert.deepEqual(tp.projectProjection({ toolsMode: 'auto', docsToolboxDefaulted: true, toolboxes: ['a', 3] }), { auto: true, docsDefaulted: true, toolboxes: ['a', null] });
  assert.deepEqual(tp.projectProjection({ toolsMode: 'AUTO', docsToolboxDefaulted: 'yes' }), { auto: false, docsDefaulted: false, toolboxes: null });
  assert.deepEqual(tp.idsProjection(['a', undefined, 5]), ['a', null, null]);
  assert.throws(() => tp.idsProjection('a'), /not a list/);
});
