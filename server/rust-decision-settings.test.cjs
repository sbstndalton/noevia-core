'use strict';
// #2190: Settings -> Models -> Decision service is the Rust front's (noevia-rs
// bins/noevia-server decision_settings_routes.rs, tested there through real HTTP). Node refuses both
// paths before authentication, refuses the row on its guarded connection, and re-reads it per use.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const decision = require('./rust-decision-settings.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });
const refuse = (method, url) => { const res = {}; return decision.refuseOwned({ url, method, headers: {}, on() { throw new Error('body listener'); } }, res, { parseRequestUrl, json }) ? res : null; };

test('both paths, every method, are refused; other shapes are not', () => {
  assert.deepEqual([...decision.OWNED_PATHS], ['/api/admin/decision-settings', '/api/admin/decision-settings/test']);
  assert.ok(Object.isFrozen(decision.OWNED_PATHS));
  assert.equal(decision.ROUTE_REFUSAL.code, 'RUST_DECISION_SETTINGS_OWNED');
  for (const p of decision.OWNED_PATHS) for (const m of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    assert.deepEqual(refuse(m, `${p}?x=1`), { status: 503, body: decision.ROUTE_REFUSAL }, `${m} ${p}`);
  }
  for (const url of ['/api/admin/decision-settings/', '/api/admin/decision-settings/testx', '/api/admin/decision', '/api/admin/features']) {
    assert.equal(refuse('GET', url), null, url);
  }
});

test('the Node write path is gone', () => {
  const settings = require('./decision-settings.cjs').createDecisionSettings({ store: { get() {}, set() { throw Error('no write'); } }, env: {} });
  for (const name of ['save', 'reset', 'test']) assert.equal(name in settings, false, name);
  const features = fs.readFileSync(path.join(__dirname, 'routes', 'features.cjs'), 'utf8');
  assert.equal(features.includes('decisionSettings'), false);
});

// ── through the real router ─────────────────────────────────────────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-decision-'));
process.env.UI_DATA_DIR = dataDir;
require('../tests/server/project-store-server.cjs').installProjectStore(dataDir);
process.env.PUBLIC_ORIGIN = 'http://localhost';
process.env.LEGACY_AUTH_COMPAT = 'false';
const originalWarn = console.warn;
console.warn = () => {};
const index = require('./index.cjs');
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
  await index.handleRequest(req, res);
  await done;
  const text = Buffer.concat(chunks).toString('utf8');
  let parsed = null; try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.statusCode, headers: out, text, json: parsed };
}

test('through the router: refused signed out and as an admin, before the body is read', async () => {
  const admin = seedAccount(dataDir, { username: 'decision-admin', displayName: 'Synthetic', role: 'admin', publicOrigin: 'http://localhost' });
  const as = { cookie: admin.cookie, origin: 'http://localhost', 'x-csrf-token': admin.csrf };
  for (const [method, url] of [['GET', '/api/admin/decision-settings'], ['PUT', '/api/admin/decision-settings'], ['DELETE', '/api/admin/decision-settings'], ['POST', '/api/admin/decision-settings/test']]) {
    for (const headers of [{}, as]) {
      const r = await request(url, { method, headers, body: '{"url":"http://192.168.1.20:8040","timeoutMs":900}' });
      assert.equal(r.status, 503, `${method} ${url}`);
      assert.deepEqual(r.json, decision.ROUTE_REFUSAL);
    }
  }
  assert.equal((await request('/api/admin/decision-settings/')).status, 401, 'another path shape reaches the session gate');
});

test('through the real database: Node refuses the key; a Rust-side write is in force on the next decision use', async () => {
  const Database = require('better-sqlite3');
  // Node's connection as production guards it (auth.cjs installs the same guard on cowork.db).
  const node = new Database(path.join(dataDir, 'cowork.db'));
  require('./rust-auth.cjs').createRustAuthGuard().install(node);
  test.after(() => node.close());
  const store = require('./feature-setting-source.cjs').createStore(node);
  assert.throws(() => store.writeFact('decision:configuration', '{"url":"http://192.168.1.20:8040","timeoutMs":900}'), { code: 'RUST_DECISION_SETTINGS_OWNED' });
  const settings = require('./decision-settings.cjs').createDecisionSettings({ store, env: {} });
  assert.equal(settings.get().source, 'deployment');
  const rust = new Database(path.join(dataDir, 'cowork.db'));
  try {
    rust.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('decision:configuration',?)").run('{"url":"http://192.168.1.20:8040","timeoutMs":900}');
    assert.deepEqual(settings.get(), { url: 'http://192.168.1.20:8040', timeoutMs: 900, source: 'admin' });
    assert.equal(settings.backend().baseUrl, 'http://192.168.1.20:8040');
    rust.prepare("DELETE FROM settings WHERE key='decision:configuration'").run();
    assert.equal(settings.get().source, 'deployment');
    assert.equal(settings.backend(), null);
  } finally { rust.close(); }
});
