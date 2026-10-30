'use strict';
// The sealed token files of the Google Drive connections, in the format the Rust front writes and
// reads (noevia-rs crates/google-token-seal, sbstndalton/noevia#2190 round 7): AES-256-GCM under
// HKDF-SHA256(backupKey, empty salt, "noevia google token v1"), base64 of iv|tag|body. The Rust front is
// the only owner of the files; this module is what is left of gdrive.cjs for the two things that still
// run in Node: `secrets:rotate` re-sealing an account's file under the new key (#866), and the golden
// vector that proves Rust and Node agree on the bytes.
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
 * Re-seals a token file written under `previousKey` with `currentKey` (#866). Returns 'current' when it
 * already opens with the current key, 'rotated' when it was re-sealed, 'empty' for an empty file, and
 * throws when neither key opens it. Token values never appear in the thrown message.
 */
function resealTokenFile(file, currentKey, previousKey) {
  const text = nodeFs.readFileSync(file, 'utf8');
  if (!text.trim()) return 'empty';
  try { sealer(currentKey).open(text); return 'current'; } catch { /* maybe the previous key */ }
  if (!previousKey) throw new Error('sealed under a key that is no longer available');
  let obj;
  try { obj = sealer(previousKey).open(text); } catch { throw new Error('sealed under a key that is no longer available'); }
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  nodeFs.writeFileSync(tmp, sealer(currentKey).seal(obj), { mode: 0o600 });
  nodeFs.renameSync(tmp, file);
  return 'rotated';
}

module.exports = { sealer, resealTokenFile };
