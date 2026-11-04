'use strict';

// Route-level tests for the per-user LLM rate limit on /api/chat and the
// Insights reflection proxies. Chat port S6: the `llm:` budget is the Rust
// front's (rust-chat-edge.cjs); with LLM_RATE_LIMIT lowered to 2 BEFORE the
// server module loads, Node still answers every relayed turn. Invalid-JSON
// chat bodies fail fast at the parse step; no inference endpoint involved.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { frontTurn } = require('../tests/server/front-chat-turn.cjs');
const test = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-llm-rate-test-'));
process.env.DIARY_AUTH_TOKEN = 'test-cowork-token';
// #294: UI_AUTH_TOKEN no longer falls back to DIARY_AUTH_TOKEN; the admin Bearer requests below
// need it set explicitly.
process.env.UI_AUTH_TOKEN = 'test-cowork-token';
process.env.UI_DATA_DIR = testDataDir;
// #1071: Node saves projects.json / free-chats.json only through the Rust project store.
require('../tests/server/project-store-server.cjs').installProjectStore(testDataDir);
process.env.LEGACY_AUTH_COMPAT = 'true';
process.env.PUBLIC_ORIGIN = 'http://localhost';
process.env.LLM_RATE_LIMIT = '2';

const { handleRequest } = require('./index.cjs');

test.after(() => {
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

async function request(url, { method = 'GET', headers = {}, body = '', peer } = {}) {
  const req = Readable.from(body ? [body] : []);
  req.url = url;
  req.method = method;
  req.headers = { host: 'localhost', ...headers };
  if (peer) req.socket = { remoteAddress: peer };
  const chunks = [];
  const responseHeaders = {};
  const res = new Writable({
    write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
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
  return { status: res.statusCode, headers: responseHeaders, text: Buffer.concat(chunks).toString('utf8') };
}

let cookie = '';
let csrf = '';
let adminId = '';

test.before(async () => {
  // Sign-in is the Rust front's (#1071): the account and its session are seeded directly.
  ({ cookie, csrf, id: adminId } = require('../tests/server/seed-account.cjs').seedAccount(testDataDir, { username: 'admin', displayName: 'Admin', publicOrigin: 'http://localhost' }));
});

const mutationHeaders = () => ({ origin: 'http://localhost', cookie, 'content-type': 'application/json', 'x-csrf-token': csrf });

test('chat port S6: Node keeps no llm: budget; the front counts it (rust-chat-edge.cjs)', async () => {
  // LLM_RATE_LIMIT is 2, as it was when this process counted the third turn as a 429: now every relayed turn reaches
  // routes/chat.cjs (400: invalid JSON), however many the front let through.
  for (let i = 0; i < 4; i += 1) {
    const r = await request(...frontTurn({ method: 'POST', headers: mutationHeaders(), body: 'not-json' }, adminId));
    assert.equal(r.status, 400, `turn ${i + 1}`);
    assert.deepEqual(JSON.parse(r.text), { error: 'invalid JSON' });
  }
  const source = fs.readFileSync(path.join(__dirname, 'index.cjs'), 'utf8');
  assert.equal(/llmRateLimit|LLM_RATE_LIMIT\)/.test(source), false, 'no llm: limiter is built here');
});

test('the removed Insights reflection route is unavailable', async () => {
  const response = await request('/api/diary/insights/reflect', { method: 'POST', headers: mutationHeaders(), body: JSON.stringify({}) });
  assert.equal(response.status, 404);
});

test('other routes are unaffected by the LLM throttle', async () => {
  // GET /api/integrations/storage is the Rust front's (#1071); the workspace view is still Node's.
  const response = await request('/api/chats/search', { headers: { cookie } });
  assert.equal(response.status, 200);
});

test('the throttle bucket is per user, not global', async () => {
  // A second, signed-in user (seeded: sign-in is the Rust front's, #1071): their bucket must be empty.
  const { cookie: memberCookie, csrf: memberCsrf, id: memberId } = require('../tests/server/seed-account.cjs').seedAccount(testDataDir, { username: 'member', displayName: 'Member', role: 'member' });

  const response = await request(...frontTurn({
    method: 'POST',
    headers: { origin: 'http://localhost', cookie: memberCookie, 'content-type': 'application/json', 'x-csrf-token': memberCsrf },
    body: 'not-json',
  }, memberId));
  assert.equal(response.status, 400); // not throttled: fresh per-user bucket
});
