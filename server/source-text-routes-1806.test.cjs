'use strict';
// #1806 through the real server: GET /api/workspace lists sources without their text, GET
// /api/projects/{id}/sources/text serves one source's text to its owner only, and the config save
// the web client sends (sources listed without text) keeps them. Synthetic data only.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1806-routes-'));
process.env.DIARY_AUTH_TOKEN = 'test-cowork-token';
process.env.UI_DATA_DIR = testDataDir;
// #1071: Node saves projects.json / free-chats.json only through the Rust project store.
require('../tests/server/project-store-server.cjs').installProjectStore(testDataDir);
process.env.LEGACY_AUTH_COMPAT = 'true';
process.env.PUBLIC_ORIGIN = 'http://localhost';
process.env.EMBEDDING_BASE_URL = 'http://127.0.0.1:9'; // nothing listens: indexing fails fast, offline

let handleRequest;
test.after(() => fs.rmSync(testDataDir, { recursive: true, force: true }));

async function request(url, { method = 'GET', headers = {}, body = '' } = {}) {
  const req = Readable.from(body ? [body] : []);
  req.url = url; req.method = method; req.headers = { host: 'localhost', ...headers };
  const chunks = []; const responseHeaders = {};
  const res = new Writable({ write(chunk, _e, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  res.statusCode = 200; res.headersSent = false;
  res.setHeader = (n, v) => { responseHeaders[n] = v; };
  res.writeHead = (status, h = {}) => { res.statusCode = status; res.headersSent = true; Object.assign(responseHeaders, h); return res; };
  const finished = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
  await handleRequest(req, res);
  await finished;
  return { status: res.statusCode, headers: responseHeaders, text: Buffer.concat(chunks).toString('utf8') };
}

let cookie = '', csrf = '';
test.before(async () => {
  ({ handleRequest } = require('./index.cjs'));
  // Sign-in is the Rust front's (#1071): the account and its session are seeded directly.
  ({ cookie, csrf } = require('../tests/server/seed-account.cjs').seedAccount(testDataDir, { username: 'admin', displayName: 'Admin', publicOrigin: 'http://localhost' }));
});
const mutation = () => ({ origin: 'http://localhost', cookie, 'content-type': 'application/json', 'x-csrf-token': csrf });
const workspace = async () => JSON.parse((await request('/api/workspace', { headers: { cookie } })).text);
const textUrl = (id, name) => `/api/projects/${encodeURIComponent(id)}/sources/text?name=${encodeURIComponent(name)}`;

const NOTES = '# Synthetic notes\n\nThe synthetic code word is CEDAR-1806.';
const PLAN = 'Synthetic plan: ship the widget.';

test('#1806: /api/workspace sends source metadata only; the text is fetched per source', async () => {
  const created = await request('/api/projects', { method: 'POST', headers: mutation(),
    body: JSON.stringify({ name: 'Synthetic 1806', files: [{ name: 'notes.md', content: NOTES }, { name: 'docs/plan.txt', content: PLAN }] }) });
  assert.equal(created.status, 200, created.text);
  const id = JSON.parse(created.text).id;
  assert.ok(!created.text.includes('CEDAR-1806'), 'the create answer carries no source text');

  const raw = (await request('/api/workspace', { headers: { cookie } })).text;
  assert.ok(!raw.includes('CEDAR-1806') && !raw.includes('ship the widget'), 'no source text in the workspace payload');
  const project = JSON.parse(raw).projects.find((p) => p.id === id);
  assert.deepEqual(project.files.map((f) => [f.name, 'content' in f, f.chars, f.textRef]), [
    ['notes.md', false, NOTES.length, crypto.createHash('sha256').update(NOTES).digest('hex')],
    ['docs/plan.txt', false, PLAN.length, crypto.createHash('sha256').update(PLAN).digest('hex')],
  ]);

  const one = await request(textUrl(id, 'docs/plan.txt'), { headers: { cookie } });
  assert.equal(one.status, 200, one.text);
  assert.deepEqual(JSON.parse(one.text), { name: 'docs/plan.txt', content: PLAN, chars: PLAN.length });
});

test('#1806: the per-source text answers its owner only: signed out 401, another tenant\'s project 404, unknown 404, no name 400', async () => {
  const id = (await workspace()).projects.find((p) => p.name === 'Synthetic 1806').id;
  assert.equal((await request(textUrl(id, 'notes.md'))).status, 401, 'signed out');
  assert.equal((await request(textUrl(id, 'missing.md'), { headers: { cookie } })).status, 404, 'unknown source');
  assert.equal((await request(textUrl('proj-nope', 'notes.md'), { headers: { cookie } })).status, 404, 'unknown project');
  assert.equal((await request(`/api/projects/${id}/sources/text`, { headers: { cookie } })).status, 400, 'no name');
  // An internal project (a free chat's attachments) exists for this person but is not listed, so it is refused as a project.
  assert.equal((await request('/api/chats/c-1806-synthetic/context', { method: 'POST', headers: mutation() })).status, 200);
  const internal = await request(textUrl('cowork-chat-context-c-1806-synthetic', 'notes.md'), { headers: { cookie } });
  assert.deepEqual([internal.status, JSON.parse(internal.text).error], [404, 'no such project']);

  // Another person's workspace, on disk beside this one: its project id is not this person's.
  const other = path.join(testDataDir, 'users', '99999999-8888-4777-8666-555555555555');
  fs.mkdirSync(path.join(other, 'project-sources', 'proj-other'), { recursive: true });
  const secret = 'another tenant synthetic secret';
  const ref = crypto.createHash('sha256').update(secret).digest('hex');
  fs.writeFileSync(path.join(other, 'project-sources', 'proj-other', `${ref}.txt`), secret);
  fs.writeFileSync(path.join(other, 'projects.json'), JSON.stringify({ projects: [{ id: 'proj-other', name: 'Other', files: [{ name: 'secret.md', textRef: ref, chars: secret.length }] }] }));
  const cross = await request(textUrl('proj-other', 'secret.md'), { headers: { cookie } });
  assert.equal(cross.status, 404);
  assert.ok(!cross.text.includes(secret));
});

test('#1806: a config save listing sources without text (the web client\'s remove and add) keeps the others as they are', async () => {
  const project = (await workspace()).projects.find((p) => p.name === 'Synthetic 1806');
  // The web client removes docs/plan.txt and adds a picked file: it sends what it holds, metadata for the rest.
  const files = [...project.files.filter((f) => f.name !== 'docs/plan.txt'), { name: 'picked.md', content: 'picked synthetic text' }];
  const saved = await request(`/api/projects/${project.id}/config`, { method: 'POST', headers: mutation(), body: JSON.stringify({ files }) });
  assert.equal(saved.status, 200, saved.text);
  const after = (await workspace()).projects.find((p) => p.id === project.id);
  assert.deepEqual(after.files.map((f) => f.name), ['notes.md', 'picked.md']);
  assert.equal(JSON.parse((await request(textUrl(project.id, 'notes.md'), { headers: { cookie } })).text).content, NOTES, 'the kept source keeps its text');
  assert.equal(JSON.parse((await request(textUrl(project.id, 'picked.md'), { headers: { cookie } })).text).content, 'picked synthetic text');
  // A metadata-only entry naming no held source is not a source.
  await request(`/api/projects/${project.id}/config`, { method: 'POST', headers: mutation(), body: JSON.stringify({ files: [...after.files, { name: 'ghost.md' }] }) });
  assert.deepEqual((await workspace()).projects.find((p) => p.id === project.id).files.map((f) => f.name), ['notes.md', 'picked.md']);
});
