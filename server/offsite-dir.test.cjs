'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { createDirStore } = require('./offsite-dir.cjs');
const { createOffsiteBackup } = require('./offsite-backup.cjs');
const { checkDestination } = require('./offsite-service.cjs');

const temps = [];
const temp = (p = 'noevia-offdir-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temps.push(d); return d; };
test.after(() => { for (const d of temps) fs.rmSync(d, { recursive: true, force: true }); });

test('a folder store behaves like the S3 one: relative keys, prefix listing, null for missing', async () => {
  const store = createDirStore({ root: temp() });
  await store.put('config', Buffer.from('c'));
  await store.put('data/ab/abc123', Buffer.from('chunk'));
  await store.put('snapshots/20260918-x', Buffer.from('snap'));
  assert.deepEqual(await store.list(''), ['config', 'data/ab/abc123', 'snapshots/20260918-x']);
  assert.deepEqual(await store.list('data/'), ['data/ab/abc123']);
  assert.deepEqual(await store.get('data/ab/abc123'), Buffer.from('chunk'));
  assert.equal(await store.get('data/ab/missing'), null);
  await store.delete('data/ab/abc123');
  await store.delete('data/ab/abc123'); // idempotent, as S3 is
  assert.deepEqual(await store.list('data/'), []);
});

test('no key can climb out of the destination', async () => {
  const root = temp();
  const store = createDirStore({ root });
  for (const bad of ['../escape', 'data/../../escape', '/etc/passwd', '', '.hidden', 'data//x', 'data/.tmp-1', 'a/./b']) {
    await assert.rejects(() => store.put(bad, Buffer.from('x')), /unsafe backup key/, JSON.stringify(bad));
  }
  assert.deepEqual(fs.readdirSync(path.dirname(root)).filter((n) => n === 'escape'), []);
});

test('an interrupted write leaves nothing a sync could upload as real', async () => {
  // The sync runs on its own schedule. Half a chunk must never look like a chunk.
  const root = temp();
  const store = createDirStore({ root });
  const failing = createDirStore({
    root,
    fs: { ...fs, renameSync: () => { throw new Error('ENOSPC: no space left on device'); } },
  });
  await assert.rejects(() => failing.put('data/ab/half', Buffer.alloc(1024, 1)), /ENOSPC/);
  assert.equal(await store.get('data/ab/half'), null, 'the key does not exist');
  const leftovers = fs.readdirSync(path.join(root, 'data', 'ab'));
  assert.deepEqual(leftovers, [], 'and the temp file was cleaned up');
});

test('temp files are invisible to listing even if one is left behind', async () => {
  const root = temp();
  const store = createDirStore({ root });
  await store.put('data/ab/real', Buffer.from('r'));
  fs.writeFileSync(path.join(root, 'data', 'ab', '.tmp-deadbeef'), 'half');
  assert.deepEqual(await store.list(''), ['data/ab/real']);
});

test('objects are private to the owner', async () => {
  const root = temp();
  const store = createDirStore({ root });
  await store.put('data/ab/x', Buffer.from('x'));
  assert.equal(fs.statSync(path.join(root, 'data', 'ab', 'x')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(root, 'data')).mode & 0o777, 0o700);
});

test('a relative root is refused', () => {
  assert.throws(() => createDirStore({ root: 'relative/path' }), /absolute path/);
  assert.throws(() => createDirStore({ root: '' }), /absolute path/);
});

test('the whole encrypted engine runs against a folder, and restores what it backed up', async () => {
  // The real test: offsite-backup.cjs, unmodified, on the folder store.
  const source = temp('noevia-src-');
  fs.writeFileSync(path.join(source, 'diary.md'), '# a private entry\nnothing to see');
  fs.mkdirSync(path.join(source, 'nested'));
  fs.writeFileSync(path.join(source, 'nested', 'big.bin'), crypto.randomBytes(9 * 1024 * 1024));
  const dest = temp('noevia-dest-');
  const backup = createOffsiteBackup({ store: createDirStore({ root: dest }), key: crypto.randomBytes(32), paths: [source] });
  await backup.backup();

  // Nothing readable left the source: no plaintext anywhere in the destination.
  const all = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else all.push(p); } };
  walk(dest);
  assert.ok(all.length >= 3, 'config, chunks and a snapshot were written');
  for (const f of all) assert.equal(fs.readFileSync(f).includes('a private entry'), false, `${f} holds plaintext`);
  assert.equal(all.some((f) => /diary|nested|big/.test(path.basename(f))), false, 'names reveal nothing');

  // And it comes back intact, from nothing but the folder and the key.
  const [snapshot] = await backup.snapshots();
  assert.ok(snapshot, 'the snapshot is listed from the folder');
  const target = path.join(temp('noevia-restore-'), 'into');
  const result = await backup.restore(snapshot.id, target);
  assert.equal(result.files, 2);
  const found = (name) => { const hits = []; const w = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) w(p); else if (e.name === name) hits.push(p); } }; w(target); return hits[0]; };
  assert.equal(fs.readFileSync(found('diary.md'), 'utf8'), '# a private entry\nnothing to see');
  assert.deepEqual(fs.readFileSync(found('big.bin')), fs.readFileSync(path.join(source, 'nested', 'big.bin')));
});

test('the destination may not overlap what it backs up', () => {
  const data = temp('noevia-data-');
  fs.mkdirSync(path.join(data, 'inside'));
  assert.throws(() => checkDestination(path.join(data, 'inside'), [data]), /must not overlap/, 'inside a backed-up path would back itself up forever');
  assert.throws(() => checkDestination(path.dirname(data), [data]), /must not overlap/, 'containing one invites a restore on top of its source');
  assert.throws(() => checkDestination(data, [data]), /must not overlap/);
  const separate = temp('noevia-elsewhere-');
  assert.equal(checkDestination(separate, [data]), fs.realpathSync(separate));
  assert.throws(() => checkDestination('/does/not/exist', [data]), /does not exist/);
});
