'use strict';
// Provider egress is always the Rust port (PROVIDER_EGRESS_IMPL retired, #1071). This file pins how the
// rules chat.cjs calls use the port's answers, with a stand-in for the port (no dav-parse.wasm needed;
// tests/server/provider-egress-differential.test.cjs runs the real module against the frozen answers).
// The port decides alone: its refusal or null is the answer, and an unknown, a fault or a bad reply gives the
// strict result (external, refused, private toolbox removed). Synthetic rows only.
const test = require('node:test'), assert = require('node:assert/strict');
const pe = require('./provider-egress.cjs');
const davParseWasm = require('./dav-parse-wasm.cjs');

const LOCAL = { id: 'local', label: 'Local', baseUrl: 'http://llama:8080/v1' };
const REMOTE = { id: 'r', external: true, label: 'Remote', baseUrl: 'https://remote.example/v1', apiKey: 'sk-synthetic' };
const STORAGE = { kind: 'nextcloud', corpusRoot: 'Diary', baseUrl: 'https://nc.example/remote.php/dav/files/alice', password: 'synthetic' };
const fault = () => { throw new davParseWasm.DavParseError('dav-parse module failed', 'trap'); };
const EXTERNAL = () => ({ external: true, trial: false });
const LOCAL_REPLY = () => ({ external: false, trial: false });

/** A stand-in port: every providerEgress* call is recorded and answered by `answers[name]` (a fault by default). */
function fakePort(answers = {}) {
  const calls = [];
  const fn = (name) => (...args) => { calls.push([name, args]); return (answers[name] || fault)(...args); };
  return {
    calls,
    wasmLoader: () => ({ providerEgressExternal: fn('external'), providerEgressRefusal: fn('refusal'), providerEgressStrip: fn('strip'), providerEgressToolRefusal: fn('tool') }),
  };
}
function quietly(fn) {
  const warn = console.warn, seen = [];
  console.warn = (m) => seen.push(String(m));
  try { return { value: fn(), seen }; } finally { console.warn = warn; }
}

test('the module exports the rules chat.cjs calls and the port projections: no JS rule, switch or canonicaliser remains', () => {
  assert.deepEqual(Object.keys(pe).sort(), ['__setStreamGuardEnabledForTests', 'egressRefusal', 'evaluateToolCall', 'isExternalProvider', 'isTrialTermsHost',
    'providerProjection', 'setToolArgumentSchema', 'storageProjection', 'stripPrivateToolboxes', 'toolRefusal', 'validateToolArguments']);
});

test('the retired switch changes nothing: the port is asked whatever PROVIDER_EGRESS_IMPL says', () => {
  const saved = process.env.PROVIDER_EGRESS_IMPL;
  try {
    for (const value of [undefined, '', 'js', 'wasm', 'on']) {
      if (value === undefined) delete process.env.PROVIDER_EGRESS_IMPL; else process.env.PROVIDER_EGRESS_IMPL = value;
      const port = fakePort({ external: LOCAL_REPLY });
      assert.equal(pe.isExternalProvider(LOCAL, port), false, String(value));
      assert.equal(port.calls.length, 1, String(value));
    }
  } finally { if (saved === undefined) delete process.env.PROVIDER_EGRESS_IMPL; else process.env.PROVIDER_EGRESS_IMPL = saved; }
  assert.ok(!davParseWasm.IMPL_FLAGS.includes('PROVIDER_EGRESS_IMPL'));
  assert.equal(davParseWasm.RETIRED_FLAGS.PROVIDER_EGRESS_IMPL, 'wasm');
});

