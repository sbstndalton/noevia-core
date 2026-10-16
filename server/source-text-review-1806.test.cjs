'use strict';
// #1806 review (core#126 FIX FIRST): strict rollback, no '' saved over an unreadable text, no source
// text collection after a corrupt load, durable and self-repairing text writes, collection under
// the projects.json flock with a grace for in-flight handlers. Synthetic fixtures only.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { createWorkspaceStore } = require('./workspace.cjs');
const sourceText = require('./source-text.cjs');
const rustProjects = require('./rust-projects.cjs');
const documentSources = require('./document-sources.cjs');

const USER = '11111111-2222-4333-8444-555555555555';
const DEFAULT = { id: 'local', label: 'Local', baseUrl: 'http://127.0.0.1:1', apiKey: '' };
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1806r-'));
// #1264: with the front sharing projects.json, Node saves through the Rust project store (a stand-in here).
const { createStubStore, remoteFor } = require('../tests/server/project-store-stub.cjs');
const A = 'alpha synthetic text', B = 'bravo synthetic text';

function seeded(projects = [{ id: 'p1', name: 'P', files: [{ name: 'a.md', content: A }, { name: 'b.md', content: B }], chats: [] }]) {
  sourceText._cache.clear();
  sourceText._setGraceMs(0);
  const root = tmp();
  const dir = path.join(root, 'users', USER);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify({ projects }, null, 2));
  createWorkspaceStore(root, DEFAULT, null).get(USER); // migrates
  return { root, dir, file: path.join(dir, 'projects.json'), text: (p, t) => path.join(dir, 'project-sources', p, `${sha(t)}.txt`) };
}
const listing = (dir) => {
  const out = [];
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const f = path.join(d, n); if (fs.statSync(f).isDirectory()) walk(f); else out.push([path.relative(dir, f), fs.readFileSync(f, 'utf8')]); } };
  if (fs.existsSync(dir)) walk(dir);
  return out.sort();
};

test('review 1: the inline rollback reads every text strictly; a missing or mismatched one aborts before anything is written', () => {
  for (const damage of ['missing', 'mismatched', 'empty']) {
    const { dir, file, text } = seeded();
    if (damage === 'missing') fs.rmSync(text('p1', B));
    else fs.writeFileSync(text('p1', B), damage === 'empty' ? '' : 'not the text');
    const before = fs.readFileSync(file);
    const backups = fs.readdirSync(path.join(dir, 'migration-backups'));
    assert.throws(() => sourceText.inlineAll(dir), (e) => e.code === 'ROLLBACK_ABORTED' && /b\.md/.test(e.message), damage);
    assert.deepEqual(fs.readFileSync(file), before, `${damage}: projects.json untouched`);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'migration-backups')), backups, `${damage}: no backup written`);
  }
  const { dir, file } = seeded();
  assert.equal(sourceText.inlineAll(dir), 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects[0].files, [{ name: 'a.md', content: A }, { name: 'b.md', content: B }]);
});

test('review 2: a source whose text cannot be read keeps its pointer through spreads and documentSources.failed; no empty text is saved', () => {
  const { root, file, text } = seeded();
  fs.rmSync(text('p1', B));
  sourceText._cache.clear();
  const ws = createWorkspaceStore(root, DEFAULT, null).get(USER);
  const [a, b] = ws.projects[0].files;
  assert.equal(b.content, '', 'a reader sees empty text');
  // routes/projects.cjs folder sync: `previous` kept as a spread, or via documentSources.failed.
  ws.projects[0].files = [{ ...a }, { ...documentSources.failed(b, 'b.md', 'synthetic refresh failure'), source: 'F' }];
  ws.saveProjects();
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).projects[0].files;
  assert.equal(saved[0].textRef, sha(A));
  assert.equal(saved[1].textRef, sha(B), 'the old pointer is kept');
  assert.ok(!fs.existsSync(text('p1', '')), 'no empty text file');
  // The text comes back (a restore): the kept pointer finds it.
  fs.writeFileSync(text('p1', B), B);
  sourceText._cache.clear();
  assert.equal(createWorkspaceStore(root, DEFAULT, null).get(USER).projects[0].files[1].content, B);
});

test('review 3: after a corrupt projects.json loads as empty, a save leaves every source text in place', () => {
  for (const corrupt of ['{ "projects": [ {"id": "p1",', '{"projects": {"p1": 1}}']) {
    const { root, dir, file } = seeded();
    const before = listing(path.join(dir, 'project-sources'));
    assert.equal(before.length, 2);
    fs.writeFileSync(file, corrupt);
    const ws = createWorkspaceStore(root, DEFAULT, null).get(USER);
    assert.deepEqual(ws.projects, []);
    ws.saveProjects();
    ws.projects.push({ id: 'p2', name: 'New', files: [{ name: 'n.md', content: 'new synthetic' }] });
    ws.saveProjects();
    assert.deepEqual(listing(path.join(dir, 'project-sources')).filter(([n]) => n.startsWith('p1')), before, corrupt);
  }
  // An empty list from a good file collects nothing either.
  const { root, dir } = seeded();
  const ws = createWorkspaceStore(root, DEFAULT, null).get(USER);
  ws.projects.splice(0);
  ws.saveProjects();
  assert.equal(listing(path.join(dir, 'project-sources')).length, 2);
});

