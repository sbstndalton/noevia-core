'use strict';
// #1815 through the real server: a source whose text file is gone is listed with textMissing in
// GET /api/workspace and its text is a SOURCE_TEXT_MISSING 404 (never an empty 200); the pointer
// is kept and projects.json is not rewritten. Synthetic data only.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1815-'));
process.env.DIARY_AUTH_TOKEN = 'test-cowork-token';
process.env.UI_DATA_DIR = testDataDir;
process.env.LEGACY_AUTH_COMPAT = 'true';
process.env.PUBLIC_ORIGIN = 'http://localhost';
process.env.EMBEDDING_BASE_URL = 'http://127.0.0.1:9'; // nothing listens: indexing fails fast, offline

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

let handleRequest;
const sourceText = require('./source-text.cjs');
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
  const setupCode = fs.readFileSync(path.join(testDataDir, 'first-run-setup-code'), 'utf8').trim();
  const setup = await request('/api/setup/complete', { method: 'POST', headers: { origin: 'http://localhost' },
    body: JSON.stringify({ setupCode, publicOrigin: 'http://localhost', username: 'admin', displayName: 'Admin', password: 'correct horse battery staple' }) });
  assert.equal(setup.status, 201);
  const login = await request('/api/auth/login/password', { method: 'POST', headers: { origin: 'http://localhost' },
    body: JSON.stringify({ username: 'admin', password: 'correct horse battery staple' }) });
  const set = login.headers['set-cookie'] || login.headers['Set-Cookie'] || [];
  cookie = set.map((c) => c.split(';')[0]).join('; ');
  csrf = decodeURIComponent(set.map((c) => c.split(';')[0]).find((c) => c.startsWith('cowork_csrf=')).split('=').slice(1).join('='));
});
const mutation = () => ({ origin: 'http://localhost', cookie, 'content-type': 'application/json', 'x-csrf-token': csrf });
const textUrl = (id, name) => `/api/projects/${encodeURIComponent(id)}/sources/text?name=${encodeURIComponent(name)}`;
/** The one text file named `ref` under any workspace of the test data dir. */
function textFile(ref) {
  const users = path.join(testDataDir, 'users');
  for (const u of fs.readdirSync(users)) {
    const root = path.join(users, u, 'project-sources');
    if (!fs.existsSync(root)) continue;
    for (const p of fs.readdirSync(root)) { const f = path.join(root, p, `${ref}.txt`); if (fs.existsSync(f)) return { file: f, projectsJson: path.join(users, u, 'projects.json'), workspace: path.join(users, u) }; }
  }
  return null;
}

const KEEP = 'Synthetic kept text: the code word is SPRUCE-1815.';
const GONE = 'Synthetic lost text: the code word is ASPEN-1815.';

test('#1815: a source whose text file is deleted is listed with textMissing and its text is a SOURCE_TEXT_MISSING 404; a normal source is not; the pointer is kept', async () => {
  const created = await request('/api/projects', { method: 'POST', headers: mutation(),
    body: JSON.stringify({ name: 'Synthetic 1815', files: [{ name: 'keep.md', content: KEEP }, { name: 'gone.md', content: GONE }] }) });
  assert.equal(created.status, 200, created.text);
  const id = JSON.parse(created.text).id;
  const lost = textFile(sha(GONE));
  assert.ok(lost, 'the text was written to its file');
  const before = fs.readFileSync(lost.projectsJson, 'utf8');
  fs.rmSync(lost.file);

  // #1818: the list itself does no file check; its first load starts a background scan.
  await request('/api/workspace', { headers: { cookie } });
  await sourceText.scanSettled(lost.workspace);
  const listed = JSON.parse((await request('/api/workspace', { headers: { cookie } })).text).projects.find((p) => p.id === id);
  const byName = Object.fromEntries(listed.files.map((f) => [f.name, f]));
  assert.equal(byName['gone.md'].textMissing, true, 'the deleted text is reported');
  assert.equal('textMissing' in byName['keep.md'], false, 'a normal source carries no flag');
  assert.equal(byName['gone.md'].textRef, sha(GONE), 'the pointer is still listed');

  const missing = await request(textUrl(id, 'gone.md'), { headers: { cookie } });
  assert.equal(missing.status, 404, missing.text);
  assert.equal(JSON.parse(missing.text).code, 'SOURCE_TEXT_MISSING');
  const kept = await request(textUrl(id, 'keep.md'), { headers: { cookie } });
  assert.equal(kept.status, 200);
  assert.equal(JSON.parse(kept.text).content, KEEP);

  assert.equal(fs.readFileSync(lost.projectsJson, 'utf8'), before, 'projects.json is not rewritten by reading');
  assert.ok(JSON.parse(before).projects.find((p) => p.id === id).files.some((f) => f.textRef === sha(GONE)));

  // The text comes back (a restore): the text is served again (checked on the file), which clears the flag.
  fs.writeFileSync(lost.file, GONE, { mode: 0o600 });
  const served = await request(textUrl(id, 'gone.md'), { headers: { cookie } });
  assert.deepEqual([served.status, JSON.parse(served.text).content], [200, GONE]);
  const again = JSON.parse((await request('/api/workspace', { headers: { cookie } })).text).projects.find((p) => p.id === id);
  assert.equal('textMissing' in again.files.find((f) => f.name === 'gone.md'), false);
});


test('#1818: GET /api/workspace makes no sync stat or access call on any source text', async () => {
  const texts = Array.from({ length: 20 }, (_, i) => `Synthetic hot-path text ${i} (#1818).`);
  const created = await request('/api/projects', { method: 'POST', headers: mutation(),
    body: JSON.stringify({ name: 'Synthetic 1818', files: texts.map((t, i) => ({ name: `${i}.md`, content: t })) }) });
  assert.equal(created.status, 200, created.text);
  const orig = { accessSync: fs.accessSync, statSync: fs.statSync, lstatSync: fs.lstatSync, existsSync: fs.existsSync };
  const hits = [];
  for (const k of Object.keys(orig)) fs[k] = (p, ...a) => { hits.push([k, String(p)]); return orig[k](p, ...a); };
  let listed;
  try { listed = await request('/api/workspace', { headers: { cookie } }); } finally { Object.assign(fs, orig); }
  assert.equal(listed.status, 200);
  assert.deepEqual(hits.filter(([k, p]) => k === 'accessSync' || p.includes('project-sources')), [], 'no per-source sync check');
});
