'use strict';

// Credential envelopes (#979): versionOf, decryptWith, open and encrypt, moved here unchanged from
// secrets.cjs. secrets.cjs keeps the key files, rotation and derivation and passes key bytes in.
//
// Formats:
//   enc:v1:<iv|tag|body>  legacy, no associated data (still decrypts)
//   enc:v2:<iv|tag|body>  GCM with AAD = "noevia:user:<userId>", so a
//                         ciphertext copied from another account fails.
// encrypt() always encrypts its input: a caller-supplied string that merely
// looks like a ciphertext is treated as plaintext, never stored verbatim.
//
// `secret-envelope` (sbstndalton/noevia-rs, in the dav-parse.wasm module pinned by
// server/dav-parse.lock) is the Rust port. SECRET_ENVELOPE_IMPL=js|wasm picks one (default js; any
// other value means js, with one warning). Both read and write the same formats, so switching
// needs no migration and every existing v1/v2 value opens either way; a value written by one opens
// in the other.
//
// `wasm` FAILS CLOSED: a missing or tampered module, a trap or an unexpected reply throws; nothing
// falls back to the JS code and nothing is re-encrypted on a failure. A value that cannot be opened
// throws 'credential could not be opened' (a v2 value without a user keeps the JS message
// 'credential is bound to an account'); a seal failure throws 'credential could not be sealed'.
// Only the failure reason is logged (module failures only), never a key, plaintext or ciphertext.
//
// What crosses: the key bytes (current, and previous when configured), String(userId) when the
// value is bound, and the value as UTF-16 units (so Node's lenient base64url reading of odd text is
// reproduced exactly); for a seal, the key, a 12-byte nonce from crypto.randomBytes (the module has
// no RNG and imports nothing) and the UTF-8 plaintext. The module wipes its input, and
// dav-parse-wasm.cjs zeroes the whole linear memory and drops the instance after every secret call.
// The plaintext copies made here are zeroed after use; the key Buffers belong to secrets.cjs.
//
// Differences (wasm refuses, js would try): values over 12 Mi UTF-16 units, plaintext over 8 MiB,
// user ids over 64 KiB. Both refuse an envelope whose tag is shorter than 16 bytes (#995).

const crypto = require('crypto');
const davParseWasm = require('./dav-parse-wasm.cjs');

const aadFor = (userId) => Buffer.from(`noevia:user:${userId}`, 'utf8');
const hasUser = (userId) => userId !== undefined && userId !== null && userId !== '';
const versionOf = (text) => (text.startsWith('enc:v2:') ? 2 : text.startsWith('enc:v1:') ? 1 : 0);

function encryptJs(key, value, userId) {
  if (value === undefined || value === null || value === '') return '';
  const bound = hasUser(userId);
  const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (bound) cipher.setAAD(aadFor(userId));
  const body = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `enc:${bound ? 'v2' : 'v1'}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
}

function decryptWithJs(k, text, version, userId) {
  const raw = Buffer.from(text.slice(7), 'base64url');
  // iv(12) + tag(16) at least, and only a full 16-byte tag (#995): Node would otherwise check a
  // truncated tag. encrypt never writes one, so no stored value is affected.
  if (raw.length < 28) throw new Error('credential envelope is truncated');
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, raw.subarray(0, 12), { authTagLength: 16 });
  if (version === 2) decipher.setAAD(aadFor(userId));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

// Returns { plain, keyUsed: 'current'|'previous'|'none' }; throws when no key opens it.
function openJs(key, previousKey, value, userId) {
  const text = String(value || '');
  const version = versionOf(text);
  if (!version) return { plain: value || '', keyUsed: 'none' };
  if (version === 2 && !hasUser(userId)) throw new Error('credential is bound to an account');
  try { return { plain: decryptWithJs(key, text, version, userId), keyUsed: 'current' }; } catch (e) {
    if (!previousKey) throw e;
  }
  return { plain: decryptWithJs(previousKey, text, version, userId), keyUsed: 'previous' };
}

const OPEN_FAILURE = 'credential could not be opened';
const SEAL_FAILURE = 'credential could not be sealed';
const BOUND_FAILURE = 'credential is bound to an account';
const IMPLS = new Set(['js', 'wasm']);
let warnedImpl = '';

/** SECRET_ENVELOPE_IMPL, read per call so a test (or an owner flip plus restart) takes effect. */
function secretEnvelopeImpl(env = process.env) {
  const raw = env.SECRET_ENVELOPE_IMPL;
  if (raw === undefined || raw === '') return 'js';
  const value = String(raw).trim().toLowerCase();
  if (IMPLS.has(value)) return value;
  if (warnedImpl !== value) {
    warnedImpl = value;
    console.warn(`[secrets] SECRET_ENVELOPE_IMPL=${JSON.stringify(String(raw))} is not js or wasm; using js`);
  }
  return 'js';
}

const MODULE_REASONS = new Set(['lock', 'missing', 'checksum', 'compile', 'abi', 'trap', 'reply', 'unknown']);

function failure(op, err, message) {
  const reason = err instanceof davParseWasm.DavParseError ? err.reason : 'unexpected';
  // An unopenable value is an ordinary answer (the callers decide what to say); a module failure
  // is logged, by reason only.
  if (MODULE_REASONS.has(reason) || reason === 'unexpected') console.warn(`[secrets] secret-envelope ${op} failed (${reason})`);
  return Object.assign(new Error(reason === 'bound' ? BOUND_FAILURE : message), { code: 'secret_envelope_failed', reason });
}

function openWasm(key, previousKey, value, userId) {
  const text = String(value || '');
  let r;
  try {
    r = davParseWasm.secretOpen(previousKey ? [key, previousKey] : [key], hasUser(userId) ? `${userId}` : null, text);
  } catch (err) { throw failure('open', err, OPEN_FAILURE); }
  if (r.keyUsed === 'none') return { plain: value || '', keyUsed: 'none' };
  const plain = Buffer.from(r.plain.buffer, r.plain.byteOffset, r.plain.length).toString('utf8');
  r.plain.fill(0);
  return { plain, keyUsed: r.keyUsed };
}

function encryptWasm(key, value, userId) {
  if (value === undefined || value === null || value === '') return '';
  const plain = Buffer.from(String(value), 'utf8');
  try {
    return davParseWasm.secretSeal(key, crypto.randomBytes(12), plain, hasUser(userId) ? `${userId}` : null);
  } catch (err) { throw failure('seal', err, SEAL_FAILURE); } finally { plain.fill(0); }
}

/** encryptJs or its Rust port, by SECRET_ENVELOPE_IMPL. */
function encrypt(key, value, userId, { impl = secretEnvelopeImpl() } = {}) {
  return impl === 'wasm' ? encryptWasm(key, value, userId) : encryptJs(key, value, userId);
}

/** openJs or its Rust port, by SECRET_ENVELOPE_IMPL. */
function open(key, previousKey, value, userId, { impl = secretEnvelopeImpl() } = {}) {
  return impl === 'wasm' ? openWasm(key, previousKey, value, userId) : openJs(key, previousKey, value, userId);
}

module.exports = { aadFor, hasUser, versionOf, encryptJs, decryptWithJs, openJs, encrypt, open, secretEnvelopeImpl, OPEN_FAILURE, SEAL_FAILURE, BOUND_FAILURE };
