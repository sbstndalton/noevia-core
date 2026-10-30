'use strict';
// #770: a WebDAV/Nextcloud connection's login is checked before it is saved. A rejected login
// (401) keeps the old row; a 403 or an unreachable server saves with a warning; the secret never
// appears in a response, an error or a log line. Synthetic fixtures only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const storageClient = require('./storage-client.cjs');

const SECRET = 'synthetic-app-password-7f3a';
// undici's shape for a refused redirect: TypeError('fetch failed') with cause 'unexpected redirect'.
const redirectError = () => Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });

// The save's login check (a 401 keeps the old row, a 403 or an unreachable server saves with a
// warning, the redirect and timeout words, the secret never in a reply) moved with
// PUT /api/integrations/storage to the Rust front (sbstndalton/noevia#2190 round 4): noevia-rs
// tests/storage_integrations.rs put_connection_validates_checks_and_saves. checkLogin itself stays
// here: Node's automatic callers still classify a refused login with it.

test('#776: checkLogin maps a real 3xx under redirect:error to unverified redirect', async (t) => {
  const http = require('node:http');
  const server = http.createServer((req, res) => { res.writeHead(301, { Location: '/elsewhere/' }); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const conn = { baseUrl: `http://127.0.0.1:${server.address().port}/dav`, username: 'u', secret: SECRET };
  const result = await storageClient.checkLogin(conn, { fetchImpl: fetch });
  assert.deepEqual(result, { ok: false, unverified: 'redirect' });
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test('checkLogin never throws and classifies statuses', async () => {
  const conn = { baseUrl: 'https://dav.example.test/x', username: 'u', secret: SECRET };
  const at = (status) => storageClient.checkLogin(conn, { fetchImpl: async () => new Response('', { status }) });
  assert.deepEqual(await at(207), { ok: true });
  assert.deepEqual(await at(401), { ok: false, rejected: true, status: 401 });
  assert.deepEqual(await at(403), { ok: false, unverified: 'status', status: 403 });
  assert.deepEqual(await at(500), { ok: false, unverified: 'status', status: 500 });
  const failed = await storageClient.checkLogin(conn, { fetchImpl: async () => { throw new Error(SECRET); } });
  assert.deepEqual(failed, { ok: false, unverified: 'network' });
  assert.deepEqual(await storageClient.checkLogin(conn, { fetchImpl: async () => { throw redirectError(); } }), { ok: false, unverified: 'redirect' });
  // A plain network TypeError without a redirect cause stays 'network'.
  assert.deepEqual(await storageClient.checkLogin(conn, { fetchImpl: async () => { throw new TypeError('fetch failed'); } }), { ok: false, unverified: 'network' });
  assert.equal(storageClient.isLoginRejected, undefined);
});

// The refresh side: the browser turns "storage returned 401" into a message that says the login
// was rejected and where to fix it, in the toast and in the source-state text.
function sourceStatus() {
  const exportsObject = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/source-status.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: exportsObject });
  return exportsObject;
}

test('a refresh 401/403 says the storage login was rejected and keeps the retained note', () => {
  const s = sourceStatus();
  const entries = s.sourceRefreshEntries([{ folder: 'Finance', reason: 'storage returned 401', retained: true }, { folder: 'Other', reason: 'storage returned 404' }]);
  assert.equal(entries[0], 'Finance: Storage login rejected. Check your storage credentials in Settings → Diary & storage. Previous readable text retained.');
  assert.equal(entries[1], 'Other: storage returned 404');
  const t = (key) => `[${key}]`;
  assert.equal(s.sourceRefreshIssues([{ folder: 'F', reason: 'storage returned 403' }], t), 'F: [storage.refreshLoginRejected]');
  const toast = s.resolveSkippedToast({ signature: '', message: '' }, [{ folder: 'F', reason: 'storage returned 401', retained: true }], null, t);
  assert.ok(s.mentionsStorageLogin(toast.show, t));
  assert.ok(!s.mentionsStorageLogin('F: storage returned 404', t));
  assert.equal(s.sourceRefreshFailure(new Error('storage returned 401'), t), 'Sources could not be refreshed — [storage.refreshLoginRejected]');
  assert.equal(s.sourceRefreshFailure(new Error('storage returned 500')), 'Sources could not be refreshed — storage returned 500.');
  assert.match(s.sourceStatus({ document: { state: 'failed', stale: true, error: 'storage returned 401' } }), /Storage login rejected/);
});

test('#849: an upload the server failed with a refused storage login reads as that, in the interface language', () => {
  const s = sourceStatus();
  const t = (key) => `[${key}]`;
  const rejected = Object.assign(new Error('Storage login rejected. Check your storage credentials in Settings → Diary & storage.'), { code: 'storageLoginRejected' });
  assert.equal(s.uploadFailureText(rejected), 'Storage login rejected. Check your storage credentials in Settings → Diary & storage.');
  assert.equal(s.uploadFailureText(rejected, t), '[storage.refreshLoginRejected]');
  assert.ok(s.mentionsStorageLogin(s.uploadFailureText(rejected, t), t), 'the Settings link logic recognises it');
  // Everything else keeps the server's message, or the caller's fallback for a non-Error.
  assert.equal(s.uploadFailureText(new Error('Could not create the storage folder; retry.'), t), 'Could not create the storage folder; retry.');
  assert.equal(s.uploadFailureText('boom', t, 'Upload failed'), 'Upload failed');
  assert.equal(s.uploadFailureText(null, t, 'Upload failed'), 'Upload failed');
});
