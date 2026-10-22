'use strict';

// #1071 retirement gate for the credential envelopes (#979). Production (server/secret-envelope.cjs)
// now seals and opens with the Rust port in dav-parse.wasm alone; the JS code the release before
// ran is the oracle (tests/server/oracle/secret-envelope.cjs, moved unchanged). This drives both
// through the same calls over a generated hostile corpus built from envelopes the JS code sealed:
// every single-bit flip of iv, tag and body, every truncation, appended and inserted junk
// (including characters whose low byte Node's base64url reader would take as a digit), wrong and
// rotated keys, wrong, missing and look-alike users, version relabels, a v2 value replayed into
// another account, empty, odd and large plaintext, and non-string values and user ids.
//
// Every outcome must be the oracle's: the same plaintext and key, or the same refusal class
// ('bound' or 'unopenable'). The one documented difference is a bound the JS code did not have: a
// value over 12 Mi UTF-16 units, plaintext over 8 MiB or a user id over 64 KiB is refused
// ('too_large'), never answered differently. A replay into the same account opens in both, by
// design (an envelope is not a one-time token). Synthetic keys and values only. Needs dav-parse.wasm.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const test = require('node:test');

const oracle = require('./oracle/secret-envelope.cjs');
const envelope = require('../../server/secret-envelope.cjs');
const davParseWasm = require('../../server/dav-parse-wasm.cjs');

const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

const keyOf = (label) => crypto.createHash('sha256').update(`noevia-core #1071 synthetic envelope key: ${label}`).digest();
const K = { current: keyOf('current'), previous: keyOf('previous'), other: keyOf('other') };
const USERS = [undefined, null, '', 0, 7, 'u1', '11111111-1111-4111-8111-111111111111', 'u\ud800', 'U1', 'u1 ', 'u1', false, NaN];

function outcome(open, key, prev, value, user) {
  try {
    const r = open(key, prev, value, user);
    return { keyUsed: r.keyUsed, plain: r.plain };
  } catch (e) {
    if (e.reason === 'too_large') return { error: 'too_large' };
    // The JS code threw Node's own messages; production fixed ones. The class is what callers see.
    return { error: e.message === envelope.BOUND_FAILURE ? 'bound' : 'unopenable' };
  }
}

const enc = (raw, version) => `enc:v${version}:${Buffer.from(raw).toString('base64url')}`;
const rawOf = (value) => Buffer.from(value.slice(7), 'base64url');

