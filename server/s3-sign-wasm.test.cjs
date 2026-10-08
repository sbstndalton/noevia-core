'use strict';

// S3_SIGN_IMPL: js is the default and unchanged; wasm signs through noevia-rs crates/s3-sign in
// dav-parse.wasm and must return the very same headers (keys, order, values) as the JS, fail
// closed with fixed messages, and never put the secret key in a reply, an error or a log line.
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

test('S3_SIGN_IMPL defaults to js; unknown values mean js with one warning', (t) => {
  assert.equal(sign.s3SignImpl({}), 'js');
  assert.equal(sign.s3SignImpl({ S3_SIGN_IMPL: '' }), 'js');
  assert.equal(sign.s3SignImpl({ S3_SIGN_IMPL: ' WASM ' }), 'wasm');
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(sign.s3SignImpl({ S3_SIGN_IMPL: 'rust' }), 'js');
  assert.equal(sign.s3SignImpl({ S3_SIGN_IMPL: 'rust' }), 'js');
  assert.equal(warn.mock.callCount(), 1);
  assert.ok(davParseWasm.IMPL_FLAGS.includes('S3_SIGN_IMPL'));
});

test('the default path is the JS code: it signs with no module at all', () => {
  withEnv({ S3_SIGN_IMPL: undefined, DAV_PARSE_WASM: MISSING }, () => {
    const h = sign.signS3Request('GET', new URL('https://s3.example.com/diary-bucket?list-type=2&max-keys=1'), '', 'AKIAIOSFODNN7EXAMPLE', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', { amzDate: DATE });
    assert.match(h.Authorization, /Signature=4560899e7ffad2d2164e3dbc99454334a44ba5a4a86bf34dadad3be59e0364ad$/);
    assert.equal(region.normalizeS3Region(' EU-West-1 '), 'eu-west-1');
  });
});

test('wasm fails closed when the module is missing or tampered: fixed message, the reason logged, no secret', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3-sign-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tampered = path.join(dir, 'dav-parse.wasm');
  fs.writeFileSync(tampered, Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  for (const [file, reason] of [[MISSING, 'missing'], [tampered, 'checksum']]) {
    withEnv({ S3_SIGN_IMPL: 'wasm', DAV_PARSE_WASM: file }, () => {
      assert.throws(() => sign.signS3Request('GET', new URL('https://s3.example.com/b'), '', 'AK', SECRET, { amzDate: DATE }),
        (e) => e.message === sign.SIGN_FAILURE && e.code === 's3_sign_failed' && e.reason === reason && e.status === 502 && !String(e.stack).includes(SECRET));
      assert.throws(() => region.normalizeS3Region('eu-west-1'), (e) => e.code === 's3_sign_failed' && e.reason === reason);
    });
  }
  const logged = warn.mock.calls.map((c) => c.arguments.join(' ')).join('\n');
  assert.match(logged, /s3-sign failed \(missing\)/);
  assert.ok(!logged.includes(SECRET));
});

test('startup refuses S3_SIGN_IMPL=wasm without a verified module', () => {
  assert.deepEqual(davParseWasm.wasmFlags({ S3_SIGN_IMPL: 'wasm' }), ['S3_SIGN_IMPL']);
  assert.throws(() => davParseWasm.verifyAtStartup({ S3_SIGN_IMPL: 'wasm', DAV_PARSE_WASM: MISSING }), /S3_SIGN_IMPL set to wasm, but dav-parse\.wasm failed verification \(missing\)/);
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
