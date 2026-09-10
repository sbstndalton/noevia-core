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
function session(response) {
  const body = JSON.parse(response.text);
  return { user: body.user, csrf: body.csrfToken, cookie: response.headers['Set-Cookie'].map(c => c.split(';')[0]).join('; ') };
}
test.before(async () => {
  const r = await request('/api/setup/complete', { method: 'POST', headers: { origin: 'http://localhost' }, body: JSON.stringify({ setupCode: fs.readFileSync(path.join(testDataDir, 'first-run-setup-code'), 'utf8').trim(), publicOrigin: 'http://localhost', username: 'owner', password: 'synthetic onboarding password', diaryEnabled: true }) });
  assert.equal(r.status, 201); admin = session(r);
  const invite = await request('/api/admin/invitations', { method: 'POST', headers: headers(admin), body: JSON.stringify({ role: 'member' }) });
  assert.equal(invite.status, 201);
  const joined = await request('/api/auth/invitations/accept', { method: 'POST', headers: { origin: 'http://localhost' }, body: JSON.stringify({ token: JSON.parse(invite.text).token, username: 'member', password: 'synthetic onboarding password', diaryEnabled: false }) });
  assert.equal(joined.status, 201); member = session(joined);
});
test('invited member can finish only its own onboarding, with CSRF required', async () => {
  assert.equal(member.user.onboarded, false);
  assert.equal((await request('/api/profile/onboarding', { method: 'POST', headers: { cookie: member.cookie, origin: 'http://localhost' }, body: '{}' })).status, 403);
  const done = await request('/api/profile/onboarding', { method: 'POST', headers: headers(member), body: JSON.stringify({ userId: admin.user.id, diaryEnabled: true }) });
  assert.equal(done.status, 200);
  const me = JSON.parse((await request('/api/auth/session', { headers: headers(member) })).text).user;
  assert.equal(me.onboarded, true); assert.equal(me.diaryEnabled, false);
  const owner = JSON.parse((await request('/api/auth/session', { headers: headers(admin) })).text).user;
  assert.equal(owner.onboarded, false); assert.equal(owner.diaryEnabled, true);
});
test('onboarding does not grant members administrator or global model access', async () => {
  for (const url of ['/api/admin/users', '/api/admin/invitations', '/api/models/download']) {
    const method = url === '/api/admin/users' ? 'GET' : 'POST';
    assert.equal((await request(url, { method, headers: headers(member), body: method === 'POST' ? '{}' : '' })).status, 403, url);
  }
  assert.equal((await request('/api/providers', { method: 'POST', headers: headers(member), body: JSON.stringify({ label: 'Forbidden shared', baseUrl: 'https://example.test', shared: true }) })).status, 403);
});
test('member diary and storage choices stay within the authenticated account', async () => {
  const r = await request('/api/profile/features', { method: 'PUT', headers: headers(member), body: JSON.stringify({ userId: admin.user.id, diaryEnabled: false }) });
  assert.equal(r.status, 200);
  const owner = JSON.parse((await request('/api/auth/session', { headers: headers(admin) })).text).user;
  assert.equal(owner.diaryEnabled, true);
  const saved = await request('/api/integrations/storage', { method: 'PUT', headers: headers(member), body: JSON.stringify({ kind: 'local', corpusRoot: 'synthetic-member-only', userId: admin.user.id }) });
  assert.equal(saved.status, 200);
  const storage = JSON.parse((await request('/api/integrations/storage', { headers: headers(admin) })).text);
  assert.notEqual(storage.corpusRoot, 'synthetic-member-only');
});
