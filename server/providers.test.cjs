'use strict';
// The provider registry's lookup and request headers. Listing, connecting, editing and removing are
// the Rust front's (noevia-rs provider_routes.rs, tested there through real HTTP, including the key
// masking); the files as a workspace reads them are workspace-shared.test.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderRegistry } = require('./providers.cjs');

function fixture() {
  const providers = [
    { id: 'default', label: 'Local', baseUrl: 'http://engine:11434', apiKey: 'local', shared: true },
    { id: 'shared-1', label: 'Team', baseUrl: 'https://team.example', apiKey: 'sk-teamteamteam1234', shared: true },
    { id: 'mine-1', label: 'Mine', baseUrl: 'https://mine.example', apiKey: 'short' },
  ];
  return { registry: createProviderRegistry({ PROVIDERS: providers, DEFAULT_PROVIDER_ID: 'default' }) };
}

test('the registry has no writer and no key masking any more: the front owns both', () => {
  const { registry } = fixture();
  assert.deepEqual(Object.keys(registry).sort(), ['getProvider', 'providerHeaders']);
});

test('getProvider resolves the legacy alias and falls back to the default', () => {
  const { registry } = fixture();
  assert.equal(registry.getProvider('mine-1').label, 'Mine');
  assert.equal(registry.getProvider('lemonade').id, 'default');
  assert.equal(registry.getProvider('ghost').id, 'default');
  assert.equal(registry.getProvider(undefined).id, 'default');
});

test('a key becomes a bearer header for the provider; local and empty keys send none', () => {
  const { registry } = fixture();
  assert.deepEqual(registry.providerHeaders({ apiKey: 'sk-1' }, { Accept: 'text/event-stream' }), { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: 'Bearer sk-1' });
  assert.deepEqual(registry.providerHeaders({ apiKey: 'local' }), { 'Content-Type': 'application/json' });
  assert.deepEqual(registry.providerHeaders({ apiKey: '' }), { 'Content-Type': 'application/json' });
});
