'use strict';

// Differential tests for the credential envelopes (#979): the JS implementation
// (server/secret-envelope.cjs openJs, encryptJs) and its Rust port in dav-parse.wasm
// (sbstndalton/noevia-rs crates/secret-envelope) must agree on every synthetic fixture in
// tests/fixtures/secret-envelope.v1.json (byte-identical to noevia-rs's copy; CI compares them):
// the same plaintext or the same refusal class for every open, and byte-identical envelopes for a
// seal with the same nonce. Then round trips: what one writes, the other opens. The WebAssembly
// half needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); it is skipped without it unless
// DAV_PARSE_WASM_REQUIRED=1. Synthetic keys only.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const envelope = require('../../server/secret-envelope.cjs');
const davParseWasm = require('../../server/dav-parse-wasm.cjs');

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/secret-envelope.v1.json'), 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

const KEYS = Object.fromEntries(Object.entries(fixtures.keys).map(([k, v]) => [k, Buffer.from(v, 'hex')]));
const str16 = (h) => { const b = Buffer.from(h, 'hex'); let s = ''; for (let i = 0; i < b.length; i += 2) s += String.fromCharCode(b.readUInt16LE(i)); return s; };
// An empty plaintext is only sealed for a non-empty value whose String() is '' (e.g. []).
const plainOf = (c) => (c.plain8 === '' ? [] : Buffer.from(c.plain8, 'hex').toString('utf8'));
const user = (c) => (c.user16 === null ? undefined : str16(c.user16));

function outcome(impl, c) {
  try {
    const r = envelope.open(KEYS[c.keys[0]], c.keys[1] ? KEYS[c.keys[1]] : null, str16(c.value16), user(c), { impl });
    return { keyUsed: r.keyUsed, plain16: Buffer.from(String(r.plain), 'utf16le').toString('hex') };
  } catch (err) {
    return { error: err.message === envelope.BOUND_FAILURE ? 'bound' : 'unopenable' };
  }
}

function withNonce(nonceHex, fn) {
  const real = crypto.randomBytes;
  crypto.randomBytes = (n) => (n === 12 ? Buffer.from(nonceHex, 'hex') : real(n));
  try { return fn(); } finally { crypto.randomBytes = real; }
}

test('the JS implementation reproduces every committed expectation', () => {
  assert.equal(fixtures.version, 1);
  assert.ok(fixtures.open.length >= 1000 && fixtures.seal.length >= 250, `${fixtures.open.length} open, ${fixtures.seal.length} seal`);
  for (const c of fixtures.open) assert.deepEqual(outcome('js', c), c.expect, c.name);
  for (const c of fixtures.seal) {
    const got = withNonce(c.nonce8, () => envelope.encryptJs(KEYS[c.key], plainOf(c), user(c)));
    assert.equal(got, c.expect, c.name);
  }
});

test('dav-parse.wasm opens and refuses exactly as JS on every fixture', { skip: skipWasm }, (t) => {
  t.mock.method(console, 'warn', () => {});
  davParseWasm.reset();
  const bad = fixtures.open.filter((c) => JSON.stringify(outcome('wasm', c)) !== JSON.stringify(c.expect));
  assert.deepEqual(bad.map((c) => c.name), [], `${bad.length} of ${fixtures.open.length} open fixtures disagree`);
  const badSeal = fixtures.seal.filter((c) => withNonce(c.nonce8, () => envelope.encrypt(KEYS[c.key], plainOf(c), user(c), { impl: 'wasm' })) !== c.expect);
  assert.deepEqual(badSeal.map((c) => c.name), [], `${badSeal.length} of ${fixtures.seal.length} seal fixtures disagree`);
  console.log(`# secret-envelope differential: ${fixtures.open.length} open and ${fixtures.seal.length} seal fixtures agree`);
});

test('round trips with random nonces: js writes, wasm opens; wasm writes, js opens', { skip: skipWasm }, () => {
  let seed = 0x979979;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const pieces = ['a', 'é', '😀', '\ud800', '\udc00', '\u0000', '{"k":1}', ' ', 'enc:v2:'];
  const [k, prev] = [KEYS.current, KEYS.previous];
  let n = 0;
  for (; n < 500; n++) {
    let p = ''; for (let i = Math.floor(rand() * 30) + 1; i > 0; i--) p += pick(pieces);
    const u = pick([undefined, null, '', 0, 7, 'u1', '11111111-1111-4111-8111-111111111111', 'u\ud800']);
    const want = Buffer.from(p, 'utf8').toString('utf8');
    const fromJs = envelope.encrypt(k, p, u, { impl: 'js' });
    const fromWasm = envelope.encrypt(k, p, u, { impl: 'wasm' });
    assert.notEqual(fromJs, fromWasm, 'fresh nonces');
    for (const v of [fromJs, fromWasm]) {
      assert.equal(v.slice(0, 7), envelope.hasUser(u) ? 'enc:v2:' : 'enc:v1:');
      for (const impl of ['js', 'wasm']) {
        assert.deepEqual(envelope.open(k, null, v, u, { impl }), { plain: want, keyUsed: 'current' }, `round trip ${n} ${impl}`);
        // Rotation: the same value under the previous key.
        assert.deepEqual(envelope.open(prev, k, v, u, { impl }), { plain: want, keyUsed: 'previous' });
      }
    }
  }
  console.log(`# secret-envelope differential: ${n}/${n} random round trips agree (js->wasm, wasm->js, rotation)`);
});

test('wasm nonces come from crypto.randomBytes: no repeats over 2000 seals', { skip: skipWasm }, () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const v = envelope.encrypt(KEYS.current, 'same plaintext', 'u1', { impl: 'wasm' });
    seen.add(Buffer.from(v.slice(7), 'base64url').subarray(0, 12).toString('hex'));
  }
  assert.equal(seen.size, 2000);
});
