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
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, raw.subarray(0, 12));
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
