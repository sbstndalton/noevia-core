'use strict';
// #1818 (follow-ups to #1815): a save that fails partway never leaves a source switched to a pointer
// whose folder was not fsynced; the workspace list does no sync file check per source (a known-missing
// set filled by failed reads and a background async scan, cleared on write); the sources/text 404
// still checks the file itself. Synthetic data only.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');

const sourceText = require('./source-text.cjs');
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const scratch = (tag) => { sourceText._cache.clear(); return fs.mkdtempSync(path.join(os.tmpdir(), `noevia-1818-${tag}-`)); };

test('#1818 D1: a write failing on the 3rd text leaves no source switched, and a retry fsyncs the folder before switching', () => {
  const dir = scratch('fail');
  const texts = ['one synthetic', 'two synthetic', 'three synthetic', 'four synthetic'];
  const projects = [{ id: 'p1', files: texts.map((t, i) => ({ name: `${i}.md`, content: t })) }];
  const pdir = path.join(dir, 'project-sources', 'p1');
  const orig = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, writeSync: fs.writeSync };
  const fdPath = new Map(); const log = [];
  let writes = 0;
  fs.openSync = (p, ...rest) => { const fd = orig.openSync(p, ...rest); fdPath.set(fd, String(p)); return fd; };
  fs.fsyncSync = (fd) => { log.push(fdPath.get(fd)); return orig.fsyncSync(fd); };
  fs.writeSync = (fd, ...rest) => {
    if (String(fdPath.get(fd)).endsWith('.tmp') && ++writes === 3) throw Object.assign(new Error('synthetic ENOSPC'), { code: 'ENOSPC' });
    return orig.writeSync(fd, ...rest);
  };
  try { assert.throws(() => sourceText.externalize(dir, projects), /ENOSPC/); } finally { Object.assign(fs, orig); }
  // The first two texts were renamed into place, but their folder was never fsynced...
  assert.ok(fs.existsSync(path.join(pdir, `${sha(texts[0])}.txt`)));
  assert.ok(!log.includes(pdir), 'the folder was not fsynced in the failed call');
  // ...so no source was switched: each still holds its text as a plain value, no pointer.
  for (const [i, f] of projects[0].files.entries()) {
    const d = Object.getOwnPropertyDescriptor(f, 'content');
    assert.equal(d.value, texts[i], `${f.name} still holds its text inline`);
    assert.equal(f.textRef, undefined, `${f.name} has no pointer`);
    assert.equal(sourceText.isExternal(f), false);
  }
  // What the caller would have written (it does not: the save threw) carries no pointer.
  assert.ok(!JSON.stringify(projects).includes('textRef'));

  // The retry: the files already there are kept, their folder is fsynced, then the sources switch.
  log.length = 0;
  fs.openSync = (p, ...rest) => { const fd = orig.openSync(p, ...rest); fdPath.set(fd, String(p)); return fd; };
  fs.fsyncSync = (fd) => { log.push(fdPath.get(fd)); return orig.fsyncSync(fd); };
  try { assert.equal(sourceText.externalize(dir, projects), 4); } finally { Object.assign(fs, orig); }
  assert.ok(log.includes(pdir), 'the folder holding the earlier renames is fsynced on the retry');
  for (const [i, f] of projects[0].files.entries()) { assert.equal(f.textRef, sha(texts[i])); assert.equal(f.content, texts[i]); }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#1818 D1: a failing folder fsync leaves no source switched either', () => {
  const dir = scratch('fsync');
  const projects = [{ id: 'p1', files: [{ name: 'a.md', content: 'alpha synthetic' }] }];
  const orig = { openSync: fs.openSync, fsyncSync: fs.fsyncSync };
  const fdPath = new Map();
  fs.openSync = (p, ...rest) => { const fd = orig.openSync(p, ...rest); fdPath.set(fd, String(p)); return fd; };
  fs.fsyncSync = (fd) => { if (!String(fdPath.get(fd)).endsWith('.tmp')) throw Object.assign(new Error('synthetic EIO'), { code: 'EIO' }); return orig.fsyncSync(fd); };
  try { assert.throws(() => sourceText.externalize(dir, projects), /EIO/); } finally { Object.assign(fs, orig); }
  assert.equal(projects[0].files[0].textRef, undefined);
  assert.equal(Object.getOwnPropertyDescriptor(projects[0].files[0], 'content').value, 'alpha synthetic');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#1818 D2: meta() over many sources makes no sync filesystem call', async () => {
  const dir = scratch('hot');
  const projects = [{ id: 'p1', files: Array.from({ length: 50 }, (_, i) => ({ name: `${i}.md`, content: `synthetic ${i}` })) }];
  sourceText.externalize(dir, projects);
  const orig = { accessSync: fs.accessSync, statSync: fs.statSync, existsSync: fs.existsSync, readFileSync: fs.readFileSync, openSync: fs.openSync };
  let calls = 0;
  for (const k of Object.keys(orig)) fs[k] = (...a) => { calls += 1; return orig[k](...a); };
  try { for (const f of projects[0].files) sourceText.meta(f); } finally { Object.assign(fs, orig); }
  assert.equal(calls, 0);
  await sourceText.scanSettled(dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#1818 D2: a deleted text is flagged after the background scan, or after a read attempt; a re-upload clears it', async () => {
  const dir = scratch('flag');
  const projects = [{ id: 'p1', files: [{ name: 'a.md', content: 'alpha synthetic' }, { name: 'b.md', content: 'bravo synthetic' }] }];
  sourceText.externalize(dir, projects);
  const [a, b] = projects[0].files;
  const fileA = path.join(dir, 'project-sources', 'p1', `${sha('alpha synthetic')}.txt`);
  const fileB = path.join(dir, 'project-sources', 'p1', `${sha('bravo synthetic')}.txt`);
  fs.rmSync(fileA);
  assert.equal(sourceText.textMissing(a), false, 'unknown before the scan: not flagged');
  sourceText.meta(b);
  await sourceText.scanSettled(dir);
  assert.equal(sourceText.meta(a).textMissing, true, 'flagged by the scan');
  assert.equal('textMissing' in sourceText.meta(b), false);

  // Within the refresh interval no new scan runs; a failed read flags it at once.
  fs.rmSync(fileB);
  assert.equal(sourceText.textMissing(b), false);
  const copy = { name: 'b.md', textRef: sha('bravo synthetic') };
  sourceText.attachFile(copy, dir, 'p1');
  assert.equal(copy.content, '', 'a read of the gone file');
  assert.equal(sourceText.meta(b).textMissing, true, 'flagged by the failed read');

  // Re-upload of the same text writes the file again and clears the flag.
  projects[0].files.push({ name: 'a2.md', content: 'alpha synthetic' });
  sourceText.externalize(dir, projects);
  assert.ok(fs.existsSync(fileA));
  assert.equal('textMissing' in sourceText.meta(a), false, 'cleared by the write');

  // The next scan (interval elapsed) also clears a restored file.
  fs.writeFileSync(fileB, 'bravo synthetic');
  sourceText._setScanMs(0);
  sourceText.meta(b);
  await sourceText.scanSettled(dir);
  assert.equal('textMissing' in sourceText.meta(b), false, 'cleared by the scan');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#1818 D2: collecting a text clears its flag', () => {
  const dir = scratch('gc');
  const projects = [{ id: 'p1', files: [{ name: 'a.md', content: 'alpha synthetic' }] }];
  sourceText.externalize(dir, projects);
  const a = projects[0].files[0];
  const file = path.join(dir, 'project-sources', 'p1', `${sha('alpha synthetic')}.txt`);
  fs.chmodSync(file, 0o000);
  const copy = { name: 'a.md', textRef: a.textRef };
  sourceText.attachFile(copy, dir, 'p1');
  const readable = (() => { try { fs.readFileSync(file); return true; } catch { return false; } })();
  if (!readable) { assert.equal(copy.content, ''); assert.equal(sourceText.textMissing(a), true); }
  fs.chmodSync(file, 0o600);
  projects[0].files = [];
  sourceText.collect(dir, [{ id: 'p1', files: [] }], { graceMs: 0 });
  assert.ok(!fs.existsSync(file), 'collected');
  assert.equal(sourceText.textMissing(a), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
