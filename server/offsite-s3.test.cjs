'use strict';
// Synthetic in-memory S3-compatible backend: no network, no real credentials or Diary data.
const test = require('node:test'), assert = require('node:assert/strict');
const { createS3Store } = require('./offsite-s3.cjs');

function escapeXml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/** A minimal fake bucket that speaks just enough SigV4-path-style S3 to exercise put/get/list/delete. */
function fakeBucket({ bucket = 'test-bucket' } = {}) {
  const objects = new Map();
  const fetchImpl = async (target, init) => {
    const url = new URL(typeof target === 'string' ? target : target.toString());
    const parts = url.pathname.replace(/^\/+/, '').split('/');
    const reqBucket = decodeURIComponent(parts[0] || '');
    assert.equal(reqBucket, bucket);
    const key = parts.slice(1).map(decodeURIComponent).join('/');
    if (init.method === 'PUT') {
      objects.set(key, Buffer.from(init.body || Buffer.alloc(0)));
      return { ok: true, status: 200 };
    }
    if (init.method === 'DELETE') {
      objects.delete(key);
      return { ok: true, status: 204 };
    }
    if (init.method === 'GET' && url.searchParams.get('list-type') === '2') {
      const prefix = url.searchParams.get('prefix') || '';
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
      const xml = `<ListBucketResult>${keys.map((k) => `<Contents><Key>${escapeXml(k)}</Key></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`;
      return { ok: true, status: 200, text: async () => xml };
    }
    if (init.method === 'GET') {
      if (!objects.has(key)) return { ok: false, status: 404 };
      const bytes = objects.get(key);
      return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    }
    throw Error(`unexpected method ${init.method}`);
  };
  return { objects, fetchImpl };
}

function store(prefix, extra = {}) {
  const { objects, fetchImpl } = fakeBucket();
  const s = createS3Store({
    endpoint: 'https://s3.example.test', bucket: 'test-bucket', accessKeyId: 'AKIATEST', secretAccessKey: 'secret',
    prefix, fetchImpl, ...extra,
  });
  return { s, objects };
}

for (const prefix of ['/', '//', '']) {
  test(`list() finds what was written when OFFSITE_BACKUP_S3_PREFIX is ${JSON.stringify(prefix)}`, async () => {
    const { s, objects } = store(prefix);
    await s.put('data/chunk1', Buffer.from('hello'));
    await s.put('snapshots/2026-09-24.json', Buffer.from('{}'));
    // Objects land at the bare key, not nested under an empty-string prefix segment.
    assert.deepEqual([...objects.keys()].sort(), ['data/chunk1', 'snapshots/2026-09-24.json']);
    assert.deepEqual(await s.list('data/'), ['data/chunk1']);
    assert.deepEqual(await s.list('snapshots/'), ['snapshots/2026-09-24.json']);
    assert.equal((await s.get('data/chunk1')).toString(), 'hello');
  });
}

test('a real prefix round-trips and namespaces the bucket', async () => {
  const { s, objects } = store('a/b/');
  await s.put('data/chunk1', Buffer.from('x'));
  assert.deepEqual([...objects.keys()], ['a/b/data/chunk1']);
  assert.deepEqual(await s.list('data/'), ['data/chunk1']);
  assert.equal((await s.get('data/chunk1')).toString(), 'x');
  await s.delete('data/chunk1');
  assert.deepEqual(await s.list('data/'), []);
});

test('leading/trailing slashes on the configured prefix are normalised the same as a clean one', async () => {
  const messy = store('/a/b/');
  const clean = store('a/b');
  await messy.s.put('data/chunk1', Buffer.from('x'));
  await clean.s.put('data/chunk1', Buffer.from('x'));
  assert.deepEqual([...messy.objects.keys()], [...clean.objects.keys()]);
});

test('an internal doubled slash like "a//b/" is collapsed the same in object URLs and listings', async () => {
  const messy = store('a//b/');
  const clean = store('a/b');
  await messy.s.put('data/chunk1', Buffer.from('x'));
  await clean.s.put('data/chunk1', Buffer.from('x'));
  // Before the fix, the object landed at the collapsed key (matching clean)
  // but list() sent the raw doubled-slash prefix, so it never found what put()
  // had just written -- an empty listing meant dedup and retention saw nothing.
  assert.deepEqual([...messy.objects.keys()], [...clean.objects.keys()]);
  assert.deepEqual(await messy.s.list('data/'), ['data/chunk1']);
});

test('get() returns null for a missing key and delete() is idempotent', async () => {
  const { s } = store('noevia-backup');
  assert.equal(await s.get('data/missing'), null);
  await s.delete('data/missing'); // does not throw on 404
});

test('put/get/list/delete surface a clear error when the destination refuses', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  const s = createS3Store({ endpoint: 'https://s3.example.test', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's', prefix: 'p', fetchImpl });
  await assert.rejects(() => s.put('k', Buffer.alloc(0)), /refused a write/);
  await assert.rejects(() => s.get('k'), /refused a read/);
  await assert.rejects(() => s.list('k'), /refused a listing/);
});
