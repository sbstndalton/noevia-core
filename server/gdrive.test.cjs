'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createGoogleDrive } = require('./gdrive.cjs');
const { createDirStore } = require('./offsite-dir.cjs');
const { createOffsiteBackup } = require('./offsite-backup.cjs');
const { startFakeGoogle } = require('../qa/fake-google.cjs');

const temps = [];
const temp = (p = 'noevia-gdrive-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };
let google;
test.before(async () => { google = await startFakeGoogle(); });
test.after(async () => { await google.close(); for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

const key = crypto.randomBytes(32);
const make = (dir, extra = {}) => createGoogleDrive({
  clientId: 'fake-client', clientSecret: 'fake-secret', tokenFile: path.join(dir, 'google-drive.sealed'), backupKey: () => key,
  oauthBase: google.base, apiBase: `${google.base}/drive`, uploadBase: `${google.base}/upload`, ...extra,
});
const until = async (fn) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timed out'); };
async function backupStore() {
  const src = temp('noevia-gsrc-');
  fs.writeFileSync(path.join(src, 'diary.md'), '# a private entry');
  const store = createDirStore({ root: temp('noevia-gstore-') });
  await createOffsiteBackup({ store, key, paths: [src] }).backup();
  return store;
}

test('without a registered client the page says so and nothing is attempted', async () => {
  const d = createGoogleDrive({ tokenFile: path.join(temp(), 't'), backupKey: () => key });
  assert.equal(d.state().state, 'not-configured');
  await assert.rejects(() => d.connect(), /no Google sign-in registered/);
});

test('device sign-in: a code to show, background polling, a sealed token, the account email', async () => {
  const dir = temp();
  let connected = false;
  const d = make(dir);
  const started = await d.connect(() => { connected = true; });
  assert.equal(started.state, 'pending');
  assert.equal(started.userCode, 'WDJB-MJHT');
  assert.match(started.verificationUrl, /\/device$/);
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(d.state().state, 'pending', 'still waiting while Google says authorization_pending');
  google.approve();
  await until(() => connected);
  const s = d.state();
  assert.equal(s.state, 'connected');
  assert.equal(s.email, 'backup-owner@example.com');
  const onDisk = fs.readFileSync(path.join(dir, 'google-drive.sealed'), 'utf8');
  for (const t of google.state.refresh) assert.equal(onDisk.includes(t), false, 'the refresh token is sealed on disk');
  assert.equal(fs.statSync(path.join(dir, 'google-drive.sealed')).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(s).includes('refresh'), false, 'no token in the state the page sees');
  // Another backup key cannot open it: the page asks to connect again rather than crashing.
  assert.equal(make(dir, { backupKey: () => crypto.randomBytes(32) }).state().state, 'error');
});

test('declining on Google’s page ends the attempt with a plain message', async () => {
  const d = make(temp());
  await d.connect();
  google.deny();
  await until(() => d.state().state === 'disconnected');
  assert.match(d.state().message, /declined/);
});

test('mirror: uploads the encrypted store, is idempotent, follows retention, refuses a wiped store', async () => {
  const d = make(temp());
  await d.connect(); google.approve();
  await until(() => d.state().state === 'connected');
  const store = await backupStore();
  const keys = await store.list('');
  const first = await d.mirror(store);
  assert.equal(first.uploaded, keys.length);
  const names = () => [...google.files.values()].filter((f) => f.parents?.[0] !== 'root').map((f) => f.name).sort();
  assert.deepEqual(names(), keys);
  for (const f of google.files.values()) assert.equal(f.body.includes('a private entry'), false, 'no plaintext reaches Google');
  const folders = [...google.files.values()].filter((f) => f.name === 'noevia-offsite');
  assert.equal(folders.length, 1);
  // Same bytes back out.
  const onDrive = [...google.files.values()].find((f) => f.name === 'config');
  assert.deepEqual(onDrive.body, await store.get('config'));

  assert.equal((await d.mirror(store)).uploaded, 0, 'a second run uploads nothing');
  assert.equal([...google.files.values()].filter((f) => f.name === 'noevia-offsite').length, 1, 'and reuses the folder');

  const chunk = keys.find((k) => k.startsWith('data/'));
  await store.delete(chunk);
  assert.equal((await d.mirror(store)).removed, 1);
  assert.equal(names().includes(chunk), false, 'retention is followed on Drive');

  const before = names();
  const empty = createDirStore({ root: temp('noevia-wiped-') });
  await assert.rejects(() => d.mirror(empty), /looks empty/);
  assert.deepEqual(names(), before, 'a wiped local store never wipes Drive');
});

test('mirror: a different file under an existing name is corruption, not something to overwrite', async () => {
  const d = make(temp());
  await d.connect(); google.approve();
  await until(() => d.state().state === 'connected');
  const store = await backupStore();
  await d.mirror(store);
  const snap = (await store.list('snapshots/'))[0];
  fs.appendFileSync(path.join(store.root, ...snap.split('/')), 'CORRUPT');
  const uploads = google.state.uploads;
  await assert.rejects(() => d.mirror(store), /differs/);
  assert.equal(google.state.uploads, uploads);
});

test('mirror: over the delete cap it stops rather than emptying Drive', async () => {
  const d = make(temp());
  await d.connect(); google.approve();
  await until(() => d.state().state === 'connected');
  const store = await backupStore();
  await d.mirror(store);
  const folder = [...google.files.values()].find((f) => f.name === 'noevia-offsite').id;
  for (let i = 0; i < 3; i++) google.files.set(`extra${i}`, { id: `extra${i}`, name: `data/zz/extra${i}`, parents: [folder], body: Buffer.from('x'), trashed: false });
  const deletes = google.state.deletes;
  await assert.rejects(() => d.mirror(store, { maxDelete: 1 }), /stopped to be safe/);
  assert.equal(google.state.deletes - deletes, 1);
});

test('disconnect revokes the token at Google and forgets it', async () => {
  const dir = temp();
  const d = make(dir);
  await d.connect(); google.approve();
  await until(() => d.state().state === 'connected');
  const revoked = google.state.revoked.length;
  assert.equal((await d.disconnect()).state, 'disconnected');
  assert.equal(google.state.revoked.length, revoked + 1);
  assert.equal(fs.existsSync(path.join(dir, 'google-drive.sealed')), false);
});
