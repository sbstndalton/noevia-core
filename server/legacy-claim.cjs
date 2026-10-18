'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 512;
const MAX_DEPTH = 32;
const MAX_MS = 2000;
const UUID = /^[0-9a-f-]{36}$/i;

function unavailable(message) {
  return Object.assign(new Error(message), { status: 503, code: 'LEGACY_SETUP_UNAVAILABLE' });
}
function hasLegacy(root) {
  const started = process.hrtime.bigint();
  if (fs.existsSync(path.join(root, 'projects.json')) || fs.existsSync(path.join(root, 'providers.json'))) return true;
  for (const n of fs.readdirSync(root)) {
    checkTime(started);
    if (/^history-.*\.json$/.test(n)) return true;
  }
  return false;
}
function lstat(file) {
  try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
function ensureDir(file) {
  const s = lstat(file);
  if (s) {
    if (!s.isDirectory() || s.isSymbolicLink()) throw unavailable('Legacy workspace contains an unsafe path.');
  } else {
    fs.mkdirSync(file, { mode: 0o700 });
    fs.chmodSync(file, 0o700);
  }
}
function previousOwner(root, started) {
  const users = path.join(root, 'users');
  const us = lstat(users);
  if (!us) return null;
  if (!us.isDirectory() || us.isSymbolicLink()) throw unavailable('Legacy workspace contains an unsafe users directory.');
  let scanned = 0;
  for (const id of fs.readdirSync(users)) {
    checkTime(started);
    if (++scanned > MAX_ENTRIES) throw unavailable('Legacy ownership exceeds scan limit.');
    if (!UUID.test(id)) continue;
    const d = path.join(users, id), ds = lstat(d), m = lstat(path.join(d, 'migration.json'));
    if (ds && ds.isDirectory() && !ds.isSymbolicLink() && m && m.isFile() && !m.isSymbolicLink()) return id;
  }
  return null;
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
  const file = path.join(root, 'legacy-owner.json'), s = lstat(file);
  if (!s) return null;
  if (!s.isFile() || s.isSymbolicLink()) return { malformed: true };
  const bytes = readRegularBounded(file, 4096);
  if (!bytes) return { malformed: true };
  try {
    const v = JSON.parse(bytes.toString('utf8'));
    return v && typeof v === 'object' ? v : { malformed: true };
  } catch { return { malformed: true }; }
}
function needsClaim(root, userId) {
  if (!UUID.test(userId)) throw new Error('invalid user id');
  if (!hasLegacy(root)) return false;
  const stored = ownerRecord(root);
  if (!stored) return true; // An absent marker may be recoverable from a prior target, or need first-claim ownership.
  if (stored.malformed || stored.userId !== userId) return false;
  return !lstat(path.join(root, 'users', userId));
}
function writeOwner(root, id) {
  const file = path.join(root, 'legacy-owner.json');
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ userId: id })); fs.fchmodSync(fd, 0o600); }
  finally { fs.closeSync(fd); }
}
function checkTime(started) {
  if (Number(process.hrtime.bigint() - started) / 1e6 > MAX_MS) throw unavailable('Legacy workspace migration exceeded its time limit.');
}
function candidateNames(root) {
  return fs.readdirSync(root).filter(n =>
    /^(projects|providers|free-chats|auto-roles)\.json$/.test(n) ||
    /^history-.*\.json$/.test(n) || n === 'rag');
}
function inspect(root, names, started) {
  const files = [], budget = { bytes: 0, entries: 0 };
  function visit(rel, depth) {
    checkTime(started);
    if (depth > MAX_DEPTH) throw unavailable('Legacy workspace exceeds migration depth limit.');
    const s = fs.lstatSync(path.join(root, rel));
    if (s.isSymbolicLink() || (!s.isFile() && !s.isDirectory())) throw unavailable('Legacy workspace contains a link or special file.');
    if (++budget.entries > MAX_ENTRIES) throw unavailable('Legacy workspace exceeds migration entry limit.');
    if (s.isFile()) {
      budget.bytes += s.size;
      if (budget.bytes > MAX_BYTES) throw unavailable('Legacy workspace exceeds migration size limit.');
      files.push({ rel, type: 'file', size: s.size });
    } else {
      files.push({ rel, type: 'dir' });
      for (const child of fs.readdirSync(path.join(root, rel)).sort()) visit(path.join(rel, child), depth + 1);
    }
  }
  for (const n of names) visit(n, 0);
  checkTime(started);
  return files;
}
function copyTree(root, rel, dest, started, budget) {
  checkTime(started);
  const source = path.join(root, rel), stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw unavailable('Legacy workspace contains a link or special file.');
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { mode: 0o700 });
    fs.chmodSync(dest, 0o700);
    for (const child of fs.readdirSync(source).sort()) copyTree(root, path.join(rel, child), path.join(dest, child), started, budget);
    return;
  }
  if (!stat.isFile()) throw unavailable('Legacy workspace contains a link or special file.');
  let input = null, output = null;
  try {
    input = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) |
      (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOCTTY || 0));
    const opened = fs.fstatSync(input);
    if (!opened.isFile() || opened.size !== stat.size) throw unavailable('Legacy workspace changed during migration.');
    output = fs.openSync(dest, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      checkTime(started);
      const count = fs.readSync(input, buffer, 0, buffer.length, null);
      if (count === 0) break;
      budget.bytes += count;
      if (budget.bytes > MAX_BYTES) throw unavailable('Legacy workspace exceeds migration size limit.');
      let offset = 0;
      while (offset < count) offset += fs.writeSync(output, buffer, offset, count - offset);
    }
    fs.fsyncSync(output);
    fs.fchmodSync(output, 0o600);
  } catch (e) {
    if (e.code === 'ELOOP') throw unavailable('Legacy workspace contains a link or special file.');
    throw e;
  } finally {
    if (input !== null) fs.closeSync(input);
    if (output !== null) fs.closeSync(output);
  }
}

