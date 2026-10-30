'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
// #2191 round 2: POST /api/projects is the Rust front's; fixtures are written as its create leaves them.
const { createProjectAs } = require('../tests/server/front-projects.cjs');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-project-modes-route-test-'));
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
  return { status: res.statusCode, headers: responseHeaders, text: Buffer.concat(chunks).toString('utf8'), bytes: Buffer.concat(chunks) };
}

let cookie = '';
let csrf = '';
let frontUserId = '';
test.before(async () => {
  // Sign-in is the Rust front's (#1071): the account and its session are seeded directly.
  ({ cookie, csrf, id: frontUserId } = require('../tests/server/seed-account.cjs').seedAccount(testDataDir, { username: 'admin', displayName: 'Admin', publicOrigin: 'http://localhost' }));
});

const mutationHeaders = () => ({ origin: 'http://localhost', cookie, 'content-type': 'application/json', 'x-csrf-token': csrf });

const post = (url, body, headers = mutationHeaders()) => request(url, { method: 'POST', headers, body: JSON.stringify(body) });
const realFetch = global.fetch;
test.before(() => { global.fetch = async () => { throw new Error('Unexpected network in project modes route test'); }; });
test.after(() => { global.fetch = realFetch; });

test('projects are Chat projects; an old client sending modes is accepted, normalised, and garbage is refused (#1576)', async () => {
  const plain = createProjectAs(testDataDir, frontUserId, { name: 'Synthetic default' });
  assert.deepEqual(plain.modes, ['chat']);
  const code = createProjectAs(testDataDir, frontUserId, { name: 'Synthetic C++', modes: ['code'] });
  assert.deepEqual(code.modes, ['chat', 'code']);
  // The create's own normalisation and its 400s are the Rust front's (noevia-rs lifecycle.rs tests).
  const patched = await post(`/api/projects/${plain.id}/config`, { modes: ['code', 'cowork'] });
  assert.equal(patched.status, 200);
  // The saved project, as the store left it (the list, GET /api/workspace, is the Rust front's).
  const saved = JSON.parse(fs.readFileSync(path.join(testDataDir, 'users', frontUserId, 'projects.json'), 'utf8'));
  assert.deepEqual(saved.projects.find((p) => p.id === plain.id).modes, ['chat', 'cowork', 'code']);
  assert.equal((await post(`/api/projects/${plain.id}/config`, { modes: 'chat' })).status, 400);
});

test('a project once saved without Chat no longer refuses chat turns (#1576)', async () => {
  const code = createProjectAs(testDataDir, frontUserId, { name: 'Synthetic code only', modes: ['code'] });
  const reply = await post('/api/chat', { spaceId: 'project', projectId: code.id, message: 'hello', history: [] });
  assert.notEqual(reply.status, 409, reply.text);
  assert.doesNotMatch(reply.text, /not enabled for Chat/);
});
