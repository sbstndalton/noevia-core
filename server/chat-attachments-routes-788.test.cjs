'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-788-route-test-'));
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


// #788 end to end through the real wiring: the free-chat context route, the asset upload, the
// free-chat delete, Delete old chats, the moved-chat delete and the /api/workspace orphan sweep.
// Synthetic chats and bytes only.
const usersDir = () => path.join(testDataDir, 'users');
const workspaceDir = () => {
  const ids = fs.readdirSync(usersDir()).filter((id) => fs.statSync(path.join(usersDir(), id)).isDirectory());
  assert.equal(ids.length, 1);
  return path.join(usersDir(), ids[0]);
};
const projectIds = () => JSON.parse(fs.readFileSync(path.join(workspaceDir(), 'projects.json'), 'utf8')).projects.map((p) => p.id);
const ctx = (chatId) => `cowork-chat-context-${chatId}`;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
const until = async (check) => { for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10)); };

async function openWithImage(chatId) {
  const opened = await post(`/api/chats/${chatId}/context`, {});
  assert.equal(opened.status, 200);
  assert.equal(JSON.parse(opened.text).project.id, ctx(chatId));
  const asset = await post(`/api/projects/${ctx(chatId)}/assets`, { name: 'synthetic.png', mime: 'image/png', dataBase64: PNG });
  assert.equal(asset.status, 200);
  const assetDir = path.join(workspaceDir(), 'project-assets', ctx(chatId));
  assert.equal(fs.readdirSync(assetDir).length, 1);
  // A RAG index for the context (sqlite-vec may be absent here, so it is seeded).
  const rag = path.join(workspaceDir(), 'rag', `${ctx(chatId)}.db`);
  fs.mkdirSync(path.dirname(rag), { recursive: true }); fs.writeFileSync(rag, 'synthetic');
  return { assetDir, rag };
}
const gone = async ({ assetDir, rag }) => { await until(() => !fs.existsSync(assetDir)); return !fs.existsSync(assetDir) && !fs.existsSync(rag); };

test('deleting a free chat removes its attachments project, and a stale tab cannot recreate it (#788)', async () => {
  const regular = JSON.parse((await post('/api/projects', { name: 'Synthetic regular' })).text);
  const kept = await openWithImage('c788-keep');
  const doomed = await openWithImage('c788-delete');
  assert.equal((await post('/api/freechats', { chats: [{ id: 'c788-delete', title: 'a' }, { id: 'c788-keep', title: 'b', archived: true }] })).status, 200);

  const deleted = await request('/api/freechats/c788-delete', { method: 'DELETE', headers: mutationHeaders() });
  assert.equal(deleted.status, 200);
  assert.ok(await gone(doomed), 'local assets and RAG index are gone');
  assert.ok(!projectIds().includes(ctx('c788-delete')), 'the record is gone from projects.json');
  assert.ok(projectIds().includes(ctx('c788-keep')), 'an archived chat keeps its attachments');
  assert.ok(projectIds().includes(regular.id), 'a regular project is untouched');
  assert.ok(fs.existsSync(kept.assetDir) && fs.existsSync(kept.rag));

  const again = await post('/api/chats/c788-delete/context', {});
  assert.equal(again.status, 410);
  assert.ok(!projectIds().includes(ctx('c788-delete')));
  const read = await request('/api/chats/c788-delete/context', { headers: { cookie } });
  assert.deepEqual(JSON.parse(read.text), { project: null });
});

test('a moved chat and Delete old chats take their attachments projects along (#788)', async () => {
  const host = JSON.parse((await post('/api/projects', { name: 'Synthetic host' })).text);
  const moved = await openWithImage('c788-moved');
  assert.equal((await post('/api/freechats', { chats: [{ id: 'c788-moved', title: 'm' }] })).status, 200);
  assert.equal((await post('/api/chats/c788-moved/move', { projectId: host.id })).status, 200);
  assert.equal((await request(`/api/projects/${host.id}/chats/c788-moved`, { method: 'DELETE', headers: mutationHeaders() })).status, 200);
  assert.ok(await gone(moved));
  assert.ok(!projectIds().includes(ctx('c788-moved')));

  const old = await openWithImage('c788-old');
  const fresh = await openWithImage('c788-fresh');
  const longAgo = Date.now() - 100 * 86400000;
  assert.equal((await post('/api/freechats', { chats: [{ id: 'c788-old', title: 'o', updatedAt: longAgo }, { id: 'c788-fresh', title: 'f' }] })).status, 200);
  const preview = JSON.parse((await request('/api/account/retention', { headers: { cookie } })).text).preview;
  const swept = await request('/api/account/retention', { method: 'PUT', headers: mutationHeaders(), body: JSON.stringify({ days: 90, confirmDeletes: preview[90] }) });
  assert.equal(swept.status, 200);
  assert.ok(await gone(old));
  assert.ok(!projectIds().includes(ctx('c788-old')));
  assert.ok(projectIds().includes(ctx('c788-fresh')) && fs.existsSync(fresh.assetDir));
  assert.equal((await request('/api/account/retention', { method: 'PUT', headers: mutationHeaders(), body: JSON.stringify({ days: 0 }) })).status, 200);
});

test('loading the workspace removes attachments projects of chats deleted before #788, and only those (#788)', async () => {
  const orphan = await openWithImage('c788-orphan');
  const unsaved = await openWithImage('c788-unsaved');
  // Simulate a delete made by the old code: the chat is tombstoned, its project was left behind.
  const file = path.join(workspaceDir(), 'deleted-chats.json');
  const ids = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  fs.writeFileSync(file, JSON.stringify([...ids, 'c788-orphan']));
  const workspace = await request('/api/workspace', { headers: { cookie } });
  assert.equal(workspace.status, 200);
  assert.ok(!JSON.parse(workspace.text).projects.some((p) => p.id.startsWith('cowork-chat-context-')), 'hidden projects never reach the client');
  assert.ok(await gone(orphan));
  assert.ok(!projectIds().includes(ctx('c788-orphan')));
  assert.ok(projectIds().includes(ctx('c788-unsaved')) && fs.existsSync(unsaved.assetDir), 'a chat open but not yet saved keeps its attachments');
});
