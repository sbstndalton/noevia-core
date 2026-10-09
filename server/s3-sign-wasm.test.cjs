'use strict';

// S3 signing (#1071): noevia-rs crates/s3-sign in dav-parse.wasm signs, always, and must return the
// very same headers (keys, order, values) as the JS reference (tests/server/oracle/s3-sign.cjs),
// fail closed with fixed messages, and never put the secret key in a reply, an error or a log line.
// The case-by-case differential (fixtures, seeded random requests) is
// tests/server/s3-sign-differential.test.cjs, which also runs on the shipped runtime image.
// Synthetic credentials only (AKIA…/wJalr… is AWS's published documentation example).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('./dav-parse-wasm.cjs');
const sign = require('./s3-sign.cjs');
const region = require('./s3-region.cjs');
const oracle = require('../tests/server/oracle/s3-sign.cjs');

const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const required = process.env.DAV_PARSE_WASM_REQUIRED === '1';
const skipWasm = !fs.existsSync(wasmFile) && !required && 'dav-parse.wasm not built (set DAV_PARSE_WASM_REQUIRED=1 to require it)';
const MISSING = path.join(os.tmpdir(), 'no-such-s3-sign-dav-parse.wasm');
const SECRET = 'synthetic-SECRET-k3y/0123456789abcdefXYZ';
const DATE = '20130524T000000Z';

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  davParseWasm.reset();
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    davParseWasm.reset();
  }
}

const same = (a, b) => assert.deepEqual(Object.entries(a), Object.entries(b));

test('a retired S3_SIGN_IMPL=js is ignored: Rust still signs, and there is no JS switch', { skip: skipWasm }, () => {
  withEnv({ S3_SIGN_IMPL: 'js', DAV_PARSE_WASM: undefined }, () => {
    const h = sign.signS3Request('GET', new URL('https://s3.example.com/diary-bucket?list-type=2&max-keys=1'), '', 'AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', { amzDate: DATE });
    assert.match(h.Authorization, /Signature=4560899e7ffad2d2164e3dbc99454334a44ba5a4a86bf34dadad3be59e0364ad$/);
    assert.equal(region.normalizeS3Region(' EU-West-1 '), 'eu-west-1');
  });
  assert.equal(sign.s3SignImpl, undefined);
  for (const name of ['signS3RequestJs', 'signS3Parts', 'sha256Hex', 'uriEncode', 'canonicalUri']) assert.equal(sign[name], undefined, name);
  assert.equal(region.normalizeS3RegionJs, undefined);
  assert.ok(!davParseWasm.IMPL_FLAGS.includes('S3_SIGN_IMPL'));
  assert.ok(Object.hasOwn(davParseWasm.RETIRED_FLAGS, 'S3_SIGN_IMPL'));
});

test('the signer returns the very same headers (keys, order, values) as the JS reference', { skip: skipWasm }, () => {
  withEnv({ DAV_PARSE_WASM: undefined }, () => {
    const url = new URL('https://s3.example.com/diary-bucket/Cowork/notes%20(1).md?max-keys=1&list-type=2');
    for (const [method, payload, opts] of [['GET', '', { amzDate: DATE }], ['PUT', Buffer.from('month contents'), { amzDate: DATE, region: 'eu-west-1' }], ['GET', '', { amzDate: DATE, sessionToken: 'synthetic-token' }]]) {
      same(sign.signS3Request(method, url, payload, 'AKIAIOSFODNN7EXAMPLE', SECRET, opts), oracle.signS3RequestJs(method, url, payload, 'AKIAIOSFODNN7EXAMPLE', SECRET, opts));
    }
    for (const value of [' EU-West-1 ', '', undefined, 'bad region!', 'a'.repeat(33), 'us-east-1']) assert.equal(region.normalizeS3Region(value), oracle.normalizeS3RegionJs(value), String(value));
  });
});

