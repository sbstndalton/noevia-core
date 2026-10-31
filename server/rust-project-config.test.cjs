'use strict';
// #2191 round 9: a project's configuration, its instruction skills and a published skill's install are the
// Rust front's (noevia-rs crates/server-projects config.rs, instruction_skills.rs, skill_routes.rs, tested
// there through real HTTP and against the stores: Node's order, status codes and bodies, every field of the
// patch, the review states, the manifests, the install's host and caps). Node refuses the six routes before
// authentication, whoever asks; the chat-bound project routes beside them stay Node's; its handlers are gone.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const { OWNED_ROUTES, ROUTE_REFUSAL, owned, refuseOwned } = require('./rust-project-config.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });

test('the owned list is exactly the config, the instruction skills, the manifests and the install', () => {
  assert.deepEqual([...OWNED_ROUTES].sort(), [
    'GET /api/projects/{projectId}/instruction-skills',
    'GET /api/projects/{projectId}/instruction-skills/manifests',
    'GET /api/projects/{projectId}/instruction-skills/manifests/{skillId}/content',
    'POST /api/projects/{projectId}/config',
    'POST /api/projects/{project}/skills/install',
    'PUT /api/projects/{projectId}/instruction-skills',
  ]);
  assert.ok(Object.isFrozen(OWNED_ROUTES));
  assert.equal(ROUTE_REFUSAL.code, 'RUST_PROJECT_CONFIG_OWNED');
  for (const [m, p] of [
    ['POST', '/api/projects/p1/config'], ['POST', '/api/projects/p%2F1/config'],
    ['GET', '/api/projects/p1/instruction-skills'], ['PUT', '/api/projects/p1/instruction-skills'],
    ['GET', '/api/projects/p1/instruction-skills/manifests'],
    ['GET', '/api/projects/p1/instruction-skills/manifests/skill_a/content'],
    ['POST', '/api/projects/p1/skills/install'],
  ]) assert.equal(owned(m, p), true, `${m} ${p}`);
  // The other methods of those paths, look-alikes and the chat-bound routes beside them are not owned.
  for (const [m, p] of [
    ['GET', '/api/projects/p1/config'], ['PUT', '/api/projects/p1/config'], ['DELETE', '/api/projects/p1/config'],
    ['POST', '/api/projects/p1/instruction-skills'], ['DELETE', '/api/projects/p1/instruction-skills'],
    ['POST', '/api/projects/p1/instruction-skills/manifests'], ['PUT', '/api/projects/p1/instruction-skills/manifests/s/content'],
    ['GET', '/api/projects/p1/skills/install'], ['POST', '/api/projects//config'], ['POST', '/api/projects/a/b/config'],
    ['POST', '/api/projects/p1/config/'], ['GET', '/api/projects/p1/instruction-skills/manifests//content'],
    ['GET', '/api/projects/p1/instruction-skills/manifests/a/b/content'],
    ['POST', '/api/projects/p1/browser'], ['POST', '/api/projects/p1/code'], ['POST', '/api/projects/p1/research'],
  ]) assert.equal(owned(m, p), false, `${m} ${p}`);
});

test('an owned request is refused with a 503 before its body is read; the rest falls through', () => {
  for (const [method, url] of [['POST', '/api/projects/p1/config'], ['PUT', '/api/projects/p1/instruction-skills'], ['GET', '/api/projects/p1/instruction-skills/manifests?x=1'], ['POST', '/api/projects/p1/skills/install']]) {
    const req = { url, method, headers: { host: 'localhost' }, on() { throw new Error('body listener'); } };
    const res = {};
    assert.equal(refuseOwned(req, res, { parseRequestUrl, json }), true, `${method} ${url}`);
    assert.deepEqual(res, { status: 503, body: ROUTE_REFUSAL });
  }
  for (const [method, url] of [['GET', '/api/projects/p1/config'], ['DELETE', '/api/projects/p1/config'], ['HEAD', '/api/projects/p1/instruction-skills'], ['POST', '/api/projects/p1/browser']]) {
    assert.equal(refuseOwned({ url, method, headers: {} }, {}, { parseRequestUrl, json }), false, `${method} ${url}`);
  }
  assert.equal(refuseOwned({ url: '//[', method: 'POST', headers: {} }, {}, { parseRequestUrl, json }), false);
});

