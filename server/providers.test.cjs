'use strict';
// The provider registry over a fake workspace: which file each save touches, the default and
// its legacy alias, key masking, and the headers a provider gets. The routes are
// routes/providers.test.cjs; the shared/private persistence itself is workspace-shared.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderRegistry } = require('./providers.cjs');

function fixture() {
  const workspace = {
    providers: [
      { id: 'default', label: 'Local', baseUrl: 'http://engine:11434', apiKey: 'local', shared: true },
      { id: 'shared-1', label: 'Team', baseUrl: 'https://team.example', apiKey: 'sk-teamteamteam1234', shared: true },
      { id: 'mine-1', label: 'Mine', baseUrl: 'https://mine.example', apiKey: 'short' },
    ],
    privateProviders: null, saved: [],
    saveProviders() { this.saved.push('private'); }, saveShared() { this.saved.push('shared'); },
  };
  const registry = createProviderRegistry({ currentWorkspace: () => workspace, PROVIDERS: workspace.providers, DEFAULT_PROVIDER_ID: 'default' });
  return { registry, workspace };
}

test('a private save syncs only the private rows and never rewrites the shared file', () => {
  const { registry, workspace } = fixture();
  registry.saveProviders();
  assert.deepEqual(workspace.privateProviders.map((p) => p.id), ['mine-1']);
  assert.deepEqual(workspace.saved, ['private']);
  registry.saveSharedProviders();
  assert.deepEqual(workspace.saved, ['private', 'shared']);
  assert.deepEqual(workspace.privateProviders.map((p) => p.id), ['mine-1'], 'the shared save keeps the private rows in memory only');
});

test('getProvider resolves the legacy alias and falls back to the default', () => {
  const { registry } = fixture();
  assert.equal(registry.getProvider('mine-1').label, 'Mine');
  assert.equal(registry.getProvider('lemonade').id, 'default');
  assert.equal(registry.getProvider('ghost').id, 'default');
  assert.equal(registry.getProvider(undefined).id, 'default');
});

test('keys are masked for the client and become bearer headers for the provider', () => {
  const { registry } = fixture();
  assert.equal(registry.maskKey('sk-teamteamteam1234'), 'sk-…1234');
  assert.equal(registry.maskKey('short'), '…hort');
  assert.equal(registry.maskKey('local'), null);
  assert.equal(registry.maskKey(''), null);
  assert.deepEqual(registry.providerHeaders({ apiKey: 'sk-1' }, { Accept: 'text/event-stream' }), { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: 'Bearer sk-1' });
  assert.deepEqual(registry.providerHeaders({ apiKey: 'local' }), { 'Content-Type': 'application/json' });
});
