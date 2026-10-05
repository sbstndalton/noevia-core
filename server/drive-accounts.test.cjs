'use strict';
// Whose Google Drive an account reaches while a sign-in is pending: only the administrator who
// started the backup connection sees its code or can finish it (#868). Fake Google, two admins.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createGoogleDrive } = require('./gdrive.cjs');
const { createDriveAccounts } = require('./drive-accounts.cjs');
const { createConnectorRoutes } = require('./routes/connectors.cjs');
const { startFakeGoogle } = require('../qa/fake-google.cjs');

const temps = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-daccts-')); temps.push(d); return d; };
let google;
test.before(async () => { google = await startFakeGoogle(); });
test.after(async () => { await google.close(); for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

const key = crypto.randomBytes(32);
const makeDrive = ({ tokenFile, backupKey }) => createGoogleDrive({
  clientId: 'fake-client', clientSecret: 'fake-secret', tokenFile, backupKey,
  oauthBase: google.base, apiBase: `${google.base}/drive`, uploadBase: `${google.base}/upload`,
});
const until = async (fn) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timed out'); };
const adminA = { id: 'u-admin-a', role: 'admin' }, adminB = { id: 'u-admin-b', role: 'admin' };

function setup() {
  const dir = temp();
  const backupDrive = makeDrive({ tokenFile: path.join(dir, 'google-drive.sealed'), backupKey: () => key });
  const accounts = createDriveAccounts({ backupDrive, dataDir: dir, userKey: () => key, makeDrive });
  return { dir, backupDrive, accounts };
}

test('while the backup sign-in is pending, only the administrator who started it owns it', async () => {
  const { accounts, backupDrive } = setup();
  assert.equal(accounts.forUser(adminA).backup, true, 'nothing pending: an administrator fills the backup slot');
  await backupDrive.connect(() => {}, { owner: adminA.id });
  assert.equal(backupDrive.state().state, 'pending');
  assert.equal(accounts.forUser(adminA).backup, true);
  const b = accounts.forUser(adminB);
  assert.equal(b.backup, false, 'a second administrator is not shown the first one\'s pending code');
  assert.equal(b.drive.state().state, 'disconnected');
  assert.equal(b.drive.state().userCode, undefined);

  // The first administrator finishes it; the connection is theirs, not the second administrator's.
  google.approve();
  await until(() => backupDrive.state().state === 'connected');
  assert.equal(backupDrive.state().owner, adminA.id);
  assert.equal(accounts.forUser(adminA).backup, true);
  assert.equal(accounts.forUser(adminB).backup, false);
});

test('the connectors view shows the pending code to its initiator only, and the second admin connects their own Drive', async () => {
  const { accounts, backupDrive, dir } = setup();
  const sent = [];
  const offsite = { connectGoogle: (owner) => backupDrive.connect(() => {}, { owner }), status: () => ({ enabled: true, google: { copyEnabled: true, copy: null }, lastBackup: null }) };
  const routes = createConnectorRoutes({
    accounts, driveTools: { names: new Set(), labels: {} }, policy: { mode: () => 'ask' }, offsite, isWrite: () => false,
    json: (res, status, body) => { res.status = status; res.body = body; sent.push(res); }, readBody: async () => ({}),
  });
  const call = async (user, method, p) => { const res = {}; await routes({ method }, res, { path: p, authn: { user } }); return res; };

  const started = await call(adminA, 'POST', '/api/connectors/gdrive/connect');
  assert.equal(started.body.state, 'pending');
  assert.equal(started.body.userCode, 'WDJB-MJHT');
  const asB = await call(adminB, 'GET', '/api/connectors');
  const driveB = asB.body.connectors.find((c) => c.id === 'gdrive');
  assert.equal(driveB.state, 'disconnected');
  assert.equal(driveB.userCode, undefined);
  assert.equal(driveB.backup, null);
  // B cannot cancel A's pending sign-in either: their disconnect only touches their own (empty) Drive.
  await call(adminB, 'POST', '/api/connectors/gdrive/disconnect');
  assert.equal(backupDrive.state().state, 'pending');
  const asA = await call(adminA, 'GET', '/api/connectors');
  assert.equal(asA.body.connectors.find((c) => c.id === 'gdrive').userCode, 'WDJB-MJHT');

  // B starting their own connection does not take over A's.
  google.approve();
  await until(() => backupDrive.state().state === 'connected');
  const bOwn = await call(adminB, 'POST', '/api/connectors/gdrive/connect');
  assert.equal(bOwn.status, 200);
  assert.equal(bOwn.body.state, 'pending');
  google.approve();
  await until(() => fs.existsSync(path.join(dir, 'google-drive-users', `${adminB.id}.sealed`)));
  assert.equal(backupDrive.state().owner, adminA.id);
});

test('a pending sign-in without a recorded initiator keeps the old rule', async () => {
  const { accounts, backupDrive } = setup();
  await backupDrive.connect();
  assert.equal(backupDrive.state().state, 'pending');
  assert.equal(accounts.forUser(adminA).backup, true);
  assert.equal(accounts.forUser(adminB).backup, true);
  await backupDrive.disconnect();
});

test('the admin Backups routes withhold another administrator\'s pending code and refuse to take it over (#868)', async () => {
  const { backupDrive } = setup();
  const { createOffsiteRoutes } = require('./routes/offsite-backup.cjs');
  const service = {
    status: () => ({ enabled: true, google: backupDrive.state() }),
    connectGoogle: (owner) => backupDrive.connect(() => {}, { owner }),
    disconnectGoogle: () => backupDrive.disconnect(),
  };
  const routes = createOffsiteRoutes({ service, json: (res, status, body) => Object.assign(res, { status, body }) });
  const call = async (user, method, p) => { const res = {}; await routes({ method }, res, { path: p, authn: { user } }); return res; };

  const started = await call(adminA, 'POST', '/api/admin/offsite-backup/google/connect');
  assert.equal(started.status, 200);
  const asA = await call(adminA, 'GET', '/api/admin/offsite-backup');
  assert.equal(asA.body.google.state, 'pending');
  assert.equal(asA.body.google.userCode, 'WDJB-MJHT', 'the initiator keeps polling a full pending view');
  assert.match(asA.body.google.verificationUrl, /\/device$/);

  const asB = await call(adminB, 'GET', '/api/admin/offsite-backup');
  assert.equal(asB.body.google.state, 'pending');
  assert.equal(asB.body.google.userCode, undefined);
  assert.equal(asB.body.google.verificationUrl, undefined);
  assert.equal(asB.body.google.owner, undefined);
  assert.equal(asB.body.google.message, 'Another administrator is connecting Google Drive.');
  assert.ok(!JSON.stringify(asB.body).includes('WDJB'));

  const connectB = await call(adminB, 'POST', '/api/admin/offsite-backup/google/connect');
  assert.equal(connectB.status, 409);
  assert.ok(!JSON.stringify(connectB.body).includes('WDJB'));
  const cancelB = await call(adminB, 'POST', '/api/admin/offsite-backup/google/disconnect');
  assert.equal(cancelB.status, 409);
  assert.equal(backupDrive.state().state, 'pending', 'B could not cancel A\'s sign-in');

  const cancelA = await call(adminA, 'POST', '/api/admin/offsite-backup/google/disconnect');
  assert.equal(cancelA.status, 200);
  assert.equal(backupDrive.state().state, 'disconnected');
  // With nothing pending, either administrator may start one.
  assert.equal((await call(adminB, 'POST', '/api/admin/offsite-backup/google/connect')).status, 200);
  assert.equal((await call(adminB, 'GET', '/api/admin/offsite-backup')).body.google.userCode, 'WDJB-MJHT');
  assert.equal((await call(adminA, 'GET', '/api/admin/offsite-backup')).body.google.userCode, undefined);
  await backupDrive.disconnect();
});

test('two connects racing: the first administrator\'s pending sign-in is kept (#868)', async () => {
  const { backupDrive } = setup();
  const [a, b] = await Promise.all([backupDrive.connect(() => {}, { owner: adminA.id }), backupDrive.connect(() => {}, { owner: adminB.id })]);
  assert.equal(a.state, 'pending');
  assert.equal(b.state, 'pending');
  assert.equal(backupDrive.state().owner, adminA.id);
  assert.equal(b.owner, adminA.id, 'the second caller is handed the first one\'s sign-in');
  await backupDrive.disconnect();
});
