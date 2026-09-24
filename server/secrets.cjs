'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function createSecretStore(dataDir) {
  // A fresh install has no state directory yet. Create it before the key,
  // rather than relying on a later database initializer to do so.
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dataDir, 0o700); } catch {}
  const keyFile = path.join(dataDir, 'secrets.key');
  let key;
  if (fs.existsSync(keyFile)) key = fs.readFileSync(keyFile);
  else {
    key = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, key, { mode: 0o600, flag: 'wx' });
    console.warn(`Generated credential-encryption key: ${keyFile} (include this file in backups)`);
  }
  if (key.length !== 32) throw new Error(`invalid credential-encryption key at ${keyFile}`);
  // Formats:
  //   enc:v1:<iv|tag|body>  legacy, no associated data (still decrypts)
  //   enc:v2:<iv|tag|body>  GCM with AAD = "noevia:user:<userId>", so a
  //                         ciphertext copied from another account fails.
  // encrypt() always encrypts its input: a caller-supplied string that merely
  // looks like a ciphertext is treated as plaintext, never stored verbatim.
  const aadFor = (userId) => Buffer.from(`noevia:user:${userId}`, 'utf8');
  function encrypt(value, userId) {
    if (value === undefined || value === null || value === '') return '';
    const bound = userId !== undefined && userId !== null && userId !== '';
    const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    if (bound) cipher.setAAD(aadFor(userId));
    const body = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return `enc:${bound ? 'v2' : 'v1'}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
  }
  function decrypt(value, userId) {
    const text = String(value || '');
    const version = text.startsWith('enc:v2:') ? 2 : text.startsWith('enc:v1:') ? 1 : 0;
    if (!version) return value || '';
    if (version === 2 && (userId === undefined || userId === null || userId === '')) throw new Error('credential is bound to an account');
    const raw = Buffer.from(text.slice(7), 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    if (version === 2) decipher.setAAD(aadFor(userId));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
  // A separate key per purpose, derived rather than reused: signing a
  // capability token with the same bytes that encrypt stored credentials
  // would make a signing-oracle bug a credential-disclosure bug. HKDF gives
  // an independent key per label from the one file operators already back up.
  function derive(label, bytes = 32) {
    if (!label || typeof label !== 'string') throw new Error('derive needs a label');
    return Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), Buffer.from(`noevia:${label}`, 'utf8'), bytes));
  }
  return { encrypt, decrypt, derive, keyFile };
}

module.exports = { createSecretStore };
