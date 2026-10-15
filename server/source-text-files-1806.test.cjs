'use strict';
// #1806: project source text lives in per-source files, projects.json holds metadata only.
// Synthetic fixtures only.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { createWorkspaceStore } = require('./workspace.cjs');
// Required lazily, so that on a checkout without it each test fails on its own assertion.
const sourceText = new Proxy({}, { get: (_t, k) => {
  try { return require('./source-text.cjs')[k]; } catch { return k === '_cache' ? { clear() {} } : undefined; }
} });
const skills = require('./instruction-skills.cjs');

// Collection grace off by default here; the grace itself has its own test below.
try { require('./source-text.cjs')._setGraceMs(0); } catch { /* main: no module */ }

const USER = '11111111-2222-4333-8444-555555555555';
const DEFAULT = { id: 'local', label: 'Local', baseUrl: 'http://127.0.0.1:1', apiKey: '' };
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1806-'));
const mode = (f) => fs.statSync(f).mode & 0o777;

const SKILL = '---\nname: synthetic-skill\ndescription: A synthetic test skill\n---\nDo the synthetic thing.';
const legacy = () => ({
  projects: [
    { id: 'proj-a', name: 'Alpha', modes: ['chat'], files: [
      { name: 'notes.md', content: '# Synthetic notes\n\nAlpha beta gamma.' },
      { name: 'helper.md', content: SKILL },
      { name: 'same.md', content: '# Synthetic notes\n\nAlpha beta gamma.' },
      { name: 'empty.txt', content: '' },
      { name: 'photo.png', attachment: { id: 'a'.repeat(64), group: 'Images', assetId: 'img-1' } },
    ], chats: [], instructionSkills: {} },
    { id: 'proj-b', name: 'Beta', modes: ['chat'], files: [{ name: 'b.txt', content: 'bravo synthetic text' }], chats: [] },
  ],
});

function seed(root, data = legacy()) {
  const dir = path.join(root, 'users', USER);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'projects.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return { dir, file, bytes: fs.readFileSync(file) };
}
const onDisk = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const backups = (dir) => (fs.existsSync(path.join(dir, 'migration-backups')) ? fs.readdirSync(path.join(dir, 'migration-backups')).filter((n) => n.startsWith('projects-pre-1806-')) : []);

test('#1806 migration: inline text moves to 0600 per-source files after a byte-exact backup; projects.json keeps metadata and pointers', () => {
  sourceText._cache.clear();
  const root = tmp();
  const { dir, file, bytes } = seed(root);
  const ws = createWorkspaceStore(root, DEFAULT, null).get(USER);

  const saved = onDisk(file);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('Alpha beta gamma'), 'no source text left in projects.json');
  const notes = saved.projects[0].files[0];
  assert.deepEqual(notes, { name: 'notes.md', textRef: sha('# Synthetic notes\n\nAlpha beta gamma.'), chars: 36 });
  assert.equal(saved.projects[0].files[1].skillHeader, true, 'a front-matter skill keeps the flag reconcile reads');
  assert.equal(saved.projects[0].files[2].textRef, notes.textRef, 'the same text is one file');
  assert.deepEqual(saved.projects[0].files[4], legacy().projects[0].files[4], 'an image row without text is untouched');

  const textFile = path.join(dir, 'project-sources', 'proj-a', `${notes.textRef}.txt`);
  assert.equal(fs.readFileSync(textFile, 'utf8'), '# Synthetic notes\n\nAlpha beta gamma.');
  assert.equal(mode(textFile), 0o600);
  assert.equal(mode(path.join(dir, 'project-sources', 'proj-a')), 0o700);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'project-sources', 'proj-a')).sort(),
    [sha(''), sha(SKILL), notes.textRef].map((r) => `${r}.txt`).sort());

  const [backup] = backups(dir);
  assert.ok(backup, 'a backup was kept');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'migration-backups', backup)), bytes, 'the backup is the file as it was');
  assert.equal(mode(path.join(dir, 'migration-backups', backup)), 0o600);

  // Readers keep getting the text.
  assert.equal(ws.projects[0].files[0].content, '# Synthetic notes\n\nAlpha beta gamma.');
  assert.equal(ws.projects[1].files[0].content, 'bravo synthetic text');
  assert.equal(ws.projects[0].files[3].content, '');
  assert.equal(ws.projects[0].files[4].content, undefined);
});

