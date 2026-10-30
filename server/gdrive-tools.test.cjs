'use strict';
// Google Drive as a chat connector: the seven tools, whose Drive each account reaches, and the
// per-tool allow/ask/block policy. Against the fake Google server, never a real Drive.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { createDriveAccounts } = require('./gdrive-broker.cjs');
const { startBrokerFixture } = require('./gdrive-broker-fixture.cjs');
const { createDriveTools } = require('./gdrive-tools.cjs');
const { createToolPolicy } = require('./tool-policy.cjs');
const { quote } = require('./gdrive-files.cjs');
const { startFakeGoogle } = require('../qa/fake-google.cjs');

const temps = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-gtools-')); temps.push(d); return d; };
let google;
test.before(async () => { google = await startFakeGoogle({ autoApprove: true }); });
test.after(async () => { await google.close(); for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

const until = async (fn) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timed out'); };
const member = { id: 'u-member', role: 'member' }, other = { id: 'u-other', role: 'member' };

// The Rust front is the token authority (noevia-rs tests/gdrive.rs covers it); here a stand-in broker
// signs accounts in against the fake Google, so these tests are about the tools.
function setup() {
  const dir = temp();
  const fixture = startBrokerFixture({ google, dataDir: dir });
  const accounts = createDriveAccounts({ broker: fixture.broker, dataDir: dir, apiBase: `${google.base}/drive`, uploadBase: `${google.base}/upload` });
  return { dir, fixture, accounts, tools: createDriveTools({ accounts, cap: 200 }) };
}
async function connect(fixture, user) { await fixture.connect(user); }

test('the tools create, find, read, update and trash files in the caller\'s own Drive only', async () => {
  const { fixture, accounts, tools } = setup();
  assert.match(await tools.execute(member, 'drive_list_recent', {}), /not connected/);
  assert.equal(tools.connected(member), false);
  await connect(fixture, member);
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
  const { fixture, accounts, tools } = setup();
  await connect(fixture, member);
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

test('policy: reads default to allow, writes to ask, and the table is read here on every call', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('u1'),('u2');");
  const policy = createToolPolicy({ db });
  // The Rust front is the writer (noevia-rs tests/gdrive.rs); this stands in for one of its upserts.
  const put = (user, tool, mode, at = 1) => db.prepare('INSERT INTO tool_policies VALUES(?,?,?,?) ON CONFLICT(user_id, tool) DO UPDATE SET mode=excluded.mode, updated_at=excluded.updated_at').run(user, tool, mode, at);
  assert.equal(policy.mode('u1', 'read_a', false), 'allow');
  assert.equal(policy.mode('u1', 'write_a', true), 'ask');
  assert.equal(typeof policy.set, 'undefined', 'Node has no writer left');
  put('u1', 'read_a', 'ask');
  assert.equal(policy.mode('u1', 'read_a', false), 'ask', 'a write by another process is seen at once');
  assert.equal(policy.mode('u2', 'read_a', false), 'allow', 'one account\'s choice never applies to another');
  assert.equal(typeof policy.fingerprint, 'undefined', 'the permitted view is the front\'s now: nothing here watches the table');
  put('u1', 'read_a', 'block', 2);
  assert.equal(policy.mode('u1', 'read_a', false), 'block');
  put('u1', 'read_a', 'ask', 1);
  assert.equal(policy.mode('u1', 'read_a', false), 'ask');
  put('u1', 'write_a', 'block');
  assert.equal(policy.mode('u1', 'write_a', true), 'block');
  // A write stored as allow before it became a write asks; an unknown stored mode blocks.
  db.pragma('ignore_check_constraints = ON');
  put('u1', 'read_b', 'allow');
  assert.equal(policy.mode('u1', 'read_b', true), 'ask');
  assert.equal(policy.mode(null, 'read_a', false), 'allow');
});

test('deleting an account is the front\'s: this process has no removeUser, and the front\'s forget shows through the state file', async () => {
  const { fixture, accounts } = setup();
  await connect(fixture, member);
  assert.equal(accounts.removeUser, undefined, 'the front revokes and forgets the connection itself (#2190, #2191 round 9)');
  assert.equal(accounts.connected(member), true);
  await fixture.broker.gdriveForget('u-member'); // what the front does when it deletes the account
  assert.equal(accounts.connected(member), false, 'the broker\'s state file shows through, nothing here forgets it');
  assert.equal(fixture.refresh.has('u-member'), false);
});