/** [description, key, previousKey, value, user] cases built from JS-sealed envelopes. */
function corpus() {
  let seed = 0x1071979;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const plains = ['', 'a', 'synthetic-api-key', 'é漢😀', 'x\ud800y', '\0', 'enc:v2:looks-enveloped', JSON.stringify({ access_token: 'synthetic', refresh_token: 'synthetic' }),
    crypto.randomBytes(700).toString('base64'), 'p'.repeat(64 * 1024), 7, true, { toString: () => 'synthetic-object' }, []];
  const cases = [];
  const add = (why, key, prev, value, user) => cases.push([why, key, prev, value, user]);
  for (const p of plains) {
    for (const u of [undefined, 'u1', '11111111-1111-4111-8111-111111111111', 0]) {
      const sealed = oracle.encryptJs(K.current, p, u);
      if (!sealed) { add('empty value', K.current, null, sealed, u); continue; }
      const v = sealed.slice(4, 6) === 'v2' ? 2 : 1;
      // As written, with every user shape, every key arrangement.
      for (const user of USERS) add('user shape', K.current, null, sealed, user);
      add('right key', K.current, null, sealed, u);
      add('rotated: previous key opens', K.other, K.current, sealed, u);
      add('rotated: current key opens', K.current, K.other, sealed, u);
      add('wrong key', K.other, null, sealed, u);
      add('two wrong keys', K.other, K.previous, sealed, u);
      // Replay: the same value in another account, and in the same one.
      add('replayed into another account', K.current, null, sealed, 'someone-else');
      add('replayed into the same account', K.current, null, sealed, u);
      // Version relabels and look-alike prefixes.
      for (const prefix of ['enc:v1:', 'enc:v2:', 'enc:v3:', 'ENC:v1:', 'enc:V2:', 'enc:v1 ', ' enc:v1:', 'enc:v1::', 'enc:v2', 'enc:', '﻿enc:v2:']) add(`relabel ${prefix}`, K.current, null, prefix + sealed.slice(7), u);
      const raw = rawOf(sealed);
      if (p === 'a' || p === '' || p === 'synthetic-api-key') {
        // Tamper: every single-bit flip of iv, tag and body.
        for (let i = 0; i < raw.length; i++) for (let bit = 0; bit < 8; bit++) {
          const t = Buffer.from(raw); t[i] ^= 1 << bit; add(`flip byte ${i} bit ${bit}`, K.current, null, enc(t, v), u);
        }
        // Truncate: every prefix of the stored text.
        for (let n = 0; n < sealed.length; n++) add(`truncate to ${n}`, K.current, null, sealed.slice(0, n), u);
        // Raw truncation (a shorter tag over the same body).
        for (let n = 0; n < raw.length; n++) add(`raw truncate to ${n}`, K.current, null, enc(raw.subarray(0, n), v), u);
      }
      // Appended and inserted junk; Node reads a UTF-16 unit by its low byte.
      for (const junk of ['=', '==', 'A', 'AA', '=A', ' ', '\n', '!', '.', '+', '/', '\ud800', 'é', 'Ł', '乁', 'Ａ', '\0']) {
        add(`append ${JSON.stringify(junk)}`, K.current, null, sealed + junk, u);
        const at = 7 + Math.floor(rand() * (sealed.length - 7));
        add(`insert ${JSON.stringify(junk)}`, K.current, null, sealed.slice(0, at) + junk + sealed.slice(at), u);
      }
      // A random character swapped for another base64url digit.
      for (let n = 0; n < 8; n++) {
        const at = 7 + Math.floor(rand() * (sealed.length - 7));
        add('swap a digit', K.current, null, sealed.slice(0, at) + pick('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.split('')) + sealed.slice(at + 1), u);
      }
    }
  }
  // Plain values are returned as they are, never decrypted.
  for (const plain of ['', 'legacy-plaintext', 'enc', 'enc:', 'enc:v1', 'enc:v0:abc', null, undefined, 0, 'x'.repeat(10000)]) for (const u of [undefined, 'u1']) add('plain value', K.current, null, plain, u);
  // Garbage after a well-formed prefix.
  for (let n = 0; n < 300; n++) {
    let body = ''; for (let i = Math.floor(rand() * 80); i > 0; i--) body += pick(['A', 'z', '0', '-', '_', '=', '+', '/', ' ', 'é', '\ud800', 'Q', 'w']);
    add('garbage body', pick([K.current, K.other]), pick([null, K.current]), `${pick(['enc:v1:', 'enc:v2:'])}${body}`, pick(['u1', undefined]));
  }
  return cases;
}

test('production (Rust) opens, refuses and rotates exactly as the JS code did over a hostile corpus of JS-sealed envelopes', { skip: skipWasm }, (t) => {
  t.mock.method(console, 'warn', () => {});
  davParseWasm.reset();
  const cases = corpus();
  const bad = [];
  const tally = { opened: 0, none: 0, bound: 0, unopenable: 0 };
  for (const [why, key, prev, value, user] of cases) {
    const want = outcome(oracle.openJs, key, prev, value, user);
    const got = outcome(envelope.open, key, prev, value, user);
    if (JSON.stringify(got) !== JSON.stringify(want)) bad.push({ why, want, got });
    else if (want.error) tally[want.error] += 1;
    else tally[want.keyUsed === 'none' ? 'none' : 'opened'] += 1;
  }
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} of ${cases.length} cases diverge`);
  assert.ok(cases.length >= 5000, `${cases.length} cases`);
  for (const k of Object.keys(tally)) assert.ok(tally[k] > 0, `the corpus reaches ${k}`);
  console.log(`# secret-envelope retirement: ${cases.length} hostile open cases agree with the JS code (${tally.opened} opened, ${tally.none} plain, ${tally.bound} bound, ${tally.unopenable} unopenable); 0 divergences`);
});

test('every single-bit tamper and every truncation is refused, never opened to different plaintext', { skip: skipWasm }, () => {
  let n = 0;
  for (const [why, key, prev, value, user] of corpus()) {
    if (!/^(flip|raw truncate|truncate to)/.test(why)) continue;
    const r = outcome(envelope.open, key, prev, value, user);
    // A text truncated before the prefix is complete is a plain value, returned as it is.
    if (r.keyUsed === 'none') { assert.equal(r.plain, value || ''); continue; }
    assert.ok(r.error === 'unopenable' || r.error === 'bound', `${why}: ${JSON.stringify(r)}`);
    n += 1;
  }
  assert.ok(n > 1000, `${n} tampered or truncated envelopes`);
});

test('seals: Rust and JS write the same envelope for the same nonce, and each opens the other', { skip: skipWasm }, () => {
  const real = crypto.randomBytes;
  let n = 0;
  try {
    for (const p of ['a', 'é😀', 'x\ud800y', '\0', 7, { toString: () => 'obj' }, [], 'p'.repeat(100000)]) {
      for (const u of [undefined, null, '', 0, 'u1', 'u\ud800', 'x'.repeat(64 * 1024)]) {
        const nonce = real(12);
        crypto.randomBytes = (k) => (k === 12 ? Buffer.from(nonce) : real(k));
        const js = oracle.encryptJs(K.current, p, u);
        const rust = envelope.encrypt(K.current, p, u);
        assert.equal(rust, js, `${JSON.stringify(String(p).slice(0, 20))} ${JSON.stringify(String(u).slice(0, 20))}`);
        crypto.randomBytes = real;
        if (js) {
          assert.deepEqual(envelope.open(K.current, null, js, u), oracle.openJs(K.current, null, rust, u));
          n += 1;
        }
      }
    }
  } finally { crypto.randomBytes = real; }
  for (const empty of [undefined, null, '']) assert.equal(envelope.encrypt(K.current, empty, 'u1'), '');
  assert.ok(n > 40);
});

test('the documented bounds: refused, not answered differently', { skip: skipWasm }, (t) => {
  t.mock.method(console, 'warn', () => {});
  const big = 'b'.repeat(davParseWasm.MAX_SECRET_PLAIN_BYTES + 1);
  assert.ok(oracle.encryptJs(K.current, big, 'u1').startsWith('enc:v2:'), 'the JS code sealed any size');
  assert.throws(() => envelope.encrypt(K.current, big, 'u1'), (e) => e.message === envelope.SEAL_FAILURE && e.reason === 'too_large');
  const longUser = 'u'.repeat(davParseWasm.MAX_SECRET_USER_BYTES + 1);
  const sealed = oracle.encryptJs(K.current, 'synthetic', longUser);
  assert.equal(oracle.openJs(K.current, null, sealed, longUser).plain, 'synthetic');
  assert.throws(() => envelope.open(K.current, null, sealed, longUser), (e) => e.message === envelope.OPEN_FAILURE && e.reason === 'too_large');
  assert.throws(() => envelope.encrypt(K.current, 'synthetic', longUser), (e) => e.reason === 'too_large');
  // At the bound itself both still work.
  const atUser = 'u'.repeat(davParseWasm.MAX_SECRET_USER_BYTES);
  assert.equal(envelope.open(K.current, null, oracle.encryptJs(K.current, 'synthetic', atUser), atUser).plain, 'synthetic');
});
