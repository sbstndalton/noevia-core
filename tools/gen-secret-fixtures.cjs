#!/usr/bin/env node
'use strict';
// Regenerates the shared differential fixtures for the credential envelopes (#979). Every
// expectation comes from the CURRENT JS implementation (server/secret-envelope.cjs openJs and
// encryptJs). The same file is committed byte-for-byte in sbstndalton/noevia-rs
// (crates/secret-envelope/tests/fixtures/secret-envelope.v1.json); noevia-core CI compares them.
//   node tools/gen-secret-fixtures.cjs > tests/fixtures/secret-envelope.v1.json
// The keys are fixed synthetic test keys (sha256 of a label) and every plaintext is synthetic:
// nothing here is, or protects, a real credential.
//
// Shapes (strings that may hold lone surrogates travel as hex of UTF-16LE units, `*16`; byte
// strings as hex, `*8`):
//   keys: { name: hex(32 bytes) }
//   open: { name, keys: [name] (current first), value16 (and `value` when well-formed), user16
//          (String(userId), or null when the JS hasUser(userId) is false),
//          expect: { keyUsed, plain16 } | { error: 'bound'|'unopenable' } }
//          `plain16` is what JS returns (the plaintext decoded as UTF-8 with replacement); for
//          keyUsed 'none' it is the value itself.
//   seal: { name, key, nonce8, plain8, user16, expect } where `expect` is the envelope encryptJs
//         wrote with that nonce (randomBytes is replaced by the listed nonce while generating).

const crypto = require('crypto');
const { openJs, encryptJs } = require('../server/secret-envelope.cjs');

let seed = 0x979;
const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
const int = (n) => Math.floor(rand() * n);
const pick = (a) => a[int(a.length)];
const hex16 = (s) => { const b = Buffer.alloc(s.length * 2); for (let i = 0; i < s.length; i++) b.writeUInt16LE(s.charCodeAt(i), i * 2); return b.toString('hex'); };
const keyOf = (label) => crypto.createHash('sha256').update(`noevia-rs secret-envelope fixture key: ${label}`).digest();
const KEYS = { current: keyOf('current'), previous: keyOf('previous'), other: keyOf('other') };

// Deterministic nonces: encryptJs reads crypto.randomBytes at call time.
const realRandomBytes = crypto.randomBytes;
let nextNonce = null;
crypto.randomBytes = (n) => {
  if (n !== 12) return realRandomBytes(n);
  const b = Buffer.alloc(12); for (let i = 0; i < 12; i++) b[i] = int(256);
  nextNonce = b; return Buffer.from(b);
};

const hasUser = (u) => u !== undefined && u !== null && u !== '';
const userField = (u) => (hasUser(u) ? hex16(`${u}`) : null);
const open = [], seal = [];

function addOpen(name, keyNames, value, userId) {
  const keys = keyNames.map((k) => KEYS[k]);
  let expect;
  try {
    const r = openJs(keys[0], keys[1] || null, value, userId);
    expect = { keyUsed: r.keyUsed, plain16: hex16(String(r.plain)) };
  } catch (err) {
    expect = { error: err.message === 'credential is bound to an account' ? 'bound' : 'unopenable' };
  }
  const entry = { name, keys: keyNames, value16: hex16(value), user16: userField(userId), expect };
  if (value.isWellFormed()) entry.value = value;
  open.push(entry);
}

function sealed(keyName, plain, userId, record = null) {
  const out = encryptJs(KEYS[keyName], plain, userId);
  if (record) seal.push({ name: record, key: keyName, nonce8: nextNonce.toString('hex'), plain8: Buffer.from(String(plain), 'utf8').toString('hex'), user16: userField(userId), expect: out });
  return out;
}

// A raw envelope with arbitrary plaintext bytes (e.g. invalid UTF-8), as encryptJs would lay it out.
function rawEnvelope(key, bytes, userId) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (hasUser(userId)) c.setAAD(Buffer.from(`noevia:user:${userId}`, 'utf8'));
  const body = Buffer.concat([c.update(bytes), c.final()]);
  return `enc:${hasUser(userId) ? 'v2' : 'v1'}:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url')}`;
}

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const PLAINS = {
  ascii: 'synthetic-api-key-0000',
  empty: '',
  json: JSON.stringify({ access_token: 'synthetic-token', refresh_token: 'synthetic-refresh', expires_at: 1700000000000 }),
  latin1: 'café ñandú',
  unicode: 'emoji 😀 cjk 漢字 rtl عربى',
  nul: 'a\u0000b',
  loneSurrogate: 'x\ud800y\udc00z',
  bom: '﻿bom',
  long: 'L'.repeat(4096),
  looksEnveloped: 'enc:v2:AAAA',
};
const USERS = { none: undefined, null: null, emptyString: '', uuid: USER, zero: 0, number: 42, unicode: 'ü😀', lone: 'u\ud800' };

