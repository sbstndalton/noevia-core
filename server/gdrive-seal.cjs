'use strict';
// The sealed token files of the Google Drive connections, in the format the Rust front writes and
// reads (noevia-rs crates/google-token-seal, sbstndalton/noevia#2190 round 7): AES-256-GCM under
// HKDF-SHA256(backupKey, empty salt, "noevia google token v1"), base64 of iv|tag|body. The Rust front is
// the only owner of the files; this module is what is left of gdrive.cjs for the two things that still
// run in Node: the read-only check `secrets:rotate` makes after the front re-sealed an account's file under the
// new key (#866), and the golden vector that proves Rust and Node agree on the bytes.
const nodeFs = require('node:fs');
const crypto = require('node:crypto');

function sealer(backupKey) {
  const key = Buffer.from(crypto.hkdfSync('sha256', backupKey, Buffer.alloc(0), 'noevia google token v1', 32));
  return {
    seal(obj) {
      const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
    },
    open(text) {
      const raw = Buffer.from(text, 'base64');
      const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
    },
  };
}

/**
 * A READ-ONLY check that a token file opens with the current key. Since the review of round 7 Node writes none
 * of these files: `secrets:rotate` asks the Rust front to re-seal them (POST /v1/gdrive/reseal, under the
 * front's own fence, so a disconnect or a sign-in during the rotation is never undone by a stale rewrite) and
 * then checks the result here. Returns 'current' when it opens, 'empty' for an empty file, and throws when it
 * does not (still sealed under the retired key, or under no key). Token values never appear in the message.
 */
function checkTokenFile(file, currentKey) {
  const text = nodeFs.readFileSync(file, 'utf8');
  if (!text.trim()) return 'empty';
  try { sealer(currentKey).open(text); } catch { throw new Error('not sealed under the current key; the Rust front has not re-sealed it'); }
  return 'current';
}

module.exports = { sealer, checkTokenFile };
