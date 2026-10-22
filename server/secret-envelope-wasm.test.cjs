'use strict';

// The credential envelopes (#979), always Rust since #1071 (they were SECRET_ENVELOPE_IMPL, default
// js): the port inside dav-parse.wasm reads every v1/v2 value the JS code wrote (no migration), and
// fails closed with fixed messages, never returning plaintext, re-encrypting or logging
// key/plaintext/ciphertext. A leftover SECRET_ENVELOPE_IMPL never brings the JS code back; the JS
// code is a test oracle (tests/server/oracle/secret-envelope.cjs). Synthetic keys and values only.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('./dav-parse-wasm.cjs');
const envelope = require('./secret-envelope.cjs');
const oracle = require('../tests/server/oracle/secret-envelope.cjs');
const { createSecretStore } = require('./secrets.cjs');

const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const required = process.env.DAV_PARSE_WASM_REQUIRED === '1';
const skipWasm = !fs.existsSync(wasmFile) && !required && 'dav-parse.wasm not built (set DAV_PARSE_WASM_REQUIRED=1 to require it)';
const MISSING = path.join(os.tmpdir(), 'no-such-secret-dav-parse.wasm');
const USER = '11111111-1111-4111-8111-111111111111';

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  davParseWasm.reset();
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    davParseWasm.reset();
  }
}
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-envelope-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const noPrev = { env: {} };
const keyIn = (dir, name = 'secrets.key') => fs.readFileSync(path.join(dir, name));

test('SECRET_ENVELOPE_IMPL is retired (#1071): no selector and no JS envelope code are left in production', () => {
  assert.deepEqual(Object.keys(envelope).sort(), ['BOUND_FAILURE', 'OPEN_FAILURE', 'SEAL_FAILURE', 'encrypt', 'hasUser', 'open', 'versionOf']);
  for (const gone of ['secretEnvelopeImpl', 'encryptJs', 'decryptWithJs', 'openJs', 'aadFor']) assert.equal(envelope[gone], undefined, gone);
  assert.equal(davParseWasm.RETIRED_FLAGS.SECRET_ENVELOPE_IMPL, 'wasm');
  // The two helpers secrets.cjs keeps for rotation's bookkeeping are the reference's.
  for (const v of ['', 'x', 'enc:v1:', 'enc:v2:abc', 'enc:v3:x', 'ENC:v1:x', ' enc:v1:x']) assert.equal(envelope.versionOf(v), oracle.versionOf(v), v);
  for (const u of [undefined, null, '', 0, 'u', false, NaN]) assert.equal(envelope.hasUser(u), oracle.hasUser(u), String(u));
});

