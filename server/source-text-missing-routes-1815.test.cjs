'use strict';
// #1815 through the real server: a source whose text file is gone has a SOURCE_TEXT_MISSING 404 text (never an
// empty 200); the pointer is kept and projects.json is not rewritten. The `textMissing` flag in the workspace
// list (GET /api/workspace) and its background scan are the Rust front's since the #2191 close-out
// (noevia-rs bins/noevia-server tests/workspace.rs). Synthetic data only.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
// #2191 round 2: POST /api/projects is the Rust front's; fixtures are written as its create leaves them.
const { createProjectAs } = require('../tests/server/front-projects.cjs');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1815-'));
process.env.DIARY_AUTH_TOKEN = 'test-cowork-token';
process.env.UI_DATA_DIR = testDataDir;
// #1071: Node saves projects.json / free-chats.json only through the Rust project store.
require('../tests/server/project-store-server.cjs').installProjectStore(testDataDir);
process.env.LEGACY_AUTH_COMPAT = 'true';
process.env.PUBLIC_ORIGIN = 'http://localhost';
process.env.EMBEDDING_BASE_URL = 'http://127.0.0.1:9'; // nothing listens: indexing fails fast, offline

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

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
let frontUserId = '';
test.before(async () => {
  ({ handleRequest } = require('./index.cjs'));
  // Sign-in is the Rust front's (#1071): the account and its session are seeded directly.
  ({ cookie, csrf, id: frontUserId } = require('../tests/server/seed-account.cjs').seedAccount(testDataDir, { username: 'admin', displayName: 'Admin', publicOrigin: 'http://localhost' }));
});
const mutation = () => ({ origin: 'http://localhost', cookie, 'content-type': 'application/json', 'x-csrf-token': csrf });
const stored = require('../tests/server/stored-sources.cjs');
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

test('#1815: a source whose text file is deleted has a SOURCE_TEXT_MISSING 404 text; a normal source reads; the pointer is kept', async () => {
  const createdProject = createProjectAs(testDataDir, frontUserId, { name: 'Synthetic 1815', files: [{ name: 'keep.md', content: KEEP }, { name: 'gone.md', content: GONE }] });
  const created = { status: 200, text: JSON.stringify(createdProject) };
  assert.equal(created.status, 200, created.text);
  const id = JSON.parse(created.text).id;
  const lost = textFile(sha(GONE));
  assert.ok(lost, 'the text was written to its file');
  const before = fs.readFileSync(lost.projectsJson, 'utf8');
  fs.rmSync(lost.file);

  // #2191: the per-source read is the Rust front's (Node refuses it); the stored state it reads is checked.
  assert.equal((await request(textUrl(id, 'gone.md'), { headers: { cookie } })).status, 503);
  const missing = stored.sourceText(testDataDir, id, 'gone.md');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.code, 'SOURCE_TEXT_MISSING');
  const kept = stored.sourceText(testDataDir, id, 'keep.md');
  assert.equal(kept.status, 200);
  assert.equal(kept.json.content, KEEP);

  assert.equal(fs.readFileSync(lost.projectsJson, 'utf8'), before, 'projects.json is not rewritten by reading');
  assert.ok(JSON.parse(before).projects.find((p) => p.id === id).files.some((f) => f.textRef === sha(GONE)));

  // The text comes back (a restore): the read is whole again.
  fs.writeFileSync(lost.file, GONE, { mode: 0o600 });
  assert.deepEqual([stored.sourceText(testDataDir, id, 'gone.md').status, stored.sourceText(testDataDir, id, 'gone.md').json.content], [200, GONE]);
});

