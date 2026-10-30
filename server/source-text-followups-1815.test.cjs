'use strict';
// #1815 (follow-ups to #1806): the source-text collection waits 24 hours and never runs while a
// folder import or attached-folder sync is in flight in that workspace; a save fsyncs each new
// text file before its rename but each folder only once, after every rename and before
// projects.json is committed. Synthetic data only.

const assert = require('node:assert/strict');
const { createStubStore } = require('../tests/server/project-store-stub.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');

const sourceText = require('./source-text.cjs');
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function scratch() {
  sourceText._cache.clear();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1815-ws-'));
  const pdir = path.join(dir, 'project-sources', 'p1');
  fs.mkdirSync(pdir, { recursive: true });
  const orphan = path.join(pdir, `${sha('orphan synthetic')}.txt`);
  fs.writeFileSync(orphan, 'orphan synthetic');
  return { dir, orphan, projects: [{ id: 'p1', files: [] }] };
}

test('#1815: the collection grace is 24 hours', () => {
  assert.equal(sourceText.GRACE_MS, 24 * 60 * 60 * 1000);
  sourceText._setGraceMs(sourceText.GRACE_MS);
  try {
    const { dir, orphan, projects } = scratch();
    const t0 = 1_000_000;
    sourceText.collect(dir, projects, { now: t0 });
    sourceText.collect(dir, projects, { now: t0 + 31 * 60 * 1000 });
    assert.ok(fs.existsSync(orphan), 'kept past the old 30-minute grace');
    sourceText.collect(dir, projects, { now: t0 + 23 * 60 * 60 * 1000 });
    assert.ok(fs.existsSync(orphan), 'kept at 23 hours');
    sourceText.collect(dir, projects, { now: t0 + 24 * 60 * 60 * 1000 + 1 });
    assert.ok(!fs.existsSync(orphan), 'removed after 24 hours');
  } finally { sourceText._setGraceMs(sourceText.GRACE_MS); }
});

test('#1815: no collection while a folder import or sync is in flight for that workspace; other workspaces are unaffected', async () => {
  const a = scratch(), b = scratch();
  const end = sourceText.beginSourceWork(a.dir);
  sourceText.collect(a.dir, a.projects, { graceMs: 0 });
  sourceText.collect(b.dir, b.projects, { graceMs: 0 });
  assert.ok(fs.existsSync(a.orphan), 'skipped while work is in flight');
  assert.ok(!fs.existsSync(b.orphan), 'another workspace still collects');
  end(); end(); // idempotent
  assert.equal(sourceText.sourceWorkInFlight(a.dir), false);
  sourceText.collect(a.dir, a.projects, { graceMs: 0 });
  assert.ok(!fs.existsSync(a.orphan), 'collected once the work ends');

  // whileSourceWork registers for its whole run and ends on a throw too.
  const c = scratch();
  let release;
  const run = sourceText.whileSourceWork(c.dir, () => new Promise((r) => { release = r; }));
  assert.equal(sourceText.sourceWorkInFlight(c.dir), true);
  sourceText.collect(c.dir, c.projects, { graceMs: 0 });
  assert.ok(fs.existsSync(c.orphan));
  release('done');
  assert.equal(await run, 'done');
  assert.equal(sourceText.sourceWorkInFlight(c.dir), false);
  await assert.rejects(sourceText.whileSourceWork(c.dir, async () => { throw new Error('synthetic failure'); }), /synthetic failure/);
  assert.equal(sourceText.sourceWorkInFlight(c.dir), false);
});