function validateStage(stage, manifest) {
  const expected = new Map(manifest.map(item => [item.rel, item]));
  const seen = new Set();
  function visit(rel) {
    const file = path.join(stage, rel), stat = fs.lstatSync(file), item = expected.get(rel);
    if (!item || stat.isSymbolicLink() || (item.type === 'dir' ? !stat.isDirectory() : !stat.isFile())) {
      throw unavailable('Legacy workspace changed during migration.');
    }
    if (item.type === 'file' && stat.size !== item.size) throw unavailable('Legacy workspace changed during migration.');
    seen.add(rel);
    if (item.type === 'dir') {
      fs.chmodSync(file, 0o700);
      for (const child of fs.readdirSync(file).sort()) visit(path.join(rel, child));
    } else {
      fs.chmodSync(file, 0o600);
    }
  }
  for (const item of manifest) if (!item.rel.includes(path.sep)) visit(item.rel);
  if (seen.size !== expected.size) throw unavailable('Legacy workspace changed during migration.');
}

function makeStage(parent) {
  const dir = path.join(parent, '.legacy-stage-' + crypto.randomBytes(12).toString('hex'));
  fs.mkdirSync(dir, { mode: 0o700 }); fs.chmodSync(dir, 0o700);
  return dir;
}
function cleanStage(dir) {
  if (!dir) return;
  const s = lstat(dir);
  if (!s) return;
  if (s.isSymbolicLink() || !s.isDirectory()) { fs.unlinkSync(dir); return; }
  fs.rmSync(dir, { recursive: true, force: true });
}
function claimLegacyRoot(root, userId) {
  if (!UUID.test(userId)) throw new Error('invalid user id');
  const started = process.hrtime.bigint();
  if (!hasLegacy(root)) return false;
  checkTime(started);
  const stored = ownerRecord(root);
  if (stored && stored.malformed) return false;
  const owner = stored ? stored.userId : (previousOwner(root, started) || userId);
  const target = path.join(root, 'users', userId);
  const targetStat = lstat(target);
  if (owner !== userId || targetStat) {
    if (!stored) { try { writeOwner(root, owner); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
    return false;
  }
  const names = candidateNames(root);
  checkTime(started);
  const manifest = inspect(root, names, started);
  const users = path.join(root, 'users'), backups = path.join(root, 'migration-backups');
  ensureDir(users); ensureDir(backups);
  const suffix = Date.now() + '-' + process.pid + '-' + crypto.randomBytes(8).toString('hex');
  const backup = path.join(backups, 'legacy-' + suffix);
  let backupStage = null, targetStage = null;
  let backupPublished = false, targetPublished = false;
  try {
    backupStage = makeStage(backups);
    targetStage = makeStage(users);
    const backupBudget = { bytes: 0 }, targetBudget = { bytes: 0 };
    for (const name of names) {
      checkTime(started);
      copyTree(root, name, path.join(backupStage, name), started, backupBudget);
      copyTree(root, name, path.join(targetStage, name), started, targetBudget);
    }
    validateStage(backupStage, manifest); validateStage(targetStage, manifest);
    const marker = { version: 1, source: 'legacy-root', backup, migratedAt: Date.now() };
    fs.writeFileSync(path.join(targetStage, 'migration.json'), JSON.stringify(marker, null, 2), { flag: 'wx', mode: 0o600 });
    fs.chmodSync(path.join(targetStage, 'migration.json'), 0o600);
    checkTime(started);
    fs.renameSync(backupStage, backup); backupPublished = true;
    fs.renameSync(targetStage, target); targetPublished = true;
    if (!stored) writeOwner(root, owner);
    checkTime(started);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST' && !targetPublished) throw unavailable('Legacy workspace target appeared during migration.');
    throw e;
  } finally {
    if (!backupPublished) cleanStage(backupStage);
    if (!targetPublished) cleanStage(targetStage);
  }
}
module.exports = { claimLegacyRoot, hasLegacy, needsClaim, MAX_BYTES, MAX_ENTRIES, MAX_DEPTH, MAX_MS };
