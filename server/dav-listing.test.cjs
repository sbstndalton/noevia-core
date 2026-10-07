'use strict';

// DAV_PARSE_IMPL switch (#967): js is the default and unchanged; wasm fails closed.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const davListing = require('./dav-listing.cjs');
const davParseWasm = require('./dav-parse-wasm.cjs');
const storageClient = require('./storage-client.cjs');

const T = 'https://dav.example.test/remote.php/dav/files/alice/Notes/';
const DIR = '/remote.php/dav/files/alice/Notes';
const BODY = `<d:multistatus xmlns:d="DAV:"><d:response><d:href>${DIR}/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`
  + `<d:response><d:href>${DIR}/a&amp;b.md</d:href><d:propstat><d:prop><d:getcontentlength>42</d:getcontentlength></d:prop></d:propstat></d:response>`
  + `<d:response><d:href>${DIR}/Sub/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>`
  + `<d:response><d:href>${DIR}/../escape.md</d:href></d:response></d:multistatus>`;
const EXPECTED = [{ name: 'a&b.md', isDir: false, size: 42 }, { name: 'Sub', isDir: true, size: null }];

const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const haveWasm = fs.existsSync(wasmFile);
const required = process.env.DAV_PARSE_WASM_REQUIRED === '1';

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

async function withFetch(body, fn) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), method: init?.method }); return new Response(body, { status: 207 }); };
  try { return await fn(seen); } finally { globalThis.fetch = real; }
}

test('DAV_PARSE_IMPL defaults to js; unknown values mean js with a warning', (t) => {
  assert.equal(davListing.davParseImpl({}), 'js');
  assert.equal(davListing.davParseImpl({ DAV_PARSE_IMPL: '' }), 'js');
  assert.equal(davListing.davParseImpl({ DAV_PARSE_IMPL: 'js' }), 'js');
  assert.equal(davListing.davParseImpl({ DAV_PARSE_IMPL: ' WASM ' }), 'wasm');
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(davListing.davParseImpl({ DAV_PARSE_IMPL: 'rust' }), 'js');
  assert.equal(davListing.davParseImpl({ DAV_PARSE_IMPL: 'rust' }), 'js');
  assert.equal(warn.mock.callCount(), 1);
});

test('js path: the listing is what davList always produced', () => {
  assert.deepEqual(davListing.listingEntries(BODY, T, { impl: 'js' }), EXPECTED);
  assert.throws(() => davListing.listingEntries(BODY, 'not a url', { impl: 'js' }), TypeError);
});

test('js path never touches the WebAssembly module, even when it is missing', () => withEnv(
  { DAV_PARSE_IMPL: undefined, DAV_PARSE_WASM: path.join(os.tmpdir(), 'no-such-dav-parse.wasm') },
  () => withFetch(BODY, async (seen) => {
    const entries = await storageClient.listFiles({ kind: 'webdav', baseUrl: 'https://dav.example.test/remote.php/dav/files/alice' }, 'Notes');
    assert.deepEqual(entries.map((e) => [e.name, e.path, e.isDir, e.size, e.ext]), [['a&b.md', 'Notes/a&b.md', false, 42, '.md'], ['Sub', 'Notes/Sub', true, null, '']]);
    assert.equal(seen[0].method, 'PROPFIND');
  })));

test('wasm path fails closed when the module is missing', () => withEnv(
  { DAV_PARSE_IMPL: 'wasm', DAV_PARSE_WASM: path.join(os.tmpdir(), 'no-such-dav-parse.wasm') },
  async () => {
    assert.throws(() => davListing.listingEntries(BODY, T), (e) => e instanceof davParseWasm.DavParseError && e.reason === 'missing' && e.status === 502);
    await withFetch(BODY, async () => {
      await assert.rejects(storageClient.listFiles({ kind: 'webdav', baseUrl: 'https://dav.example.test/remote.php/dav/files/alice' }, 'Notes'), /dav-parse module not found/);
    });
  }));

test('wasm path fails closed on a tampered module', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dav-parse-'));
  const file = path.join(dir, 'dav-parse.wasm');
  // A valid, empty WebAssembly module: compiles, but is not the pinned bytes.
  fs.writeFileSync(file, Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  try {
    withEnv({ DAV_PARSE_IMPL: 'wasm', DAV_PARSE_WASM: file }, () => {
      assert.throws(() => davListing.listingEntries(BODY, T), (e) => e.reason === 'checksum');
    });
    // Even with the "right" checksum, a module without the ABI is refused.
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.throws(() => davParseWasm.load({ file, expectedSha256: sha }), (e) => e.reason === 'abi');
    fs.writeFileSync(file, Buffer.from('not wasm'));
    const sha2 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.throws(() => davParseWasm.load({ file, expectedSha256: sha2 }), (e) => e.reason === 'compile');
    assert.throws(() => davParseWasm.load({ file, expectedSha256: 'nope' }), (e) => e.reason === 'lock');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the lock pins a 40-char noevia-rs ref and both checksums', () => {
  const lock = davParseWasm.readLock();
  assert.match(lock.NOEVIA_RS_REF, /^[0-9a-f]{40}$/);
  assert.match(lock.NOEVIA_RS_SHA256, /^[0-9a-f]{64}$/);
  assert.match(lock.DAV_PARSE_WASM_SHA256, /^[0-9a-f]{64}$/);
});

test('wasm path: same listing, and refusals fail closed', { skip: !haveWasm && !required && 'dav-parse.wasm not built (set DAV_PARSE_WASM_REQUIRED=1 to require it)' }, () => withEnv(
  { DAV_PARSE_IMPL: 'wasm' },
  () => {
    assert.deepEqual(davListing.listingEntries(BODY, T), EXPECTED);
    assert.throws(() => davListing.listingEntries(BODY, 'not a url'), (e) => e instanceof davParseWasm.DavParseError && e.reason === 'invalid_target');
    assert.throws(() => davListing.listingEntries(BODY, `${T}\0`), (e) => e.reason === 'input');
    assert.throws(() => davListing.listingEntries('<response></response>'.repeat(100_001), T), (e) => e.reason === 'too_many_responses');
    assert.throws(() => davListing.listingEntries('x'.repeat(davParseWasm.MAX_INPUT_BYTES), T), (e) => e.reason === 'too_large');
    assert.throws(() => davParseWasm.listRecords(null, T), (e) => e.reason === 'input');
    // A refusal does not poison the module: the next listing still parses.
    assert.deepEqual(davListing.listingEntries(BODY, T), EXPECTED);
  }));
