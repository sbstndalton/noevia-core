'use strict';
// Directory file descriptors, for walking a tree another user can change while noevia (root)
// works in it (#2527, #2529).
//
// Node has no openat(2). On Linux `/proc/self/fd/<n>` names exactly the directory descriptor <n>
// holds, wherever that directory has since been renamed and whatever now sits at its old path, so
// `/proc/self/fd/<n>/<name>` resolves <name> inside that directory and nowhere else: openat(n,
// name) by another spelling. Only the last component is looked up afresh, and every open here
// passes O_NOFOLLOW, so a symlink swapped in for a directory is refused rather than followed.
// Without /proc there is no sound way to do this from Node, so the caller is refused.
const fs = require('node:fs');

const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW } = fs.constants;

function requireProc() {
  let ok = false;
  try { ok = fs.statSync('/proc/self/fd').isDirectory(); } catch { /* not Linux, or no /proc */ }
  if (!ok) throw Error('this host has no /proc/self/fd, so a tree another user can change cannot be walked safely');
}

/** The path that resolves `name` inside the directory `fd` holds. Buffers stay buffers. */
function at(fd, name) {
  if (name === undefined) return `/proc/self/fd/${fd}`;
  const raw = Buffer.isBuffer(name) ? name : Buffer.from(String(name));
  if (!raw.length || raw.includes(0x2f) || raw.includes(0) || raw.equals(Buffer.from('.')) || raw.equals(Buffer.from('..'))) {
    throw Error('not a single path component');
  }
  return Buffer.isBuffer(name) ? Buffer.concat([Buffer.from(`/proc/self/fd/${fd}/`), raw]) : `/proc/self/fd/${fd}/${name}`;
}

/** Open a directory, never through a symlink at its last component. */
function openDir(where) {
  return fs.openSync(where, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
}

/**
 * Open the directory `name` inside `fd` and make sure it is the one `seen` (an lstat of the same
 * entry) described: a directory swapped in between the look and the open is refused, as is a link.
 */
function openChild(fd, name, seen) {
  let child;
  try { child = openDir(at(fd, name)); }
  catch (e) {
    if (e.code === 'ELOOP' || e.code === 'ENOTDIR') throw Object.assign(Error('it was replaced while it was being checked'), { swapped: true });
    throw e;
  }
  const st = fs.fstatSync(child);
  if (!st.isDirectory() || (seen && (st.dev !== seen.dev || st.ino !== seen.ino))) {
    fs.closeSync(child);
    throw Object.assign(Error('it was replaced while it was being checked'), { swapped: true });
  }
  return child;
}

module.exports = { requireProc, at, openDir, openChild };
