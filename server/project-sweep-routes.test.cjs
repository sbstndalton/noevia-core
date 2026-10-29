'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
// #2191 round 2: POST /api/projects is the Rust front's; fixtures are written as its create leaves them.
const { createProjectAs } = require('../tests/server/front-projects.cjs');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-project-sweep-route-test-'));
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

const crypto = require('node:crypto');
function workspaceDirOf(projectId) {
  const users = path.join(testDataDir, 'users');
  for (const id of fs.readdirSync(users)) {
    const file = path.join(users, id, 'projects.json');
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(projectId)) return path.join(users, id);
  }
  throw new Error('workspace not found');
}
const until = async (check) => { for (let i = 0; i < 100 && !check(); i++) await new Promise(r => setTimeout(r, 10)); };

// #2191 round 2: DELETE /api/projects/{id} is the Rust front's (noevia-rs tests/project_lifecycle.rs: the
// directories it leaves, non-recursive; the storage sweep is queued in the index outbox, which
// rust-index-outbox.cjs drains through project-sweep.cjs). Here it is refused before anything is removed.
test('a project delete reaching Node is refused and removes nothing', async () => {
  const project = createProjectAs(testDataDir, frontUserId, { name: 'Synthetic sweep' });
  const dir = workspaceDirOf(project.id);
  const assets = path.join(dir, 'project-assets', project.id);
  fs.mkdirSync(assets, { recursive: true });
  const deleted = await request(`/api/projects/${project.id}`, { method: 'DELETE', headers: mutationHeaders() });
  assert.equal(deleted.status, 503);
  assert.equal(JSON.parse(deleted.text).code, 'RUST_PROJECT_LIFECYCLE_OWNED');
  assert.ok(fs.existsSync(assets));
});

