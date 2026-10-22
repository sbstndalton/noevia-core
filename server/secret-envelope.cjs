'use strict';

// Credential envelopes (#979): open and encrypt. secrets.cjs keeps the key files, rotation and
// derivation and passes key bytes in.
//
// Formats:
//   enc:v1:<iv|tag|body>  legacy, no associated data (still decrypts)
//   enc:v2:<iv|tag|body>  GCM with AAD = "noevia:user:<userId>", so a
//                         ciphertext copied from another account fails.
// encrypt() always encrypts its input: a caller-supplied string that merely
// looks like a ciphertext is treated as plaintext, never stored verbatim.
//
// `secret-envelope` (sbstndalton/noevia-rs, in the dav-parse.wasm module pinned by
// server/dav-parse.lock) seals and opens, always (since #1071; it was SECRET_ENVELOPE_IMPL=wasm,
// default js). It reads and writes the formats the JS code wrote, so no stored value needs a
// migration (tests/fixtures/secret-envelope-release.v1.json holds values the last JS-sealing
// release wrote). The Rust front's native reads open with the same crate. A leftover
// SECRET_ENVELOPE_IMPL only warns at startup (dav-parse-wasm.cjs RETIRED_FLAGS). The JS code is a
// test oracle: tests/server/oracle/secret-envelope.cjs.
//
// It FAILS CLOSED: a missing or tampered module, a trap or an unexpected reply throws; nothing
// falls back to JS and nothing is re-encrypted on a failure. A value that cannot be opened throws
// "credential could not be opened" (a v2 value without a user: "credential is bound to an
// account"); a seal failure throws "credential could not be sealed". Only the failure reason is
// logged (module failures only), never a key, plaintext or ciphertext.
//
// What crosses: the key bytes (current, and previous when configured), String(userId) when the
// value is bound, and the value as UTF-16 units (so Node's lenient base64url reading of odd text is
// reproduced exactly); for a seal, the key, a 12-byte nonce from crypto.randomBytes (the module has
// no RNG and imports nothing) and the UTF-8 plaintext. The module wipes its input, and
// dav-parse-wasm.cjs zeroes the whole linear memory and drops the instance after every secret call.
// The plaintext copies made here are zeroed after use; the key Buffers belong to secrets.cjs.
//
// Bounds the JS code did not have (refused, never answered differently): values over 12 Mi UTF-16
// units, plaintext over 8 MiB, user ids over 64 KiB. An envelope whose tag is shorter than 16
// bytes is refused, as the JS code also did since #995.

const crypto = require('crypto');
const davParseWasm = require('./dav-parse-wasm.cjs');

const hasUser = (userId) => userId !== undefined && userId !== null && userId !== '';
/** The envelope version a stored value claims (2, 1, or 0 for a plain value): rotation's bookkeeping. */
const versionOf = (text) => (text.startsWith('enc:v2:') ? 2 : text.startsWith('enc:v1:') ? 1 : 0);

const OPEN_FAILURE = 'credential could not be opened';
const SEAL_FAILURE = 'credential could not be sealed';
const BOUND_FAILURE = 'credential is bound to an account';

const MODULE_REASONS = new Set(['lock', 'missing', 'checksum', 'compile', 'abi', 'trap', 'reply', 'unknown']);

function failure(op, err, message) {
  const reason = err instanceof davParseWasm.DavParseError ? err.reason : 'unexpected';
  // An unopenable value is an ordinary answer (the callers decide what to say); a module failure
  // is logged, by reason only.
  if (MODULE_REASONS.has(reason) || reason === 'unexpected') console.warn(`[secrets] secret-envelope ${op} failed (${reason})`);
  return Object.assign(new Error(reason === 'bound' ? BOUND_FAILURE : message), { code: 'secret_envelope_failed', reason });
}

/** Opens a stored value with `key`, then `previousKey` (a Buffer or null). Returns
 *  { plain, keyUsed: 'current'|'previous'|'none' } ('none': not an envelope, returned as it is);
 *  throws when no key opens it. */
function open(key, previousKey, value, userId) {
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

/** Seals String(value) under `key`: enc:v2 bound to `userId` when there is one, else enc:v1. An
 *  empty value (undefined, null or '') stays ''. */
function encrypt(key, value, userId) {
  if (value === undefined || value === null || value === '') return '';
  const plain = Buffer.from(String(value), 'utf8');
  try {
    return davParseWasm.secretSeal(key, crypto.randomBytes(12), plain, hasUser(userId) ? `${userId}` : null);
  } catch (err) { throw failure('seal', err, SEAL_FAILURE); } finally { plain.fill(0); }
}

module.exports = { hasUser, versionOf, encrypt, open, OPEN_FAILURE, SEAL_FAILURE, BOUND_FAILURE };