test('review 4: a text is fsynced before its rename and the folder after; a zero-length or wrong file is rewritten', () => {
  const root = tmp();
  const real = { fsync: fs.fsyncSync, rename: fs.renameSync };
  const events = [];
  fs.fsyncSync = (fd) => { events.push(['fsync', fs.fstatSync(fd).isDirectory() ? 'dir' : 'file']); return real.fsync(fd); };
  fs.renameSync = (a, b) => { events.push(['rename']); return real.rename(a, b); };
  try { sourceText.writeText(root, 'p1', sha(A), A); } finally { fs.fsyncSync = real.fsync; fs.renameSync = real.rename; }
  // #1815: the folders just created (project-sources/p1, project-sources, the workspace) are each
  // fsynced too, after the rename and deepest first.
  assert.deepEqual(events, [['fsync', 'file'], ['rename'], ['fsync', 'dir'], ['fsync', 'dir'], ['fsync', 'dir']]);
  const f = path.join(root, 'project-sources', 'p1', `${sha(A)}.txt`);
  for (const bad of ['', 'alpha synthetic tex!', 'x']) {
    fs.writeFileSync(f, bad);
    sourceText.writeText(root, 'p1', sha(A), A);
    assert.equal(fs.readFileSync(f, 'utf8'), A, JSON.stringify(bad));
  }
  const stamp = fs.statSync(f).mtimeMs;
  sourceText.writeText(root, 'p1', sha(A), A);
  assert.equal(fs.statSync(f).mtimeMs, stamp, 'an intact file is kept');
});

test('review 5: the collection runs after the store has written the file, over what was written', async () => {
  const dir = tmp(); const file = path.join(dir, 'projects.json');
  fs.writeFileSync(file, JSON.stringify({ projects: [] }));
  const log = [];
  const remote = remoteFor(dir);
  const write = remote.client.write;
  remote.client.write = async (...args) => { const r = await write(...args); log.push('write'); return r; };
  const pf = rustProjects.createProjectsFile(file, { remote });
  const list = pf.load();
  list.push({ id: 'p1', files: [] });
  await pf.save(list, (written) => { log.push('collect'); assert.deepEqual(written.map((p) => p.id), ['p1']); });
  assert.deepEqual(log, ['write', 'collect']);
});

test('review 5: with the Rust front sharing projects.json, a save collects through the store', async () => {
  const { root, dir, text } = seeded();
  const ws = createWorkspaceStore(root, DEFAULT, null, { rustProjects: true, rustFreeChats: true, projectStore: createStubStore(root) }).get(USER);
  await ws.pendingStoreWrites();
  ws.projects[0].files = ws.projects[0].files.slice(0, 1);
  await ws.saveProjects();
  assert.ok(!fs.existsSync(text('p1', B)));
  assert.ok(fs.existsSync(text('p1', A)));
  assert.ok(!fs.existsSync(path.join(dir, 'projects.json.lock')), 'Node takes no flock');
});

test('review 5: a handler that awaited and puts back a source dropped meanwhile still finds its text (collection grace)', () => {
  const { root, file, text } = seeded();
  sourceText._setGraceMs(sourceText.GRACE_MS);
  try {
    const ws = createWorkspaceStore(root, DEFAULT, null).get(USER);
    const held = ws.projects[0].files[1]; // a folder sync's `previous`, held across its awaits
    ws.projects[0].files = ws.projects[0].files.slice(0, 1); // another route drops it and saves
    ws.saveProjects();
    assert.ok(fs.existsSync(text('p1', B)), 'kept within the grace');
    ws.projects[0].files.push(held); // the sync finishes with its stale view
    ws.saveProjects();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).projects[0].files[1].textRef, sha(B));
    sourceText._cache.clear();
    assert.equal(createWorkspaceStore(root, DEFAULT, null).get(USER).projects[0].files[1].content, B);
    // Unreferenced for longer than the grace, it is removed.
    const ws2 = createWorkspaceStore(root, DEFAULT, null).get(USER);
    ws2.projects[0].files = ws2.projects[0].files.slice(0, 1);
    ws2.saveProjects();
    sourceText.collect(path.dirname(file), ws2.projects, { now: Date.now() + sourceText.GRACE_MS + 1 });
    assert.ok(!fs.existsSync(text('p1', B)));
  } finally { sourceText._setGraceMs(0); }
});
