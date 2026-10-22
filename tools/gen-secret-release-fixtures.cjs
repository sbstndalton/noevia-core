#!/usr/bin/env node
'use strict';
// Writes tests/fixtures/secret-envelope-release.v1.json (#1071): stored credential values exactly
// as the last JS-sealing code wrote them, so the Rust-only envelope can be held to every value the
// live system may have on disk. The committed file was produced from that release's own module
// (noevia-core 36376b2, server/secret-envelope.cjs encryptJs/openJs, the core of release 75089810):
//   git -C <noevia-core> archive 36376b2 server | tar -x -C <dir>
//   node tools/gen-secret-release-fixtures.cjs --module <dir>/server/secret-envelope.cjs > tests/fixtures/secret-envelope-release.v1.json
// Without --module it uses tests/server/oracle/secret-envelope.cjs (that code, moved unchanged in
// #1071), which must print the same bytes; tests/server/secret-envelope-release-compat.test.cjs
// checks that.
//
// Every key, user id and plaintext is synthetic (keys are sha256 of a label; nonces come from a
// seeded generator). The shapes follow what the callers store: a storage connection secret (bound
// to the account), OAuth token JSON, MCP header JSON, a provider API key (unbound, v1), legacy v1
// values that a bound reader opens, values sealed under a key that has since been rotated, and
// plain legacy rows.
//
// Shape: { version, producedBy, keys: { current, previous } (hex), cases: [{ name, caller, sealedWith:
// 'current'|'previous'|null, value, openUser (String(userId) or null), expect: { keyUsed, plain16 } }] }
// plain16 is hex of the UTF-16LE units of the plaintext the release code returned.

const crypto = require('crypto');
const path = require('path');

const at = process.argv.indexOf('--module');
const modulePath = at > 0 ? path.resolve(process.argv[at + 1]) : path.join(__dirname, '../tests/server/oracle/secret-envelope.cjs');
const { encryptJs, openJs } = require(modulePath);

let seed = 0x1071;
const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
const realRandomBytes = crypto.randomBytes;
crypto.randomBytes = (n) => {
  if (n !== 12) return realRandomBytes(n);
  const b = Buffer.alloc(12); for (let i = 0; i < 12; i++) b[i] = Math.floor(rand() * 256);
  return b;
};

const keyOf = (label) => crypto.createHash('sha256').update(`noevia-core #1071 release-compat synthetic key: ${label}`).digest();
const KEYS = { current: keyOf('current'), previous: keyOf('previous') };
const hex16 = (s) => Buffer.from(String(s), 'utf16le').toString('hex');
const USER_A = 'a1111111-1111-4111-8111-111111111111';
const USER_B = 'b2222222-2222-4222-8222-222222222222';

const cases = [];
function sealed(name, caller, sealedWith, plain, sealUser, openUser = sealUser) {
  const value = encryptJs(KEYS[sealedWith], plain, sealUser);
  stored(name, caller, sealedWith, value, openUser);
}
function stored(name, caller, sealedWith, value, openUser) {
  const r = openJs(KEYS.current, KEYS.previous, value, openUser);
  cases.push({ name, caller, sealedWith, value, openUser: openUser === undefined || openUser === null || openUser === '' ? null : String(openUser), expect: { keyUsed: r.keyUsed, plain16: hex16(r.plain) } });
}

const token = (label) => crypto.createHash('sha256').update(`synthetic token ${label}`).digest('base64url');
sealed('storage connection secret', 'auth.cjs saveStorage/getStorage', 'current', 'synthetic-webdav-app-password-0001', USER_A);
sealed('storage connection secret with spaces and symbols', 'auth.cjs saveStorage/getStorage', 'current', 'p@ss w0rd/\\"\'<>&%', USER_B);
sealed('storage connection secret, legacy v1 read by its account', 'auth.cjs getStorage (pre-binding row)', 'current', 'synthetic-legacy-v1-secret', undefined, USER_A);
sealed('hosted provider sign-in tokens', 'provider sign-in store', 'current', JSON.stringify({ access_token: token('a'), refresh_token: token('r'), id_token: token('i'), expires_at: 1792000000000, account_id: 'synthetic-account' }), String(USER_A));
sealed('MCP directory headers', 'MCP directory store', 'current', JSON.stringify({ Authorization: `Bearer ${token('mcp')}`, 'X-Synthetic': '1' }), USER_A);
sealed('MCP OAuth tokens', 'MCP sign-in store', 'current', JSON.stringify({ access_token: token('m'), token_type: 'Bearer', expires_in: 3600, scope: 'read write' }), USER_B);
sealed('MCP OAuth tokens, legacy v1 opened without an account', 'MCP sign-in store (fallback read)', 'current', JSON.stringify({ access_token: token('legacy') }), undefined);
sealed('storage login flow', 'storage login flow store', 'current', JSON.stringify({ server: 'https://cloud.invalid', loginName: 'synthetic', appPassword: token('nc') }), USER_A);
sealed('provider API key (unbound)', 'provider settings store', 'current', `sk-synthetic-${token('provider')}`, undefined);
sealed('provider API key, Unicode', 'provider settings store', 'current', 'clé-synthétique-漢字-😀', undefined);
sealed('provider API key with a lone surrogate (stored as U+FFFD)', 'provider settings store', 'current', 'synthetic-\ud800-key', undefined);
sealed('value that looks enveloped (sealed, never stored verbatim)', 'auth.cjs saveStorage', 'current', 'enc:v2:not-really-an-envelope', USER_A);
sealed('a one-character secret', 'auth.cjs saveStorage', 'current', 'x', USER_A);
sealed('a numeric user id (String(userId) in the AAD)', 'provider sign-in store, String(userId)', 'current', 'synthetic-numeric-owner', 42, '42');
sealed('a large token bundle (16 KiB)', 'MCP sign-in store', 'current', JSON.stringify({ access_token: 't'.repeat(16 * 1024) }), USER_B);
sealed('rotated: v2 under the previous key', 'secrets.cjs rotation', 'previous', 'synthetic-rotated-v2', USER_A);
sealed('rotated: v1 under the previous key', 'secrets.cjs rotation', 'previous', 'synthetic-rotated-v1', undefined);
sealed('rotated: OAuth JSON under the previous key', 'provider sign-in store', 'previous', JSON.stringify({ refresh_token: token('old') }), String(USER_B));
for (let i = 0; i < 24; i++) {
  const bound = i % 3 !== 0;
  sealed(`synthetic credential ${i}`, 'mixed', i % 4 === 3 ? 'previous' : 'current', `synthetic-${i}-${token(String(i)).slice(0, 8 + i)}`, bound ? (i % 2 ? USER_A : USER_B) : undefined);
}
stored('plain legacy row (never sealed)', 'auth.cjs getStorage (plaintext row)', null, 'synthetic-plaintext-legacy-secret', USER_A);
stored('empty secret', 'auth.cjs saveStorage(\'\')', null, encryptJs(KEYS.current, '', USER_A), USER_A);

crypto.randomBytes = realRandomBytes;
const out = {
  version: 1,
  producedBy: 'noevia-core 36376b2 server/secret-envelope.cjs encryptJs/openJs (release 75089810), via tools/gen-secret-release-fixtures.cjs',
  keys: { current: KEYS.current.toString('hex'), previous: KEYS.previous.toString('hex') },
  cases,
};
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
