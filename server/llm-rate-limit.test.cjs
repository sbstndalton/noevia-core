'use strict';

// Route-level tests for the per-user LLM rate limit on /api/chat and the
// Insights reflection proxies. LLM_RATE_LIMIT is lowered to 2 BEFORE the
// server module loads (it is read once at startup), and invalid-JSON chat
// bodies are used so each counted request fails fast at the parse step —
// no inference endpoint involved.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-llm-rate-test-'));
process.env.DIARY_AUTH_TOKEN = 'test-cowork-token';
process.env.UI_DATA_DIR = testDataDir;
process.env.LEGACY_AUTH_COMPAT = 'true';
process.env.PUBLIC_ORIGIN = 'http://localhost';
process.env.LLM_RATE_LIMIT = '2';

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
    write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
  });
  res.statusCode = 200;
  res.headersSent = false;
  res.setHeader = (name, value) => { responseHeaders[name] = value; };
  res.writeHead = (status, nextHeaders = {}) => {
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
  return { status: res.statusCode, headers: responseHeaders, text: Buffer.concat(chunks).toString('utf8') };
}

let cookie = '';
let csrf = '';

test.before(async () => {
  const setupCode = fs.readFileSync(path.join(testDataDir, 'first-run-setup-code'), 'utf8').trim();
  const setup = await request('/api/setup/complete', {
    method: 'POST', headers: { origin: 'http://localhost' },
    body: JSON.stringify({ setupCode, publicOrigin: 'http://localhost', username: 'admin', displayName: 'Admin', password: 'correct horse battery staple' }),
  });
  assert.equal(setup.status, 201);
  const login = await request('/api/auth/login/password', {
    method: 'POST', headers: { origin: 'http://localhost' },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery staple' }),
  });
  const setCookies = login.headers['set-cookie'] || login.headers['Set-Cookie'] || [];
  cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  const csrfPair = setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('cowork_csrf='));
  csrf = decodeURIComponent(csrfPair.split('=').slice(1).join('='));
});

const mutationHeaders = () => ({ origin: 'http://localhost', cookie, 'content-type': 'application/json', 'x-csrf-token': csrf });

test('LLM-backed routes throttle per user after the configured limit', async () => {
  // Request 1 and 2 consume the two allowed slots (400: invalid JSON, after
  // the limiter check — each still counts).
  const first = await request('/api/chat', { method: 'POST', headers: mutationHeaders(), body: 'not-json' });
  assert.equal(first.status, 400);
  const second = await request('/api/chat', { method: 'POST', headers: mutationHeaders(), body: 'not-json' });
  assert.equal(second.status, 400);

  const third = await request('/api/chat', { method: 'POST', headers: mutationHeaders(), body: 'not-json' });
  assert.equal(third.status, 429);
  assert.match(JSON.parse(third.text).error, /Too many requests/);
});

test('the same user is throttled on the Insights reflection route too (shared bucket)', async () => {
  const response = await request('/api/diary/insights/reflect', { method: 'POST', headers: mutationHeaders(), body: JSON.stringify({}) });
  assert.equal(response.status, 429);
});

test('other routes are unaffected by the LLM throttle', async () => {
  const response = await request('/api/integrations/storage', { headers: { cookie } });
  assert.equal(response.status, 200);
});

test('the throttle bucket is per user, not global', async () => {
  // Spin up a second user through an invitation: their bucket must be empty.
  const adminAuth = { authorization: 'Bearer test-cowork-token', origin: 'http://localhost' };
  const invite = await request('/api/admin/invitations', { method: 'POST', headers: { ...adminAuth, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'member' }) });
  assert.equal(invite.status, 201);
  const { token } = JSON.parse(invite.text);
  const accepted = await request('/api/auth/invitations/accept', {
    method: 'POST', headers: { origin: 'http://localhost' },
    body: JSON.stringify({ token, username: 'member', displayName: 'Member', password: 'grumpy engineers count beans' }),
  });
  assert.equal(accepted.status, 201);
  const cookies = accepted.headers['Set-Cookie'].map((c) => c.split(';')[0]);
  const memberCookie = cookies.filter((c) => c.startsWith('cowork_session=') || c.startsWith('cowork_csrf=')).join('; ');
  const memberCsrf = JSON.parse(accepted.text).csrfToken;

  const response = await request('/api/chat', {
    method: 'POST',
    headers: { origin: 'http://localhost', cookie: memberCookie, 'content-type': 'application/json', 'x-csrf-token': memberCsrf },
    body: 'not-json',
  });
  assert.equal(response.status, 400); // not throttled: fresh per-user bucket
});
