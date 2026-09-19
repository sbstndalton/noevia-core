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
  assert.deepEqual(dir.asServers(), [{ id: s.id, url: 'https://mcp.example.com/mcp', auth: 'none', directory: true, title: 'weather', addedBy: 'u1' }]);
  assert.throws(() => dir.add({ registryName: 'io.github.x/weather', url: 'https://mcp.example.com/mcp' }), /already added/);
  assert.throws(() => dir.add({ registryName: 'b', url: 'http://mcp.example.com/mcp' }), /https/);
  assert.throws(() => dir.add({ registryName: 'c', url: 'https://{host}/mcp' }), /https/);
  const box = dir.boxFor(dir.asServers()[0], ['forecast']);
  assert.equal(box.reads, undefined, 'no reviewed read-only list, so every call asks');
  dir.remove(s.id);
  assert.deepEqual(dir.list(), []);
});

test('hosted streamable-HTTP servers are installable, including ones that need a key', () => {
  assert.deepEqual(installable({ remotes: [{ type: 'streamable-http', url: 'https://a.example/mcp' }] }), { remoteUrl: 'https://a.example/mcp', installable: true });
  assert.equal(installable({ packages: [{}] }).installable, false);
  const keyed = installable({ remotes: [{ type: 'streamable-http', url: 'https://a.example/mcp', headers: [{ name: 'Authorization', isRequired: true, isSecret: true, value: 'Bearer {api_key}', description: 'Your API key' }] }] });
  assert.equal(keyed.installable, true);assert.equal(keyed.needsKey, true);
  assert.deepEqual(keyed.headers, [{ name: 'Authorization', required: true, secret: true, description: 'Your API key', template: 'Bearer {api_key}' }]);
  for (const bad of ['Cookie', 'Host', 'mcp-session-id', 'X-Forwarded-For', 'bad name']) assert.equal(installable({ remotes: [{ type: 'streamable-http', url: 'https://a.example/mcp', headers: [{ name: bad, isRequired: true }] }] }).installable, false, bad);
  assert.equal(installable({ remotes: [{ type: 'sse', url: 'https://a.example/sse' }] }).installable, false);
  assert.equal(installable({ remotes: [{ type: 'streamable-http', url: 'https://{tenant}.example/mcp' }] }).installable, false);
});

test('keys are encrypted, never listed, templated, single-line, and replaceable', () => {
  const secrets = { encrypt: (v) => 'enc:' + Buffer.from(v).toString('base64'), decrypt: (v) => Buffer.from(v.slice(4), 'base64').toString() };
  const db = new Database(':memory:');
  const dir = createDirectoryMcp({ db, secrets });
  const declared = [{ name: 'Authorization', required: true, secret: true, template: 'Bearer {api_key}' }, { name: 'X-Region', required: false, secret: false, template: null }];
  assert.throws(() => dir.add({ registryName: 'k', title: 'k', url: 'https://k.example/mcp', declaredHeaders: declared, headerValues: {} }), /Enter Authorization/);
  assert.throws(() => dir.add({ registryName: 'k', title: 'k', url: 'https://k.example/mcp', declaredHeaders: declared, headerValues: { Authorization: 'a\nb' } }), /single line/);
  const s = dir.add({ registryName: 'k', title: 'k', url: 'https://k.example/mcp', declaredHeaders: declared, headerValues: { Authorization: 'SECRET-1', Evil: 'x' } });
  assert.deepEqual(dir.headersFor(s.id), { Authorization: 'Bearer SECRET-1' }, 'only declared names; template applied');
  assert.ok(!JSON.stringify(dir.list()).includes('SECRET-1'));assert.deepEqual(dir.list()[0].keyHeaders, ['Authorization']);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM directory_mcp_servers').all()).includes('SECRET-1'), 'stored encrypted');
  assert.equal(dir.asServers()[0].auth, 'directory');
  dir.setKeys(s.id, declared, { Authorization: 'SECRET-2' });
  assert.deepEqual(dir.headersFor(s.id), { Authorization: 'Bearer SECRET-2' });
});
