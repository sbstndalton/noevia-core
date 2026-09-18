'use strict';
// Google Drive as a chat connector: the seven tools, whose Drive each account reaches, and the
// per-tool allow/ask/block policy. Against the fake Google server, never a real Drive.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { createGoogleDrive } = require('./gdrive.cjs');
const { createDriveAccounts } = require('./drive-accounts.cjs');
const { createDriveTools } = require('./gdrive-tools.cjs');
const { createToolPolicy } = require('./tool-policy.cjs');
const { quote } = require('./gdrive-files.cjs');
const { startFakeGoogle } = require('../qa/fake-google.cjs');

const temps = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-gtools-')); temps.push(d); return d; };
let google;
test.before(async () => { google = await startFakeGoogle({ autoApprove: true }); });
test.after(async () => { await google.close(); for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

const key = crypto.randomBytes(32);
const makeDrive = ({ tokenFile, backupKey }) => createGoogleDrive({
  clientId: 'fake-client', clientSecret: 'fake-secret', tokenFile, backupKey,
  oauthBase: google.base, apiBase: `${google.base}/drive`, uploadBase: `${google.base}/upload`,
});
const until = async (fn) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timed out'); };
const admin = { id: 'u-admin', role: 'admin' }, member = { id: 'u-member', role: 'member' }, other = { id: 'u-other', role: 'member' };

function setup() {
  const dir = temp();
  const backupDrive = makeDrive({ tokenFile: path.join(dir, 'google-drive.sealed'), backupKey: () => key });
  const accounts = createDriveAccounts({ backupDrive, dataDir: dir, userKey: () => key, makeDrive });
  return { dir, backupDrive, accounts, tools: createDriveTools({ accounts, cap: 200 }) };
}
async function connect(accounts, user) {
  const { drive } = accounts.forUser(user);
  await drive.connect(() => {}, { owner: user.id });
  await until(() => drive.state().state === 'connected');
}

test('an administrator fills the backup slot; members get their own sealed connection', async () => {
  const { dir, accounts, backupDrive } = setup();
  assert.equal(accounts.forUser(admin).backup, true);
  assert.equal(accounts.forUser(member).backup, false);
  await connect(accounts, admin);
  assert.equal(backupDrive.state().owner, 'u-admin');
  // A second administrator does not inherit the first one's Drive.
  assert.equal(accounts.forUser({ id: 'u-admin2', role: 'admin' }).backup, false);
  await connect(accounts, member);
  assert.ok(fs.existsSync(path.join(dir, 'google-drive-users', 'u-member.sealed')));
  assert.equal(accounts.forUser(other).drive.state().state, 'disconnected');
  assert.throws(() => accounts.forUser(null), /Sign in/);
});

test('a backup connection saved before owners were recorded belongs to any administrator', async () => {
  const { accounts, backupDrive } = setup();
  await backupDrive.connect();
  await until(() => backupDrive.state().state === 'connected');
  assert.equal(backupDrive.state().owner, null);
  assert.equal(accounts.forUser(admin).backup, true);
  assert.equal(accounts.forUser(member).backup, false);
});

test('the tools create, find, read, update and trash files in the caller\'s own Drive only', async () => {
  const { accounts, tools } = setup();
  assert.match(await tools.execute(member, 'drive_list_recent', {}), /not connected/);
  assert.equal(tools.connected(member), false);
  await connect(accounts, member);
  assert.equal(tools.connected(member), true);

  const created = await tools.execute(member, 'drive_create_file', { name: 'plan.md', content: 'Kiwix ZIM goes to the array', mimeType: 'text/markdown' });
  const id = /id ([\w-]+)/.exec(created)[1];
  assert.match(created, /^Created plan\.md/);
  assert.match(await tools.execute(member, 'drive_search_files', { query: 'plan' }), new RegExp(`plan\\.md \\(id ${id}\\)`));
  assert.match(await tools.execute(member, 'drive_search_files', { query: "it's missing" }), /No matching files/);
  assert.match(await tools.execute(member, 'drive_read_file', { fileId: id }), /Kiwix ZIM goes to the array/);
  assert.match(await tools.execute(member, 'drive_get_metadata', { fileId: id }), /text\/markdown[\s\S]*Link: https:\/\/drive\.google\.com/);
  assert.match(await tools.execute(member, 'drive_update_file', { fileId: id, content: 'Moved to disk3' }), /^Updated plan\.md/);
  assert.match(await tools.execute(member, 'drive_read_file', { fileId: id }), /Moved to disk3/);
  assert.match(await tools.execute(member, 'drive_list_recent', { limit: 5 }), /plan\.md/);

  // Another account, with no connection of its own, cannot reach it.
  assert.match(await tools.execute(other, 'drive_read_file', { fileId: id }), /not connected/);

  assert.match(await tools.execute(member, 'drive_trash_file', { fileId: id }), /Moved plan\.md to the Drive trash/);
  assert.match(await tools.execute(member, 'drive_list_recent', {}), /No files yet/);
});

test('bad arguments and binary files come back as readable errors, never a throw', async () => {
  const { accounts, tools } = setup();
  await connect(accounts, member);
  assert.match(await tools.execute(member, 'drive_read_file', {}), /^ERROR: fileId is required/);
  assert.match(await tools.execute(member, 'drive_read_file', { fileId: '../etc' }), /^ERROR: fileId is not a Drive file id/);
  assert.match(await tools.execute(member, 'drive_read_file', { fileId: 'nope' }), /^ERROR: Google Drive has no such file/);
  const bin = /id ([\w-]+)/.exec(await tools.execute(member, 'drive_create_file', { name: 'x.bin', content: 'x', mimeType: 'image/png' }))[1];
  // An unknown type is stored as plain text rather than trusted.
  assert.match(await tools.execute(member, 'drive_get_metadata', { fileId: bin }), /text\/plain/);
  const long = /id ([\w-]+)/.exec(await tools.execute(member, 'drive_create_file', { name: 'long.txt', content: 'a'.repeat(1000) }))[1];
  assert.match(await tools.execute(member, 'drive_read_file', { fileId: long }), /\[truncated\]$/);
});

test('search quotes the query, so a stray quote cannot end the Drive literal', () => {
  assert.equal(quote("it's"), "'it\\'s'");
  assert.equal(quote('a\\b'), "'a\\\\b'");
});

test('policy: reads default to allow, writes to ask, and writes can never be allowed', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('u1'),('u2');");
  const audits = [];
  const policy = createToolPolicy({ db, audit: (...a) => audits.push(a) });
  const isWrite = (t) => !t.startsWith('read');
  assert.equal(policy.mode('u1', 'read_a', false), 'allow');
  assert.equal(policy.mode('u1', 'write_a', true), 'ask');
  policy.set('u1', ['read_a'], 'ask', isWrite);
  assert.equal(policy.mode('u1', 'read_a', false), 'ask');
  assert.equal(policy.mode('u2', 'read_a', false), 'allow', 'one account\'s choice never applies to another');
  assert.throws(() => policy.set('u1', ['read_a', 'write_a'], 'allow', isWrite), /Writes always ask first/);
  assert.equal(policy.mode('u1', 'read_a', false), 'ask', 'a refused batch changes nothing');
  policy.set('u1', ['write_a'], 'block', isWrite);
  assert.equal(policy.mode('u1', 'write_a', true), 'block');
  // A read stored as allow that is later reclassified as a write asks.
  policy.set('u1', ['read_b'], 'allow', isWrite);
  assert.equal(policy.mode('u1', 'read_b', true), 'ask');
  assert.throws(() => policy.set('u1', ['read_a'], 'sometimes', isWrite), /Choose allow, ask or block/);
  assert.throws(() => policy.set('u1', [], 'ask', isWrite), /Choose a tool/);
  assert.equal(policy.mode(null, 'read_a', false), 'allow');
  assert.deepEqual(audits.at(-1), ['tool.policy', 'u1', { tools: ['read_b'], mode: 'allow' }]);
});

test('deleting an account revokes its Drive connection', async () => {
  const { dir, accounts } = setup();
  await connect(accounts, member);
  const before = google.state.revoked.length;
  await accounts.removeUser('u-member');
  assert.equal(google.state.revoked.length, before + 1);
  assert.equal(fs.existsSync(path.join(dir, 'google-drive-users', 'u-member.sealed')), false);
});
