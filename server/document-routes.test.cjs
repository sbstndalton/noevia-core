'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
// #2191 round 2: POST /api/projects is the Rust front's; fixtures are written as its create leaves them.
const { createProjectAs } = require('../tests/server/front-projects.cjs');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-document-route-test-'));
process.env.DIARY_AUTH_TOKEN = 'test-cowork-token';
process.env.UI_DATA_DIR = testDataDir;
process.env.LEGACY_AUTH_COMPAT = 'true';
process.env.PUBLIC_ORIGIN = 'http://localhost';
require('../tests/server/project-store-server.cjs').installProjectStore(testDataDir);

const { handleRequest } = require('./index.cjs');

test.after(() => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

const stored = require('../tests/server/stored-sources.cjs');
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

const { seedAccount, setUserFeatures } = require('../tests/server/seed-account.cjs');
let cookie = '';
let csrf = '';
let adminId = '';
test.before(() => {
  // Sign-in is the Rust front's (#1071): the account and its session are seeded directly.
  ({ cookie, csrf, id: adminId } = seedAccount(testDataDir, { username: 'admin', displayName: 'Admin', publicOrigin: 'http://localhost' }));
});

const mutationHeaders = () => ({ origin: 'http://localhost', cookie, 'content-type': 'application/json', 'x-csrf-token': csrf });


const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/documents', name));
const post = (url, body, headers = mutationHeaders()) => request(url, { method: 'POST', headers, body: JSON.stringify(body) });
// The front's create is seen at the next request start once no save of this process is in flight
// (rust-projects.cjs refresh): wait until the workspace lists it, as a client does after the create.
const project = async (name) => {
  const made = createProjectAs(testDataDir, adminId, { name });
  for (let i = 0; i < 200; i++) {
    const listed = await request('/api/workspace', { headers: { cookie } });
    if ((JSON.parse(listed.text).projects || []).some((x) => x.id === made.id)) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  return made;
};
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
  // #2191: the original's download is the Rust front's (Node refuses it); what it serves is stored here.
  assert.equal((await request(docUrl(p.id, 'original'), { headers: { cookie } })).status, 503);
  assert.deepEqual(stored.documentOriginal(testDataDir, p.id, 'statement.pdf').bytes, fixture('mixed-pages.pdf'));
  // #2191 round 4: the page reader is the Rust front's too (Node refuses it); what it reads is stored here.
  assert.equal((await request(docUrl(p.id, 'pages'), { headers: { cookie } })).status, 503);
  const pagesOf = (name, query) => stored.documentPages(testDataDir, p.id, `name=${encodeURIComponent(name)}${query}`);
  const read = pagesOf('statement.pdf', '&startPage=2');
  assert.equal(read.status, 200); assert.match(read.text, /ocr-needed/);
  await post(`/api/projects/${p.id}/config`, { files: [{ name: 'statement.pdf', content: 'forged text', document: { byteHash: '../outside', state: 'ready' } }] });
  const preserved = pagesOf('statement.pdf', '&startPage=1');
  assert.match(preserved.text, /TEXT-P1/); assert.doesNotMatch(preserved.text, /forged text/);
  for (const suffix of ['&startPage=0', '&startPage=1&endPage=6', '&offset=-1', '&startPage=2&endPage=1']) {
    assert.equal(pagesOf('statement.pdf', suffix).status, 400);
  }
  await post(`/api/projects/${p.id}/config`, { files: [] });
  assert.equal(stored.documentOriginal(testDataDir, p.id, 'statement.pdf').status, 404);
});

test('a local PDF upload also saves failures, originals and explicit stale state', async () => {
  const p = await project('Legacy document upload');
  // #2191 round 5: POST .../documents is the Rust front's (rust-project-documents.cjs, refused here before
  // authentication); its Docling pipeline is tested in noevia-rs. The same ingest is the local /upload's.
  assert.equal((await post(`/api/projects/${p.id}/documents`, { name: 'statement.pdf', dataBase64: fixture('text.pdf').toString('base64') })).status, 503);
  const legacy = (bytes, replace) => post(`/api/projects/${p.id}/upload`, { name: 'statement.pdf', ...(replace ? { replace: true } : {}), dataBase64: bytes.toString('base64') });
  assert.equal((await legacy(fixture('text.pdf'))).status, 200);
  const refused = await legacy(fixture('encrypted.pdf'));
  assert.equal(refused.status, 409); assert.equal(JSON.parse(refused.text).code, 'sourceExists'); // #1454: never a silent replace
  const failed = JSON.parse((await legacy(fixture('encrypted.pdf'), true)).text);
  assert.equal(failed.document.state, 'failed'); assert.equal(failed.document.stale, true);
  const pages = stored.documentPages(testDataDir, p.id, 'name=statement.pdf');
  assert.match(pages.text, /STALE/); assert.match(pages.text, /TEXT-P1/);
  assert.deepEqual(stored.documentOriginal(testDataDir, p.id, 'statement.pdf').bytes, fixture('encrypted.pdf'));
});

test('document originals and pages are inaccessible to another authenticated user or project', async () => {
  const p = await project('Owner-only PDF');
  await upload(p.id, 'statement.pdf', fixture('text.pdf'));
  const otherProject = await project('Empty project');
  // #2191: the original and (round 4) the pages are the Rust front's, refused here whoever asks; their
  // owner-only scope is tested there (noevia-rs tests/project_reads.rs). The stored result is per project.
  assert.equal(stored.documentPages(testDataDir, otherProject.id, 'name=statement.pdf').status, 404);
  assert.equal(stored.documentPages(testDataDir, p.id, 'name=statement.pdf').status, 200);
  assert.equal((await request(docUrl(p.id, 'pages'))).status, 503);
  assert.equal((await request(docUrl(p.id, 'original'))).status, 503);
  const otherCookie = seedAccount(testDataDir, { username: 'reader', displayName: 'Reader', role: 'member' }).cookie;
  assert.equal((await request(docUrl(p.id, 'pages'), { headers: { cookie: otherCookie } })).status, 503);
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
  assert.deepEqual(stored.documentOriginal(testDataDir, p.id, 'statement.pdf').bytes, fixture('text.pdf'));
});

