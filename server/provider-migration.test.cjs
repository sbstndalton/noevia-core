'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-provider-migration-'));
fs.writeFileSync(path.join(dataDir, 'providers.json'), JSON.stringify({
  providers: [{ id: 'lemonade', label: 'Legacy local', baseUrl: 'http://legacy.invalid', apiKey: '' }],
}));
fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify({
  projects: [{ id: 'project-1', provider: 'lemonade', chats: [] }],
}));

const { createWorkspaceStore } = require('./workspace.cjs');
const userId = '11111111-1111-4111-8111-111111111111';
const workspace = createWorkspaceStore(dataDir, { id: 'primary', label: 'Primary inference', baseUrl: 'http://inference.invalid', apiKey: '' }).get(userId, { claim: true });

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('legacy provider and project IDs migrate atomically with backups', () => {
  const providers = workspace.providers;
  const projects = workspace.projects;
  assert.equal(providers[0].id, 'primary');
  assert.equal(providers[0].label, 'Primary inference');
  assert.equal(projects[0].provider, 'primary');
  assert.ok(fs.existsSync(path.join(workspace.dir, 'migration.json')));
});

test('retained legacy data cannot be claimed by a later administrator, even after owner removal', () => {
  const store = createWorkspaceStore(dataDir, { id: 'primary' });
  const secondId = '22222222-2222-4222-8222-222222222222';
  const second = store.get(secondId, { claim: true });
  assert.deepEqual(second.projects, []);
  assert.equal(fs.existsSync(path.join(second.dir, 'migration.json')), false);
  fs.rmSync(workspace.dir, { recursive: true, force: true });
  const third = store.get('33333333-3333-4333-8333-333333333333', { claim: true });
  assert.deepEqual(third.projects, []);
});

test('existing deployments recover the original owner from the migration marker', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-existing-migration-'));
  try {
    fs.writeFileSync(path.join(root, 'projects.json'), JSON.stringify({ projects: [{ id: 'private-old-project' }] }));
    const first = path.join(root, 'users', userId);
    fs.mkdirSync(first, { recursive: true });
    fs.writeFileSync(path.join(first, 'migration.json'), '{}');
    const store = createWorkspaceStore(root, { id: 'primary' });
    const second = store.get('22222222-2222-4222-8222-222222222222', { claim: true });
    assert.deepEqual(second.projects, []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'legacy-owner.json'))).userId, userId);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
