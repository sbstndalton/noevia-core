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
