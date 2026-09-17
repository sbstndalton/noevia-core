'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto');
const { createOffsiteBackup, retain, loadKey, seal, open, deriveKeys } = require('./offsite-backup.cjs');
const { createS3Store } = require('./offsite-s3.cjs');

const memoryStore = () => { const m = new Map(); return { m, put: async (k, v) => { m.set(k, Buffer.from(v)); }, get: async (k) => m.get(k) || null, list: async (p) => [...m.keys()].filter((k) => k.startsWith(p)), delete: async (k) => { m.delete(k); } }; };
function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-offsite-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data'); fs.mkdirSync(path.join(data, 'users', 'u1'), { recursive: true });
  fs.writeFileSync(path.join(data, 'auth.db'), 'SQLITE synthetic');
  fs.writeFileSync(path.join(data, 'auth.db-wal'), 'wal');
  fs.writeFileSync(path.join(data, 'users', 'u1', 'projects.json'), JSON.stringify({ secret: 'PLAINTEXT-MARKER' }));
  fs.writeFileSync(path.join(data, 'users', 'u1', 'empty.txt'), '');
  fs.symlinkSync('/etc', path.join(data, 'escape'));
  return { root, data };
}
const KEY = crypto.randomBytes(32);

test('backup is encrypted, deduplicated, and restores byte-identical into an empty directory', async (t) => {
  const { root, data } = tree(t); const store = memoryStore();
  let clock = Date.parse('2026-09-17T01:00:00Z');
  const b = createOffsiteBackup({ store, key: KEY, paths: [data], now: () => clock });
  const first = await b.backup();
  assert.equal(first.files, 3, 'WAL files and symlinks are skipped');
  for (const bytes of store.m.values()) assert.ok(!bytes.includes('PLAINTEXT-MARKER') && !bytes.includes('projects.json'), 'plaintext leaked');
  clock += 3600000;
  const second = await b.backup();
  assert.equal(second.uploadedChunks, 0, 'unchanged files upload nothing');
  const target = path.join(root, 'restore');
  await b.restore(first.id, target);
  assert.equal(fs.readFileSync(path.join(target, '0', 'users', 'u1', 'projects.json'), 'utf8'), JSON.stringify({ secret: 'PLAINTEXT-MARKER' }));
  assert.equal(fs.readFileSync(path.join(target, '0', 'users', 'u1', 'empty.txt'), 'utf8'), '');
  await assert.rejects(() => b.restore(first.id, target), /empty target/);
  assert.equal((await b.verify(root)).files, 3);
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.startsWith('noevia-restore-test-')), [], 'restore test cleans up');
});

test('wrong key, tampering and missing chunks fail closed', async (t) => {
  const { root, data } = tree(t); const store = memoryStore();
  const b = createOffsiteBackup({ store, key: KEY, paths: [data] });
  const snap = await b.backup();
  await assert.rejects(() => createOffsiteBackup({ store, key: crypto.randomBytes(32), paths: [data] }).backup(), /authentication/);
  const chunkKey = [...store.m.keys()].find((k) => k.startsWith('data/'));
  const original = store.m.get(chunkKey); const bad = Buffer.from(original); bad[20] ^= 1; store.m.set(chunkKey, bad);
  await assert.rejects(() => b.restore(snap.id, path.join(root, 'r1')), /authentication/);
  store.m.delete(chunkKey);
  await assert.rejects(() => b.restore(snap.id, path.join(root, 'r2')), /missing/);
  await assert.rejects(() => b.restore('../../x', path.join(root, 'r3')), /Invalid snapshot/);
});

test('a manifest cannot write outside the restore target', async (t) => {
  const { root } = tree(t); const store = memoryStore(); const keys = deriveKeys(KEY);
  const b = createOffsiteBackup({ store, key: KEY, paths: [] });
  await b.backup();
  store.m.set('snapshots/evil', seal(keys, Buffer.from(JSON.stringify({ format: 'noevia-offsite-v1', time: 1, files: [{ root: 0, path: '../../escaped', size: 0, sha256: '', chunks: [] }] }))));
  await assert.rejects(() => b.restore('evil', path.join(root, 'r')), /unsafe path/);
  assert.equal(fs.existsSync(path.join(root, 'escaped')), false);
});

