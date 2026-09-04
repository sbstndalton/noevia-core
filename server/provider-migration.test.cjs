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

process.env.UI_DATA_DIR = dataDir;
process.env.DEFAULT_PROVIDER_ID = 'primary';
process.env.DEFAULT_PROVIDER_LABEL = 'Primary inference';
process.env.INFERENCE_BASE_URL = 'http://inference.invalid';

require('./index.cjs');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

test('legacy provider and project IDs migrate atomically with backups', () => {
  const providers = JSON.parse(fs.readFileSync(path.join(dataDir, 'providers.json'), 'utf8')).providers;
  const projects = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8')).projects;
  assert.equal(providers[0].id, 'primary');
  assert.equal(providers[0].label, 'Primary inference');
  assert.equal(projects[0].provider, 'primary');
  assert.ok(fs.existsSync(path.join(dataDir, 'providers.json.pre-neutral-provider.bak')));
  assert.ok(fs.existsSync(path.join(dataDir, 'projects.json.pre-neutral-provider.bak')));
});