test('a chat turn sent right after a 202 background upload waits for that upload to finish (#1441)', async () => {
  const p = await project('Race synthetic upload');
  const up = await post(`/api/projects/${p.id}/upload?background=1`, { name: 'statement.pdf', dataBase64: fixture('text.pdf').toString('base64') });
  assert.equal(up.status, 202);
  const { poll } = JSON.parse(up.text);
  // The turn itself may be refused later (no model is served in this test); what matters is that it
  // was not built until the file job had finished, so the first poll afterwards is already done.
  await post('/api/chat', { spaceId: 'project', projectId: p.id, message: 'Summarize this file in one sentence.', history: [] });
  const job = JSON.parse((await request(poll, { headers: { cookie } })).text);
  assert.equal(job.done, true, 'the turn was prepared before the attached file was ingested');
  assert.equal(job.status, 200, JSON.stringify(job));
});

test('unified uploads accept DOCX, preserve opaque bytes, protect metadata and expose authenticated downloads', async () => {
  const p = await project('Opaque synthetic uploads');
  // Larger than the old background wrapper's accidental 1 MB limit.
  const bytes = Buffer.alloc(2 * 1024 * 1024, 65); bytes.set([0x50,0x4b,3,4]);
  const up = await post(`/api/projects/${p.id}/upload?background=1`, { organized: true, name: 'fixture.docx', dataBase64: bytes.toString('base64') });
  assert.equal(up.status, 202);
  const poll = JSON.parse(up.text).poll;
  let job;
  for (let i=0;i<100;i++) { job=JSON.parse((await request(poll,{headers:{cookie}})).text); if(job.done) break; await new Promise(r=>setTimeout(r,10)); }
  assert.equal(job.status,200,JSON.stringify(job)); assert.equal(job.body.attachment.state,'stored');
  // #2191: the download is the Rust front's (Node refuses it; noevia-rs tests/project_reads.rs covers
  // its scope, headers and traversal refusals); the stored original is what it serves.
  const url = `/api/projects/${p.id}/uploads/original?name=fixture.docx`;
  assert.equal((await request(url)).status,503);
  assert.equal((await request(url,{headers:{cookie}})).status,503);
  const other = await project('No access through other project');
  assert.equal(stored.uploadOriginal(testDataDir, other.id, 'fixture.docx'), null);
  await post(`/api/projects/${p.id}/config`, { files: [{ name:'fixture.docx',content:'forged',attachment:{id:'../escape'} }] });
  assert.deepEqual(stored.uploadOriginal(testDataDir, p.id, 'fixture.docx'),bytes, 'a forged attachment id does not replace the stored one');
  const bad=await post(`/api/projects/${p.id}/upload`,{organized:true,name:'fixture.zip',dataBase64:bytes.toString('base64')});
  assert.equal(bad.status,400);
});

test('diary extras are lazy, private to the tenant, and hidden from ordinary projects', async () => {
  setUserFeatures(testDataDir, adminId, { diaryEnabled: true });
  assert.equal(JSON.parse((await request('/api/diary/context', {headers:{cookie}})).text).project, null);
  assert.equal((await post('/api/chat', {spaceId:'diary-extras',message:'fixture'})).status,400);
  assert.equal((await request('/api/diary/context')).status,401);
  const result = await post('/api/diary/context', {});
  assert.equal(result.status,200);
  const p = JSON.parse(result.text).project;
  assert.deepEqual(p.toolboxes,[]);
  const uploaded = await post(`/api/projects/${p.id}/upload`, {organized:true,name:'context.txt',dataBase64:Buffer.from('Synthetic optional source').toString('base64')});
  assert.equal(uploaded.status,200);
  const workspace = JSON.parse((await request('/api/workspace',{headers:{cookie}})).text);
  assert.ok(!workspace.projects.some(item=>item.id===p.id));
  assert.equal(JSON.parse((await post('/api/diary/context',{})).text).project.files.length,1);
  const otherCookie = seedAccount(testDataDir, { username: 'reader', role: 'member' }).cookie;
  assert.equal((await request('/api/diary/context',{headers:{cookie:otherCookie}})).status,404);
  assert.equal((await request(`/api/projects/${p.id}/uploads/original?name=context.txt`,{headers:{cookie:otherCookie}})).status,503, 'the front answers it (#2191)');
  // Rust owns chat-context creation. Seed only this fixture's front-owned state;
  // actual two-tenant context isolation is covered by noevia-rs project_routes.
  const file = path.join(testDataDir, 'users', adminId, 'projects.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  stored.projects.push({ id: 'cowork-chat-context-c-fixture', name: 'Synthetic private context', files: [] });
  fs.writeFileSync(file, JSON.stringify(stored));
  assert.equal((await request('/api/projects/cowork-chat-context-c-fixture/uploads/original?name=context.txt', { headers: { cookie: otherCookie } })).status, 503);
  assert.equal((await request('/api/chats/c-fixture/context', { headers: { cookie: otherCookie } })).status, 503, 'Node refuses even for another tenant');
});
