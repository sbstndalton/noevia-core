'use strict';

// TEST ORACLE (#1071): never required by production code (server/oracle-isolation.test.cjs
// enforces that). The JS reference for the credential envelopes (#979), kept only so
// tools/gen-secret-fixtures.cjs can regenerate tests/fixtures/secret-envelope.v1.json and the
// differential and compatibility tests can compare it with dav-parse.wasm (sbstndalton/noevia-rs
// crates/secret-envelope). Production seals and opens with the Rust module alone
// (server/secret-envelope.cjs).
// Moved here unchanged from server/secret-envelope.cjs aadFor, hasUser, versionOf, encryptJs,
// decryptWithJs and openJs (noevia-core 36376b2, the code the release before the retirement ran
// and with which every stored value up to then was written).
//
// Formats:
//   enc:v1:<iv|tag|body>  legacy, no associated data (still decrypts)
//   enc:v2:<iv|tag|body>  GCM with AAD = "noevia:user:<userId>", so a
//                         ciphertext copied from another account fails.

const crypto = require('crypto');

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

module.exports = { aadFor, hasUser, versionOf, encryptJs, decryptWithJs, openJs };
