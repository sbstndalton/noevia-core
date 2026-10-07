'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const envelope = require('./secret-envelope.cjs');

function createSecretStore(dataDir, { env = process.env } = {}) {
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
  // Key rotation (#111): an operator may keep the retired key next to the current
  // one, as `secrets.key.previous` (raw 32 bytes, like secrets.key) or in
  // SECRETS_KEY_PREVIOUS (base64 or hex of 32 bytes). decrypt() tries the current
  // key, then the previous one; rotate() re-encrypts every stored value under the
  // current key so the previous one can be removed.
  const previousKeyFile = path.join(dataDir, 'secrets.key.previous');
  let previousKey = null;
  if (fs.existsSync(previousKeyFile)) previousKey = fs.readFileSync(previousKeyFile);
  else if (env.SECRETS_KEY_PREVIOUS) {
    const text = String(env.SECRETS_KEY_PREVIOUS).trim();
    previousKey = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64');
  }
  if (previousKey && previousKey.length !== 32) throw new Error('invalid previous credential-encryption key (need 32 bytes)');
  if (previousKey && previousKey.equals(key)) previousKey = null;
  // The envelope formats (enc:v1, enc:v2) live in secret-envelope.cjs (#979), which runs the JS
  // code or its Rust port by SECRET_ENVELOPE_IMPL (default js; read per call).
  const encrypt = (value, userId) => envelope.encrypt(key, value, userId);
  // Returns { plain, keyUsed: 'current'|'previous'|'none' }; throws when no key opens it.
  const open = (value, userId) => envelope.open(key, previousKey, value, userId);
  const decrypt = (value, userId) => open(value, userId).plain;
  /** True when the value is empty, plaintext, or opens with the current or previous key. */
  function canDecrypt(value, userId) { try { open(value, userId); return true; } catch { return false; } }
  // Re-encrypt one stored value under the current key. `userId` is the owning account
  // for bound tables (v2), or undefined for unbound ones (v1). Returns
  // { status: 'current'|'rotated'|'upgraded'|'empty', value? } or throws.
  function reseal(value, userId) {
    const text = String(value || '');
    if (!text) return { status: 'empty' };
    const version = envelope.versionOf(text);
    const wanted = envelope.hasUser(userId) ? 2 : 1;
    // A v2 row in an unbound table cannot be opened without its owner; leave it.
    if (version === 2 && wanted === 1) throw new Error('credential is bound to an unknown account');
    const { plain, keyUsed } = open(text, userId);
    if (keyUsed === 'current' && version === wanted) return { status: 'current' };
    return { status: keyUsed === 'previous' ? 'rotated' : 'upgraded', value: encrypt(plain, userId) };
  }
  /**
   * Re-encrypt every stored credential under the current key. Each table is
   * { name, rows(): [{ ref, value, userId? }], write(ref, value), reseal?(row) }. One bad row is
   * counted and reported, never fatal. Idempotent: a second run finds all "current".
   */
  function rotate({ tables = [] } = {}) {
    const report = { tables: {}, totals: { current: 0, rotated: 0, upgraded: 0, empty: 0, failed: 0 }, failures: [] };
    for (const table of tables) {
      const counts = { current: 0, rotated: 0, upgraded: 0, empty: 0, failed: 0 };
      let rows = [];
      try { rows = table.rows() || []; } catch (e) {
        counts.failed += 1; report.failures.push({ table: table.name, ref: null, error: String(e.message || e) });
      }
      for (const row of rows) {
        try {
          // A table whose values are not enc: strings (a sealed file) brings its own reseal(row).
          const out = table.reseal ? table.reseal(row) : reseal(row.value, row.userId);
          if (out.value !== undefined) table.write(row.ref, out.value);
          counts[out.status] += 1;
        } catch (e) {
          counts.failed += 1;
          report.failures.push({ table: table.name, ref: row.ref, error: String(e.message || e).slice(0, 200) });
        }
      }
      report.tables[table.name] = counts;
      for (const k of Object.keys(counts)) report.totals[k] += counts[k];
    }
    return report;
  }
  // A separate key per purpose, derived rather than reused: signing a
  // capability token with the same bytes that encrypt stored credentials
  // would make a signing-oracle bug a credential-disclosure bug. HKDF gives
  // an independent key per label from the one file operators already back up.
  function deriveFrom(k, label, bytes) {
    if (!label || typeof label !== 'string') throw new Error('derive needs a label');
    return Buffer.from(crypto.hkdfSync('sha256', k, Buffer.alloc(0), Buffer.from(`noevia:${label}`, 'utf8'), bytes));
  }
  const derive = (label, bytes = 32) => deriveFrom(key, label, bytes);
  // The same derivation from the retired key (null when none is configured), so values sealed
  // under a derived key (not enc: strings) can still be opened and re-sealed during a rotation (#866).
  const derivePrevious = (label, bytes = 32) => (previousKey ? deriveFrom(previousKey, label, bytes) : null);
  return { encrypt, decrypt, canDecrypt, reseal, rotate, derive, derivePrevious, keyFile, previousKeyFile, hasPreviousKey: () => !!previousKey };
}

module.exports = { createSecretStore };
