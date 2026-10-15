const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const modes = require('./project-modes.cjs');

test('the load migration makes every project a Chat project, keeps other recorded modes and is idempotent (#1576)', () => {
  const legacy = { id: 'p1' }, empty = { id: 'p2', modes: [] }, code = { id: 'p3', modes: ['code'] };
  const cowork = { id: 'p4', modes: ['cowork'] }, all = { id: 'p5', modes: ['code', 'cowork', 'chat'] }, done = { id: 'p6', modes: ['chat', 'cowork'] };
  assert.equal(modes.migrate(legacy), true); assert.deepEqual(legacy.modes, ['chat']);
  assert.equal(modes.migrate(empty), true); assert.deepEqual(empty.modes, ['chat']);
  assert.equal(modes.migrate(code), true); assert.deepEqual(code.modes, ['chat', 'code']);
  assert.equal(modes.migrate(cowork), true); assert.deepEqual(cowork.modes, ['chat', 'cowork']);
  assert.equal(modes.migrate(all), true); assert.deepEqual(all.modes, ['chat', 'cowork', 'code']);
  assert.equal(modes.migrate(done), false); assert.deepEqual(done.modes, ['chat', 'cowork']);
  for (const p of [legacy, empty, code, cowork, all, done]) assert.equal(modes.migrate(p), false, `${p.id} migrates once`);
  assert.equal(modes.migrate(null), false);
});

test('a modes value from an old client is accepted and never turns Chat off; garbage is still a 400', () => {
  assert.deepEqual(modes.sanitize(['code', 'chat', 'chat']), ['chat', 'code']);
  assert.deepEqual(modes.sanitize(['cowork']), ['chat', 'cowork']);
  assert.deepEqual(modes.sanitize([]), ['chat']);
  for (const bad of [['chat', 'voice'], 'chat', null]) assert.throws(() => modes.sanitize(bad), (e) => e.status === 400);
});

test('every project takes chats; only archiving keeps a chat out (#1576, #810)', () => {
  for (const p of [{}, { modes: ['cowork'] }, { modes: ['code'] }, { modes: [] }]) {
    assert.equal(modes.enabled(p, 'chat'), true);
    assert.equal(modes.chatDestination(p), true);
  }
  assert.equal(modes.enabled({ modes: ['chat'] }, 'code'), false);
  assert.equal(modes.enabled({ modes: ['chat', 'cowork'] }, 'cowork'), true);
  assert.equal(modes.chatDestination({ modes: ['chat'], archived: true }), false);
  assert.equal(modes.chatDestination(null), false);
});

function workspaceWith(projects) {
  const { createWorkspaceStore } = require('./workspace.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-modes-migrate-'));
  const store = createWorkspaceStore(root, { id: 'default', label: 'Default', baseUrl: 'http://localhost', apiKey: '' }, null);
  const user = '00000000-0000-4000-8000-000000000001';
  const file = path.join(store.userDir(user), 'projects.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = JSON.stringify({ projects });
  fs.writeFileSync(file, original);
  return { root, store, user, file, original, dir: path.dirname(file) };
}
const backups1576 = (dir) => { const d = path.join(dir, 'migration-backups'); return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.startsWith('projects-pre-1576-')) : []; };

test('workspace load migrates a stored Cowork project to Chat, backs up first, keeps its chats and persists it (#1576)', () => {
  const chats = [{ id: 'task-chat', title: 'Fix the synthetic test', updatedAt: 5, mode: 'cowork' }, { id: 'plain', title: 'Hello', updatedAt: 4 }];
  const w = workspaceWith([{ id: 'old', name: 'Old' }, { id: 'cw', name: 'Synthetic cowork', modes: ['cowork'], chats }, { id: 'code', name: 'Code', modes: ['code'] }]);
  try {
    const ws = w.store.get(w.user);
    assert.deepEqual(ws.projects.map((p) => p.modes), [['chat'], ['chat', 'cowork'], ['chat', 'code']]);
    const saved = JSON.parse(fs.readFileSync(w.file, 'utf8')).projects;
    assert.deepEqual(saved.map((p) => p.modes), [['chat'], ['chat', 'cowork'], ['chat', 'code']]);
    assert.deepEqual(saved[1].chats, chats, 'chats and their per-chat cowork mode are untouched');
    const [backup] = backups1576(w.dir);
    assert.ok(backup, 'projects.json is backed up before it is rewritten');
    assert.equal(fs.readFileSync(path.join(w.dir, 'migration-backups', backup), 'utf8'), w.original, 'the backup holds the original bytes');
    w.store.remove?.(w.user);
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('an already migrated workspace is not rewritten or backed up again (#1576)', () => {
  const w = workspaceWith([{ id: 'p', name: 'P', modes: ['chat', 'cowork'] }]);
  try {
    const before = fs.statSync(w.file).mtimeMs;
    w.store.get(w.user);
    assert.equal(fs.readFileSync(w.file, 'utf8'), w.original);
    assert.equal(fs.statSync(w.file).mtimeMs, before);
    assert.deepEqual(backups1576(w.dir), []);
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('a failed #1576 backup keeps the migrated modes off the disk, through the #1806 save too, until a backup succeeds (#1839)', () => {
  const sourceText = require('./source-text.cjs');
  const real = sourceText.backupProjectsFile;
  const w = workspaceWith([{ id: 'cw', name: 'Synthetic', modes: ['cowork'], files: [{ id: 'f', name: 'a.txt', content: 'inline text' }] }, { id: 'old', name: 'Old' }]);
  try {
    sourceText.backupProjectsFile = (dir, tag = '1806') => { if (tag === '1576') throw new Error('disk full (synthetic)'); return real(dir, tag); };
    const ws = w.store.get(w.user);
    assert.deepEqual(ws.projects.map((p) => p.modes), [['chat', 'cowork'], ['chat']], 'the migration still applies in memory');
    let disk = JSON.parse(fs.readFileSync(w.file, 'utf8')).projects;
    assert.ok(disk[0].files[0].textRef, 'the #1806 save did run');
    assert.deepEqual(disk[0].modes, ['cowork'], 'original modes stay on disk after the load save');
    assert.equal(disk[1].modes, undefined);
    assert.deepEqual(backups1576(w.dir), []);
    ws.projects[1].name = 'Renamed'; ws.saveProjects();
    disk = JSON.parse(fs.readFileSync(w.file, 'utf8')).projects;
    assert.equal(disk[1].name, 'Renamed'); assert.deepEqual(disk[0].modes, ['cowork']);
    assert.deepEqual(ws.projects.map((p) => p.modes), [['chat', 'cowork'], ['chat']], 'memory is unchanged by a held save');
    sourceText.backupProjectsFile = real;
    ws.saveProjects();
    disk = JSON.parse(fs.readFileSync(w.file, 'utf8')).projects;
    assert.deepEqual(disk.map((p) => p.modes), [['chat', 'cowork'], ['chat']], 'written once a backup exists');
    assert.equal(backups1576(w.dir).length, 1);
  } finally { sourceText.backupProjectsFile = real; fs.rmSync(w.root, { recursive: true, force: true }); }
});