test('wasm fails closed when the module is missing or tampered: fixed message, the reason logged, no secret', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-sign-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tampered = path.join(dir, 'dav-parse.wasm');
  fs.writeFileSync(tampered, Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  for (const [file, reason] of [[MISSING, 'missing'], [tampered, 'checksum']]) {
    withEnv({ DAV_PARSE_WASM: file }, () => {
      assert.throws(() => sign.signS3Request('GET', new URL('https://s3.example.com/b'), '', 'AK', SECRET, { amzDate: DATE }),
        (e) => e.message === sign.SIGN_FAILURE && e.code === 's3_sign_failed' && e.reason === reason && e.status === 502 && !String(e.stack).includes(SECRET));
      assert.throws(() => region.normalizeS3Region('eu-west-1'), (e) => e.code === 's3_sign_failed' && e.reason === reason);
    });
  }
  const logged = warn.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
  assert.match(logged, /s3-sign failed \(missing\)/);
  assert.ok(!logged.includes(SECRET));
});

test('refusals: fixed reasons, the secret in no error, the memory wiped after every call', { skip: skipWasm }, () => {
  withEnv({ DAV_PARSE_WASM: wasmFile }, () => {
    const url = new URL('https://s3.example.com/b');
    const cases = [
      [['GET', url, '', 'a\ud800', SECRET, { amzDate: DATE }], 'input'], // echoed text must be well-formed
      [['GET', url, '', 'AK', SECRET, { amzDate: '2013052😀T' }], 'input'], // the stamp splits a pair
      [['GET', url, '', 'AK', SECRET, { region: 5, amzDate: DATE }], 'input'],
      [['GET', 'https://s3.example.com/b', '', 'AK', SECRET, { amzDate: DATE }], 'input'],
      [['GET', { host: 's3.example.com', pathname: '/b/\ud800', searchParams: new URLSearchParams() }, '', 'AK', SECRET, { amzDate: DATE }], 'input'], // the JS throws URIError here
      [['GET', url, '', 'AK', SECRET, null], 'input'],
      [['GET', url, '', 'AK', SECRET, 'opts'], 'input'],
      [['GET', url, '', 'x'.repeat(davParseWasm.MAX_S3_FIELD_BYTES + 1), SECRET, { amzDate: DATE }], 'too_large'],
      [['PUT', url, Buffer.alloc(davParseWasm.MAX_S3_PAYLOAD_BYTES + 1), 'AK', SECRET, { amzDate: DATE }], 'too_large'],
    ];
    for (const [args, reason] of cases) {
      assert.throws(() => davParseWasm.s3Sign(...args), (e) => e instanceof davParseWasm.DavParseError && e.reason === reason && !String(e.stack).includes(SECRET) && !e.message.includes('x'.repeat(20)), reason);
    }
    // After a signing call the instance is gone (its memory zeroed first); nothing lingers.
    davParseWasm.s3Sign('GET', url, '', 'AK', SECRET, { amzDate: DATE });
    assert.equal(davParseWasm.memoryBytes(), 0);
  });
});

test('the reply-shape check rejects a module that answers oddly', { skip: skipWasm }, (t) => {
  withEnv({ DAV_PARSE_WASM: wasmFile }, () => {
    // A well-formed reply for one request is rejected for another (host/date/credential differ).
    const realParse = JSON.parse;
    const forged = { host: 'evil.example', 'x-amz-content-sha256': '0'.repeat(64), 'x-amz-date': DATE, Authorization: `AWS4-HMAC-SHA256 Credential=AK/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${'0'.repeat(64)}` };
    t.mock.method(JSON, 'parse', (text, ...rest) => (String(text).includes('"Authorization"') ? forged : realParse(text, ...rest)));
    assert.throws(() => davParseWasm.s3Sign('GET', new URL('https://s3.example.com/b'), '', 'AK', SECRET, { amzDate: DATE }), (e) => e.reason === 'reply');
    forged.host = 's3.example.com';
    forged.extra = 'x';
    assert.throws(() => davParseWasm.s3Sign('GET', new URL('https://s3.example.com/b'), '', 'AK', SECRET, { amzDate: DATE }), (e) => e.reason === 'reply');
    delete forged.extra;
    assert.deepEqual(Object.keys(davParseWasm.s3Sign('GET', new URL('https://s3.example.com/b'), '', 'AK', SECRET, { amzDate: DATE })), ['host', 'x-amz-content-sha256', 'x-amz-date', 'Authorization']);
  });
});
