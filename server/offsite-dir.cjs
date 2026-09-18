'use strict';
// A folder as an off-site backup destination (D7), for providers that do not speak S3.
//
// Google Drive is the case this exists for. noevia never talks to Google: it writes its
// encrypted snapshot store into a folder, and the host's rclone mirrors that folder to Drive
// (deploy/offsite/rclone-sync.sh). That split is deliberate:
//
//   * The Google credential never enters noevia. It lives in the host's rclone config, scoped
//     to `drive.file`, which can see only the files rclone itself created — not the rest of the
//     user's Drive.
//   * Nothing readable ever leaves the box. Every object here is already sealed with AES-256-GCM
//     by offsite-backup.cjs, and names reveal nothing about contents.
//
// The contract is the S3 store's, exactly: relative keys, `list` filtered by prefix, `get`
// returning null for a missing key, `delete` idempotent.
//
// Writes are atomic (temp file, fsync, rename) and temp files are hidden with a leading dot,
// because the sync runs on its own schedule and must never upload half a chunk. The sync
// script excludes `.tmp-*` for the same reason.
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const crypto = require('node:crypto');

// What offsite-backup.cjs actually produces: `config`, `data/ab/<hex>`, `snapshots/<time>-<rnd>`.
// No empty, dot-led or `..` segments, so a key can never climb out of the root or collide with
// a temp file.
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]*(\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/;
const TEMP = '.tmp-';

const fail = (message, status = 400) => Object.assign(Error(message), { status, publicMessage: message });

/**
 * @param {{root: string, fs?: typeof import('node:fs')}} options
 */
function createDirStore({ root, fs = nodeFs }) {
  if (!root || !nodePath.isAbsolute(String(root))) throw fail('OFFSITE_BACKUP_DIR must be an absolute path.');
  const base = nodePath.resolve(String(root));

  function file(key) {
    const text = String(key || '');
    if (!KEY.test(text) || text.split('/').includes('..')) throw fail(`Refusing an unsafe backup key: ${text.slice(0, 80)}`);
    const full = nodePath.join(base, ...text.split('/'));
    // Belt and braces after the pattern: the resolved path must still be under the root.
    if (full !== base && !full.startsWith(base + nodePath.sep)) throw fail('Refusing a backup key outside the destination.');
    return full;
  }

  async function put(key, bytes) {
    const target = file(key);
    const dir = nodePath.dirname(target);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = nodePath.join(dir, `${TEMP}${crypto.randomBytes(6).toString('hex')}`);
    const fd = fs.openSync(temp, 'w', 0o600);
    try {
      fs.writeSync(fd, Buffer.from(bytes));
      // A rename is only as durable as the data behind it.
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    try { fs.renameSync(temp, target); }
    catch (error) { try { fs.unlinkSync(temp); } catch { /* already gone */ } throw error; }
  }

  async function get(key) {
    try { return fs.readFileSync(file(key)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async function del(key) {
    try { fs.unlinkSync(file(key)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async function list(prefix = '') {
    const keys = [];
    const walk = (dir, rel) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        // Temp files are half-written by definition; dot entries are never ours.
        if (entry.name.startsWith('.')) continue;
        const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(nodePath.join(dir, entry.name), nextRel);
        else if (entry.isFile() && nextRel.startsWith(prefix)) keys.push(nextRel);
      }
    };
    walk(base, '');
    return keys.sort();
  }

  return { put, get, delete: del, list, root: base };
}

module.exports = { createDirStore, TEMP };
