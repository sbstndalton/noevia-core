'use strict';

// The S3 page scan (#976) and the storage path rules (#978), both always Rust since #1071 (the path
// rules were STORAGE_PATH_IMPL, default js): they run inside dav-parse.wasm and fail closed with
// fixed public messages; a leftover STORAGE_PATH_IMPL never brings the JS rules back.
// Synthetic buckets, keys and paths only.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('./dav-parse-wasm.cjs');
const s3Listing = require('./s3-listing.cjs');
const storagePath = require('./storage-path.cjs');
const storageClient = require('./storage-client.cjs');
const uploads = require('./uploads.cjs');

const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const haveWasm = fs.existsSync(wasmFile);
const required = process.env.DAV_PARSE_WASM_REQUIRED === '1';
const skipWasm = !haveWasm && !required && 'dav-parse.wasm not built (set DAV_PARSE_WASM_REQUIRED=1 to require it)';
const MISSING = path.join(os.tmpdir(), 'no-such-storage-dav-parse.wasm');

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  davParseWasm.reset();
  const restore = () => { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } davParseWasm.reset(); };
  let out;
  try { out = fn(); } catch (err) { restore(); throw err; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
}

const s3Conn = { kind: 's3', baseUrl: 'http://s3.invalid', bucket: 'b', username: 'ak', secret: 'sk', corpusRoot: '/Synthetic/' };
const s3Xml = (inner, token) => `<?xml version="1.0"?><ListBucketResult>${inner}<IsTruncated>${token ? 'true' : 'false'}</IsTruncated>${token ? `<NextContinuationToken>${token}</NextContinuationToken>` : ''}</ListBucketResult>`;
const PAGE1 = s3Xml('<CommonPrefixes><Prefix>Synthetic/Docs/R&amp;D/</Prefix></CommonPrefixes><Contents><Key>Synthetic/Docs/a&amp;b.md</Key><Size>42</Size></Contents>'
  + '<Contents><Key>Synthetic/Docs/deep/x.md</Key><Size>1</Size></Contents><Contents><Key>Synthetic/Docs/huge.bin</Key><Size>99999999999999999999</Size></Contents>', 'tok&amp;1');
const PAGE2 = s3Xml('<Contents><Key>Synthetic/Docs/two.txt</Key><Size>x</Size></Contents>', 'tok&1'); // repeats the token: stop

async function withS3(fn) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => { const u = new URL(String(url)); seen.push(u.searchParams.get('continuation-token')); return new Response(seen.length === 1 ? PAGE1 : PAGE2, { status: 200 }); };
  try { return await fn(seen); } finally { globalThis.fetch = real; }
}
const EXPECTED_S3 = [['a&b.md', 'Docs/a&b.md', false, 42, '.md'], ['huge.bin', 'Docs/huge.bin', false, 1e20, '.bin'], ['R&D', 'Docs/R&D', true, null, ''], ['two.txt', 'Docs/two.txt', false, null, '.txt']];
const shape = (list) => list.map((e) => [e.name, e.path, e.isDir, e.size, e.ext]);

test('STORAGE_PATH_IMPL is retired (#1071): no selector and no JS rules are left in production', () => {
  assert.deepEqual(Object.keys(storagePath).sort(), ['PUBLIC_FAILURE', 'cleanRoot', 'joinRoot', 'safeRelativePath']);
  for (const gone of ['storagePathImpl', 'safeRelativePathJs', 'cleanRootJs', 'joinRootJs', 'isPlainFilenameJs', 'isPlainFilename']) assert.equal(storagePath[gone], undefined, gone);
  assert.equal(davParseWasm.RETIRED_FLAGS.STORAGE_PATH_IMPL, 'wasm');
  assert.equal(s3Listing.s3ParseImpl, undefined);
  assert.equal(s3Listing.s3PageRecordsJs, undefined);
});

test('the S3 listing and the path rules are Rust even with the retired S3_PARSE_IMPL=js and STORAGE_PATH_IMPL=js', { skip: skipWasm }, () => withEnv(
  { S3_PARSE_IMPL: 'js', STORAGE_PATH_IMPL: 'js', DAV_PARSE_WASM: undefined },
  () => withS3(async (seen) => {
    assert.deepEqual(shape(await storageClient.listFiles(s3Conn, 'Docs')), EXPECTED_S3);
    assert.deepEqual(seen, [null, 'tok&1'], 'the repeated token stops the walk');
    assert.equal(storageClient.safeRelativePath(' a\\b//c '), 'a/b/c');
    assert.doesNotThrow(() => uploads.validate('a.md', Buffer.from('x')));
    // Only the module refuses a lone surrogate (the JS rules answered 'a\ud800'): Rust decided.
    assert.throws(() => storageClient.safeRelativePath('a\ud800'), (e) => e.code === 'storage_path_failed' && e.reason === 'input');
  })));

test('the S3 listing fails closed with a fixed public message when the module is missing', (t) => withEnv(
  { DAV_PARSE_WASM: MISSING },
  () => withS3(async () => {
    const warn = t.mock.method(console, 'warn', () => {});
    // The whole listing fails closed (the path rule, also Rust since #1071, is the first to stop it)...
    const whole = await storageClient.listFiles(s3Conn, 'Docs').then(() => null, (e) => e);
    assert.ok(whole && whole.status === 500 && whole.code === 'storage_path_failed' && whole.message === storagePath.PUBLIC_FAILURE, String(whole?.message));
    // ...and the page scan itself answers with its own fixed message.
    const err = (() => { try { s3Listing.s3Page('<ListBucketResult/>', ''); } catch (e) { return e; } return null; })();
    assert.equal(err?.message, 'storage listing could not be read');
    assert.equal(err.status, 502);
    assert.equal(err.code, 's3_parse_failed');
    assert.doesNotMatch(err.message, /no-such|sha256|wasm|missing/);
    assert.ok(warn.mock.calls.some((c) => /s3-list-parse failed \(missing\): .*no-such-storage-dav-parse\.wasm/.test(String(c.arguments[0]))));
  })));