for (const leftover of [undefined, 'js', 'wasm']) {
  test(`fails closed when the module is missing or tampered (SECRET_ENVELOPE_IMPL=${leftover}): fixed messages, no plaintext, nothing logged but the reason`, (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    const dir = tmp(t);
    const s = createSecretStore(dir, noPrev);
    // Written by the JS code the release before #1071 ran (the oracle is that code, unchanged).
    const stored = oracle.encryptJs(keyIn(dir), 'synthetic-plaintext-xyz', USER);
    const tampered = path.join(dir, 'dav-parse.wasm');
    fs.writeFileSync(tampered, Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    for (const [file, reason] of [[MISSING, 'missing'], [tampered, 'checksum']]) {
      withEnv({ SECRET_ENVELOPE_IMPL: leftover, DAV_PARSE_WASM: file }, () => {
        assert.throws(() => s.decrypt(stored, USER), (e) => e.message === envelope.OPEN_FAILURE && e.code === 'secret_envelope_failed' && e.reason === reason);
        assert.throws(() => s.encrypt('synthetic-plaintext-xyz', USER), (e) => e.message === envelope.SEAL_FAILURE && e.reason === reason);
        assert.equal(s.canDecrypt(stored, USER), false);
        // An empty value never needs the module.
        assert.equal(s.encrypt(''), '');
        // reseal (rotation) reports the failure and writes nothing.
        const report = s.rotate({ tables: [{ name: 't', rows: () => [{ ref: 1, value: stored, userId: USER }], write: () => assert.fail('must not write') }] });
        assert.equal(report.totals.failed, 1);
      });
    }
    const key = keyIn(dir);
    const logged = warn.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
    assert.match(logged, /secret-envelope open failed \(missing\)/);
    assert.doesNotMatch(logged, /SECRET_ENVELOPE_IMPL/);
    for (const secret of ['synthetic-plaintext-xyz', stored, stored.slice(7, 30), key.toString('hex'), key.toString('base64')]) assert.ok(!logged.includes(secret));
  });
}

test('values the JS code wrote open under Rust, values Rust writes open with the JS reference, whatever a leftover SECRET_ENVELOPE_IMPL says', { skip: skipWasm }, (t) => {
  const dir = tmp(t);
  const values = ['synthetic-api-key', 'émoji 😀 漢字', JSON.stringify({ access_token: 'synthetic' }), 'x\ud800y', 'enc:v2:looks-enveloped', 7, { toString: () => 'synthetic-object' }];
  const s = createSecretStore(dir, noPrev);
  const key = keyIn(dir);
  const want = (v) => Buffer.from(String(v)).toString('utf8');
  const written = [];
  for (const v of values) written.push({ v, u: USER, enc: oracle.encryptJs(key, v, USER) }, { v, u: undefined, enc: oracle.encryptJs(key, v) }, { v, u: 42, enc: oracle.encryptJs(key, v, 42) });
  for (const leftover of [undefined, 'js', 'wasm', 'rust']) {
    withEnv({ SECRET_ENVELOPE_IMPL: leftover }, () => {
      for (const w of written) assert.equal(s.decrypt(w.enc, w.u), want(w.v), `${leftover} ${w.enc.slice(0, 7)}`);
      const fresh = values.map((v) => ({ v, u: USER, enc: s.encrypt(v, USER) })).concat(values.map((v) => ({ v, u: undefined, enc: s.encrypt(v) })));
      for (const w of fresh) {
        assert.equal(w.enc.slice(0, 7), w.u === undefined ? 'enc:v1:' : 'enc:v2:');
        assert.deepEqual(oracle.openJs(key, null, w.enc, w.u), { plain: want(w.v), keyUsed: 'current' });
      }
      assert.equal(s.encrypt(''), '');
      assert.equal(s.encrypt(null), '');
      assert.equal(s.decrypt('legacy plaintext'), 'legacy plaintext');
      assert.equal(s.decrypt(''), '');
      assert.throws(() => s.decrypt(written[0].enc), /bound to an account/);
      assert.throws(() => s.decrypt(written[0].enc, 'someone-else'), (e) => e.message === envelope.OPEN_FAILURE);
    });
  }
});

test('rotation: values the JS code wrote under the previous key are resealed under the current one', { skip: skipWasm }, (t) => {
  const dir = tmp(t);
  createSecretStore(dir, noPrev);
  const oldKey = keyIn(dir);
  const v1 = oracle.encryptJs(oldKey, 'synthetic-v1'), v2 = oracle.encryptJs(oldKey, 'synthetic-v2', USER);
  fs.renameSync(path.join(dir, 'secrets.key'), path.join(dir, 'secrets.key.previous'));
  const rows = [{ ref: 'a', value: v1 }, { ref: 'b', value: v2, userId: USER }, { ref: 'c', value: 'legacy-plain', userId: USER }, { ref: 'd', value: '' }];
  const out = {};
  const fresh = createSecretStore(dir, noPrev);
  const report = fresh.rotate({ tables: [{ name: 't', rows: () => rows, write: (ref, value) => { out[ref] = value; } }] });
  assert.deepEqual(report.totals, { current: 0, rotated: 2, upgraded: 1, empty: 1, failed: 0 });
  assert.equal(fresh.decrypt(out.a), 'synthetic-v1');
  assert.equal(fresh.decrypt(out.b, USER), 'synthetic-v2');
  assert.equal(fresh.decrypt(out.c, USER), 'legacy-plain');
  // A second run finds everything current.
  const again = fresh.rotate({ tables: [{ name: 't', rows: () => Object.entries(out).map(([ref, value]) => ({ ref, value, userId: ref === 'a' ? undefined : USER })), write: () => assert.fail('nothing to reseal') }] });
  assert.deepEqual(again.totals, { current: 3, rotated: 0, upgraded: 0, empty: 0, failed: 0 });
  fs.rmSync(path.join(dir, 'secrets.key.previous'));
  const after = createSecretStore(dir, noPrev);
  const current = keyIn(dir);
  assert.equal(oracle.openJs(current, null, out.a).plain, 'synthetic-v1');
  assert.equal(oracle.openJs(current, null, out.b, USER).plain, 'synthetic-v2');
  assert.equal(after.canDecrypt(v1), false);
});

test('Rust wipes the linear memory and drops the instance after every secret call', { skip: skipWasm }, (t) => {
  const key = Buffer.alloc(32, 0xa7);
  const marker = 'synthetic-marker-plaintext-0123456789';
  const instances = [];
  const Real = WebAssembly.Instance;
  t.mock.method(WebAssembly, 'Instance', function Instance(m, i) { const inst = new Real(m, i); instances.push(inst); return inst; });
  const contains = (mem, needle) => Buffer.from(mem.buffer).indexOf(needle) !== -1;
  withEnv({}, () => {
    const sealed = envelope.encrypt(key, marker, USER);
    assert.equal(davParseWasm.memoryBytes(), 0);
    assert.equal(envelope.open(key, null, sealed, USER).plain, marker);
    assert.equal(davParseWasm.memoryBytes(), 0);
    assert.throws(() => envelope.open(Buffer.alloc(32, 0xb8), key, sealed, 'someone-else'));
    assert.ok(instances.length >= 3);
    for (const inst of instances) {
      const mem = inst.exports.memory;
      assert.ok(Buffer.from(mem.buffer).every((b) => b === 0), 'linear memory is all zeros');
      for (const needle of [key.subarray(0, 8), Buffer.from(marker), Buffer.from(sealed.slice(7, 30))]) assert.ok(!contains(mem, needle));
    }
  });
});

test('caps: an 8 MiB plaintext round trips both ways, one byte more is refused, not sealed differently', { skip: skipWasm }, (t) => {
  t.mock.method(console, 'warn', () => {});
  const key = Buffer.alloc(32, 3);
  withEnv({}, () => {
    const big = 'b'.repeat(davParseWasm.MAX_SECRET_PLAIN_BYTES);
    const sealed = envelope.encrypt(key, big, USER);
    assert.ok(oracle.openJs(key, null, sealed, USER).plain === big);
    assert.ok(envelope.open(key, null, oracle.encryptJs(key, big, USER), USER).plain === big);
    assert.throws(() => envelope.encrypt(key, `${big}b`, USER), (e) => e.message === envelope.SEAL_FAILURE && e.reason === 'too_large');
    assert.throws(() => envelope.open(key, null, `enc:v1:${'A'.repeat(davParseWasm.MAX_SECRET_UNITS)}`), (e) => e.message === envelope.OPEN_FAILURE && e.reason === 'too_large');
  });
});

test('both the JS reference and Rust refuse a truncated GCM tag (a valid 12-byte tag over an empty body, #995)', { skip: skipWasm }, (t) => {
  t.mock.method(console, 'warn', () => {});
  const key = Buffer.alloc(32, 3);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv); c.final();
  const tag = c.getAuthTag();
  const full = `enc:v1:${Buffer.concat([iv, tag]).toString('base64url')}`;
  assert.equal(oracle.openJs(key, null, full).plain, '', 'js: the full tag opens');
  assert.equal(envelope.open(key, null, full).plain, '', 'rust: the full tag opens');
  for (const n of [4, 8, 12, 15]) {
    const short = `enc:v1:${Buffer.concat([iv, tag.subarray(0, n)]).toString('base64url')}`;
    assert.throws(() => oracle.openJs(key, null, short), /truncated/, `js ${n}-byte tag`);
    assert.throws(() => envelope.open(key, null, short), (e) => e.message === envelope.OPEN_FAILURE && e.reason === 'unopenable', `rust ${n}-byte tag`);
  }
});
