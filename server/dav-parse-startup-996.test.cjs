'use strict';

// #996: when any *_IMPL switch is wasm, dav-parse.wasm is loaded and verified at startup; a missing
// or tampered module stops the server with one clear log line instead of failing on every request.
// Synthetic paths only.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('./dav-parse-wasm.cjs');

const MISSING = path.join(os.tmpdir(), 'no-such-startup-dav-parse.wasm');
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

test('wasmFlags lists exactly the switches set to wasm, read as the switches read them', () => {
  assert.deepEqual(davParseWasm.IMPL_FLAGS, ['STORAGE_PATH_IMPL', 'SECRET_ENVELOPE_IMPL', 'STREAM_GUARD_IMPL', 'GGUF_META_IMPL', 'ROLE_CONTEXT_IMPL', 'CODE_ACTIONS_IMPL', 'PROJECT_FILE_NAMES_IMPL', 'PROVIDER_EGRESS_IMPL', 'BROWSER_POLICY_IMPL', 'TOOL_GATE_IMPL', 'TOOLBOXES_PERMITTED_IMPL']);
  assert.deepEqual(davParseWasm.wasmFlags({}), []);
  assert.deepEqual(davParseWasm.wasmFlags({ STORAGE_PATH_IMPL: 'js', GGUF_META_IMPL: 'rust', STREAM_GUARD_IMPL: '' }), []);
  assert.deepEqual(davParseWasm.wasmFlags({ SECRET_ENVELOPE_IMPL: ' WASM ', STORAGE_PATH_IMPL: 'wasm' }), ['STORAGE_PATH_IMPL', 'SECRET_ENVELOPE_IMPL']);
});

test('with no switch set the module is still required (the retired switches have no JS path)', (t) => {
  const tampered = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'startup-1071-')), 'dav-parse.wasm');
  t.after(() => { fs.rmSync(path.dirname(tampered), { recursive: true, force: true }); davParseWasm.reset(); });
  fs.writeFileSync(tampered, Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  for (const [file, reason] of [[MISSING, 'missing'], [tampered, 'checksum']]) {
    assert.throws(() => davParseWasm.verifyAtStartup({ DAV_PARSE_WASM: file }),
      (e) => e.reason === reason && e.flags.length === 0 && /^dav-parse\.wasm \(always required\) failed verification/.test(e.message));
  }
});

test('with no switch set and the pinned module, startup verifies it and names no flag', { skip: skipWasm }, () => {
  davParseWasm.reset();
  assert.deepEqual(davParseWasm.verifyAtStartup({ DAV_PARSE_WASM: wasmFile }), []);
  assert.ok(davParseWasm.memoryBytes() > 0);
  davParseWasm.reset();
});

