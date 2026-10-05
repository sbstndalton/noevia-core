'use strict';
// Members' Google Drive connections survive a secrets.key rotation (#866): the sealed token files are
// re-sealed by the rotation, and read with the previous key until then. Fake Google, synthetic ids.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createGoogleDrive } = require('./gdrive.cjs');
const { createDriveAccounts } = require('./drive-accounts.cjs');
const { createSecretStore } = require('./secrets.cjs');
const { runRotation } = require('./secrets-rotate.cjs');
const { startFakeGoogle } = require('../qa/fake-google.cjs');

const temps = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-gkr-')); temps.push(d); return d; };
let google;
test.before(async () => { google = await startFakeGoogle({ autoApprove: true }); });
test.after(async () => { await google.close(); for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

const noPrev = { env: {} };
const member = { id: 'u-member', role: 'member' }, other = { id: 'u-other', role: 'member' };
const until = async (fn) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timed out'); };
// No database tables here: rotationTables skips tables that do not exist.
const noDb = { prepare: () => ({ get: () => undefined, all: () => [] }) };

const accountsFor = (dir, secrets) => createDriveAccounts({
  backupDrive: null, dataDir: dir, userKey: () => secrets.derive('google-drive-user'), userKeyPrevious: () => secrets.derivePrevious('google-drive-user'),
  makeDrive: ({ tokenFile, backupKey, previousBackupKey }) => createGoogleDrive({
    clientId: 'fake-client', clientSecret: 'fake-secret', tokenFile, backupKey, previousBackupKey,
    oauthBase: google.base, apiBase: `${google.base}/drive`, uploadBase: `${google.base}/upload`,
  }),
});
const retire = (dir) => fs.renameSync(path.join(dir, 'secrets.key'), path.join(dir, 'secrets.key.previous'));

async function connectedBeforeRotation() {
  const dir = temp();
  const old = createSecretStore(dir, noPrev);
  const accounts = accountsFor(dir, old);
  for (const user of [member, other]) {
    const { drive } = accounts.forUser(user);
    await drive.connect(() => {}, { owner: user.id });
    await until(() => drive.state().state === 'connected');
  }
  const refresh = google.state.refresh.size;
  assert.ok(refresh >= 2);
  retire(dir); // a new secrets.key is generated on the next start, the old one is kept as the previous key
  return { dir, fresh: createSecretStore(dir, noPrev) };
}

test('after a key change a member\'s Drive reads through the previous key, and disconnect can still revoke', async () => {
  const { dir, fresh } = await connectedBeforeRotation();
  assert.equal(fresh.hasPreviousKey(), true);
  const accounts = accountsFor(dir, fresh);
  const { drive } = accounts.forUser(member);
  const state = drive.state();
  assert.equal(state.state, 'connected');
  assert.equal(state.owner, member.id);
  assert.ok(await drive.call(`${google.base}/drive/files?pageSize=1`) !== undefined, 'a token can be refreshed from the record');
  const before = google.state.revoked.length;
  await drive.disconnect();
  assert.equal(google.state.revoked.length, before + 1, 'the refresh token was read and revoked at Google');
  assert.equal(drive.state().state, 'disconnected');
  assert.equal(fs.existsSync(path.join(dir, 'google-drive-users', `${member.id}.sealed`)), false);
});

test('the rotation re-seals every member file so the previous key can be removed', async () => {
  const { dir, fresh } = await connectedBeforeRotation();
  const report = runRotation({ secrets: fresh, db: noDb, dataDir: dir });
  assert.deepEqual(report.tables.google_drive_users, { current: 0, rotated: 2, upgraded: 0, empty: 0, failed: 0 });
  assert.equal(report.totals.failed, 0);
  for (const secret of google.state.refresh) assert.ok(!JSON.stringify(report).includes(secret), 'the report never carries a token');

  fs.rmSync(path.join(dir, 'secrets.key.previous'));
  const only = createSecretStore(dir, noPrev);
  assert.equal(only.hasPreviousKey(), false);
  const accounts = accountsFor(dir, only);
  assert.equal(accounts.forUser(member).drive.state().state, 'connected');
  assert.equal(accounts.forUser(other).drive.state().state, 'connected');
  // A refresh still works, and disconnect revokes the old refresh token.
  assert.ok(await accounts.forUser(member).drive.call(`${google.base}/drive/files?pageSize=1`) !== undefined);
  const before = google.state.revoked.length;
  await accounts.forUser(member).drive.disconnect();
  assert.equal(google.state.revoked.length, before + 1);

  // Idempotent: a second run finds everything current.
  const again = runRotation({ secrets: only, db: noDb, dataDir: dir });
  assert.deepEqual(again.tables.google_drive_users, { current: 1, rotated: 0, upgraded: 0, empty: 0, failed: 0 });
});

test('a file sealed under neither key is counted as failed, never rewritten, and leaks no token', async () => {
  const { dir, fresh } = await connectedBeforeRotation();
  const lost = path.join(dir, 'google-drive-users', `${other.id}.sealed`);
  const text = fs.readFileSync(path.join(dir, 'google-drive-users', `${member.id}.sealed`), 'utf8');
  fs.writeFileSync(lost, 'AAAA' + text.slice(4)); // tampered: opens under neither key
  const report = runRotation({ secrets: fresh, db: noDb, dataDir: dir });
  assert.deepEqual(report.tables.google_drive_users, { current: 0, rotated: 1, upgraded: 0, empty: 0, failed: 1 });
  assert.equal(report.failures[0].ref, `${other.id}.sealed`);
  assert.match(report.failures[0].error, /no longer available/);
  assert.equal(fs.readFileSync(lost, 'utf8'), 'AAAA' + text.slice(4));
});

test('without a previous key a file sealed under the old key is "connect again", as before', async () => {
  const { dir } = await connectedBeforeRotation();
  fs.rmSync(path.join(dir, 'secrets.key.previous'));
  const only = createSecretStore(dir, noPrev);
  assert.equal(only.derivePrevious('google-drive-user'), null);
  const state = accountsFor(dir, only).forUser(member).drive.state();
  assert.equal(state.state, 'error');
  assert.match(state.message, /could not be read/);
});