test('#1815: a save fsyncs each text file before its rename and each folder once, after every rename', () => {
  sourceText._cache.clear();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1815-fsync-'));
  const texts = ['one synthetic', 'two synthetic', 'three synthetic'];
  const projects = [{ id: 'p1', files: texts.map((t, i) => ({ name: `${i}.md`, content: t })) }];
  const log = [];
  const fdPath = new Map();
  const orig = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, closeSync: fs.closeSync };
  fs.openSync = (p, ...rest) => { const fd = orig.openSync(p, ...rest); fdPath.set(fd, String(p)); return fd; };
  fs.closeSync = (fd) => { fdPath.delete(fd); return orig.closeSync(fd); };
  fs.fsyncSync = (fd) => { log.push(['fsync', fdPath.get(fd)]); return orig.fsyncSync(fd); };
  fs.renameSync = (a, b) => { log.push(['rename', String(a), String(b)]); return orig.renameSync(a, b); };
  try { assert.equal(sourceText.externalize(dir, projects), 3); }
  finally { Object.assign(fs, orig); }

  const pdir = path.join(dir, 'project-sources', 'p1');
  const dirSyncs = log.filter(([k, p]) => k === 'fsync' && !p.endsWith('.tmp'));
  const fileSyncs = log.filter(([k, p]) => k === 'fsync' && p.endsWith('.tmp'));
  assert.equal(fileSyncs.length, 3, 'one data fsync per new text');
  assert.deepEqual(dirSyncs.map(([, p]) => p), [pdir, path.join(dir, 'project-sources'), dir], 'each folder once, deepest first (new folders included)');
  for (const t of texts) {
    const tmpIdx = log.findIndex(([k, p]) => k === 'fsync' && p.startsWith(path.join(pdir, sha(t))));
    const renIdx = log.findIndex(([k, , to]) => k === 'rename' && to === path.join(pdir, `${sha(t)}.txt`));
    assert.ok(tmpIdx >= 0 && tmpIdx < renIdx, 'the data is durable before the rename');
  }
  const lastRename = log.map(([k]) => k).lastIndexOf('rename');
  const firstDirSync = log.findIndex(([k, p]) => k === 'fsync' && !p.endsWith('.tmp'));
  assert.ok(firstDirSync > lastRename, 'folders are fsynced after every rename (and externalize returns only after)');
  for (const t of texts) assert.equal(fs.readFileSync(path.join(pdir, `${sha(t)}.txt`), 'utf8'), t);

  // A second save of new text in the existing folder: one file fsync, then each folder up to the
  // workspace once (#1819: a folder that already exists may be one a failed save created).
  log.length = 0;
  projects[0].files.push({ name: '3.md', content: 'four synthetic' });
  fs.openSync = (p, ...rest) => { const fd = orig.openSync(p, ...rest); fdPath.set(fd, String(p)); return fd; };
  fs.fsyncSync = (fd) => { log.push(['fsync', fdPath.get(fd)]); return orig.fsyncSync(fd); };
  try { sourceText.externalize(dir, projects); } finally { Object.assign(fs, orig); }
  assert.deepEqual(log.map(([, p]) => (p.endsWith('.tmp') ? 'file' : p)), ['file', pdir, path.join(dir, 'project-sources'), dir]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#1815: workspace.saveProjects commits projects.json only after the batched folder fsync', async () => {
  const { createWorkspaceStore } = require('./workspace.cjs');
  sourceText._cache.clear();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1815-save-'));
  const USER = '11111111-2222-4333-8444-555555555555';
  const ws = createWorkspaceStore(root, { id: 'local', label: 'Local', baseUrl: 'http://127.0.0.1:1', apiKey: '' }, null, { projectStore: createStubStore(root) }).get(USER);
  ws.projects.push({ id: 'p1', name: 'P', files: [{ name: 'a.md', content: 'alpha synthetic' }, { name: 'b.md', content: 'bravo synthetic' }], chats: [] });
  const pdir = path.join(ws.dir, 'project-sources', 'p1');
  const log = [];
  const fdPath = new Map();
  const orig = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync, writeFileSync: fs.writeFileSync };
  fs.openSync = (p, ...rest) => { const fd = orig.openSync(p, ...rest); fdPath.set(fd, String(p)); return fd; };
  fs.fsyncSync = (fd) => { log.push(['fsync', fdPath.get(fd)]); return orig.fsyncSync(fd); };
  fs.renameSync = (a, b) => { log.push(['rename', String(a), String(b)]); return orig.renameSync(a, b); };
  fs.writeFileSync = (p, ...rest) => { log.push(['write', String(p)]); return orig.writeFileSync(p, ...rest); };
  // #1264: the commit is the project store's write, after the save's await.
  try { await ws.saveProjects(); } finally { Object.assign(fs, orig); }
  const folderSync = log.findIndex(([k, p]) => k === 'fsync' && p === pdir);
  const commit = log.findIndex(([k, a, b]) => (k === 'rename' && b === path.join(ws.dir, 'projects.json')) || (k === 'write' && a === path.join(ws.dir, 'projects.json')));
  assert.ok(folderSync >= 0, 'the folder is fsynced');
  assert.ok(commit > folderSync, `projects.json is committed after the folder fsync (${JSON.stringify(log)})`);
  fs.rmSync(root, { recursive: true, force: true });
});
