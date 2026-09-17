'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-project-sweep-route-test-'));
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
  return { status: res.statusCode, headers: responseHeaders, text: Buffer.concat(chunks).toString('utf8'), bytes: Buffer.concat(chunks) };
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

test('deleting a project removes its empty local directories and keeps a non-empty one', async () => {
  const project = JSON.parse((await post('/api/projects', { name: 'Synthetic sweep' })).text);
  const dir = workspaceDirOf(project.id);
  const hash = crypto.createHash('sha256').update(project.id).digest('hex');
  const uploads = path.join(dir, 'project-uploads', hash);
  const documents = path.join(dir, 'project-documents', hash);
  const assets = path.join(dir, 'project-assets', project.id);
  for (const d of [uploads, documents, assets]) fs.mkdirSync(d, { recursive: true });
  // Pruning removes unreferenced asset files; content it doesn't own (a nested folder) must survive.
  fs.mkdirSync(path.join(assets, 'nested')); fs.writeFileSync(path.join(assets, 'nested', 'late-write'), 'synthetic');
  const other = JSON.parse((await post('/api/projects', { name: 'Synthetic neighbour' })).text);
  const neighbour = path.join(dir, 'project-assets', other.id); fs.mkdirSync(neighbour, { recursive: true });

  const deleted = await request(`/api/projects/${project.id}`, { method: 'DELETE', headers: mutationHeaders() });
  assert.equal(deleted.status, 200);
  await until(() => !fs.existsSync(uploads) && !fs.existsSync(documents));
  assert.equal(fs.existsSync(uploads), false);
  assert.equal(fs.existsSync(documents), false);
  assert.equal(fs.readFileSync(path.join(assets, 'nested', 'late-write'), 'utf8'), 'synthetic', 'non-empty directory must stay');
  assert.ok(fs.existsSync(neighbour), 'another project is untouched');
  const again = await request(`/api/projects/${project.id}`, { method: 'DELETE', headers: mutationHeaders() });
  assert.equal(again.status, 404);
});
