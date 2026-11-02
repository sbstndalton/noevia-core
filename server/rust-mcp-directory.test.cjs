'use strict';
// sbstndalton/noevia#2202 round 2: the admin MCP directory, the permitted-tools view and the connectors list are the
// Rust front's (noevia-rs mcp_directory_routes.rs, toolbox_routes.rs, nextcloud_routes.rs, each tested there through
// real HTTP). Node refuses their routes before authentication, with exactly the paths and methods the front's route
// table gives Rust, and no longer holds the code that answered them. Synthetic values only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const directory = require('./rust-mcp-directory.cjs');
const permitted = require('./rust-toolboxes-permitted.cjs');
const connectors = require('./rust-connectors.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });
const refuse = (m, method, url) => { const res = {}; return m.refuseOwned({ url, method, headers: {}, on() { throw new Error('body listener'); } }, res, { parseRequestUrl, json }) ? res : null; };

test('the admin directory: every method of exactly the six paths is refused, with its own code, before the body is read', () => {
  const expected = { status: 503, body: directory.ROUTE_REFUSAL };
  assert.equal(directory.ROUTE_REFUSAL.code, 'RUST_MCP_DIRECTORY_OWNED');
  for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']) {
    for (const url of ['/api/admin/mcp-directory', '/api/admin/mcp-directory/', '/api/admin/mcp-directory/custom', '/api/admin/mcp-directory/custom/preview',
      '/api/admin/mcp-directory/dir-x', '/api/admin/mcp-directory/dir-x/keys', '/api/admin/mcp-directory/dir-x/oauth-client', '/api/admin/mcp-directory/Dir-X/keys', '/api/x/../admin/mcp-directory']) {
      assert.deepEqual(refuse(directory, method, url), expected, `${method} ${url}`);
    }
  }
  // The query string is not the path; a path the front's table does not give Rust stays Node's (its 404).
  assert.deepEqual(refuse(directory, 'GET', '/api/admin/mcp-directory?x=1'), expected);
  for (const url of ['/api/admin/mcp-directory/a/b/c', '/api/admin/mcp-directoryx', '/api/admin/mcp-directories', '/api/admin/mcp-directory/dir-x/other', '/api/mcp-directory', '/api/admin/web-address']) {
    assert.equal(refuse(directory, 'GET', url), null, url);
  }
  assert.equal(directory.refuseOwned({ url: '//[', method: 'GET', headers: {} }, {}, { parseRequestUrl: () => null, json }), false);
});

test('the permitted-tools view: every method of the exact path is refused', () => {
  assert.equal(permitted.ROUTE_REFUSAL.code, 'RUST_TOOLBOXES_PERMITTED_OWNED');
  for (const method of ['GET', 'POST', 'DELETE']) assert.deepEqual(refuse(permitted, method, '/api/toolboxes/permitted?projectId=p&mode=chat'), { status: 503, body: permitted.ROUTE_REFUSAL }, method);
  // The picker has a separate Rust refusal; this module only owns the permitted view.
  for (const url of ['/api/toolboxes', '/api/toolboxes/', '/api/toolboxes/permitted/', '/api/toolboxes/permitted/x', '/api/toolboxesx']) assert.equal(refuse(permitted, 'GET', url), null, url);
});

test('the connectors list and the Nextcloud permissions: exactly GET /api/connectors and PUT /api/connectors/nextcloud/policy', () => {
  assert.equal(connectors.ROUTE_REFUSAL.code, 'RUST_CONNECTORS_OWNED');
  assert.deepEqual(refuse(connectors, 'GET', '/api/connectors'), { status: 503, body: connectors.ROUTE_REFUSAL });
  assert.deepEqual(refuse(connectors, 'PUT', '/api/connectors/nextcloud/policy'), { status: 503, body: connectors.ROUTE_REFUSAL });
  // Other methods, and the Google Drive writes (their own refusal, rust-google-drive.cjs), are not this one's.
  for (const [method, url] of [['POST', '/api/connectors'], ['PUT', '/api/connectors'], ['GET', '/api/connectors/nextcloud/policy'], ['POST', '/api/connectors/nextcloud/policy'],
    ['GET', '/api/connectors/'], ['PUT', '/api/connectors/nextcloud/policy/'], ['PUT', '/api/connectors/gdrive/policy'], ['POST', '/api/connectors/gdrive/connect'], ['get', '/api/connectors']]) {
    assert.equal(refuse(connectors, method, url), null, `${method} ${url}`);
  }
});

test('index.cjs mounts the three refusals before authentication and no longer builds their routes or caches', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  const pre = index.indexOf('const preAuth = requestAuth.authenticate(req);');
  for (const name of ['rust-mcp-directory', 'rust-toolboxes-permitted', 'rust-connectors']) {
    const at = index.indexOf(`require('./${name}.cjs').refuseOwned(req, res, { parseRequestUrl, json })`);
    assert.ok(at > 0 && at < pre, name);
  }
  assert.doesNotMatch(index, /routes\/mcp-directory\.cjs|routes\/connectors\.cjs|createMcpDirectoryRoutes|createConnectorRoutes|permittedToolsCache|createFingerprintedCache|computePermittedTools/);
  assert.match(index, /createMcpDiscoveryPublisher\(/);
  assert.match(index, /mcpDiscoveryPublisher\.start\(\)/);
  for (const gone of ['routes/mcp-directory.cjs', 'routes/connectors.cjs']) assert.equal(fs.existsSync(path.join(__dirname, gone)), false, gone);
});

test('the dead Node code is gone: the cache, the permitted-tools composition, the registry lookup and the fingerprints', () => {
  const tp = require('./toolboxes-permitted.cjs');
  for (const name of ['computePermittedTools', 'permittedProjection', 'createTtlCache', 'createFingerprintedCache', 'CODE_BOX_ID']) assert.equal(tp[name], undefined, name);
  assert.equal(typeof tp.projectToolboxIds, 'function');
  assert.equal(typeof tp.selectedToolboxIds, 'function');
  const policy = require('./tool-policy.cjs').createToolPolicy({ db: new (require('better-sqlite3'))(':memory:') });
  assert.equal(policy.fingerprint, undefined, 'nothing caches the permissions here any more');
});

test('the front\'s capabilities are named by the markers index.cjs carries (the supervisor pairs them)', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  for (const name of ['rust-mcp-directory', 'rust-toolboxes-permitted', 'rust-connectors']) assert.match(index, new RegExp(`require\\('\\./${name}\\.cjs'\\)`), name);
});
