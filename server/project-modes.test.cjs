const test = require('node:test'), assert = require('node:assert/strict');
const modes = require('./project-modes.cjs');

test('existing projects migrate to Chat-enabled once, without touching explicit choices', () => {
  const legacy = { id: 'p1' }, empty = { id: 'p2', modes: [] }, chosen = { id: 'p3', modes: ['code'] };
  assert.equal(modes.migrate(legacy), true); assert.deepEqual(legacy.modes, ['chat']);
  assert.equal(modes.migrate(legacy), false);
  assert.equal(modes.migrate(empty), true); assert.deepEqual(empty.modes, ['chat']);
  assert.equal(modes.migrate(chosen), false); assert.deepEqual(chosen.modes, ['code']);
});

test('modes are validated, ordered, de-duplicated and never empty', () => {
  assert.deepEqual(modes.sanitize(['code', 'chat', 'chat']), ['chat', 'code']);
  for (const bad of [[], ['chat', 'voice'], 'chat', null]) assert.throws(() => modes.sanitize(bad), (e) => e.status === 400);
});

test('enablement treats an unmigrated project as Chat only', () => {
  assert.equal(modes.enabled({}, 'chat'), true);
  assert.equal(modes.enabled({}, 'code'), false);
  assert.equal(modes.enabled({ modes: ['cowork', 'code'] }, 'chat'), false);
});

test('workspace load migrates legacy projects to Chat and persists it', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { createWorkspaceStore } = require('./workspace.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-modes-migrate-'));
  try {
    const store = createWorkspaceStore(root, { id: 'default', label: 'Default', baseUrl: 'http://localhost', apiKey: '' }, null);
    const file = path.join(store.userDir('00000000-0000-4000-8000-000000000001'), 'projects.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ projects: [{ id: 'old', name: 'Old' }, { id: 'code', name: 'Code', modes: ['code'] }] }));
    const ws = store.get('00000000-0000-4000-8000-000000000001');
    assert.deepEqual(ws.projects.map((p) => p.modes), [['chat'], ['code']]);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).projects.map((p) => p.modes), [['chat'], ['code']]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
