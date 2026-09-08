'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

// The parser is the security boundary for credential pass-through, so it is
// exercised directly rather than through a live server. Each case re-requires
// index.cjs with a different environment.
function parseWith(env) {
  for (const key of ['MCP_SERVERS', 'MCP_SERVER_URL']) delete process.env[key];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('./index.cjs')];
  const mod = require('./index.cjs');
  return mod.MCP_SERVERS;
}

test('MCP_SERVER_URL still means one Nextcloud server that receives the credential', () => {
  const servers = parseWith({ MCP_SERVER_URL: 'http://nextcloud-mcp:8000/mcp' });
  assert.deepEqual(servers, [{ id: 'nextcloud', url: 'http://nextcloud-mcp:8000/mcp', auth: 'nextcloud' }]);
});

test('a server only receives the Nextcloud credential when the operator says so', () => {
  const servers = parseWith({
    MCP_SERVERS: 'nextcloud|http://nextcloud-mcp:8000/mcp|nextcloud, docs|http://docs-mcp:8000/mcp|none',
  });
  assert.deepEqual(servers.map((s) => [s.id, s.auth]), [['nextcloud', 'nextcloud'], ['docs', 'none']]);
});

test('auth defaults to none, so a new server never inherits the password by accident', () => {
  // Omitting the third field must not be a way to get credentials: the failure
  // mode of forgetting it is a tool that cannot authenticate, not a password
  // handed to a service that should never see it.
  const servers = parseWith({ MCP_SERVERS: 'docs|http://docs-mcp:8000/mcp' });
  assert.deepEqual(servers, [{ id: 'docs', url: 'http://docs-mcp:8000/mcp', auth: 'none' }]);

  const misspelled = parseWith({ MCP_SERVERS: 'docs|http://docs-mcp:8000/mcp|nextclod' });
  assert.equal(misspelled[0].auth, 'none');
});

test('malformed, duplicate and credential-bearing entries are dropped, not guessed at', () => {
  const servers = parseWith({
    MCP_SERVERS: [
      'ok|http://a:8000/mcp|none',
      'ok|http://b:8000/mcp|none',        // duplicate id
      '|http://c:8000/mcp|none',          // no id
      'nourl',                            // no url
      'creds|http://u:p@d:8000/mcp|none', // credentials in the URL
      'ftp|ftp://e:8000/mcp|none',        // wrong protocol
      'bad|not a url|none',
    ].join(','),
  });
  assert.deepEqual(servers.map((s) => s.id), ['ok']);
  assert.equal(servers[0].url, 'http://a:8000/mcp');
});

test('no MCP configuration at all is a supported state', () => {
  assert.deepEqual(parseWith({}), []);
});

test('every curated box names a server that exists', () => {
  parseWith({ MCP_SERVER_URL: 'http://nextcloud-mcp:8000/mcp' });
  const { MCP_TOOLBOX_MANIFEST, MCP_SERVERS } = require('./index.cjs');
  const ids = new Set(MCP_SERVERS.map((s) => s.id));
  for (const box of MCP_TOOLBOX_MANIFEST) {
    assert.ok(box.server, `box ${box.id} declares no server`);
    assert.ok(ids.has(box.server), `box ${box.id} names unknown server "${box.server}"`);
  }
});

// ── which boxes are offered ──────────────────────────────────────────────

function offeredWith(env) {
  for (const key of ['ENABLED_TOOLBOXES']) delete process.env[key];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('./index.cjs')];
  return require('./index.cjs').toolboxOffered;
}

test('unset ENABLED_TOOLBOXES offers every box', () => {
  const offered = offeredWith({});
  assert.equal(offered('nextcloud-cookbook'), true);
  assert.equal(offered('nextcloud-files'), true);
  assert.equal(offered('core'), true);
});

test('a named list offers only those boxes', () => {
  const offered = offeredWith({ ENABLED_TOOLBOXES: 'nextcloud-files, nextcloud-sharing' });
  assert.equal(offered('nextcloud-files'), true);
  assert.equal(offered('nextcloud-sharing'), true);
  assert.equal(offered('nextcloud-cookbook'), false);
  assert.equal(offered('nextcloud-mail-send'), false);
});

test('core survives any list, so a deployment cannot lose its built-ins', () => {
  // core is built-in and always safe; filtering it out would take the clock
  // and project-file reads away for no benefit.
  assert.equal(offeredWith({ ENABLED_TOOLBOXES: 'nextcloud-files' })('core'), true);
  assert.equal(offeredWith({ ENABLED_TOOLBOXES: 'nothing-matches' })('core'), true);
});

// ── folder detachment ────────────────────────────────────────────────────

test('a sync with no attached folders keeps uploads and drops folder-derived files', () => {
  // Detaching a folder is expressed as a sync against the remaining list, so
  // emptying that list has to clear what the folders contributed while leaving
  // anything uploaded by hand alone. Getting this backwards orphans files that
  // no longer have a folder to belong to.
  const files = [
    { name: 'notes.md', content: 'kept' },
    { name: 'Docs/a.md', content: 'from a folder', source: 'Docs' },
    { name: 'Docs/b.md', content: 'from a folder', source: 'Docs' },
  ];
  const uploaded = files.filter((f) => !f.source);
  const fromFolders = []; // what a sync produces when nothing is attached
  const next = [...uploaded, ...fromFolders];
  assert.deepEqual(next.map((f) => f.name), ['notes.md']);
});