// ── seal: byte-exact against encryptJs for a given nonce; every plaintext × user ──
for (const [pn, p] of Object.entries(PLAINS)) for (const [un, u] of Object.entries(USERS)) {
  if (p === '') continue; // encryptJs returns '' before encrypting; the wrapper does the same
  sealed('current', p, u, `seal ${pn} user=${un}`);
}
for (const v of [[], 0, false, 1.5]) sealed('current', v, USER, `seal String(${JSON.stringify(v)})`);
for (let i = 0; i < 200; i++) {
  const p = Array.from({ length: int(40) + 1 }, () => pick(['a', 'é', '😀', '\ud800', '\u0000', '{', '"', ' ', 'Z'])).join('');
  sealed(pick(['current', 'previous', 'other']), p, pick([undefined, USER, 'x', 7]), `seal random ${i}`);
}

// ── open: every plaintext under v1 and v2, the right and wrong users, key rotation ──
for (const [pn, p] of Object.entries(PLAINS)) {
  const v1 = sealed('current', p === '' ? [] : p); // String([]) === '': an empty plaintext
  const v2 = sealed('current', p === '' ? [] : p, USER);
  addOpen(`v1 ${pn}`, ['current'], v1);
  addOpen(`v1 ${pn} with a user (ignored)`, ['current'], v1, USER);
  addOpen(`v2 ${pn}`, ['current'], v2, USER);
  addOpen(`v2 ${pn} wrong user`, ['current'], v2, OTHER_USER);
  addOpen(`v2 ${pn} no user`, ['current'], v2, undefined);
  addOpen(`v2 ${pn} empty user`, ['current'], v2, '');
  addOpen(`v2 ${pn} with previous configured`, ['current', 'previous'], v2, USER);
  const old1 = sealed('previous', p || [], undefined), old2 = sealed('previous', p || [], USER);
  addOpen(`v1 ${pn} under the previous key`, ['current', 'previous'], old1);
  addOpen(`v2 ${pn} under the previous key`, ['current', 'previous'], old2, USER);
  addOpen(`v1 ${pn} under a retired key, no previous`, ['current'], old1);
  addOpen(`v2 ${pn} under the previous key, wrong user`, ['current', 'previous'], old2, OTHER_USER);
  addOpen(`v2 ${pn} under an unknown key`, ['current', 'previous'], sealed('other', p || [], USER), USER);
}
for (const [un, u] of Object.entries(USERS)) {
  if (!hasUser(u)) continue;
  const v = sealed('current', 'bound', u);
  addOpen(`v2 user=${un}`, ['current'], v, u);
  addOpen(`v2 user=${un} opened as String`, ['current'], v, `${u}`);
}
addOpen('v2 user 42 opened as "042"', ['current'], sealed('current', 'n', 42), '042');

// Plaintext that is not UTF-8 (only a raw writer makes it; JS decodes with replacement).
for (const bytes of [[0xff], [0xc3], [0xed, 0xa0, 0x80], [0xe2, 0x82], [0xf0, 0x9f, 0x98], [0x61, 0x80, 0x62], [0xef, 0xbb, 0xbf, 0x61]]) {
  addOpen(`raw plaintext ${Buffer.from(bytes).toString('hex')} v1`, ['current'], rawEnvelope(KEYS.current, Buffer.from(bytes)));
  addOpen(`raw plaintext ${Buffer.from(bytes).toString('hex')} v2`, ['current'], rawEnvelope(KEYS.current, Buffer.from(bytes), USER), USER);
}

// ── not an envelope: returned as is ──
for (const v of ['', 'plain-text-key', 'enc:', 'enc:v1', 'enc:v3:AAAA', 'ENC:v1:AAAA', ' enc:v1:AAAA', 'enc:v0:AAAA', 'enc;v1:AAAA', 'énc:v1:AAAA', '\ud800enc:v1:', 'enc:vı:AAAA'])
  addOpen(`plain ${JSON.stringify(v)}`, ['current'], v, pick([undefined, USER]));

