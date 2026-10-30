'use strict';
// sbstndalton/noevia#2191 close-out: GET /api/workspace is the Rust front's (noevia-rs
// crates/server-projects workspace.rs and bins/noevia-server tests/workspace.rs, which hold the list's
// behaviour, the retention sweep and the orphan-context cleanup this route used to run). Node refuses
// the GET before authentication.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
const workspace = require('./rust-workspace.cjs');

const parseRequestUrl = (req, base = 'http://localhost') => { try { return new URL(req.url, base); } catch { return null; } };
const json = (res, status, body) => Object.assign(res, { status, body });
const refuse = (method, url) => { const res = {}; return workspace.refuseOwned({ url, method, headers: {}, on() { throw new Error('body listener'); } }, res, { parseRequestUrl, json }) ? res : null; };

test('exactly the GET of the exact path is refused, before authentication', () => {
  assert.equal(workspace.ROUTE_REFUSAL.code, 'RUST_WORKSPACE_OWNED');
  assert.deepEqual(refuse('GET', '/api/workspace'), { status: 503, body: workspace.ROUTE_REFUSAL });
  assert.deepEqual(refuse('GET', '/api/workspace?x=1'), { status: 503, body: workspace.ROUTE_REFUSAL });
  for (const [m, u] of [['POST', '/api/workspace'], ['HEAD', '/api/workspace'], ['GET', '/api/workspace/'], ['GET', '/api/workspace/model'], ['GET', '/api/workspace-ops'], ['GET', '/api/projects']]) {
    assert.equal(refuse(m, u), null, `${m} ${u}`);
  }
});

test('Node keeps no sweep and no orphan cleanup of its own: both run in the front\'s list', () => {
  const lists = fs.readFileSync(path.join(__dirname, 'routes', 'chat-lists.cjs'), 'utf8');
  assert.equal(lists.includes("p === '/api/workspace'"), false);
  assert.equal(lists.includes('sweepRetention'), false);
  assert.equal(fs.readFileSync(path.join(__dirname, 'projects.cjs'), 'utf8').includes('function removeOrphanChatContexts'), false);
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-rust-workspace-'));
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

async function request(url, { method = 'GET', headers = {} } = {}) {
  const req = Readable.from([]);
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
  return { status: res.statusCode, text, json: parsed };
}

test('through the router: refused signed out and signed in; the other paths keep their gate', async () => {
  const admin = seedAccount(dataDir, { username: 'workspace-admin', displayName: 'Synthetic', role: 'admin', publicOrigin: 'http://localhost' });
  for (const headers of [{}, { cookie: admin.cookie }]) {
    const r = await request('/api/workspace', { headers });
    assert.equal(r.status, 503);
    assert.deepEqual(r.json, workspace.ROUTE_REFUSAL);
  }
  assert.equal((await request('/api/workspace/')).status, 401);
});
