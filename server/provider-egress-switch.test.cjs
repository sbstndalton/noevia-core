'use strict';
// PROVIDER_EGRESS_IMPL: the switch and its fail-closed paths, with a stand-in for the Rust port (no
// dav-parse.wasm needed; tests/server/provider-egress-differential.test.cjs runs the real module).
// Whatever the JS keeps back stays back without asking the port; when the JS lets something out,
// it goes only if the port lets it out too. A port refusal, an unknown, a fault or a bad reply gives
// the strict answer (external, refused, private toolbox removed). Synthetic rows only.
const test = require('node:test'), assert = require('node:assert/strict');
const pe = require('./provider-egress.cjs');
const davParseWasm = require('./dav-parse-wasm.cjs');

const LOCAL = { id: 'local', label: 'Local', baseUrl: 'http://llama:8080/v1' };
const CHATGPT = { id: 'c', kind: 'chatgpt-oauth', label: 'ChatGPT', baseUrl: 'https://chatgpt.com/backend-api/codex', apiKey: 'sk-synthetic' };
const STORAGE = { kind: 'nextcloud', corpusRoot: 'Diary', baseUrl: 'https://nc.example/remote.php/dav/files/alice', password: 'synthetic' };
const fault = () => { throw new davParseWasm.DavParseError('dav-parse module failed', 'trap'); };

/** A stand-in port: every providerEgress* call is recorded and answered by `answers[name]`. */
function fakePort(answers = {}) {
  const calls = [];
  const fn = (name) => (...args) => { calls.push([name, args]); return (answers[name] || fault)(...args); };
  return {
    calls,
    loader: () => ({ providerEgressExternal: fn('external'), providerEgressRefusal: fn('refusal'), providerEgressStrip: fn('strip'), providerEgressToolRefusal: fn('tool') }),
  };
}
const wasm = (port) => ({ impl: 'wasm', wasmLoader: port.loader });
function quietly(fn) {
  const warn = console.warn, seen = [];
  console.warn = (m) => seen.push(String(m));
  try { return { value: fn(), seen }; } finally { console.warn = warn; }
}

test('PROVIDER_EGRESS_IMPL: default js, wasm when set, anything else js with one warning', () => {
  const { seen } = quietly(() => {
    assert.equal(pe.providerEgressImpl({}), 'js');
    assert.equal(pe.providerEgressImpl({ PROVIDER_EGRESS_IMPL: '' }), 'js');
    assert.equal(pe.providerEgressImpl({ PROVIDER_EGRESS_IMPL: ' WASM ' }), 'wasm');
    assert.equal(pe.providerEgressImpl({ PROVIDER_EGRESS_IMPL: 'rust' }), 'js');
    assert.equal(pe.providerEgressImpl({ PROVIDER_EGRESS_IMPL: 'rust' }), 'js');
  });
  assert.equal(seen.length, 1);
  assert.match(seen[0], /PROVIDER_EGRESS_IMPL="rust" is not js or wasm; using js/);
  assert.ok(davParseWasm.IMPL_FLAGS.includes('PROVIDER_EGRESS_IMPL'), 'a missing or tampered module stops startup');
});

test('under js (the default, and an unknown value) the port is never asked', () => {
  const port = fakePort();
  for (const opts of [{ wasmLoader: port.loader, env: {} }, { wasmLoader: port.loader, env: { PROVIDER_EGRESS_IMPL: 'on' } }]) {
    quietly(() => {
      assert.equal(pe.isExternalProvider(LOCAL, opts), false);
      assert.equal(pe.isTrialTermsHost(LOCAL, opts), false);
      assert.equal(pe.egressRefusal({ provider: LOCAL, spaceId: 'diary' }, opts), null);
      const sel = ['diary', 'web'];
      assert.deepEqual(pe.stripPrivateToolboxes(sel, LOCAL, opts), []);
      assert.deepEqual(sel, ['diary', 'web']);
      assert.equal(pe.toolRefusal({ provider: LOCAL, toolName: 'diary_read', rawArgs: '{}', storage: STORAGE }, opts), null);
      assert.equal(pe.evaluateToolCall({ provider: LOCAL, toolName: 'nc_webdav_read_file', rawArgs: '{"path":"Diary/a"}', storage: STORAGE }, opts), null);
    });
  }
  assert.deepEqual(port.calls, []);
});