// ── malformed envelopes ──
const base1 = sealed('current', 'tamper me, synthetic', undefined);
const base2 = sealed('current', 'tamper me, synthetic', USER);
for (const [label, base, user] of [['v1', base1, undefined], ['v2', base2, USER]]) {
  for (let cut = 7; cut < base.length; cut++) addOpen(`${label} truncated to ${cut}`, ['current', 'previous'], base.slice(0, cut), user);
  addOpen(`${label} empty body`, ['current'], base.slice(0, 7), user);
  const raw = Buffer.from(base.slice(7), 'base64url');
  for (let i = 0; i < raw.length; i++) for (const bit of [0x01, 0x80]) {
    const t = Buffer.from(raw); t[i] ^= bit;
    addOpen(`${label} byte ${i} ^ ${bit}`, ['current'], base.slice(0, 7) + t.toString('base64url'), user);
  }
  addOpen(`${label} extra byte`, ['current'], base.slice(0, 7) + Buffer.concat([raw, Buffer.from([0])]).toString('base64url'), user);
  // Prefix swaps.
  const other = label === 'v1' ? 'enc:v2:' : 'enc:v1:';
  addOpen(`${label} body under ${other}`, ['current'], other + base.slice(7), USER);
  // Node's lenient base64url: junk is skipped, either alphabet is read, '=' ends the data, and a
  // two-byte string is read through each unit's low byte.
  const body = base.slice(7);
  const mid = body.length >> 1;
  const variants = {
    'bang inserted': body.slice(0, mid) + '!' + body.slice(mid),
    'space and newline': ' ' + body.slice(0, mid) + '\n' + body.slice(mid) + '\t',
    'standard alphabet': body.replace(/-/g, '+').replace(/_/g, '/'),
    'padding appended': body + '==',
    'padding mid': body.slice(0, mid) + '=' + body.slice(mid),
    'dot inserted': body.slice(0, 5) + '.' + body.slice(5),
    'U+0100 inserted': body.slice(0, mid) + 'Ā' + body.slice(mid),
    'U+0161 inserted': body.slice(0, mid) + 'š' + body.slice(mid),
    'U+0141 replaces a char': body.slice(0, mid) + 'Ł' + body.slice(mid + 1),
    'emoji inserted': body.slice(0, mid) + '😀' + body.slice(mid),
    'lone high surrogate inserted': body.slice(0, mid) + '\ud800' + body.slice(mid),
    'lone low surrogate inserted': body.slice(0, mid) + '\udc41' + body.slice(mid),
    'NUL inserted': body.slice(0, mid) + '\u0000' + body.slice(mid),
    'last char dropped': body.slice(0, -1),
    'one char appended': body + 'A',
    'two chars appended': body + 'AA',
    'non-zero trailing bits': body.slice(0, -1) + String.fromCharCode(body.charCodeAt(body.length - 1) ^ 1),
    'all junk': '!!!!',
    'not base64 at all': '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
  };
  for (const [vn, v] of Object.entries(variants)) addOpen(`${label} ${vn}`, ['current'], base.slice(0, 7) + v, user);
}

// Seeded random mutations of real envelopes.
for (let i = 0; i < 600; i++) {
  const user = pick([undefined, USER]);
  let v = sealed(pick(['current', 'previous']), pick(Object.values(PLAINS).filter(Boolean)).slice(0, 64), user);
  const ops = int(3);
  for (let j = 0; j < ops; j++) {
    const at = 7 + int(v.length - 6);
    const ch = pick(['A', '-', '_', '+', '/', '=', '!', ' ', 'Ā', 'š', '\ud800', '😀', '']);
    v = rand() < 0.5 ? v.slice(0, at) + ch + v.slice(at) : v.slice(0, at) + ch + v.slice(at + 1);
  }
  addOpen(`random mutation ${i}`, pick([['current'], ['current', 'previous']]), v, pick([user, user, OTHER_USER, undefined]));
}

// Truncated GCM tags that are otherwise valid (#995): a tag cut to n bytes over an empty body.
// Node checked such a tag before authTagLength: 16; both implementations now refuse it.
for (const [label, u] of [['v1', undefined], ['v2', USER]]) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEYS.current, iv);
  if (u) c.setAAD(Buffer.from(`noevia:user:${u}`, 'utf8'));
  c.final();
  const tag = c.getAuthTag();
  for (const n of [0, 4, 8, 12, 13, 14, 15, 16]) addOpen(`${label} empty body, tag cut to ${n} bytes`, ['current'], `enc:${label}:${Buffer.concat([iv, tag.subarray(0, n)]).toString('base64url')}`, u);
}

crypto.randomBytes = realRandomBytes;
const out = { version: 1, generator: 'tools/gen-secret-fixtures.cjs', keys: Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, v.toString('hex')])), open, seal };
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
