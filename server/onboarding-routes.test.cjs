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
  for (const url of ['/api/admin/features', '/api/models/download', '/api/models/preset/suggest?model=synthetic', '/api/models/calibration', '/api/models/calibration/cancel', '/api/models/presets/reload', '/api/model-manager/sections', '/api/model-manager/backends/cowork-llama-1/logs']) {
    const method = url === '/api/admin/features' || url.startsWith('/api/models/preset/suggest') || url.endsWith('/logs') ? 'GET' : 'POST';
    assert.equal((await request(url, { method, headers: headers(member), body: method === 'POST' ? '{}' : '' })).status, 403, url);
  }
  assert.equal((await request('/api/providers', { method: 'POST', headers: headers(member), body: JSON.stringify({ label: 'Forbidden shared', baseUrl: 'https://example.test', shared: true }) })).status, 403);
});
test('a member\'s storage choice stays within the authenticated account', async () => {
  const saved = await request('/api/integrations/storage', { method: 'PUT', headers: headers(member), body: JSON.stringify({ kind: 'local', corpusRoot: 'synthetic-member-only', userId: admin.id }) });
  assert.equal(saved.status, 200);
  // GET /api/integrations/storage is the Rust front's (#1071): the saved rows are read directly.
  const db = new (require('better-sqlite3'))(path.join(testDataDir, 'cowork.db'), { readonly: true });
  try {
    assert.equal(db.prepare('SELECT corpus_root FROM storage_connections WHERE user_id=?').get(member.id)?.corpus_root, 'synthetic-member-only');
    assert.notEqual(db.prepare('SELECT corpus_root FROM storage_connections WHERE user_id=?').get(admin.id)?.corpus_root, 'synthetic-member-only');
  } finally { db.close(); }
});
