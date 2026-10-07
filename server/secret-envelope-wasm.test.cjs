'use strict';

// SECRET_ENVELOPE_IMPL (#979): js is the default and unchanged; wasm runs the Rust port inside
// dav-parse.wasm, reads every existing v1/v2 value (no migration), and fails closed with fixed
// messages, never returning plaintext, re-encrypting or logging key/plaintext/ciphertext.
// Synthetic keys and values only.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('./dav-parse-wasm.cjs');
const envelope = require('./secret-envelope.cjs');
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

test('SECRET_ENVELOPE_IMPL defaults to js; unknown values mean js with one warning', (t) => {
  const fn = envelope.secretEnvelopeImpl;
  assert.equal(fn({}), 'js');
  assert.equal(fn({ SECRET_ENVELOPE_IMPL: '' }), 'js');
  assert.equal(fn({ SECRET_ENVELOPE_IMPL: ' WASM ' }), 'wasm');
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(fn({ SECRET_ENVELOPE_IMPL: 'rust' }), 'js');
  assert.equal(fn({ SECRET_ENVELOPE_IMPL: 'rust' }), 'js');
  assert.equal(warn.mock.callCount(), 1);
});

test('the default path is the JS code: it works with no module at all', (t) => {
  withEnv({ SECRET_ENVELOPE_IMPL: undefined, DAV_PARSE_WASM: MISSING }, () => {
    const s = createSecretStore(tmp(t), noPrev);
    assert.equal(s.decrypt(s.encrypt('synthetic', USER), USER), 'synthetic');
  });
});

test('wasm fails closed when the module is missing or tampered: fixed messages, no plaintext, nothing logged but the reason', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const dir = tmp(t);
  const s = createSecretStore(dir, noPrev);
  const stored = s.encrypt('synthetic-plaintext-xyz', USER);
  const tampered = path.join(dir, 'dav-parse.wasm');
  fs.writeFileSync(tampered, Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  for (const [file, reason] of [[MISSING, 'missing'], [tampered, 'checksum']]) {
    withEnv({ SECRET_ENVELOPE_IMPL: 'wasm', DAV_PARSE_WASM: file }, () => {
      assert.throws(() => s.decrypt(stored, USER), (e) => e.message === envelope.OPEN_FAILURE && e.code === 'secret_envelope_failed' && e.reason === reason);
      assert.throws(() => s.encrypt('synthetic-plaintext-xyz', USER), (e) => e.message === envelope.SEAL_FAILURE && e.reason === reason);
      assert.equal(s.canDecrypt(stored, USER), false);
      // reseal (rotation) reports the failure and writes nothing.
      const report = s.rotate({ tables: [{ name: 't', rows: () => [{ ref: 1, value: stored, userId: USER }], write: () => assert.fail('must not write') }] });
      assert.equal(report.totals.failed, 1);
    });
  }
  const key = fs.readFileSync(path.join(dir, 'secrets.key'));
  const logged = warn.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
  assert.match(logged, /secret-envelope open failed \(missing\)/);
  for (const secret of ['synthetic-plaintext-xyz', stored, stored.slice(7, 30), key.toString('hex'), key.toString('base64')]) assert.ok(!logged.includes(secret));
});

test('flag flip: js-written values open under wasm, wasm-written under js, and all still open after flipping back', { skip: skipWasm }, (t) => {
  const dir = tmp(t);
  const values = ['synthetic-api-key', 'émoji 😀 漢字', JSON.stringify({ access_token: 'synthetic' }), 'x\ud800y', 'enc:v2:looks-enveloped'];
  const s = createSecretStore(dir, noPrev);
  const written = [];
  withEnv({ SECRET_ENVELOPE_IMPL: 'js' }, () => {
    for (const v of values) written.push({ v, u: USER, enc: s.encrypt(v, USER) }, { v, u: undefined, enc: s.encrypt(v) });
  });
  withEnv({ SECRET_ENVELOPE_IMPL: 'wasm' }, () => {
    for (const w of written) assert.equal(s.decrypt(w.enc, w.u), Buffer.from(w.v).toString('utf8'));
    for (const v of values) written.push({ v, u: USER, enc: s.encrypt(v, USER) }, { v, u: undefined, enc: s.encrypt(v) });
    for (const w of written) assert.equal(s.decrypt(w.enc, w.u), Buffer.from(w.v).toString('utf8'));
    assert.equal(s.encrypt(''), '');
    assert.equal(s.decrypt('legacy plaintext'), 'legacy plaintext');
    assert.throws(() => s.decrypt(written[0].enc), /bound to an account/);
    assert.throws(() => s.decrypt(written[0].enc, 'someone-else'), (e) => e.message === envelope.OPEN_FAILURE);
  });
  withEnv({ SECRET_ENVELOPE_IMPL: 'js' }, () => {
    for (const w of written) assert.equal(s.decrypt(w.enc, w.u), Buffer.from(w.v).toString('utf8'));
  });
});

