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

test('saving an S3 connection is the Rust front\'s: Node refuses it before reading the body (#2190 round 4)', async () => {
  // The bucket/region round trip, the sealed secret and the reply (no secret) are asserted in
  // noevia-rs tests/storage_integrations.rs (put_connection_validates_checks_and_saves).
  const saved = await request('/api/integrations/storage', {
    method: 'PUT', headers: mutationHeaders(),
    body: JSON.stringify({ kind: 's3', baseUrl: 'https://s3.example.com', bucket: 'my-bucket', username: 'AKIA...', secret: 'shhh', corpusRoot: 'Notes/Diary' }),
  });
  assert.equal(saved.status, 503);
  assert.equal(JSON.parse(saved.text).code, 'RUST_STORAGE_CONNECTION_OWNED');
  // Reading the connection back (GET) is the Rust front's since #1071; Node refuses it.
  const fetched = await request('/api/integrations/storage', { headers: { cookie } });
  assert.equal(fetched.status, 503);
});

test('the S3 connection test is the Rust front\'s: Node refuses it before reading the row (#2190)', async () => {
  // Its validation (bucket, endpoint), signing and failures are asserted in noevia-rs
  // tests/storage_integrations.rs.
  const refused = await request('/api/integrations/storage/test', {
    method: 'POST', headers: mutationHeaders(),
    body: JSON.stringify({ kind: 's3', baseUrl: 'https://s3.example.com' }),
  });
  assert.equal(refused.status, 503);
  assert.equal(JSON.parse(refused.text).code, 'RUST_STORAGE_INTEGRATIONS_OWNED');
});
