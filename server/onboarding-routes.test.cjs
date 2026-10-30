'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-onboarding-routes-'));
process.env.DIARY_AUTH_TOKEN = 'test-cowork-token';
process.env.UI_DATA_DIR = testDataDir;
// #1071: Node saves projects.json / free-chats.json only through the Rust project store.
require('../tests/server/project-store-server.cjs').installProjectStore(testDataDir);
process.env.LEGACY_AUTH_COMPAT = 'false';
process.env.PUBLIC_ORIGIN = 'http://localhost';

const { handleRequest } = require('./index.cjs');

test.after(() => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

async function request(url, { method = 'GET', headers = {}, body = '' } = {}) {
  const req = Readable.from(body ? [body] : []);
  req.url = url;
  req.method = method;
  req.headers = { host: 'localhost', ...headers };

  const chunks = [];
  const responseHeaders = {};
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  res.statusCode = 200;
  res.headersSent = false;
  res.setHeader = (name, value) => { responseHeaders[name] = value; };
  res.writeHead = (status, nextHeaders = {}) => {
    if (res.headersSent) throw Object.assign(new Error('headers already sent'), {code:'ERR_HTTP_HEADERS_SENT'});
    res.statusCode = status;
    res.headersSent = true;
    Object.assign(responseHeaders, nextHeaders);
    return res;
  };

  const finished = new Promise((resolve, reject) => {
    res.once('finish', resolve);
    res.once('error', reject);
  });
  await handleRequest(req, res);
  await finished;
  return {
    status: res.statusCode,
    headers: responseHeaders,
    text: Buffer.concat(chunks).toString('utf8'),
  };
}


let admin, member;
function headers(session) { return { cookie: session.cookie, origin: 'http://localhost', 'x-csrf-token': session.csrf, 'content-type': 'application/json' }; }
test.before(() => {
  // Sign-in, invitations and completing onboarding are the Rust front's (#1071): an owner and an
  // invited member who has not finished onboarding are seeded directly.
  const { seedAccount } = require('../tests/server/seed-account.cjs');
  admin = seedAccount(testDataDir, { username: 'owner', diaryEnabled: true, onboarded: false, publicOrigin: 'http://localhost' });
  member = seedAccount(testDataDir, { username: 'member', role: 'member', onboarded: false });
});
test('a member who has not finished onboarding gets no administrator or global model access', async () => {
  // Feature administration is the Rust front's: Node refuses it before authentication, so this member
  // meets that refusal (never a Node answer) and it cannot be used as an administrator probe either.
  const features = await request('/api/admin/features', { method: 'GET', headers: headers(member), body: '' });
  assert.equal(features.status, 503, '/api/admin/features');
  assert.equal(JSON.parse(features.text).code, 'RUST_FEATURES_OWNED');
  // GET of the preset suggestion is the Rust front's (#2189): Node refuses it whoever asks.
  const suggestion = await request('/api/models/preset/suggest?model=synthetic', { method: 'GET', headers: headers(member), body: '' });
  assert.equal(suggestion.status, 503);
  assert.equal(JSON.parse(suggestion.text).code, 'RUST_MODEL_SIZING_OWNED');
  for (const url of ['/api/models/download', '/api/models/calibration', '/api/models/calibration/cancel', '/api/models/presets/reload', '/api/model-manager/sections', '/api/model-manager/backends/cowork-llama-1/logs']) {
    const method = url.endsWith('/logs') ? 'GET' : 'POST';
    assert.equal((await request(url, { method, headers: headers(member), body: method === 'POST' ? '{}' : '' })).status, 403, url);
  }
  // Connecting a shared provider is the Rust front's (#2190 round 6; its 403 for a member is asserted in noevia-rs tests/providers.rs): Node refuses it.
  assert.equal((await request('/api/providers', { method: 'POST', headers: headers(member), body: JSON.stringify({ label: 'Forbidden shared', baseUrl: 'https://example.test', shared: true }) })).status, 503);
});
test('a member\'s storage choice stays within the authenticated account', async () => {
  // Saving is the Rust front's (#2190 round 4), which saves for the session's account only (the body's
  // userId is ignored: noevia-rs tests/storage_integrations.rs). Node refuses it and writes nothing.
  const saved = await request('/api/integrations/storage', { method: 'PUT', headers: headers(member), body: JSON.stringify({ kind: 'local', corpusRoot: 'synthetic-member-only', userId: admin.id }) });
  assert.equal(saved.status, 503);
  assert.equal(JSON.parse(saved.text).code, 'RUST_STORAGE_CONNECTION_OWNED');
  const db = new (require('better-sqlite3'))(path.join(testDataDir, 'cowork.db'), { readonly: true });
  try {
    for (const id of [member.id, admin.id]) assert.notEqual(db.prepare('SELECT corpus_root FROM storage_connections WHERE user_id=?').get(id)?.corpus_root, 'synthetic-member-only');
  } finally { db.close(); }
});