test('what the JS keeps back stays back without asking the port', () => {
  const port = fakePort();
  const w = wasm(port);
  assert.equal(pe.isExternalProvider(CHATGPT, w), true);
  assert.equal(pe.isTrialTermsHost({ baseUrl: 'https://integrate.api.nvidia.com/v1' }, w), true);
  assert.match(pe.egressRefusal({ provider: CHATGPT, spaceId: 'diary' }, w), /Diary text is never sent/);
  const sel = ['files', 'diary'];
  assert.deepEqual(pe.stripPrivateToolboxes(sel, CHATGPT, w), ['diary']);
  assert.deepEqual(sel, ['files']);
  assert.match(pe.toolRefusal({ provider: CHATGPT, toolName: 'nc_webdav_read_file', rawArgs: '{"path":"Diary/a.md"}', storage: STORAGE }, w), /in the Diary folder/);
  assert.match(pe.evaluateToolCall({ provider: CHATGPT, toolName: 'nc_webdav_read_file', rawArgs: '{"path":"/diary"}', storage: STORAGE }, w), /in the Diary folder/);
  assert.deepEqual(port.calls, []);
});

test('external: false only when the port says false; true, unknown, a fault or a bad reply count as external', () => {
  const ask = (answer) => quietly(() => pe.isExternalProvider(LOCAL, wasm(fakePort({ external: answer })))).value;
  assert.equal(ask(() => ({ external: false, trial: false })), false);
  assert.equal(ask(() => ({ external: true, trial: true })), true);
  assert.equal(ask(() => ({ external: null, trial: null })), true);
  assert.equal(ask(fault), true);
  assert.equal(ask(() => { throw new TypeError('bad'); }), true);
  const trial = (answer) => quietly(() => pe.isTrialTermsHost(LOCAL, wasm(fakePort({ external: answer })))).value;
  assert.equal(trial(() => ({ external: false, trial: false })), false);
  assert.equal(trial(() => ({ external: false, trial: null })), true);
  assert.equal(trial(fault), true);
  // The port is sent the projection only: no key, no id.
  const port = fakePort({ external: () => ({ external: false, trial: false }) });
  pe.isExternalProvider({ ...LOCAL, apiKey: 'sk-synthetic', external: 'yes', kind: 7 }, wasm(port));
  assert.deepEqual(port.calls, [['external', [{ kind: null, external: false, baseUrl: 'http://llama:8080/v1', label: 'Local' }]]]);
});

test('egressRefusal: a JS null stands only when the port agrees; a port refusal or fault refuses', () => {
  const ask = (answer) => quietly(() => pe.egressRefusal({ provider: LOCAL, spaceId: 'diary', projectId: 'p', diaryProjectId: 'p' }, wasm(fakePort({ refusal: answer }))));
  assert.equal(ask(() => ({ refusal: null })).value, null);
  const r = ask(() => ({ refusal: 'Diary text is never sent to an external provider (Local).' }));
  assert.equal(r.value, 'Diary text is never sent to an external provider (Local).');
  assert.match(r.seen.join('\n'), /impl_mismatch \(egress\)/);
  const f = ask(() => { throw new davParseWasm.DavParseError('provider egress input is too large', 'too_large'); });
  assert.match(f.value, /could not be checked against the external-provider rules, so nothing was sent/);
  assert.match(f.seen.join('\n'), /wasm_fault \(too_large\)/);
  // Non-JSON ids go as null.
  const port = fakePort({ refusal: () => ({ refusal: null }) });
  pe.egressRefusal({ provider: null, spaceId: 5, projectId: { id: 1 }, diaryProjectId: Infinity }, wasm(port));
  assert.deepEqual(port.calls[0][1], [null, null, null, null]);
});