test('#1806 migration is idempotent, survives an interruption, and rolls back losslessly with the inline tool', () => {
  sourceText._cache.clear();
  const root = tmp();
  const { dir, file, bytes } = seed(root);
  // Interrupted run: the backup and one text file were written (and a temp file left behind),
  // then the process died before projects.json was replaced.
  createWorkspaceStore(root, DEFAULT, null).get(USER);
  const migrated = fs.readFileSync(file);
  fs.writeFileSync(file, bytes);
  const partial = path.join(dir, 'project-sources', 'proj-b');
  fs.rmSync(partial, { recursive: true });
  fs.mkdirSync(partial, { recursive: true });
  fs.writeFileSync(path.join(partial, 'x.txt.123.tmp'), 'half');

  createWorkspaceStore(root, DEFAULT, null).get(USER);
  assert.deepEqual(fs.readFileSync(file), migrated, 'the rerun reaches the same projects.json');
  assert.deepEqual(fs.readdirSync(partial), [`${sha('bravo synthetic text')}.txt`], 'a stale temp file is removed');
  assert.equal(backups(dir).length, 1, 'the same original is backed up once');

  // A third load has nothing to move: no new backup, no rewrite.
  const stamp = fs.statSync(file).mtimeMs;
  const ws = createWorkspaceStore(root, DEFAULT, null).get(USER);
  assert.equal(fs.statSync(file).mtimeMs, stamp);
  assert.equal(backups(dir).length, 1);
  assert.equal(ws.projects[0].files[1].content, SKILL);

  // Rollback for code from before #1806: the text goes back inline, equal to the original.
  assert.equal(sourceText.inlineAll(dir), 5);
  assert.deepEqual(onDisk(file), JSON.parse(bytes.toString('utf8')));
});

test('#1806 saves: new or edited text is written out before projects.json, unused text files are removed, spreads and snapshots still read', () => {
  sourceText._cache.clear();
  const root = tmp();
  const { dir, file } = seed(root);
  const ws = createWorkspaceStore(root, DEFAULT, null).get(USER);
  const a = ws.projects[0];

  const copy = { ...a.files[0] };
  assert.equal(copy.content, '# Synthetic notes\n\nAlpha beta gamma.', 'a spread copy carries the text');
  const snap = skills.snapshot(a);
  assert.ok(sourceText.isExternal(snap.files[0]), 'a snapshot still reads on demand');
  assert.equal(snap.files[1].content, SKILL);

  a.files[0].content = 'edited synthetic text';
  a.files.push({ name: 'new.md', content: 'brand new synthetic text' });
  a.files = a.files.filter((f) => f.name !== 'empty.txt');
  ws.saveProjects();
  const saved = onDisk(file).projects[0].files;
  assert.ok(!fs.readFileSync(file, 'utf8').includes('synthetic text'), 'no text in projects.json');
  assert.equal(saved[0].textRef, sha('edited synthetic text'));
  assert.equal(saved[0].chars, 'edited synthetic text'.length);
  assert.equal(saved.at(-1).textRef, sha('brand new synthetic text'));
  const texts = fs.readdirSync(path.join(dir, 'project-sources', 'proj-a')).sort();
  assert.deepEqual(texts, [sha('# Synthetic notes\n\nAlpha beta gamma.'), sha(SKILL), sha('edited synthetic text'), sha('brand new synthetic text')].map((r) => `${r}.txt`).sort(),
    'the removed empty text is collected; same.md still holds the old text');
  assert.equal(a.files[0].content, 'edited synthetic text');

  // A project that is deleted loses its text folder on the next save.
  ws.projects.splice(1, 1);
  ws.saveProjects();
  assert.ok(!fs.existsSync(path.join(dir, 'project-sources', 'proj-b')));
});

test('#1806 readers: the chat file injection, skills and coverage get the text or its length', async () => {
  sourceText._cache.clear();
  const root = tmp();
  seed(root);
  const ws = createWorkspaceStore(root, DEFAULT, null).get(USER);
  const a = ws.projects[0];

  // instruction skills: the flag keeps the candidate without a read; the body is the text.
  assert.equal(skills.reconcile(a), true);
  assert.deepEqual(Object.keys(a.instructionSkills), ['helper.md']);
  assert.equal(skills.list(a)[0].content, SKILL);
  assert.equal(skills.list(a)[0].hash, sha(SKILL));
  assert.deepEqual(skills.sources(a).map((f) => f.name), ['notes.md', 'same.md', 'empty.txt', 'photo.png']);

  // the chat file injection (rag.filesContext, run as the other filesContext tests run it)
  const vm = require('node:vm');
  const src = fs.readFileSync(require.resolve('./rag.cjs'), 'utf8');
  const body = src.slice(src.indexOf('async function filesContext('), src.indexOf('\nmodule.exports'));
  const context = { DIRECT_INJECT_MAX: 2400, FILES_CONTEXT_MAX_CHARS: 120000, LARGE_FILE_HEAD: 24000, documentNotice: () => '',
    frameUntrusted: require('./prompt-framing.cjs').frameUntrusted, ...require('./quoted-name.cjs'), ragAvailable: () => false, searchProject: async () => [] };
  vm.createContext(context); vm.runInContext(body, context);
  const text = await context.filesContext('proj-a', skills.sources(a), 'what is in notes.md', USER, () => {});
  assert.match(text, /Alpha beta gamma/);

  assert.equal(sourceText.textLength(a.files[0]), 36);
  const coverage = require('./source-coverage.cjs');
  const big = { name: 'big.md', content: 'x'.repeat(50000) };
  a.files.push(big); ws.saveProjects();
  assert.deepEqual(coverage.partialSources([a.files.at(-1)], []).map((p) => [p.name, p.length]), [['big.md', 50000]]);
});