test('the dead Node handlers and their library halves are gone; chat keeps what it reads', () => {
  assert.equal(fs.existsSync(path.join(__dirname, 'routes', 'projects.cjs')), false, 'no project route mount is left');
  const skills = require('./instruction-skills.cjs');
  for (const gone of ['setSelection', 'listForClient', 'resolve']) assert.equal(skills[gone], undefined, gone);
  for (const kept of ['inspect', 'list', 'manifests', 'resolvePinned', 'reconcile', 'snapshot', 'enabled', 'sources', 'read']) assert.equal(typeof skills[kept], 'function', kept);
  assert.equal(fs.existsSync(path.join(__dirname, 'routes', 'plugin-directory.cjs')), false);
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.equal(index.includes("routes/projects.cjs"), false);
  assert.ok(index.includes("require('./rust-project-config.cjs').refuseOwned("), 'the marker the supervisor and the assembler pair with the capability');
  assert.ok(index.indexOf("require('./rust-project-config.cjs').refuseOwned(") < index.indexOf('requestAuth.authenticate(req)', index.indexOf('async function handleRequestInner')), 'refused before authentication');
});

test('the catalogue the front validates against carries every toolbox the server knows', () => {
  const { catalogueOf } = require('./project-catalogue.cjs');
  const published = catalogueOf({ selectable: ['core'], defaults: ['core'], icons: ['folder'], known: ['core', 'nextcloud'] });
  assert.deepEqual(published, { version: 1, selectable: ['core'], defaults: ['core'], icons: ['folder'], known: ['core', 'nextcloud'] });
  assert.deepEqual(catalogueOf({ selectable: ['core'], defaults: [], icons: [] }).known, ['core'], 'an older caller publishes what is selectable');
  const index = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.ok(index.includes('known: allToolboxes().map((b) => b.id),'), 'index.cjs publishes allToolboxes()');
});

// ── through the real router ─────────────────────────────────────────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-project-config-'));
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

test('through the router: every owned route is refused signed out and signed in; the browser route is still Node\'s', async () => {
  const admin = seedAccount(dataDir, { username: 'config-admin', displayName: 'Synthetic', role: 'admin', publicOrigin: 'http://localhost' });
  const member = seedAccount(dataDir, { username: 'config-member', displayName: 'Synthetic', role: 'member', publicOrigin: 'http://localhost' });
  const as = (a) => ({ cookie: a.cookie, origin: 'http://localhost', 'x-csrf-token': a.csrf, 'content-type': 'application/json' });
  const routes = [
    ['POST', '/api/projects/p1/config', {}], ['GET', '/api/projects/p1/instruction-skills'], ['PUT', '/api/projects/p1/instruction-skills', {}],
    ['GET', '/api/projects/p1/instruction-skills/manifests'], ['GET', '/api/projects/p1/instruction-skills/manifests/skill_x/content?version=x'],
    ['POST', '/api/projects/p1/skills/install', { skill: 'frontend-design' }],
  ];
  for (const headers of [{}, as(admin), as(member)]) {
    for (const [method, url, body] of routes) {
      const r = await request(url, { method, headers, body });
      assert.deepEqual([r.status, r.json], [503, ROUTE_REFUSAL], `${method} ${url}`);
    }
  }
  assert.equal((await request('/api/projects/p1/browser', { method: 'POST', headers: as(admin), body: {} })).status, 404, 'chat-bound: still Node\'s');
  assert.equal((await request('/api/projects/p1/browser', { method: 'POST', body: '{}' })).status, 401, 'signed out reaches Node\'s authentication');
  // The front\'s other methods of the same paths still reach Node (which has no handler for them any more).
  const get = await request('/api/projects/p1/config', { headers: as(admin) });
  assert.notEqual(get.status, 503);
});
