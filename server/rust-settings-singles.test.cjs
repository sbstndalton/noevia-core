'use strict';
// #2190: the public pages (/about, /privacy: GET and HEAD), the device approval page (/device, every
// method) and the plugin directory (/api/plugins/directory, every method) are the Rust front's
// (noevia-rs bins/noevia-server public_pages.rs and plugin_directory_routes.rs, tested there through
// real HTTP against a synthetic registry). Node refuses them before authentication; every other
// method and path shape still runs Node's ordinary chain.
//
// The first block is the pure functions; the second goes through the real router (handleRequest).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const pages = require('./rust-public-pages.cjs');
const directory = require('./rust-plugin-directory.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });
const refuse = (mod, method, url) => { const res = {}; return mod.refuseOwned({ url, method, headers: {}, on() { throw new Error('body listener'); } }, res, { parseRequestUrl, json }) ? res : null; };

test('the owned lists are exactly the front\'s routes and methods', () => {
  assert.deepEqual([...pages.PAGE_PATHS], ['/about', '/privacy']);
  assert.deepEqual([...pages.DEVICE_PATHS], ['/device', '/device/']);
  assert.deepEqual([...directory.OWNED_PATHS], ['/api/plugins/directory']);
  for (const list of [pages.PAGE_PATHS, pages.DEVICE_PATHS, directory.OWNED_PATHS]) assert.ok(Object.isFrozen(list));
  assert.equal(pages.ROUTE_REFUSAL.code, 'RUST_PUBLIC_PAGES_OWNED');
  assert.equal(directory.ROUTE_REFUSAL.code, 'RUST_PLUGIN_DIRECTORY_OWNED');
  for (const p of pages.PAGE_PATHS) {
    for (const m of ['GET', 'HEAD']) assert.deepEqual(refuse(pages, m, p + '?x=1'), { status: 503, body: pages.ROUTE_REFUSAL }, `${m} ${p}`);
    for (const m of ['POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal(refuse(pages, m, p), null, `${m} ${p} stays Node's`);
  }
  for (const p of pages.DEVICE_PATHS) for (const m of ['GET', 'HEAD', 'POST', 'DELETE']) {
    assert.deepEqual(refuse(pages, m, p), { status: 503, body: pages.ROUTE_REFUSAL }, `${m} ${p}`);
  }
  for (const m of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']) {
    assert.deepEqual(refuse(directory, m, '/api/plugins/directory?kind=skills&starters=1'), { status: 503, body: directory.ROUTE_REFUSAL }, m);
  }
});

test('other path shapes are not refused', () => {
  for (const url of ['/about/', '/privacy/', '/About', '/about.html', '/device/x', '/devices', '/']) {
    assert.equal(refuse(pages, 'GET', url), null, url);
  }
  for (const url of ['/api/plugins/directory/', '/api/plugins/directoryx', '/api/plugins', '/api/mcp-directory/servers']) {
    assert.equal(refuse(directory, 'GET', url), null, url);
  }
  assert.equal(refuse(pages, 'GET', '//['), null);
});

test('the dead Node handlers are gone; the library the Node routes use stays', () => {
  assert.equal(fs.existsSync(path.join(__dirname, 'routes', 'public-pages.cjs')), false);
  assert.equal(fs.existsSync(path.join(__dirname, 'plugin-starters.json')), false);
  const lib = require('./routes/plugin-directory.cjs');
  assert.equal(lib.createPluginDirectoryRoutes, undefined);
  for (const kept of ['mcpItems', 'findRegistryServer', 'installable', 'fallbackServerName']) assert.equal(typeof lib[kept], 'function', kept);
  assert.equal(lib.fetchPublishedSkill, undefined, 'the install fetch moved with the route (#2191 round 9)');
  assert.ok(lib.RESERVED_HEADERS instanceof RegExp);
  const device = fs.readFileSync(path.join(__dirname, 'routes', 'device-auth.cjs'), 'utf8');
  assert.equal(device.includes('isDevicePage'), false);
});

// ── through the real router ─────────────────────────────────────────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-singles-'));
process.env.UI_DATA_DIR = dataDir;
require('../tests/server/project-store-server.cjs').installProjectStore(dataDir);
process.env.PUBLIC_ORIGIN = 'http://localhost';
process.env.LEGACY_AUTH_COMPAT = 'false';
const originalWarn = console.warn;
console.warn = () => {};
const { handleRequest } = require('./index.cjs');
console.warn = originalWarn;
const { seedAccount } = require('../tests/server/seed-account.cjs');

test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

async function request(url, { method = 'GET', headers = {}, body } = {}) {
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const req = Readable.from(payload ? [payload] : []);
  Object.assign(req, { url, method, headers: { host: 'localhost', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  const chunks = [];
  const out = {};
  const res = new Writable({ write(chunk, _e, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  res.statusCode = 200;
  res.headersSent = false;
  res.setHeader = (k, v) => { out[k.toLowerCase()] = v; };
  res.writeHead = (status, h = {}) => { res.statusCode = status; res.headersSent = true; for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v; return res; };
  const done = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
  await handleRequest(req, res);
  await done;
  const text = Buffer.concat(chunks).toString('utf8');
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.statusCode, headers: out, text, json: parsed };
}

test('through the router: the owned routes are refused signed out and signed in; the rest runs as before', async () => {
  const member = seedAccount(dataDir, { username: 'singles-member', displayName: 'Synthetic', role: 'member', publicOrigin: 'http://localhost' });
  const as = { cookie: member.cookie, origin: 'http://localhost', 'x-csrf-token': member.csrf };
  for (const [method, url, refusal] of [
    ['GET', '/about', pages.ROUTE_REFUSAL], ['HEAD', '/privacy', pages.ROUTE_REFUSAL], ['GET', '/device', pages.ROUTE_REFUSAL],
    ['POST', '/device/', pages.ROUTE_REFUSAL], ['GET', '/x/../about', pages.ROUTE_REFUSAL],
    ['GET', '/api/plugins/directory', directory.ROUTE_REFUSAL], ['POST', '/api/plugins/directory', directory.ROUTE_REFUSAL],
  ]) {
    for (const headers of [{}, as]) {
      const r = await request(url, { method, headers });
      assert.equal(r.status, 503, `${method} ${url}`);
      if (method !== 'HEAD') assert.deepEqual(r.json, refusal, `${method} ${url}`);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['x-noevia-api'], url.startsWith('/api/') ? '1' : undefined, url);
    }
  }
  // Positive controls: Node's chain still answers what it kept.
  assert.equal((await request('/api/plugins/directory/')).status, 401, 'another path shape reaches the session gate');
  assert.notEqual((await request('/about', { method: 'POST' })).status, 503, 'POST /about is still Node\'s');
});
