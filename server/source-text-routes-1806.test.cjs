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
// #2191: the per-source text route is the Rust front's; the stored text is read as it reads it.
const stored = require('../tests/server/stored-sources.cjs');

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

  const one = stored.sourceText(testDataDir, id, 'docs/plan.txt');
  assert.equal(one.status, 200, JSON.stringify(one.json));
  assert.deepEqual(one.json, { name: 'docs/plan.txt', content: PLAN, chars: PLAN.length });
});

test('#2191: Node refuses the per-source text read, signed in or not; the front answers it (noevia-rs tests/project_reads.rs covers its owner-only scope)', async () => {
  const id = (await workspace()).projects.find((p) => p.name === 'Synthetic 1806').id;
  for (const headers of [{}, { cookie }]) for (const url of [textUrl(id, 'notes.md'), `/api/projects/${id}/sources/text`, textUrl('proj-nope', 'notes.md')]) {
    const r = await request(url, { headers });
    assert.deepEqual([r.status, JSON.parse(r.text).code], [503, 'RUST_PROJECT_READS_OWNED'], url);
  }
});

test('#1806: a config save listing sources without text (the web client\'s remove and add) keeps the others as they are', async () => {
  const project = (await workspace()).projects.find((p) => p.name === 'Synthetic 1806');
  // The web client removes docs/plan.txt and adds a picked file: it sends what it holds, metadata for the rest.
  const files = [...project.files.filter((f) => f.name !== 'docs/plan.txt'), { name: 'picked.md', content: 'picked synthetic text' }];
  const saved = await request(`/api/projects/${project.id}/config`, { method: 'POST', headers: mutation(), body: JSON.stringify({ files }) });
  assert.equal(saved.status, 200, saved.text);
  const after = (await workspace()).projects.find((p) => p.id === project.id);
  assert.deepEqual(after.files.map((f) => f.name), ['notes.md', 'picked.md']);
  assert.equal(stored.sourceText(testDataDir, project.id, 'notes.md').json.content, NOTES, 'the kept source keeps its text');
  assert.equal(stored.sourceText(testDataDir, project.id, 'picked.md').json.content, 'picked synthetic text');
  // A metadata-only entry naming no held source is not a source.
  await request(`/api/projects/${project.id}/config`, { method: 'POST', headers: mutation(), body: JSON.stringify({ files: [...after.files, { name: 'ghost.md' }] }) });
  assert.deepEqual((await workspace()).projects.find((p) => p.id === project.id).files.map((f) => f.name), ['notes.md', 'picked.md']);
});