test('retired switches: only a value other than the old Rust one warns, once per switch', () => {
  assert.deepEqual(Object.keys(davParseWasm.RETIRED_FLAGS), ['CHAT_TEMPLATE_CAPS_IMPL', 'AUTOTUNE_PLAN_IMPL', 'PRESET_RELOAD_IMPL', 'LAYA_LOAD_ADVISOR', 'DAV_PARSE_IMPL', 'S3_PARSE_IMPL', 'MCP_FRAME_IMPL', 'UPLOAD_SNIFF_IMPL', 'S3_SIGN_IMPL', 'PROMPT_FRAMING_IMPL', 'SSRF_IMPL', 'POLICY_LEAVES_IMPL', 'CODE_REVIEW_VERDICT_IMPL', 'TOOL_EXCHANGE_IMPL', 'DECISION_IMPL', 'COMPLETENESS_REPORT_IMPL', 'TASK_LIFECYCLE_IMPL', 'MCP_SERVERS_IMPL', 'CODE_NET_GUARD_IMPL', 'LLAMACPP_AUTOCONFIG_IMPL']);
  const warnings = [];
  const log = { warn: (m) => warnings.push(m) };
  assert.deepEqual(davParseWasm.warnRetiredFlags({}, log), []);
  assert.deepEqual(davParseWasm.warnRetiredFlags({ DAV_PARSE_IMPL: 'wasm', S3_PARSE_IMPL: ' WASM ', LAYA_LOAD_ADVISOR: 'on', AUTOTUNE_PLAN_IMPL: '', PRESET_RELOAD_IMPL: 'wasm', CHAT_TEMPLATE_CAPS_IMPL: 'wasm' }, log), []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(davParseWasm.warnRetiredFlags({ DAV_PARSE_IMPL: 'js', CHAT_TEMPLATE_CAPS_IMPL: 'off', LAYA_LOAD_ADVISOR: 'off', S3_PARSE_IMPL: 'js' }, log),
    ['CHAT_TEMPLATE_CAPS_IMPL', 'LAYA_LOAD_ADVISOR', 'DAV_PARSE_IMPL', 'S3_PARSE_IMPL']);
  assert.deepEqual(warnings, ['CHAT_TEMPLATE_CAPS_IMPL is retired; Rust is always used', 'LAYA_LOAD_ADVISOR is retired; Rust is always used',
    'DAV_PARSE_IMPL is retired; Rust is always used', 'S3_PARSE_IMPL is retired; Rust is always used']);
  // A retired switch is not a startup switch: it never selects or deselects the module.
  assert.deepEqual(davParseWasm.wasmFlags({ DAV_PARSE_IMPL: 'wasm', CHAT_TEMPLATE_CAPS_IMPL: 'wasm' }), []);
});

test('the nine switches retired in #1071 batch 3: =wasm is silent, anything else warns once, none selects the module', () => {
  const batch3 = ['POLICY_LEAVES_IMPL', 'CODE_REVIEW_VERDICT_IMPL', 'TOOL_EXCHANGE_IMPL', 'DECISION_IMPL', 'COMPLETENESS_REPORT_IMPL', 'TASK_LIFECYCLE_IMPL', 'MCP_SERVERS_IMPL', 'CODE_NET_GUARD_IMPL', 'LLAMACPP_AUTOCONFIG_IMPL'];
  const warnings = [];
  const log = { warn: (m) => warnings.push(m) };
  for (const flag of batch3) {
    assert.equal(davParseWasm.RETIRED_FLAGS[flag], 'wasm', flag);
    assert.ok(!davParseWasm.IMPL_FLAGS.includes(flag), flag);
  }
  assert.deepEqual(davParseWasm.warnRetiredFlags(Object.fromEntries(batch3.map((f) => [f, ' WASM '])), log), []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(davParseWasm.warnRetiredFlags(Object.fromEntries(batch3.map((f) => [f, 'js'])), log), batch3);
  assert.deepEqual(warnings, batch3.map((f) => `${f} is retired; Rust is always used`));
  assert.deepEqual(davParseWasm.wasmFlags(Object.fromEntries(batch3.map((f) => [f, 'wasm']))), []);
  // The switches left are exactly the ones this batch did not touch.
  assert.deepEqual(davParseWasm.IMPL_FLAGS, ['STORAGE_PATH_IMPL', 'SECRET_ENVELOPE_IMPL', 'STREAM_GUARD_IMPL', 'GGUF_META_IMPL', 'ROLE_CONTEXT_IMPL', 'CODE_ACTIONS_IMPL', 'PROJECT_FILE_NAMES_IMPL', 'PROVIDER_EGRESS_IMPL', 'BROWSER_POLICY_IMPL', 'TOOL_GATE_IMPL', 'TOOLBOXES_PERMITTED_IMPL']);
});

test('a wasm switch with a missing or tampered module throws, naming the switch and the reason', (t) => {
  const tampered = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'startup-996-')), 'dav-parse.wasm');
  t.after(() => fs.rmSync(path.dirname(tampered), { recursive: true, force: true }));
  fs.writeFileSync(tampered, Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  for (const [file, reason] of [[MISSING, 'missing'], [tampered, 'checksum']]) {
    for (const flag of davParseWasm.IMPL_FLAGS) {
      assert.throws(() => davParseWasm.verifyAtStartup({ [flag]: 'wasm', DAV_PARSE_WASM: file }),
        (e) => e.reason === reason && e.flags.includes(flag) && e.message.includes(`${flag} set to wasm`) && e.message.includes(`(${reason})`));
    }
  }
  davParseWasm.reset();
});

test('the runtime URL parser check is unconditional: a runtime that maps U+1E9E differently stops startup (was PROMPT_FRAMING_IMPL=wasm)', (t) => {
  davParseWasm.reset();
  t.after(() => davParseWasm.reset());
  assert.equal(davParseWasm.framingRuntimeMatches(() => 'ss.io'), true);
  assert.equal(davParseWasm.framingRuntimeMatches(() => 'xn--zca.io'), false);
  assert.equal(davParseWasm.framingRuntimeMatches(() => { throw new Error('bad url'); }), false);
  // No switch set at all, and not even a wasm file consulted: the runtime check comes first.
  for (const env of [{}, { PROMPT_FRAMING_IMPL: 'js' }, { PROMPT_FRAMING_IMPL: 'wasm', DAV_PARSE_WASM: MISSING }]) {
    assert.throws(() => davParseWasm.verifyAtStartup(env, { hostname: () => 'xn--zca.io' }), (e) => e.reason === 'runtime' && /does not map U\+1E9E/.test(e.message));
    assert.throws(() => davParseWasm.verifyAtStartup(env, { hostname: () => { throw new Error('bad url'); } }), (e) => e.reason === 'runtime');
  }
  // This runtime agrees with the pinned port (CI runs Node 22).
  assert.equal(davParseWasm.framingRuntimeMatches(), true, `Node ${process.version}`);
});

test('a wasm switch with the pinned module verifies and leaves it ready', { skip: skipWasm }, () => {
  davParseWasm.reset();
  assert.deepEqual(davParseWasm.verifyAtStartup({ SECRET_ENVELOPE_IMPL: 'wasm', DAV_PARSE_WASM: wasmFile }), ['SECRET_ENVELOPE_IMPL']);
  assert.ok(davParseWasm.memoryBytes() > 0);
  davParseWasm.reset();
});

