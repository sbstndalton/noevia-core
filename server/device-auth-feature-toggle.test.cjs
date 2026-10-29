'use strict';

// F4 (#555 review): turning nativeClientAuth off is a real revoke, not a pause. Grants are
// deleted and audited, both when an administrator switches the feature off and when the server
// starts with it off while grants from an earlier "on" period are still stored.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-device-toggle-'));
process.env.UI_DATA_DIR = dataDir;
// #1071: Node saves projects.json / free-chats.json only through the Rust project store.
require('../tests/server/project-store-server.cjs').installProjectStore(dataDir);
process.env.PUBLIC_ORIGIN = 'http://localhost';
process.env.LEGACY_AUTH_COMPAT = 'false';
delete process.env.NOEVIA_FEATURE_NATIVE_CLIENT_AUTH; // administrator-controlled, so it can be toggled
process.env.TRUST_PROXY = 'true'; // N3: without it the feature is unavailable and cannot be switched on

const ORIGIN = 'http://localhost';
const quiet = (fn) => { const warn = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = warn; } };

// Before the server starts: an account and a grant left over from when the feature was on. The
// device flow and the accounts are the Rust front's (#1071): both are seeded as it writes them.
const { createAuth } = require('./auth.cjs');
const { seedAccount, seedDeviceToken } = require('../tests/server/seed-account.cjs');
let admin;
let adminId;
test.before(() => {
  const auth = quiet(() => createAuth({ dataDir, publicOrigin: ORIGIN }));
  auth.db.close();
  admin = seedAccount(dataDir, { username: 'toggleqa', publicOrigin: ORIGIN });
  adminId = admin.id;
  seedDeviceToken(dataDir, adminId, { clientName: 'Left over' });
});

let handleRequest;
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

async function request(url, { method = 'GET', headers = {}, body } = {}) {
  handleRequest ||= quiet(() => require('./index.cjs').handleRequest);
  const payload = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(payload ? [payload] : []);
  Object.assign(req, { url, method, headers: { host: 'localhost', ...(payload ? { 'content-type': 'application/json' } : {}), ...headers }, socket: { remoteAddress: '127.0.0.1' } });
  const chunks = []; const out = {};
  const res = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  res.statusCode = 200; res.headersSent = false;
  res.setHeader = (k, v) => { out[k.toLowerCase()] = v; };
  res.writeHead = (s, h = {}) => { res.statusCode = s; res.headersSent = true; for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v; return res; };
  const done = new Promise((resolve) => res.once('finish', resolve));
  await handleRequest(req, res); await done;
  const text = Buffer.concat(chunks).toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.statusCode, json, headers: out };
}

function auditRows(action) {
  const db = new (require('better-sqlite3'))(path.join(dataDir, 'cowork.db'), { readonly: true });
  try { return db.prepare('SELECT * FROM audit_events WHERE action=?').all(action).map((r) => ({ ...r, detail: JSON.parse(r.detail) })); }
  finally { db.close(); }
}
function grantCount() {
  const db = new (require('better-sqlite3'))(path.join(dataDir, 'cowork.db'), { readonly: true });
  try { return db.prepare('SELECT count(*) AS n FROM device_grants').get().n; } finally { db.close(); }
}

test('all direct Node feature paths refuse before auth/body and cannot revoke devices', async()=>{
  const before=auditRows('feature.set').length;
  for(const method of ['GET','PUT','POST','DELETE','HEAD','OPTIONS'])for(const url of ['/api/features','/api/admin/features','/api/admin/features/nativeClientAuth','/api/admin/features/%']) {
    const response=await request(url,{method,body:{enabled:false}});
    assert.equal(response.status,503);
    assert.equal(response.json.code,'RUST_FEATURES_OWNED');
  }
  assert.equal(auditRows('feature.set').length,before);
  const Database=require('better-sqlite3');const db=new Database(path.join(dataDir,'cowork.db'));
  try {assert.equal(db.prepare('SELECT count(*) AS n FROM device_grants').get().n,1,'Node startup and bypass requests do not perform native cleanup');}finally{db.close();}
});