for (const leftover of [undefined, 'js', 'wasm']) {
  test(`the path rules fail closed with a fixed public message when the module is missing (STORAGE_PATH_IMPL=${leftover})`, (t) => withEnv(
    { STORAGE_PATH_IMPL: leftover, DAV_PARSE_WASM: MISSING },
    () => {
      const warn = t.mock.method(console, 'warn', () => {});
      for (const call of [() => storageClient.safeRelativePath('a/b'), () => storagePath.cleanRoot('/r/'), () => storagePath.joinRoot('r', 'a'),
        // Refusals too: no JS rule answers '' for a traversal instead of the module.
        () => storageClient.safeRelativePath('../x'), () => storagePath.safeRelativePath('')]) {
        assert.throws(call, (e) => e.message === storagePath.PUBLIC_FAILURE && e.status === 500 && e.code === 'storage_path_failed' && e.reason === 'missing');
      }
      assert.match(String(warn.mock.calls[0].arguments[0]), /storage-path safeRelativePath failed \(missing\)/);
      // An empty name is refused before the module is needed, exactly as the JS rule refused it.
      assert.throws(() => uploads.validate('', Buffer.from('x')), /plain filename/);
      // Every listing, read and write stops before any request leaves.
      const conn = { kind: 'webdav', baseUrl: 'https://storage.invalid/dav', corpusRoot: 'r' };
      const real = globalThis.fetch;
      globalThis.fetch = async () => assert.fail('no request may leave');
      return Promise.all([() => storageClient.listFiles(conn, 'a'), () => storageClient.readTextFile(conn, 'a.md'), () => storageClient.writeFile(conn, 'a.md', Buffer.from('x'))]
        .map((call) => assert.rejects(call, (e) => e.code === 'storage_path_failed' && e.status === 500)))
        .finally(() => { globalThis.fetch = real; });
    }));
}

test('wasm: the S3 listing and the path rules match the JS, and refusals fail closed', { skip: skipWasm }, (t) => withEnv(
  { STORAGE_PATH_IMPL: undefined },
  () => withS3(async (seen) => {
    assert.deepEqual(shape(await storageClient.listFiles(s3Conn, 'Docs')), EXPECTED_S3);
    assert.deepEqual(seen, [null, 'tok&1']);
    assert.equal(storageClient.safeRelativePath(' a\\b//c '), 'a/b/c');
    for (const bad of ['../x', '/abs', 'a/../../b', 'a\0b', '', null]) assert.equal(storageClient.safeRelativePath(bad), '');
    assert.equal(storagePath.joinRoot('//root//', 'a/b'), 'root/a/b');
    assert.equal(storagePath.joinRoot('', undefined), '');
    assert.equal(storagePath.cleanRoot(undefined), '');
    assert.doesNotThrow(() => uploads.validate('a.md', Buffer.from('x')));
    for (const bad of ['..', 'a/b', 'a\\b', 'a\u0001', 'x'.repeat(201), 42]) assert.throws(() => uploads.validate(bad, Buffer.from('x')), /plain filename/);
    assert.doesNotThrow(() => uploads.validate('a\ud800.md', Buffer.from('x')), 'a lone surrogate keeps the JS answer');

    const warn = t.mock.method(console, 'warn', () => {});
    // Input that cannot cross unchanged, or past the caps, is refused (never answered differently).
    assert.throws(() => storageClient.safeRelativePath('a\ud800'), (e) => e.reason === 'input' && e.status === 400 && e.message === storagePath.PUBLIC_FAILURE);
    assert.throws(() => storagePath.joinRoot('r', 7), (e) => e.reason === 'input' && e.status === 400);
    assert.throws(() => storagePath.cleanRoot('\udfff'), (e) => e.reason === 'input' && e.status === 400 && e.code === 'storage_path_failed');
    assert.throws(() => storageClient.safeRelativePath('a'.repeat(64 * 1024 + 1)), (e) => e.reason === 'too_large' && e.status === 400 && e.message === storagePath.PUBLIC_FAILURE);
    assert.throws(() => s3Listing.s3Page('', 'p'.repeat(64 * 1024 + 1)), (e) => e.reason === 'prefix_too_long' && e.status === 502 && e.message === s3Listing.PUBLIC_FAILURE);
    assert.throws(() => s3Listing.s3Page('<Contents></Contents>'.repeat(200_001), ''), (e) => e.reason === 'too_many_entries');
    assert.throws(() => s3Listing.s3Page('', 'a\udc00'), (e) => e.reason === 'input');
    assert.throws(() => davParseWasm.s3ListPage(null, ''), (e) => e.reason === 'input');
    assert.throws(() => davParseWasm.storagePath('nope', 'a'), (e) => e.reason === 'input');
    warn.mock.restore();
    // A refusal does not poison the module: the next calls still work, DAV included.
    assert.equal(storageClient.safeRelativePath('ok/again'), 'ok/again');
    assert.deepEqual(davParseWasm.listRecords('<d:response><d:href>/d/a</d:href></d:response>', 'https://h.example.test/d/'), [{ name: 'a', isDir: false, size: null }]);
  })));
