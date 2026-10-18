'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 512;
const MAX_DEPTH = 32;
const MAX_MS = 2000;
const UUID = /^[0-9a-f-]{36}$/i;
const UNREADABLE = Symbol('owner marker is not safely readable');

function unavailable(message) {
  return Object.assign(new Error(message), { status: 503, code: 'LEGACY_SETUP_UNAVAILABLE' });
}
function checkTime(started) {
  if (Number(process.hrtime.bigint() - started) / 1e6 > MAX_MS) throw unavailable('Legacy workspace scan exceeded its time limit.');
}
function lstat(file) {
  try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function readRegularBounded(file, maxBytes) {
  let fd = null;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) |
      (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOCTTY || 0);
    fd = fs.openSync(file, flags);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > maxBytes) return null;
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maxBytes) return null;
    return bytes.subarray(0, length);
  } catch { return null; }
  finally { if (fd !== null) fs.closeSync(fd); }
}
function ownerRecord(root) {
  let fileStat;
  try { fileStat = lstat(path.join(root, 'legacy-owner.json')); } catch { return UNREADABLE; }
  if (!fileStat) return null;
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > 4096) return UNREADABLE;
  const bytes = readRegularBounded(path.join(root, 'legacy-owner.json'), 4096);
  if (!bytes) return UNREADABLE;
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : { malformed: true };
  } catch { return { malformed: true }; }
}
function hasLegacy(root) {
  const started = process.hrtime.bigint();
  try {
    for (const fixed of ['projects.json', 'providers.json']) {
      checkTime(started);
      if (lstat(path.join(root, fixed))) return true;
    }
    const dir = fs.opendirSync(root);
    try {
      let seen = 0;
      while (true) {
        checkTime(started);
        const item = dir.readSync();
        if (!item) return false;
        if (++seen > MAX_ENTRIES) return true;
        if (/^history-.*\.json$/.test(item.name)) return true;
      }
    } finally { dir.closeSync(); }
  } catch {
    // This is only a fast-path hint. Uncertainty must defer to the bounded Rust authority.
    return true;
  }
}
function needsClaim(root, userId) {
  if (typeof userId !== 'string' || !UUID.test(userId)) throw new Error('invalid user id');
  if (!hasLegacy(root)) return false;
  const stored = ownerRecord(root);
  if (stored === UNREADABLE) return true;
  if (stored && (stored.malformed || stored.userId !== userId)) return false;
  if (!stored) return true; // Missing ownership may be recoverable from a prior target.
  try {
    const target = lstat(path.join(root, 'users', userId));
    if (!target) return true;
    // Existing directories are already settled by the helper. Special or linked targets need
    // authoritative inspection so they fail closed rather than suppressing the claim.
    return !target.isDirectory() || target.isSymbolicLink();
  } catch { return true; }
}
function claimLegacyRoot(root, userId) {
  if (typeof userId !== 'string' || !UUID.test(userId)) throw new Error('invalid user id');
  const configured = process.env.NOEVIA_LEGACY_CLAIM_BIN;
  if (typeof configured !== 'string' || !path.isAbsolute(configured)) {
    throw unavailable('Legacy workspace claim helper is not configured.');
  }
  let child;
  try {
    child = spawnSync(configured, ['--claim-legacy-root', path.resolve(root), userId], {
      encoding: 'utf8', timeout: 8500, maxBuffer: 1024, shell: false,
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw unavailable('Legacy workspace claim helper could not run.');
  }
  if (child.error || child.signal || child.status !== 0) {
    throw unavailable('Legacy workspace claim helper failed.');
  }
  if (child.stdout === 'CLAIMED\n') return true;
  if (child.stdout === 'SKIPPED\n') return false;
  throw unavailable('Legacy workspace claim helper returned an invalid result.');
}
module.exports = { claimLegacyRoot, hasLegacy, needsClaim, MAX_BYTES, MAX_ENTRIES, MAX_DEPTH, MAX_MS };
