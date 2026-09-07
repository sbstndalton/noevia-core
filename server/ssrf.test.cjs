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
  assert.match(JSON.parse(response.text).error, /approved/i);
});

test('member cannot probe a private target through the provider test route', async () => {
  const response = await request('/api/providers/test', {
    method: 'POST', headers: memberHeaders(),
    body: JSON.stringify({ baseUrl: 'http://10.9.8.7:8080/v1' }),
  });
  assert.equal(response.status, 400);
  assert.match(JSON.parse(response.text).error, /approved/i);
});

test('member cannot register an unapproved public-IP provider', async () => {
  // IP literal: no DNS, fully deterministic offline.
  const response = await request('/api/providers', {
    method: 'POST', headers: memberHeaders(),
    body: JSON.stringify({ label: 'Cloud provider', baseUrl: 'https://93.184.216.34/v1' }),
  });
  assert.equal(response.status, 400);
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

// ── storage endpoints: same policy, more fetch points ────────────────────────

const Database = require('better-sqlite3');
const { createSecretStore } = require('./secrets.cjs');

async function putStorage(headers, body) {
  return request('/api/integrations/storage', {
    method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('admin is exempt from the storage denylist (LAN NAS / in-network Nextcloud)', async () => {
  // Saving never fetches, so a private baseUrl must simply be accepted.
  const response = await putStorage(adminHeaders, {
    kind: 'webdav', baseUrl: 'http://192.168.1.50:5005/dav', username: 'admin', secret: 'pw', corpusRoot: 'Cowork',
  });
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.text).kind, 'webdav');
});

test('member cannot save a private-range storage connection', async () => {
  const response = await putStorage(memberHeaders(), {
    kind: 'webdav', baseUrl: 'http://10.0.0.5:5005/dav', username: 'u', secret: 'p', corpusRoot: 'Cowork',
  });
  assert.equal(response.status, 400);
  assert.match(JSON.parse(response.text).error, /approved/i);
  // Nothing was saved for the member.
  const stored = await request('/api/integrations/storage', { headers: memberHeaders() });
  assert.equal(JSON.parse(stored.text).kind, 'local');
});

test('member cannot run the storage connection test against a private target', async () => {
  const response = await request('/api/integrations/storage/test', {
    method: 'POST', headers: { ...memberHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'webdav', baseUrl: 'http://169.254.169.254/remote.php/dav', username: 'u', secret: 'p', corpusRoot: '' }),
  });
  assert.equal(response.status, 400);
  assert.match(JSON.parse(response.text).error, /approved/i);
});

test('member cannot browse or read through a saved private connection', async () => {
  // Seed a connection bypassing saveStorage: simulates a connection saved by
  // an admin account that was later demoted to member.
  const secrets = createSecretStore(testDataDir);
  const db = new Database(path.join(testDataDir, 'cowork.db'));
  const admin = db.prepare("SELECT id FROM users WHERE username='admin'").get();
  const member = db.prepare("SELECT id FROM users WHERE username='member'").get();
  const adminRow = db.prepare('SELECT * FROM storage_connections WHERE user_id=?').get(admin.id);
  assert.ok(adminRow, 'admin storage row exists for the ciphertext copy');
  db.prepare('INSERT INTO storage_connections(user_id,kind,base_url,bucket,username,secret,corpus_root,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(member.id, 'webdav', 'http://169.254.169.254/dav', '', 'u', adminRow.secret, 'Cowork', Date.now());

  const browse = await request('/api/integrations/storage/files', { headers: memberHeaders() });
  assert.equal(browse.status, 400);
  assert.match(JSON.parse(browse.text).error, /approved/i);

  const read = await request('/api/integrations/storage/file', {
    method: 'POST', headers: { ...memberHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ path: 'notes.md' }),
  });
  assert.equal(read.status, 400);
  assert.match(JSON.parse(read.text).error, /approved/i);

  db.prepare('DELETE FROM storage_connections WHERE user_id=?').run(member.id);
  db.close();
});

test('member cannot start a Nextcloud login flow against a private host', async () => {
  const response = await request('/api/integrations/storage/nextcloud/start', {
    method: 'POST', headers: { ...memberHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'https://10.1.2.3:8080' }),
  });
  assert.equal(response.status, 400);
  assert.match(JSON.parse(response.text).error, /approved/i);
});


test('member can connect an operator-approved origin, but not a lookalike origin', async () => {
  process.env.MEMBER_OUTBOUND_ORIGINS = 'https://approved.example.com';
  try {
    for (const [baseUrl, status] of [['https://approved.example.com/v1', 200], ['https://approved.example.com.evil.test/v1', 400], ['https://approved.example.com:8443/v1', 400]]) {
      const response = await request('/api/providers', {method:'POST', headers:memberHeaders(), body:JSON.stringify({label:'Approved', baseUrl})});
      assert.equal(response.status, status);
    }
  } finally { delete process.env.MEMBER_OUTBOUND_ORIGINS; }
});

test('member cannot read operator import folders', async () => {
  const response = await request('/api/diary/external-sources', {headers:memberHeaders()});
  assert.equal(response.status, 403);
});