test('stripPrivateToolboxes: the port can take more private toolboxes, never others; a fault takes them all', () => {
  const strip = (sel, answer) => { const r = quietly(() => pe.stripPrivateToolboxes(sel, LOCAL, wasm(fakePort({ strip: answer })))); return r.value; };
  let sel = ['files', 'diary', 'web', 'diary'];
  assert.deepEqual(strip(sel, () => ({ removed: [] })), []);
  assert.deepEqual(sel, ['files', 'diary', 'web', 'diary']);
  sel = ['files', 'diary', 'web', 'diary'];
  assert.deepEqual(strip(sel, () => ({ removed: [1, 3] })), ['diary', 'diary']);
  assert.deepEqual(sel, ['files', 'web']);
  sel = ['files', 'diary', 'web'];
  assert.deepEqual(strip(sel, () => ({ removed: [0, 1] })), ['diary'], 'a non-private toolbox is never removed');
  assert.deepEqual(sel, ['files', 'web']);
  sel = ['files', 'diary'];
  assert.deepEqual(strip(sel, fault), ['diary']);
  assert.deepEqual(sel, ['files']);
  // Nothing private selected: nothing to ask.
  const port = fakePort();
  assert.deepEqual(pe.stripPrivateToolboxes(['files', 'web'], LOCAL, wasm(port)), []);
  assert.deepEqual(port.calls, []);
});

test('toolRefusal: a JS null stands only when the port agrees; only diary_* and nc_webdav_* are asked about', () => {
  const call = { provider: CHATGPT, toolName: 'nc_webdav_read_file', rawArgs: '{"path":"Tagebu%CC%88cher/a"}', storage: STORAGE };
  const ask = (answer, c = call) => quietly(() => pe.toolRefusal(c, wasm(fakePort({ tool: answer }))));
  assert.equal(ask(() => ({ refusal: null })).value, null);
  const r = ask(() => ({ refusal: 'ERROR: nc_webdav_read_file was not run: that path is in the Diary folder.' }));
  assert.match(r.value, /in the Diary folder/);
  assert.match(r.seen.join('\n'), /impl_mismatch \(tool\)/);
  const f = ask(fault);
  assert.match(f.value, /^ERROR: nc_webdav_read_file was not run: it could not be checked against the external-provider rules/);
  // evaluateToolCall goes through the same switch.
  const e = quietly(() => pe.evaluateToolCall(call, wasm(fakePort({ tool: fault }))));
  assert.match(e.value, /could not be checked/);
  // The port is sent projections: storage without credentials, the arguments as given.
  const port = fakePort({ tool: () => ({ refusal: null }) });
  pe.toolRefusal({ ...call, rawArgs: { path: 'Work' } }, wasm(port));
  assert.deepEqual(port.calls[0][1], [{ kind: 'chatgpt-oauth', external: false, baseUrl: CHATGPT.baseUrl, label: 'ChatGPT' }, 'nc_webdav_read_file',
    { path: 'Work' }, { kind: 'nextcloud', corpusRoot: 'Diary', baseUrl: STORAGE.baseUrl }]);
  // Other tools: the port refuses nothing else, so nothing is asked.
  const other = fakePort();
  assert.equal(pe.toolRefusal({ provider: CHATGPT, toolName: 'web_fetch', rawArgs: '{}', storage: STORAGE }, wasm(other)), null);
  assert.deepEqual(other.calls, []);
});

test('warnings carry no input: no path, label, URL or argument text', () => {
  const { seen } = quietly(() => {
    pe.toolRefusal({ provider: { ...CHATGPT, label: 'Secret label' }, toolName: 'nc_webdav_read_file', rawArgs: '{"path":"Private/x"}', storage: STORAGE },
      wasm(fakePort({ tool: () => ({ refusal: 'ERROR: x' }) })));
    pe.isExternalProvider({ baseUrl: 'https://private.example/v1' }, wasm(fakePort({ external: () => { throw new davParseWasm.DavParseError('x', 'reply'); } })));
  });
  // Each event and reason is logged once per process; this reason is new here.
  assert.ok(seen.some((l) => /wasm_fault \(reply\)/.test(l)), seen.join('\n'));
  for (const line of seen) assert.doesNotMatch(line, /Private|Secret|private\.example|path/);
});
