'use strict';
// Regressions for the 2026-10-05 server hardening sweep, driven through the real router
// (index.cjs handleRequest) with synthetic accounts and no network:
//   #781  a cookie with a malformed % escape still gets an HTTP answer, and signs in normally
//   #786  a JSON body of `null` is a 400 on every route that dereferences its body, and a
//         stored-upload row whose original file is gone is a 404

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');
// #2191 round 2: POST /api/projects is the Rust front's; fixtures are written as its create leaves them.
const { createProjectAs } = require('../tests/server/front-projects.cjs');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-request-hardening-'));
process.env.DIARY_AUTH_TOKEN = 'synthetic-sidecar-token';
process.env.UI_DATA_DIR = testDataDir;
// #1071: Node saves projects.json / free-chats.json only through the Rust project store.
require('../tests/server/project-store-server.cjs').installProjectStore(testDataDir);
process.env.LEGACY_AUTH_COMPAT = 'false';
process.env.PUBLIC_ORIGIN = 'http://localhost';

const { handleRequest } = require('./index.cjs');
const { parseCookies } = require('./auth.cjs');

test('storage early refusal uses the real parser and fixed no-store reply before identity access', () => {
  const { refuseRustStorageRead, RUST_STORAGE_READS_REFUSAL } = require('./features.cjs');
  const { parseRequestUrl, badRequestUrl, json } = require('./http.cjs');
  function gate(target, { method = 'GET', host = 'localhost' } = {}) {
    const headers = { host };
    for (const key of ['cookie', 'authorization']) {
      Object.defineProperty(headers, key, { get() { assert.fail(`identity header ${key} was read`); } });
    }
    const req = { method, url: target, headers };
    Object.defineProperty(req, 'socket', { get() { assert.fail('identity socket was read'); } });
    const response = { headers: {}, status: null, body: null };
    const res = {
      setHeader(name, value) { response.headers[name] = value; },
      writeHead(status, values) { response.status = status; Object.assign(response.headers, values); },
      end(body) { response.body = JSON.parse(body); },
    };
    const handled = refuseRustStorageRead(req, res, { parseRequestUrl, badRequestUrl, json });
    return { handled, ...response };
  }
  for (const target of ['/api/integrations/storage', '/api/integrations/storage?q=secret', '/api/integrations/./storage', '/api/integrations/x/../storage', '/api/integrations/%2e/storage']) {
    const reply = gate(target);
    assert.equal(reply.handled, true, target);
    assert.equal(reply.status, 503);
    assert.deepEqual(reply.body, RUST_STORAGE_READS_REFUSAL);
    assert.equal(reply.headers['Cache-Control'], 'no-store');
    assert.equal(reply.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(reply.headers['X-Frame-Options'], 'DENY');
    assert.equal(reply.headers['Referrer-Policy'], 'same-origin');
    assert.ok(reply.headers['Content-Security-Policy'].includes("frame-ancestors 'none'"));
    assert.equal(reply.headers['Strict-Transport-Security'], 'max-age=15552000');
    assert.match(reply.headers['Permissions-Policy'], /microphone=\(\).*geolocation=\(\)/);
  }
  assert.equal(gate('/api/integrations/storage', { host: 'a b[' }).status, 503);
  for (const target of ['//[', 'http://[', '//a b']) {
    const reply = gate(target);
    assert.equal(reply.handled, true);
    assert.equal(reply.status, 400);
    assert.deepEqual(reply.body, { error: 'invalid URL' });
    assert.equal(reply.headers['Cache-Control'], 'no-store');
  }
  for (const target of ['/api/integrations/storage/', '/api/integrations/storage/files', '/api/integrations/%73torage', '/api/integrations/storage-other']) {
    assert.equal(gate(target).handled, false, target);
  }
  const poison = () => assert.fail('non-GET request parsed early');
  for (const method of [undefined, 'HEAD', 'PUT', 'POST', 'OPTIONS', 'DELETE', 'get']) {
    assert.equal(refuseRustStorageRead({ method }, {}, { parseRequestUrl: poison }), false);
  }
  // #1071: there is no ownership switch any more; a leftover `owned: false` changes nothing.
  assert.equal(gate('/api/integrations/storage', { owned: false }).status, 503);
});

const realFetch = global.fetch;
test.before(() => { global.fetch = async () => { throw new Error('Unexpected network in request hardening test'); }; });
test.after(() => {
  global.fetch = realFetch;
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

async function request(url, { method = 'GET', headers = {}, body = '' } = {}) {
  const req = Readable.from(body ? [body] : []);
  req.url = url;
  req.method = method;
  req.headers = { host: 'localhost', ...headers };
  req.socket = { remoteAddress: '203.0.113.40' };
  const chunks = [];
  const responseHeaders = {};
  const res = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  res.statusCode = 200;
  res.headersSent = false;
  res.setHeader = (name, value) => { responseHeaders[name] = value; };
  res.writeHead = (status, nextHeaders = {}) => { res.statusCode = status; res.headersSent = true; Object.assign(responseHeaders, nextHeaders); return res; };
  const finished = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
  await handleRequest(req, res);
  await finished;
  const text = Buffer.concat(chunks).toString('utf8');
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.statusCode, headers: responseHeaders, text, json };
}

const { seedAccount, setUserFeatures } = require('../tests/server/seed-account.cjs');
let cookie = '';
let csrf = '';
let adminId = '';
test.before(() => {
  // Sign-in is the Rust front's (#1071): the account and its session are seeded directly.
  ({ cookie, csrf, id: adminId } = seedAccount(testDataDir, { username: 'synthetic-admin', displayName: 'Synthetic', publicOrigin: 'http://localhost' }));
});

const writeHeaders = (extra = {}) => ({ origin: 'http://localhost', cookie, 'content-type': 'application/json', 'x-csrf-token': csrf, ...extra });

test('#781: a malformed cookie escape gets an HTTP answer and does not break a valid session', async () => {
  // GET /api/profile and /api/setup/status are the Rust front's (#1071); Node-owned routes here.
  const anonymous = await request('/api/ready', { headers: { cookie: 'a=%E0' } });
  assert.equal(anonymous.status, 200, 'a signed-out request with a bad sibling cookie is answered');
  const unknown = await request('/api/workspace', { headers: { cookie: 'a=%E0%A4%A' } });
  assert.equal(unknown.status, 401, 'no session cookie: an ordinary 401, not a reset');
  const signedIn = await request('/api/workspace', { headers: { cookie: `sibling=%E0%A4%A; ${cookie}` } });
  assert.equal(signedIn.status, 200, 'the session cookie next to a malformed one still signs in');
});

test('#781: parseCookies keeps a malformed value raw and still decodes the rest', () => {
  assert.deepEqual(parseCookies({ headers: { cookie: 'a=%E0; b=x%20y; cowork_session=tok' } }), { a: '%E0', b: 'x y', cowork_session: 'tok' });
  assert.deepEqual(parseCookies({ headers: {} }), {});
});

test('#786: a JSON body of null is a 400 on every route that reads its body', async () => {
  // The sign-in and account routes in this list moved to the Rust front (#1071).
  // Saving the storage connection is the Rust front's (#2190 round 4; its null-body 400 is asserted in
  // noevia-rs tests/storage_integrations.rs): Node refuses it before reading the body.
  const storage = await request('/api/integrations/storage', { method: 'PUT', headers: writeHeaders(), body: 'null' });
  assert.equal(storage.status, 503);
  assert.equal(JSON.parse(storage.text).code, 'RUST_STORAGE_CONNECTION_OWNED');
  // A well-formed body is unaffected.
  const control = createProjectAs(testDataDir, adminId, { name: 'Synthetic null-body control' });
  assert.equal((await request(`/api/projects/${control.id}/config`, { method: 'POST', headers: writeHeaders(), body: JSON.stringify({ pinned: true }) })).status, 200);
});

// #786 (a null body is a 400 on the connector endpoint and on the connector credentials) moved with the
// routes to the Rust front (#2206): noevia-rs bins/noevia-server tests/diary.rs. Node refuses them
// before authentication and before reading the body.
test('#2206: Node refuses the Diary connector routes before authentication and before reading the body', async () => {
  setUserFeatures(testDataDir, adminId, { diaryEnabled: true });
  for (const [method, url, headers] of [
    ['POST', '/api/profile/diary-connectors', writeHeaders()],
    ['POST', '/api/diary-connector', { authorization: 'Bearer anything', 'content-type': 'application/json' }],
  ]) {
    const res = await request(url, { method, headers, body: 'null' });
    assert.equal(res.status, 503, `${method} ${url}: ${res.text}`);
    assert.equal(JSON.parse(res.text).code, 'RUST_DIARY_ROUTES_OWNED');
  }
});

const createProject = async (name) => {
  const project = createProjectAs(testDataDir, adminId, { name });
  assert.ok(project?.id);
  return project;
};

// #786 (deleting a project file with a null body is a 400) moved with DELETE .../files to the Rust
// front (#2191 round 3): noevia-rs tests/project_lifecycle.rs. Node refuses it before reading the body.
test('#2191: Node refuses the project file delete before authentication', async () => {
  const project = await createProject('Synthetic hardening delete');
  const del = await request(`/api/projects/${project.id}/files`, { method: 'DELETE', headers: writeHeaders(), body: 'null' });
  assert.equal(del.status, 503, del.text);
  assert.equal(del.json.code, 'RUST_PROJECT_FILES_OWNED');
});

// #786 (a stored upload whose original is gone answers 404) moved with GET .../uploads/original to
// the Rust front (#2191): noevia-rs tests/project_reads.rs. Node refuses the read before auth.
test('#2191: Node refuses the stored-original download before authentication', async () => {
  for (const headers of [{}, { cookie }]) {
    const r = await request('/api/projects/p-any/uploads/original?name=synthetic.docx', { headers });
    assert.equal(r.status, 503);
    assert.equal(r.json.code, 'RUST_PROJECT_READS_OWNED');
  }
});

test('L3: an unparseable request target is a 400 without a logged stack; a malformed Host header still routes', async () => {
  const realError = console.error;
  const logged = [];
  console.error = (...args) => { logged.push(args); };
  try {
    for (const target of ['//[', 'http://[', '//a b']) {
      const res = await request(target);
      assert.equal(res.status, 400, target);
      assert.deepEqual(res.json, { error: 'invalid URL' });
    }
    const badHost = await request('/api/ready', { headers: { host: 'a b[' } });
    assert.equal(badHost.status, 200, 'the path alone is enough to route');
  } finally { console.error = realError; }
  assert.deepEqual(logged, [], 'no stack is logged for a client error');
});

// #1480: every reply the Node layer answers, not only the storage refusal, carries HSTS (six months,
// no includeSubDomains) and a Permissions-Policy that turns off the features the app never calls.
test('the public site sends Strict-Transport-Security and Permissions-Policy on every reply (#1480)', async () => {
  for (const target of ['/api/ready', '/api/features', '/api/nope-not-a-route', '/settings/providers']) {
    const reply = await request(target);
    assert.equal(reply.headers['Strict-Transport-Security'], 'max-age=15552000', target);
    const policy = reply.headers['Permissions-Policy'];
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
      assert.ok(policy.includes(`${feature}=()`), `${target}: ${feature} is off`);
    }
    assert.ok(!/includeSubDomains/i.test(reply.headers['Strict-Transport-Security']), target);
  }
});
