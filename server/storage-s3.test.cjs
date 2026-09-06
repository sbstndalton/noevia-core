'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-s3-storage-test-'));
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
  assert.equal(login.status, 200);
  const setCookies = login.headers['set-cookie'] || login.headers['Set-Cookie'] || [];
  cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  assert.ok(cookie, 'login must set a session cookie');
  const csrfPair = setCookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('cowork_csrf='));
  assert.ok(csrfPair, 'login must set the CSRF cookie');
  csrf = decodeURIComponent(csrfPair.split('=').slice(1).join('='));
});

const mutationHeaders = () => ({ origin: 'http://localhost', cookie, 'content-type': 'application/json', 'x-csrf-token': csrf });

test('S3 storage connection round-trips bucket through the encrypted row', async () => {
  const saved = await request('/api/integrations/storage', {
    method: 'PUT', headers: mutationHeaders(),
    body: JSON.stringify({ kind: 's3', baseUrl: 'https://s3.example.com', bucket: 'my-bucket', username: 'AKIA...', secret: 'shhh', corpusRoot: 'Notes/Diary' }),
  });
  assert.equal(saved.status, 200);
  const savedBody = JSON.parse(saved.text);
  assert.equal(savedBody.kind, 's3');
  assert.equal(savedBody.bucket, 'my-bucket');
  assert.equal(savedBody.secretConfigured, true);

  const fetched = await request('/api/integrations/storage', { headers: { cookie } });
  assert.equal(fetched.status, 200);
  const fetchedBody = JSON.parse(fetched.text);
  assert.equal(fetchedBody.kind, 's3');
  assert.equal(fetchedBody.bucket, 'my-bucket');
  assert.equal(fetchedBody.corpusRoot, 'Notes/Diary');
  assert.ok(!('secret' in fetchedBody), 'secret must never be returned by GET');
});

test('S3 test route validates before probing', async () => {
  const missingBucket = await request('/api/integrations/storage/test', {
    method: 'POST', headers: mutationHeaders(),
    body: JSON.stringify({ kind: 's3', baseUrl: 'https://s3.example.com' }),
  });
  assert.equal(missingBucket.status, 400);
  assert.match(JSON.parse(missingBucket.text).error, /Bucket is required/);

  const badUrl = await request('/api/integrations/storage/test', {
    method: 'POST', headers: mutationHeaders(),
    body: JSON.stringify({ kind: 's3', baseUrl: 'not-a-url', bucket: 'b' }),
  });
  assert.equal(badUrl.status, 400);
  assert.match(JSON.parse(badUrl.text).error, /http/);
});

test('S3 test route surfaces unreachable endpoints as 502', async () => {
  const unreachable = await request('/api/integrations/storage/test', {
    method: 'POST', headers: mutationHeaders(),
    body: JSON.stringify({ kind: 's3', baseUrl: 'http://127.0.0.1:1', bucket: 'b', username: 'ak', secret: 'sk' }),
  });
  assert.equal(unreachable.status, 502);
  assert.ok(JSON.parse(unreachable.text).error);
});