test('wasm rotation: values under the previous key are resealed under the current one', { skip: skipWasm }, (t) => {
  const dir = tmp(t);
  const old = createSecretStore(dir, noPrev);
  const v1 = old.encrypt('synthetic-v1'), v2 = old.encrypt('synthetic-v2', USER);
  fs.renameSync(path.join(dir, 'secrets.key'), path.join(dir, 'secrets.key.previous'));
  const rows = [{ ref: 'a', value: v1 }, { ref: 'b', value: v2, userId: USER }];
  const out = {};
  withEnv({ SECRET_ENVELOPE_IMPL: 'wasm' }, () => {
    const fresh = createSecretStore(dir, noPrev);
    const report = fresh.rotate({ tables: [{ name: 't', rows: () => rows, write: (ref, value) => { out[ref] = value; } }] });
    assert.equal(report.totals.rotated, 2);
    assert.equal(fresh.decrypt(out.a), 'synthetic-v1');
    assert.equal(fresh.decrypt(out.b, USER), 'synthetic-v2');
  });
  fs.rmSync(path.join(dir, 'secrets.key.previous'));
  withEnv({ SECRET_ENVELOPE_IMPL: 'js' }, () => {
    const after = createSecretStore(dir, noPrev);
    assert.equal(after.decrypt(out.a), 'synthetic-v1');
    assert.equal(after.decrypt(out.b, USER), 'synthetic-v2');
    assert.equal(after.canDecrypt(v1), false);
  });
});

test('wasm wipes the linear memory and drops the instance after every secret call', { skip: skipWasm }, (t) => {
  const key = Buffer.alloc(32, 0xa7);
  const marker = 'synthetic-marker-plaintext-0123456789';
  const instances = [];
  const Real = WebAssembly.Instance;
  t.mock.method(WebAssembly, 'Instance', function Instance(m, i) { const inst = new Real(m, i); instances.push(inst); return inst; });
  const contains = (mem, needle) => Buffer.from(mem.buffer).indexOf(needle) !== -1;
  withEnv({ SECRET_ENVELOPE_IMPL: 'wasm' }, () => {
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

test('wasm: caps (8 MiB plaintext round trips, one byte more is refused) and the short-tag hardening', { skip: skipWasm }, (t) => {
  t.mock.method(console, 'warn', () => {});
  const key = Buffer.alloc(32, 3);
  withEnv({ SECRET_ENVELOPE_IMPL: 'wasm' }, () => {
    const big = 'b'.repeat(davParseWasm.MAX_SECRET_PLAIN_BYTES);
    const sealed = envelope.encrypt(key, big, USER);
    assert.ok(envelope.openJs(key, null, sealed, USER).plain === big);
    assert.ok(envelope.open(key, null, envelope.encryptJs(key, big, USER), USER).plain === big);
    assert.throws(() => envelope.encrypt(key, `${big}b`, USER), (e) => e.message === envelope.SEAL_FAILURE && e.reason === 'too_large');
    assert.throws(() => envelope.open(key, null, `enc:v1:${'A'.repeat(davParseWasm.MAX_SECRET_UNITS)}`), (e) => e.message === envelope.OPEN_FAILURE && e.reason === 'too_large');
  });
});

test('both js and wasm refuse a truncated GCM tag (a valid 12-byte tag over an empty body, #995)', (t) => {
  t.mock.method(console, 'warn', () => {});
  const key = Buffer.alloc(32, 3);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv); c.final();
  const tag = c.getAuthTag();
  const full = `enc:v1:${Buffer.concat([iv, tag]).toString('base64url')}`;
  for (const impl of skipWasm ? ['js'] : ['js', 'wasm']) {
    assert.equal(envelope.open(key, null, full, undefined, { impl }).plain, '', `${impl}: the full tag opens`);
    for (const n of [4, 8, 12, 15]) {
      const short = `enc:v1:${Buffer.concat([iv, tag.subarray(0, n)]).toString('base64url')}`;
      assert.throws(() => envelope.open(key, null, short, undefined, { impl }), impl === 'wasm' ? (e) => e.message === envelope.OPEN_FAILURE && e.reason === 'unopenable' : /truncated/, `${impl} ${n}-byte tag`);
    }
  }
});
