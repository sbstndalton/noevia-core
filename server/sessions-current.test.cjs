'use strict';
// #404: the Security and login page's session dot was hard-coded green for every row — this
// checks the real signal it must now show: GET /api/profile marks the session that made the
// request `current: true`, and every other signed-in session for the same account `false`, so
// the client can tell "this device" apart from "some other device" instead of faking one colour
// for all of them.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-sessions-current-test-'));
process.env.DIARY_AUTH_TOKEN = 'test-cowork-token';
process.env.UI_AUTH_TOKEN = 'test-cowork-token';
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
  const res = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  res.statusCode = 200;
  res.headersSent = false;
  res.setHeader = (name, value) => { responseHeaders[name] = value; };
  res.writeHead = (status, nextHeaders = {}) => { res.statusCode = status; res.headersSent = true; Object.assign(responseHeaders, nextHeaders); return res; };
  const finished = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
  await handleRequest(req, res);
  await finished;
  return { status: res.statusCode, headers: responseHeaders, text: Buffer.concat(chunks).toString('utf8') };
}

function sessionCookieFrom(response) {
  const setCookies = response.headers['set-cookie'] || response.headers['Set-Cookie'] || [];
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  assert.ok(cookie.includes('cowork_session='), 'login must set a session cookie');
  return cookie;
}

test.before(async () => {
  const setupCode = fs.readFileSync(path.join(testDataDir, 'first-run-setup-code'), 'utf8').trim();
  const setup = await request('/api/setup/complete', {
    method: 'POST', headers: { origin: 'http://localhost' },
    body: JSON.stringify({ setupCode, publicOrigin: 'http://localhost', username: 'admin', displayName: 'Admin', password: 'correct horse battery staple' }),
  });
  assert.equal(setup.status, 201);
});

const login = () => request('/api/auth/login/password', {
  method: 'POST', headers: { origin: 'http://localhost' },
  body: JSON.stringify({ username: 'admin', password: 'correct horse battery staple' }),
});

test('#404: each session sees itself as current and the other account session as not', async () => {
  const first = await login();
  assert.equal(first.status, 200);
  const cookieA = sessionCookieFrom(first);
  // A second, independent sign-in creates a second live session for the same account — the
  // multi-device situation the bug report was about.
  const second = await login();
  assert.equal(second.status, 200);
  const cookieB = sessionCookieFrom(second);
  assert.notEqual(cookieA, cookieB, 'two logins produce two distinct sessions');

  const profileAs = async (cookie) => JSON.parse((await request('/api/profile', { headers: { cookie } })).text);

  const asA = await profileAs(cookieA);
  const asB = await profileAs(cookieB);
  // `/api/setup/complete` itself signs the admin in, so there may be an earlier session too —
  // only A and B's relative marking matters here, not the total count.
  assert.ok(asA.sessions.length >= 2, 'at least both sessions from this test are listed');
  assert.equal(asA.sessions.length, asB.sessions.length, 'both requests see the same set of sessions');

  const currentIn = (body) => body.sessions.filter((s) => s.current === true);
  assert.equal(currentIn(asA).length, 1, 'exactly one session is current when asked as A');
  assert.equal(currentIn(asB).length, 1, 'exactly one session is current when asked as B');
  // The two requests must not agree on which session is "current" — each sees its own.
  assert.notEqual(currentIn(asA)[0].id, currentIn(asB)[0].id);
  // Every id present in one response is present in the other (same two sessions, different marker).
  assert.deepEqual(asA.sessions.map((s) => s.id).sort(), asB.sessions.map((s) => s.id).sort());
});

test('#404: a legacy bearer-token caller has no session of its own, so none of the account\'s sessions reads as current', async () => {
  // The bearer path authenticates as whichever admin exists, with no session row backing the
  // request — real state ("this device") does not exist for it, so nothing should be labelled
  // current rather than guessing.
  const body = JSON.parse((await request('/api/profile', { headers: { authorization: 'Bearer test-cowork-token' } })).text);
  assert.ok(body.sessions.length > 0);
  assert.ok(body.sessions.every((s) => s.current === false));
});