test('index.cjs refuses to start with a clear log line when the module is missing', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-996-data-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'index.cjs')], {
    env: { ...process.env, UI_DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', PUBLIC_ORIGIN: 'http://localhost', DIARY_AUTH_TOKEN: 'test-cowork-token', SECRET_ENVELOPE_IMPL: 'wasm', DAV_PARSE_WASM: MISSING },
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(r.status, 1, `exit ${r.status} signal ${r.signal}\n${r.stderr.slice(-2000)}`);
  assert.match(r.stderr, /FATAL: SECRET_ENVELOPE_IMPL set to wasm, but dav-parse\.wasm failed verification \(missing\)/);
  assert.doesNotMatch(r.stdout, /listening on/);
});

test('index.cjs refuses to start without the module even with every retired switch left at js, and warns about them', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-1071-data-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'index.cjs')], {
    env: { ...process.env, UI_DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', PUBLIC_ORIGIN: 'http://localhost', DIARY_AUTH_TOKEN: 'test-cowork-token', DAV_PARSE_WASM: MISSING,
      DAV_PARSE_IMPL: 'js', S3_PARSE_IMPL: 'js', CHAT_TEMPLATE_CAPS_IMPL: 'off', AUTOTUNE_PLAN_IMPL: 'js', PRESET_RELOAD_IMPL: 'off', LAYA_LOAD_ADVISOR: 'off',
      MCP_FRAME_IMPL: 'js', UPLOAD_SNIFF_IMPL: 'js', S3_SIGN_IMPL: 'js', PROMPT_FRAMING_IMPL: 'js', SSRF_IMPL: 'js',
      POLICY_LEAVES_IMPL: 'js', CODE_REVIEW_VERDICT_IMPL: 'js', TOOL_EXCHANGE_IMPL: 'js', DECISION_IMPL: 'js', COMPLETENESS_REPORT_IMPL: 'js', TASK_LIFECYCLE_IMPL: 'js', MCP_SERVERS_IMPL: 'js', CODE_NET_GUARD_IMPL: 'js', LLAMACPP_AUTOCONFIG_IMPL: 'js' },
    encoding: 'utf8', timeout: 60000,
  });
  assert.equal(r.status, 1, `exit ${r.status} signal ${r.signal}\n${r.stderr.slice(-2000)}`);
  assert.match(r.stderr, /FATAL: dav-parse\.wasm \(always required\) failed verification \(missing\)/);
  for (const flag of Object.keys(davParseWasm.RETIRED_FLAGS)) assert.match(r.stderr, new RegExp(`${flag} is retired; Rust is always used`));
  assert.doesNotMatch(r.stdout, /listening on/);
});

test('index.cjs starts with the pinned module and every retired switch left at js (a warning each, no crash)', { skip: skipWasm }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-1071-ok-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const child = require('node:child_process').spawn(process.execPath, [path.join(__dirname, 'index.cjs')], {
    env: { ...process.env, UI_DATA_DIR: dataDir, UI_PORT: '0', PORT: '0', HOST: '127.0.0.1', PUBLIC_ORIGIN: 'http://localhost', DIARY_AUTH_TOKEN: 'test-cowork-token', DAV_PARSE_WASM: wasmFile,
      DAV_PARSE_IMPL: 'js', S3_PARSE_IMPL: 'js', CHAT_TEMPLATE_CAPS_IMPL: 'off', AUTOTUNE_PLAN_IMPL: 'js', PRESET_RELOAD_IMPL: 'off', LAYA_LOAD_ADVISOR: 'off',
      MCP_FRAME_IMPL: 'js', UPLOAD_SNIFF_IMPL: 'js', S3_SIGN_IMPL: 'js', PROMPT_FRAMING_IMPL: 'js', SSRF_IMPL: 'js',
      POLICY_LEAVES_IMPL: 'js', CODE_REVIEW_VERDICT_IMPL: 'js', TOOL_EXCHANGE_IMPL: 'js', DECISION_IMPL: 'js', COMPLETENESS_REPORT_IMPL: 'js', TASK_LIFECYCLE_IMPL: 'js', MCP_SERVERS_IMPL: 'js', CODE_NET_GUARD_IMPL: 'js', LLAMACPP_AUTOCONFIG_IMPL: 'js' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  const deadline = Date.now() + 30000;
  while (!/dav-parse\.wasm verified/.test(out) && child.exitCode === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.match(out, /\[dav-parse\] dav-parse\.wasm verified/, `stdout ${out.slice(-500)} stderr ${err.slice(-500)}`);
  assert.equal(child.exitCode, null, 'still running');
  for (const flag of Object.keys(davParseWasm.RETIRED_FLAGS)) assert.match(err, new RegExp(`${flag} is retired; Rust is always used`));
});
