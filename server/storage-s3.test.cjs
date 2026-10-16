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
// #1071: Node saves projects.json / free-chats.json only through the Rust project store.
require('../tests/server/project-store-server.cjs').installProjectStore(testDataDir);
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
  // Sign-in is the Rust front's (#1071): the account and its session are seeded directly.
  ({ cookie, csrf } = require('../tests/server/seed-account.cjs').seedAccount(testDataDir, { username: 'admin', displayName: 'Admin', publicOrigin: 'http://localhost' }));
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
  assert.equal(savedBody.corpusRoot, 'Notes/Diary');
  assert.ok(!('secret' in savedBody), 'the secret is never returned');
  // Reading the connection back (GET) is the Rust front's since #1071; Node refuses it.
  const fetched = await request('/api/integrations/storage', { headers: { cookie } });
  assert.equal(fetched.status, 503);
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