test('external: false only when the port says false; true, unknown, a fault or a bad reply count as external', () => {
  const ask = (answer) => quietly(() => pe.isExternalProvider(LOCAL, fakePort({ external: answer }))).value;
  assert.equal(ask(LOCAL_REPLY), false);
  assert.equal(ask(EXTERNAL), true);
  assert.equal(ask(() => ({ external: null, trial: null })), true);
  assert.equal(ask(fault), true);
  assert.equal(ask(() => { throw new TypeError('bad'); }), true);
  const trial = (answer) => quietly(() => pe.isTrialTermsHost(LOCAL, fakePort({ external: answer }))).value;
  assert.equal(trial(LOCAL_REPLY), false);
  assert.equal(trial(() => ({ external: false, trial: null })), true);
  assert.equal(trial(() => ({ external: true, trial: true })), true);
  assert.equal(trial(fault), true);
  // The port is sent the projection only: no key, no id; an unknown reply is logged once, without input.
  const port = fakePort({ external: LOCAL_REPLY });
  pe.isExternalProvider({ ...LOCAL, apiKey: 'sk-synthetic', external: 'yes', kind: 7 }, port);
  assert.deepEqual(port.calls, [['external', [{ kind: null, external: false, baseUrl: 'http://llama:8080/v1', label: 'Local' }]]]);
  assert.deepEqual(pe.providerProjection(null), null);
});

test('egressRefusal: the port\'s text or null is the answer; a fault refuses; ids that are not JSON go as null', () => {
  const ask = (answer) => quietly(() => pe.egressRefusal({ provider: LOCAL, spaceId: 'diary', projectId: 'p', diaryProjectId: 'p' }, fakePort({ refusal: answer })));
  assert.equal(ask(() => ({ refusal: null })).value, null);
  assert.equal(ask(() => ({ refusal: 'Diary text is never sent to an external provider (Local).' })).value, 'Diary text is never sent to an external provider (Local).');
  const f = ask(() => { throw new davParseWasm.DavParseError('provider egress input is too large', 'too_large'); });
  assert.match(f.value, /could not be checked against the external-provider rules, so nothing was sent/);
  assert.match(f.seen.join('\n'), /wasm_fault \(too_large\)/);
  const port = fakePort({ refusal: () => ({ refusal: null }) });
  pe.egressRefusal({ provider: null, spaceId: 5, projectId: { id: 1 }, diaryProjectId: Infinity }, port);
  assert.deepEqual(port.calls[0][1], [null, null, null, null]);
});

test('stripPrivateToolboxes: exactly the indices the port names go, in order; a fault takes every private toolbox', () => {
  const strip = (sel, answer) => quietly(() => pe.stripPrivateToolboxes(sel, LOCAL, fakePort({ strip: answer }))).value;
  let sel = ['files', 'diary', 'web', 'diary'];
  assert.deepEqual(strip(sel, () => ({ removed: [] })), []);
  assert.deepEqual(sel, ['files', 'diary', 'web', 'diary']);
  sel = ['files', 'diary', 'web', 'diary'];
  assert.deepEqual(strip(sel, () => ({ removed: [1, 3] })), ['diary', 'diary']);
  assert.deepEqual(sel, ['files', 'web']);
  sel = ['diary', 'files', 'diary'];
  assert.deepEqual(strip(sel, () => ({ removed: [0, 2] })), ['diary', 'diary']);
  assert.deepEqual(sel, ['files']);
  sel = ['files', 'diary', 'web'];
  assert.deepEqual(strip(sel, fault), ['diary']);
  assert.deepEqual(sel, ['files', 'web']);
  // The port is sent the selection with non-string ids as null, and is asked even when nothing private is selected.
  const port = fakePort({ strip: () => ({ removed: [] }) });
  assert.deepEqual(pe.stripPrivateToolboxes(['files', 7], LOCAL, port), []);
  assert.deepEqual(port.calls[0][1][1], ['files', null]);
});

