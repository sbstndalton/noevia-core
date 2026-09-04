'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-auth-test-'));
process.env.DIARY_AUTH_TOKEN = 'test-cowork-token';
process.env.UI_DATA_DIR = testDataDir;
process.env.LEGACY_AUTH_COMPAT = 'true';
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

test.before(async () => {
  const setupCode = fs.readFileSync(path.join(testDataDir, 'first-run-setup-code'), 'utf8').trim();
  const response = await request('/api/setup/complete', {
    method: 'POST', headers: { origin: 'http://localhost' },
    body: JSON.stringify({ setupCode, publicOrigin: 'http://localhost', username: 'admin', displayName: 'Admin', password: 'correct horse battery staple' }),
  });
  assert.equal(response.status, 201);
});

test('rejects API requests without a token', async () => {
  const response = await request('/api/workspace');
  assert.equal(response.status, 401);
  assert.match(response.headers['WWW-Authenticate'] || '', /^Bearer /);
  assert.deepEqual(JSON.parse(response.text), { error: 'unauthorized' });
});

test('rejects API requests with the wrong token', async () => {
  const response = await request('/api/workspace', {
    headers: { authorization: 'Bearer wrong-token' },
  });
  assert.equal(response.status, 401);
});

test('accepts a valid bearer token', async () => {
  const response = await request('/api/workspace', {
    headers: { authorization: 'Bearer test-cowork-token' },
  });
  assert.equal(response.status, 200);
  const body = JSON.parse(response.text);
  assert.ok(Array.isArray(body.projects));
});

test('protects provider creation with the same API guard', async () => {
  const denied = await request('/api/providers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Untrusted', baseUrl: 'https://example.invalid/v1' }),
  });
  assert.equal(denied.status, 401);

  const allowed = await request('/api/providers', {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-cowork-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ label: 'Trusted test', baseUrl: 'https://example.invalid/v1' }),
  });
  assert.equal(allowed.status, 200);
});

test('does not require auth for the static application shell', async () => {
  const response = await request('/');
  assert.notEqual(response.status, 401);
});
