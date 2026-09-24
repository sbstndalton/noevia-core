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
  await assert.rejects(() => d.mirror(store, { maxDelete: 1 }), /nothing was removed, to be safe/);
  assert.equal(google.state.deletes - deletes, 0, 'decided before deleting: never "delete some, then stop"');
});

// Each mirror test starts from a Drive with no noevia folders (every test makes its own store).
test.beforeEach(() => {
  if (!google) return;
  const folders = new Set([...google.files.values()].filter((f) => /^noevia-offsite/.test(f.name)).map((f) => f.id));
  for (const [id, f] of [...google.files.entries()]) if (folders.has(id) || f.parents?.some((p) => folders.has(p))) google.files.delete(id);
});
const connected = async (dir = temp(), extra = {}) => {
  const d = make(dir, extra);
  await d.connect(); google.approve();
  await until(() => d.state().state === 'connected');
  return d;
};
const folderFiles = (name) => {
  const folder = [...google.files.values()].find((f) => f.name === name);
  return folder ? [...google.files.values()].filter((f) => f.parents?.includes(folder.id)) : null;
};

test('mirror: a fresh store after a lost disk never prunes the old store on Drive', async () => {
  // The old store's copy: 600 objects plus its own config, in the folder a new connection adopts by name.
  const oldFolder = { id: 'old-folder', name: 'noevia-offsite', mimeType: 'application/vnd.google-apps.folder', parents: ['root'], body: Buffer.alloc(0), trashed: false };
  google.files.set(oldFolder.id, oldFolder);
  google.files.set('old-config', { id: 'old-config', name: 'config', parents: [oldFolder.id], body: Buffer.from('synthetic-old-config'), trashed: false });
  for (let i = 0; i < 600; i++) google.files.set(`old${i}`, { id: `old${i}`, name: `data/${String(i % 256).padStart(2, '0')}/old${i}`, parents: [oldFolder.id], body: Buffer.from('x'), trashed: false });
  const d = await connected();
  const store = await backupStore();
  const deletes = google.state.deletes;
  const r = await d.mirror(store);
  assert.equal(google.state.deletes - deletes, 0, 'zero deletes');
  assert.equal(folderFiles('noevia-offsite').length, 601, 'the old off-site copy is untouched');
  assert.equal(r.folder, 'noevia-offsite (2)');
  assert.equal(r.newFolder, true);
  assert.deepEqual(folderFiles('noevia-offsite (2)').map((f) => f.name).sort(), (await store.list('')).sort());
  // Later runs keep using the new folder and still never touch the old one.
  assert.equal((await d.mirror(store)).uploaded, 0);
  assert.equal(folderFiles('noevia-offsite').length, 601);
});

test('mirror: a quarter or more of Drive stale is refused with zero deletes and a clear error', async () => {
  const d = await connected();
  const store = await backupStore();
  const first = await d.mirror(store);
  const folder = [...google.files.values()].find((f) => f.name === first.folder && !f.trashed).id;
  for (let i = 0; i < 450; i++) google.files.set(`foreign${i}`, { id: `foreign${i}`, name: `data/ff/foreign${i}`, parents: [folder], body: Buffer.from('x'), trashed: false });
  const deletes = google.state.deletes;
  await assert.rejects(() => d.mirror(store), (e) => e.status === 502 && /450 of the 453 files on Drive are not in the local store; nothing was removed/.test(e.publicMessage));
  assert.equal(google.state.deletes - deletes, 0);
  await assert.rejects(() => d.mirror(store, { maxDelete: 10_000 }), /nothing was removed/);
  assert.equal(google.state.deletes - deletes, 0);
});

test('mirror: a folder stamped with another store id is skipped by its appProperties', async () => {
  const stamped = { id: 'stamped-folder', name: 'noevia-offsite', mimeType: 'application/vnd.google-apps.folder', parents: ['root'], body: Buffer.alloc(0), trashed: false };
  google.files.set(stamped.id, stamped);
  google.files.set('stamped-obj', { id: 'stamped-obj', name: 'snapshots/zz', parents: [stamped.id], body: Buffer.from('x'), trashed: false });
  // The fake does not echo appProperties, so add them to folder listings here.
  const wrapped = async (url, init) => {
    const r = await fetch(url, init);
    if (!String(url).includes('appProperties')) return r;
    const body = await r.json();
    for (const f of body.files || []) if (f.id === stamped.id) f.appProperties = { noeviaStoreId: 'another-store' };
    return new Response(JSON.stringify(body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };
  const d = await connected(temp(), { fetch: wrapped });
  const r = await d.mirror(await backupStore());
  assert.equal(r.folder, 'noevia-offsite (2)');
  assert.equal(google.files.get('stamped-obj').trashed, false);
});

test('mirror: overlapping runs are serialized, so nothing is uploaded twice', async () => {
  const d = await connected();
  const store = await backupStore();
  const uploads = google.state.uploads;
  const [a, b] = await Promise.all([d.mirror(store), d.mirror(store)]);
  assert.equal(a.uploaded, (await store.list('')).length);
  assert.equal(b.uploaded, 0, 'the second run waited and found everything copied');
  assert.equal(google.state.uploads - uploads, a.uploaded);
  // A failed run does not wedge the queue.
  await assert.rejects(() => d.mirror(createDirStore({ root: temp('noevia-wiped-') })), /looks empty/);
  assert.equal((await d.mirror(store)).uploaded, 0);
});

test('a broken token record is never re-saved with extra fields, and temp names are unique', async () => {
  const dir = temp();
  const file = path.join(dir, 'google-drive.sealed');
  const writes = [];
  const spyFs = { ...fs, writeFileSync: (p, ...rest) => { writes.push(p); return fs.writeFileSync(p, ...rest); } };
  const d = await connected(dir, { fs: spyFs });
  assert.equal(writes.length, 1);
  assert.match(writes[0], /google-drive\.sealed\.\d+\.[0-9a-f]{12}\.tmp$/);
  // Replace the backup key: the record can no longer be opened.
  const broken = make(dir, { backupKey: () => crypto.randomBytes(32), fs: spyFs });
  const before = fs.readFileSync(file, 'utf8');
  const store = await backupStore();
  await assert.rejects(() => broken.mirror(store), /not connected/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the unreadable record is left as it was');
  assert.equal(broken.state().state, 'error');
  assert.equal(writes.length, 1);
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
