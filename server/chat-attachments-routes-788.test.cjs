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
test.before(async () => {
  // Sign-in is the Rust front's (#1071): the account and its session are seeded directly.
  ({ cookie, csrf } = require('../tests/server/seed-account.cjs').seedAccount(testDataDir, { username: 'admin', displayName: 'Admin', publicOrigin: 'http://localhost' }));
});

const mutationHeaders = () => ({ origin: 'http://localhost', cookie, 'content-type': 'application/json', 'x-csrf-token': csrf });

const post = (url, body, headers = mutationHeaders()) => request(url, { method: 'POST', headers, body: JSON.stringify(body) });
const realFetch = global.fetch;


// #788 through Node lifecycle wiring: free-chat delete, Delete old chats, moved-chat delete and /api/workspace orphan sweep. Context creation is Rust-owned and seeded here.
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

// The image upload and the free-chat save are the Rust front's (sbstndalton/noevia#1071): here they
// are the files the front writes (the bytes under project-assets, the row in projects.json, the
// free-chat list), each replaced whole; Node takes them in at the next request start.
function frontWrite(file, value) { fs.writeFileSync(`${file}.front`, JSON.stringify(value, null, 2)); fs.renameSync(`${file}.front`, file); }
function frontUploadImage(projectId) {
  const id = `img-synthetic-${projectId.slice(-12)}`;
  const dir = path.join(workspaceDir(), 'project-assets', projectId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id), Buffer.from(PNG, 'base64'));
  const file = path.join(workspaceDir(), 'projects.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const project = data.projects.find((p) => p.id === projectId);
  project.assets = [...(project.assets || []), { id, name: 'synthetic.png', mime: 'image/png', bytes: 8 }];
  frontWrite(file, data);
}
function frontSaveFree(metas) {
  const file = path.join(workspaceDir(), 'free-chats.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(file, 'utf8')) || []; } catch { /* none yet */ }
  for (const m of metas) { const i = list.findIndex((c) => c.id === m.id); if (i >= 0) list[i] = { ...list[i], ...m }; else list.unshift({ updatedAt: Date.now(), preview: '', ...m }); }
  frontWrite(file, list);
}

async function openWithImage(chatId) {
  await request('/api/workspace', { headers: { cookie } });
  const file = path.join(workspaceDir(), 'projects.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.projects.push({ id: ctx(chatId), name: 'Synthetic context', files: [], assets: [], chats: [] });
  frontWrite(file, data);
  frontUploadImage(ctx(chatId));
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
  frontSaveFree([{ id: 'c788-delete', title: 'a' }, { id: 'c788-keep', title: 'b', archived: true }]);

  const deleted = await request('/api/freechats/c788-delete', { method: 'DELETE', headers: mutationHeaders() });
  assert.equal(deleted.status, 200);
  assert.ok(await gone(doomed), 'local assets and RAG index are gone');
  assert.ok(!projectIds().includes(ctx('c788-delete')), 'the record is gone from projects.json');
  assert.ok(projectIds().includes(ctx('c788-keep')), 'an archived chat keeps its attachments');
  assert.ok(projectIds().includes(regular.id), 'a regular project is untouched');
  assert.ok(fs.existsSync(kept.assetDir) && fs.existsSync(kept.rag));

  const again = await post('/api/chats/c788-delete/context', {});
  assert.equal(again.status, 503, 'Node has no context fallback; Rust route tests retain the 410 contract');
  assert.ok(require('./chat-lists.cjs').readTombstones(workspaceDir()).has('c788-delete'), 'the actual delete publishes the tombstone Rust reads');
  assert.ok(!projectIds().includes(ctx('c788-delete')));
  const read = await request('/api/chats/c788-delete/context', { headers: { cookie } });
  assert.equal(read.status, 503, 'context reads are also Rust-owned');
});

test('a moved chat and Delete old chats take their attachments projects along (#788)', async () => {
  const host = JSON.parse((await post('/api/projects', { name: 'Synthetic host' })).text);
  const moved = await openWithImage('c788-moved');
  frontSaveFree([{ id: 'c788-moved', title: 'm' }]);
  assert.equal((await post('/api/chats/c788-moved/move', { projectId: host.id })).status, 200);
  assert.equal((await request(`/api/projects/${host.id}/chats/c788-moved`, { method: 'DELETE', headers: mutationHeaders() })).status, 200);
  assert.ok(await gone(moved));
  assert.ok(!projectIds().includes(ctx('c788-moved')));

  const old = await openWithImage('c788-old');
  const fresh = await openWithImage('c788-fresh');
  const longAgo = Date.now() - 100 * 86400000;
  frontSaveFree([{ id: 'c788-old', title: 'o', updatedAt: longAgo }, { id: 'c788-fresh', title: 'f' }]);
  // The preview GET is the Rust front's (#1071); an unconfirmed PUT answers it too (409).
  const unconfirmed = await request('/api/account/retention', { method: 'PUT', headers: mutationHeaders(), body: JSON.stringify({ days: 90 }) });
  assert.equal(unconfirmed.status, 409);
  const preview = JSON.parse(unconfirmed.text).preview;
  assert.equal(preview[90], 1);
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
