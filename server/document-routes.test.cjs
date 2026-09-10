'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-document-route-test-'));
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


const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/documents', name));
const post = (url, body, headers = mutationHeaders()) => request(url, { method: 'POST', headers, body: JSON.stringify(body) });
const project = async name => JSON.parse((await post('/api/projects', { name })).text);
const upload = (id, name, bytes) => post(`/api/projects/${id}/upload`, { name, dataBase64: bytes.toString('base64') });
const docUrl = (id, kind, name = 'statement.pdf') => `/api/projects/${id}/documents/${kind}?name=${encodeURIComponent(name)}`;

// Any unexpected inference or storage request is a test failure, never real I/O.
const realFetch = global.fetch;
test.before(() => { global.fetch = async () => { throw new Error('Unexpected network in document route test'); }; });
test.after(() => { global.fetch = realFetch; });

test('authenticated upload persists metadata/original/pages and config cannot forge or erase them', async () => {
  const p = await project('Synthetic documents');
  const up = await upload(p.id, 'statement.pdf', fixture('mixed-pages.pdf'));
  assert.equal(up.status, 200);
  const d = JSON.parse(up.text).document;
  assert.equal(d.state, 'partial');
  const original = await request(docUrl(p.id, 'original'), { headers: { cookie } });
  assert.deepEqual(original.bytes, fixture('mixed-pages.pdf'));
  assert.match(original.headers['Content-Disposition'], /attachment/);
  const read = await request(docUrl(p.id, 'pages') + '&startPage=2', { headers: { cookie } });
  assert.equal(read.status, 200); assert.match(read.text, /ocr-needed/);
  await post(`/api/projects/${p.id}/config`, { files: [{ name: 'statement.pdf', content: 'forged text', document: { byteHash: '../outside', state: 'ready' } }] });
  const preserved = await request(docUrl(p.id, 'pages') + '&startPage=1', { headers: { cookie } });
  assert.match(preserved.text, /TEXT-P1/); assert.doesNotMatch(preserved.text, /forged text/);
  for (const suffix of ['&startPage=0', '&startPage=1&endPage=6', '&offset=-1', '&startPage=2&endPage=1']) {
    assert.equal((await request(docUrl(p.id, 'pages') + suffix, { headers: { cookie } })).status, 400);
  }
  await post(`/api/projects/${p.id}/config`, { files: [] });
  assert.equal((await request(docUrl(p.id, 'original'), { headers: { cookie } })).status, 404);
});

test('legacy PDF upload also saves failures, originals and explicit stale state', async () => {
  const p = await project('Legacy document upload');
  const legacy = bytes => post(`/api/projects/${p.id}/documents`, { name: 'statement.pdf', dataBase64: bytes.toString('base64') });
  assert.equal((await legacy(fixture('text.pdf'))).status, 200);
  const failed = JSON.parse((await legacy(fixture('encrypted.pdf'))).text);
  assert.equal(failed.document.state, 'failed'); assert.equal(failed.document.stale, true);
  const pages = await request(docUrl(p.id, 'pages'), { headers: { cookie } });
  assert.match(pages.text, /STALE/); assert.match(pages.text, /TEXT-P1/);
  assert.deepEqual((await request(docUrl(p.id, 'original'), { headers: { cookie } })).bytes, fixture('encrypted.pdf'));
});

test('document originals and pages are inaccessible to another authenticated user or project', async () => {
  const p = await project('Owner-only PDF');
  await upload(p.id, 'statement.pdf', fixture('text.pdf'));
  const otherProject = await project('Empty project');
  for (const kind of ['original', 'pages']) {
    assert.equal((await request(docUrl(otherProject.id, kind), { headers: { cookie } })).status, 404);
    assert.equal((await request(docUrl(p.id, kind))).status, 401);
  }
  const invite = await post('/api/admin/invitations', { role: 'member' });
  assert.equal(invite.status, 201);
  const body = JSON.parse(invite.text);
  const accepted = await post('/api/auth/invitations/accept', { token: body.token, username: 'reader', displayName: 'Reader', password: 'correct horse battery staple', diaryEnabled: false }, { origin: 'http://localhost', 'content-type': 'application/json' });
  assert.equal(accepted.status, 201);
  const login = await post('/api/auth/login/password', { username: 'reader', password: 'correct horse battery staple' }, { origin: 'http://localhost', 'content-type': 'application/json' });
  assert.equal(login.status, 200);
  const otherCookie = (login.headers['set-cookie'] || login.headers['Set-Cookie'] || []).map(c => c.split(';')[0]).join('; ');
  for (const kind of ['original', 'pages']) {
    assert.equal((await request(docUrl(p.id, kind), { headers: { cookie: otherCookie } })).status, 404);
  }
});


test('background upload survives a short response and polling remains authenticated and project scoped', async () => {
  const p = await project('Background synthetic upload');
  const other = await project('Other background project');
  const up = await post(`/api/projects/${p.id}/upload?background=1`, { name: 'statement.pdf', dataBase64: fixture('text.pdf').toString('base64') });
  assert.equal(up.status, 202);
  const { poll } = JSON.parse(up.text);
  assert.equal((await request(poll)).status, 401);
  assert.equal((await request(poll.replace(p.id, other.id), { headers: { cookie } })).status, 404);
  let job;
  for (let i = 0; i < 100; i++) {
    job = JSON.parse((await request(poll, { headers: { cookie } })).text);
    if (job.done) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(job.done, true); assert.equal(job.status, 200, JSON.stringify(job));
  assert.equal(job.body.document.state, 'ready');
  assert.deepEqual((await request(docUrl(p.id, 'original'), { headers: { cookie } })).bytes, fixture('text.pdf'));
});