test('#1806 a save of 1000 sources reads no source text and takes under 50 ms; projects.json stays small', () => {
  sourceText._cache.clear();
  const root = tmp();
  const filler = 'synthetic source text '.repeat(4600); // ~100k characters each (half the per-source maximum)
  const files = Array.from({ length: 1000 }, (_, i) => ({ name: `folder/sub-${i % 20}/file-${i}.md`, content: `# File ${i}\n${filler}` }));
  const { dir, file } = seed(root, { projects: [{ id: 'proj-big', name: 'Big', modes: ['chat'], files, chats: [] }] });
  const ws = createWorkspaceStore(root, DEFAULT, null).get(USER);

  const reads = [];
  const real = fs.readFileSync;
  fs.readFileSync = function (p, ...rest) { if (String(p).includes(`${path.sep}project-sources${path.sep}`)) reads.push(p); return real.call(this, p, ...rest); };
  const times = [];
  try {
    for (let i = 0; i < 7; i++) {
      ws.projects[0].updatedAt = i;
      for (const p of ws.projects) skills.reconcile(p); // what projects.cjs saveProjects runs first
      const t0 = process.hrtime.bigint();
      ws.saveProjects();
      times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
  } finally { fs.readFileSync = real; }
  times.sort((x, y) => x - y);
  assert.ok(times[3] < 50, `median save ${times[3].toFixed(1)} ms`);
  assert.ok(fs.statSync(file).size < 512 * 1024, `projects.json is ${fs.statSync(file).size} bytes`);
  assert.deepEqual(reads, [], 'no source text is read to save');
  assert.equal(fs.readdirSync(path.join(dir, 'project-sources', 'proj-big')).length, 1000);
});

const NO_FLOCK = spawnSync('flock', ['--version']).error ? 'flock(1) not on PATH' : false;

test('#1806 with the Rust front sharing projects.json: the migration saves under the lock, and a front write keeps the pointers', { skip: NO_FLOCK }, () => {
  sourceText._cache.clear();
  const root = tmp();
  const { file } = seed(root);
  const store = createWorkspaceStore(root, DEFAULT, null, { rustProjects: true });
  store.get(USER);
  const front = onDisk(file);
  assert.equal(front.projects[0].files[0].textRef, sha('# Synthetic notes\n\nAlpha beta gamma.'));
  // The front (noevia-rs server-projects) saves a chat list: it rewrites the file with every other field as read.
  front.projects[0].chats = [{ id: 'c1', title: 'From the front', updatedAt: 5 }];
  fs.writeFileSync(file + '.front', JSON.stringify(front, null, 2));
  fs.renameSync(file + '.front', file);
  const ws = store.get(USER);
  assert.equal(ws.projects[0].chats[0].title, 'From the front');
  assert.equal(ws.projects[0].files[0].content, '# Synthetic notes\n\nAlpha beta gamma.', 'the refreshed project still reads its text');
  ws.projects[1].files[0].content = 'edited after the front';
  ws.saveProjects();
  const after = onDisk(file);
  assert.equal(after.projects[0].chats[0].title, 'From the front');
  assert.equal(after.projects[1].files[0].textRef, sha('edited after the front'));
  assert.equal(ws.projects[1].files[0].content, 'edited after the front');
});

test('#1806 the startup sweep migrates only workspaces that still hold inline text', () => {
  sourceText._cache.clear();
  const root = tmp();
  const { file } = seed(root);
  const clean = '22222222-3333-4444-8555-666666666666';
  fs.mkdirSync(path.join(root, 'users', clean), { recursive: true });
  fs.writeFileSync(path.join(root, 'users', clean, 'projects.json'), JSON.stringify({ projects: [{ id: 'p', name: 'P', files: [] }] }));
  const store = createWorkspaceStore(root, DEFAULT, null);
  assert.deepEqual(store.migrateSourceText([USER, clean, 'not-a-user-id']), [USER]);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('Alpha beta gamma'));
  assert.deepEqual(createWorkspaceStore(root, DEFAULT, null).migrateSourceText([USER, clean]), [], 'nothing left to move');
});
