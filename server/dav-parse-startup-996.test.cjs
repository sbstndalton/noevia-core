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
  assert.deepEqual(davParseWasm.IMPL_FLAGS, ['DAV_PARSE_IMPL', 'S3_PARSE_IMPL', 'STORAGE_PATH_IMPL', 'UPLOAD_SNIFF_IMPL', 'SECRET_ENVELOPE_IMPL', 'MCP_FRAME_IMPL', 'CHAT_TEMPLATE_CAPS_IMPL', 'AUTOTUNE_PLAN_IMPL', 'PRESET_RELOAD_IMPL', 'PROMPT_FRAMING_IMPL', 'S3_SIGN_IMPL', 'SSRF_IMPL', 'STREAM_GUARD_IMPL', 'GGUF_META_IMPL', 'POLICY_LEAVES_IMPL', 'CODE_REVIEW_VERDICT_IMPL', 'TOOL_EXCHANGE_IMPL', 'MCP_SERVERS_IMPL', 'DECISION_IMPL', 'CODE_NET_GUARD_IMPL', 'ROLE_CONTEXT_IMPL', 'COMPLETENESS_REPORT_IMPL']);
  assert.deepEqual(davParseWasm.wasmFlags({}), []);
  assert.deepEqual(davParseWasm.wasmFlags({ DAV_PARSE_IMPL: 'js', S3_PARSE_IMPL: 'rust', UPLOAD_SNIFF_IMPL: '' }), []);
  assert.deepEqual(davParseWasm.wasmFlags({ SECRET_ENVELOPE_IMPL: ' WASM ', STORAGE_PATH_IMPL: 'wasm' }), ['STORAGE_PATH_IMPL', 'SECRET_ENVELOPE_IMPL']);
});

test('no wasm switch: nothing is loaded, even with no module', () => {
  davParseWasm.reset();
  assert.deepEqual(davParseWasm.verifyAtStartup({ DAV_PARSE_WASM: MISSING }), []);
  assert.equal(davParseWasm.memoryBytes(), 0);
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