test('toolRefusal: the port\'s text or null is the answer; only diary_* and nc_webdav_* are asked about; a local provider is never refused', () => {
  const call = { provider: REMOTE, toolName: 'nc_webdav_read_file', rawArgs: '{"path":"Tagebu%CC%88cher/a"}', storage: STORAGE };
  const ask = (answer, c = call, ext = EXTERNAL) => quietly(() => pe.toolRefusal(c, fakePort({ external: ext, tool: answer })));
  assert.equal(ask(() => ({ refusal: null })).value, null);
  assert.match(ask(() => ({ refusal: 'ERROR: nc_webdav_read_file was not run: that path is in the Diary folder.' })).value, /in the Diary folder/);
  const f = ask(fault);
  assert.match(f.value, /^ERROR: nc_webdav_read_file was not run: it could not be checked against the external-provider rules/);
  // evaluateToolCall goes through the same rule.
  const e = quietly(() => pe.evaluateToolCall(call, fakePort({ external: EXTERNAL, tool: fault })));
  assert.match(e.value, /could not be checked/);
  // An unknown external reply still asks about the tool; a fault of the external question is a fault of the tool one too.
  assert.match(quietly(() => pe.toolRefusal(call, fakePort({ external: fault, tool: () => ({ refusal: 'ERROR: x' }) }))).value, /^ERROR: x$/);
  assert.match(quietly(() => pe.toolRefusal(call, fakePort({ external: () => ({ external: null, trial: null }), tool: () => ({ refusal: 'ERROR: y' }) }))).value, /^ERROR: y$/);
  // The port is sent projections: storage without credentials, the arguments as given.
  const port = fakePort({ external: EXTERNAL, tool: () => ({ refusal: null }) });
  pe.toolRefusal({ ...call, rawArgs: { path: 'Work' } }, port);
  assert.deepEqual(port.calls.find(([n]) => n === 'tool')[1], [{ kind: null, external: true, baseUrl: REMOTE.baseUrl, label: 'Remote' }, 'nc_webdav_read_file',
    { path: 'Work' }, { kind: 'nextcloud', corpusRoot: 'Diary', baseUrl: STORAGE.baseUrl }]);
  // User names and passwords never reach the port.
  const creds = fakePort({ external: EXTERNAL, tool: () => ({ refusal: null }) });
  pe.toolRefusal({ ...call, provider: { ...REMOTE, baseUrl: 'https://u:pw@remote.example/v1' },
    storage: { ...STORAGE, baseUrl: 'https://alice:secret@nc.example/remote.php/dav/files/alice' } }, creds);
  const sent = creds.calls.find(([n]) => n === 'tool')[1];
  assert.equal(sent[0].baseUrl, 'https://remote.example/v1');
  assert.equal(sent[3].baseUrl, 'https://nc.example/remote.php/dav/files/alice');
  assert.equal(pe.providerProjection({ baseUrl: 'not a url' }).baseUrl, 'not a url');
});

test('a local provider is not refused and its arguments are not sent; other tools are not asked about at all', () => {
  const local = fakePort({ external: LOCAL_REPLY });
  assert.equal(pe.toolRefusal({ provider: LOCAL, toolName: 'diary_read', rawArgs: 'x'.repeat(9 * 1024 * 1024), storage: STORAGE }, local), null);
  assert.deepEqual(local.calls.map(([n]) => n), ['external']);
  const other = fakePort();
  assert.equal(pe.toolRefusal({ provider: REMOTE, toolName: 'web_fetch', rawArgs: 'x'.repeat(9 * 1024 * 1024), storage: STORAGE }, other), null);
  assert.deepEqual(other.calls, []);
});

test('warnings carry no input: no path, label, URL or argument text', () => {
  const { seen } = quietly(() => {
    pe.toolRefusal({ provider: { ...REMOTE, label: 'Secret label' }, toolName: 'nc_webdav_read_file', rawArgs: '{"path":"Private/x"}', storage: STORAGE },
      fakePort({ external: () => ({ external: null, trial: null }), tool: () => ({ refusal: 'ERROR: x' }) }));
    pe.isExternalProvider({ baseUrl: 'https://private.example/v1' }, fakePort({ external: () => { throw new davParseWasm.DavParseError('x', 'reply'); } }));
  });
  assert.ok(seen.some((l) => /wasm_fault \(reply\)/.test(l)), seen.join('\n'));
  for (const line of seen) assert.doesNotMatch(line, /Private|Secret|private\.example|path/);
});
