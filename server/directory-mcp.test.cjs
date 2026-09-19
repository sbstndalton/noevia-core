'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createDirectoryMcp } = require('./directory-mcp.cjs');
const { installable } = require('./routes/plugin-directory.cjs');

test('add, list and remove; only https; no duplicates', () => {
  const dir = createDirectoryMcp({ db: new Database(':memory:') });
  const s = dir.add({ registryName: 'io.github.x/weather', title: 'weather', url: 'https://mcp.example.com/mcp' }, 'u1');
  assert.equal(s.id, 'dir-io-github-x-weather');
  assert.deepEqual(dir.asServers(), [{ id: s.id, url: 'https://mcp.example.com/mcp', auth: 'none', directory: true, title: 'weather' }]);
  assert.throws(() => dir.add({ registryName: 'io.github.x/weather', url: 'https://mcp.example.com/mcp' }), /already added/);
  assert.throws(() => dir.add({ registryName: 'b', url: 'http://mcp.example.com/mcp' }), /https/);
  assert.throws(() => dir.add({ registryName: 'c', url: 'https://{host}/mcp' }), /https/);
  const box = dir.boxFor(dir.asServers()[0], ['forecast']);
  assert.equal(box.reads, undefined, 'no reviewed read-only list, so every call asks');
  dir.remove(s.id);
  assert.deepEqual(dir.list(), []);
});

test('only hosted streamable-HTTP servers without required sign-in are installable', () => {
  assert.deepEqual(installable({ remotes: [{ type: 'streamable-http', url: 'https://a.example/mcp' }] }), { remoteUrl: 'https://a.example/mcp', installable: true });
  assert.equal(installable({ packages: [{}] }).installable, false);
  assert.match(installable({ remotes: [{ type: 'streamable-http', url: 'https://a.example/mcp', headers: [{ name: 'Authorization', isRequired: true }] }] }).notInstallable, /sign-in/);
  assert.equal(installable({ remotes: [{ type: 'sse', url: 'https://a.example/sse' }] }).installable, false);
  assert.equal(installable({ remotes: [{ type: 'streamable-http', url: 'https://{tenant}.example/mcp' }] }).installable, false);
});
