'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function createSecretStore(dataDir) {
  const keyFile = path.join(dataDir, 'secrets.key');
  let key;
  if (fs.existsSync(keyFile)) key = fs.readFileSync(keyFile);
  else {
    key = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, key, { mode: 0o600, flag: 'wx' });
    console.warn(`Generated credential-encryption key: ${keyFile} (include this file in backups)`);
  }
  if (key.length !== 32) throw new Error(`invalid credential-encryption key at ${keyFile}`);
  function encrypt(value) {
    if (!value || String(value).startsWith('enc:v1:')) return value || '';
    const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return `enc:v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
  }
  function decrypt(value) {
    if (!value || !String(value).startsWith('enc:v1:')) return value || '';
    const raw = Buffer.from(String(value).slice(7), 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
  return { encrypt, decrypt, keyFile };
}

module.exports = { createSecretStore };