test('retention keeps 7 daily, 4 weekly, 6 monthly and the newest; forget prunes unreferenced chunks', async (t) => {
  const day = 86400000, start = Date.parse('2026-01-01T12:00:00Z');
  const snaps = Array.from({ length: 400 }, (_, i) => ({ id: `s${i}`, time: start + i * day }));
  const keep = retain(snaps);
  assert.ok(keep.has('s399'));
  assert.ok(keep.size <= 17 && keep.size >= 12, `kept ${keep.size}`);
  for (let i = 393; i < 400; i++) assert.ok(keep.has(`s${i}`), 'last seven days kept');
  assert.ok(!keep.has('s100'));
  const { data } = tree(t); const store = memoryStore();
  let clock = start;
  const b = createOffsiteBackup({ store, key: KEY, paths: [data], now: () => clock });
  await b.backup();
  fs.writeFileSync(path.join(data, 'users', 'u1', 'projects.json'), 'changed');
  for (let i = 1; i <= 60; i++) { clock = start + i * day; await b.backup(); }
  const result = await b.forget();
  const remaining = await b.snapshots();
  assert.equal(remaining.length, result.kept);
  assert.ok(result.prunedChunks >= 1, 'the old projects.json chunk is pruned');
  for (const s of remaining) await b.restore(s.id, fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-offsite-r-')));
});

test('key file must be valid hex and outside backed-up paths', (t) => {
  const { root, data } = tree(t);
  const inside = path.join(data, 'key'); fs.writeFileSync(inside, 'a'.repeat(64));
  assert.throws(() => loadKey(inside, [data]), /outside/);
  const outside = path.join(root, 'key'); fs.writeFileSync(outside, 'nope');
  assert.throws(() => loadKey(outside, [data]), /64 hex/);
  fs.writeFileSync(outside, 'ab'.repeat(32) + '\n');
  assert.equal(loadKey(outside, [data]).length, 32);
  assert.throws(() => loadKey('', [data]), /OFFSITE_BACKUP_KEY_FILE/);
  assert.throws(() => open(deriveKeys(KEY), Buffer.alloc(5)), /truncated/);
});

test('S3 store signs requests, pages listings and never puts secrets in URLs', async (t) => {
  const objects = new Map(); const seen = [];
  const server = http.createServer(async (req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    const u = new URL(req.url, 'http://x');
    if (!/^AWS4-HMAC-SHA256 Credential=AKIDSYNTH\//.test(req.headers.authorization || '')) { res.writeHead(403); return res.end(); }
    if (u.searchParams.get('list-type') === '2') {
      const prefix = u.searchParams.get('prefix'); const all = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const startAt = Number(u.searchParams.get('continuation-token') || 0); const page = all.slice(startAt, startAt + 2);
      const more = startAt + 2 < all.length;
      res.writeHead(200); return res.end(`<ListBucketResult>${page.map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key></Contents>`).join('')}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${startAt + 2}</NextContinuationToken>` : ''}</ListBucketResult>`);
    }
    const key = decodeURIComponent(u.pathname).replace(/^\/bucket\//, '');
    if (req.method === 'PUT') { const c = []; for await (const x of req) c.push(x); objects.set(key, Buffer.concat(c)); res.writeHead(200); return res.end(); }
    if (req.method === 'GET') { if (!objects.has(key)) { res.writeHead(404); return res.end(); } res.writeHead(200); return res.end(objects.get(key)); }
    if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const store = createS3Store({ endpoint: `http://127.0.0.1:${server.address().port}`, bucket: 'bucket', accessKeyId: 'AKIDSYNTH', secretAccessKey: 'SECRET-SYNTH', prefix: 'noevia' });
  for (const k of ['data/aa/1', 'data/aa/2 & 3', 'data/bb/4', 'snapshots/x']) await store.put(k, Buffer.from(k));
  assert.deepEqual((await store.list('data/')).sort(), ['data/aa/1', 'data/aa/2 & 3', 'data/bb/4']);
  assert.equal(String(await store.get('data/aa/2 & 3')), 'data/aa/2 & 3');
  assert.equal(await store.get('missing'), null);
  await store.delete('data/bb/4');
  assert.deepEqual((await store.list('data/bb/')), []);
  assert.ok(seen.every((s) => !s.url.includes('SECRET') && !s.url.includes('AKID')));
  assert.throws(() => createS3Store({ endpoint: 'http://backup.example', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' }), /HTTPS/);
  assert.throws(() => createS3Store({ endpoint: 'https://key:secret@backup.example', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' }), /credentials/);
});
