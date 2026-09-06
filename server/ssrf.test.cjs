'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const test = require('node:test');

const { isPrivateIp, isPublicUrl } = require('./ssrf.cjs');

// ── Unit tests: private-IP classification ───────────────────────────────────

test('classifies private, loopback, link-local, CGNAT, and reserved IPv4 as private', () => {
  for (const ip of [
    '10.1.2.3', // RFC1918
    '172.16.0.1', // RFC1918
    '172.31.255.255', // RFC1918 edge
    '192.168.1.1', // RFC1918
    '127.0.0.1', // loopback
    '0.0.0.0', // this-network
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT (Tailscale)
    '100.127.255.255', // CGNAT upper edge
    '224.0.0.1', // multicast
    '255.255.255.255', // broadcast
  ]) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
});

test('classifies public IPv4 as public and keeps RFC1918 neighbors public', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255', '100.128.0.1', '192.169.0.1', '9.9.9.9']) {
    assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
  }
});

test('classifies IPv6 loopback, ULA, link-local, and IPv4-mapped as private; global unicast as public', () => {
  for (const ip of ['::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
  for (const ip of ['2606:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
  }
});

test('isPublicUrl rejects garbage and non-http schemes without DNS', async () => {
  assert.equal(await isPublicUrl('not a url'), false);
  assert.equal(await isPublicUrl(''), false);
  assert.equal(await isPublicUrl('ftp://example.com/v1'), false);
});

test('isPublicUrl rejects literal private targets including metadata and IPv4-mapped IPv6 (no DNS needed)', async () => {
  assert.equal(await isPublicUrl('http://169.254.169.254/latest/meta-data/'), false);
  assert.equal(await isPublicUrl('http://127.0.0.1:8080/v1'), false);
  assert.equal(await isPublicUrl('http://10.0.0.5/v1'), false);
  assert.equal(await isPublicUrl('http://192.168.1.10/v1'), false);
  assert.equal(await isPublicUrl('http://[::ffff:192.168.0.1]/v1'), false);
  assert.equal(await isPublicUrl('http://metadata.google.internal/computeMetadata/v1/'), false);
});

test('isPublicUrl accepts public IP literals and rejects unresolvable hostnames', async () => {
  assert.equal(await isPublicUrl('https://93.184.216.34/v1'), true);
  assert.equal(await isPublicUrl('http://this-host-does-not-exist.invalid/v1'), false);
});

// ── Route-level tests: member vs admin on /api/providers ───────────────────

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-ssrf-test-'));
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
  return {
    status: res.statusCode,
    headers: responseHeaders,
    text: Buffer.concat(chunks).toString('utf8'),
  };
}

// Member sessions authenticate via cookies + CSRF header, not bearer tokens.
let memberCookie = '';
let memberCsrf = '';

function memberHeaders() {
  return { cookie: memberCookie, 'x-csrf-token': memberCsrf, origin: 'http://localhost' };
}

const adminHeaders = { authorization: 'Bearer test-cowork-token', origin: 'http://localhost' };

test.before(async () => {
  const setupCode = fs.readFileSync(path.join(testDataDir, 'first-run-setup-code'), 'utf8').trim();
  const response = await request('/api/setup/complete', {
    method: 'POST', headers: { origin: 'http://localhost' },
    body: JSON.stringify({ setupCode, publicOrigin: 'http://localhost', username: 'admin', displayName: 'Admin', password: 'correct horse battery staple' }),
  });
  assert.equal(response.status, 201);

  // Create + sign in a member through an invitation.
  const invite = await request('/api/admin/invitations', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ role: 'member' }),
  });
  assert.equal(invite.status, 201);
  const { token } = JSON.parse(invite.text);
  const accepted = await request('/api/auth/invitations/accept', {
    method: 'POST', headers: { origin: 'http://localhost' },
    body: JSON.stringify({ token, username: 'member', displayName: 'Member', password: 'grumpy engineers count beans' }),
  });
  assert.equal(accepted.status, 201);
  const cookies = accepted.headers['Set-Cookie'].map((c) => c.split(';')[0]);
  memberCookie = cookies.filter((c) => c.startsWith('cowork_session=') || c.startsWith('cowork_csrf=')).join('; ');
  memberCsrf = JSON.parse(accepted.text).csrfToken;
  assert.ok(memberCookie.includes('cowork_session='));
  assert.ok(memberCsrf);
});

test('member cannot register a private-range provider', async () => {
  const response = await request('/api/providers', {
    method: 'POST', headers: memberHeaders(),
    body: JSON.stringify({ label: 'Evil', baseUrl: 'http://169.254.169.254/v1' }),
  });
  assert.equal(response.status, 400);
  assert.match(JSON.parse(response.text).error, /public endpoint/);
});

test('member cannot probe a private target through the provider test route', async () => {
  const response = await request('/api/providers/test', {
    method: 'POST', headers: memberHeaders(),
    body: JSON.stringify({ baseUrl: 'http://10.9.8.7:8080/v1' }),
  });
  assert.equal(response.status, 400);
  assert.match(JSON.parse(response.text).error, /public endpoint/);
});

test('member can register a public-IP provider', async () => {
  // IP literal: no DNS, fully deterministic offline.
  const response = await request('/api/providers', {
    method: 'POST', headers: memberHeaders(),
    body: JSON.stringify({ label: 'Cloud provider', baseUrl: 'https://93.184.216.34/v1' }),
  });
  assert.equal(response.status, 200);
  assert.ok(JSON.parse(response.text).id);
});

test('admin is exempt from the denylist (local inference targets private addresses)', async () => {
  const response = await request('/api/providers', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ label: 'Local model host', baseUrl: 'http://host.docker.internal:11434/v1' }),
  });
  assert.equal(response.status, 200);
  assert.ok(JSON.parse(response.text).id);
});

test('admin can still test a private target (same exemption)', async () => {
  // The fetch itself will fail to connect in the sandbox, but the guard must
  // not be what rejects it: a 502 means the request was attempted.
  const response = await request('/api/providers/test', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ baseUrl: 'http://127.0.0.1:9/v1' }),
  });
  assert.equal(response.status, 502);
});
