'use strict';

// Shared fixtures for the SigV4 signer: tests/fixtures/s3-sign.v1.json (byte-identical to
// noevia-rs crates/s3-sign/tests/fixtures/; CI compares them) replayed through dav-parse.wasm's
// s3_sign and s3_region, and the JS reference (server/s3-sign.cjs signS3RequestJs) run on the same
// inputs here, so Node's own URL, TextEncoder and String#trim on this runtime are part of the
// comparison. Then seeded random requests with real URLs. Synthetic credentials only. The
// WebAssembly half needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it
// unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const sign = require('../../server/s3-sign.cjs');
const region = require('../../server/s3-region.cjs');

const FIXTURE = path.join(__dirname, '../fixtures/s3-sign.v1.json');
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
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

/** The URL-like object the JS reads, from a fixture case. */
const urlOf = (c) => ({ host: c.host, pathname: c.pathname, searchParams: new URLSearchParams(c.query) });
const same = (a, b) => assert.deepEqual(Object.entries(a), Object.entries(b));

const GENERATOR = path.join(__dirname, '../../tools/gen-s3-sign-fixtures.cjs');
// The shipped runtime image has no tools/ (CI mounts only tests/ there).

test('the shared fixture table is what the JS reference produces today', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { maxBuffer: 16 * 1024 * 1024 });
  assert.ok(out.equals(fs.readFileSync(FIXTURE)), 'regenerate tests/fixtures/s3-sign.v1.json (and noevia-rs\'s copy)');
});

test('differential: every fixture case signs identically through the module (keys, order, values)', { skip: skipWasm }, () => {
  const f = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  withEnv({ DAV_PARSE_WASM: wasmFile }, () => {
    let n = 0;
    for (const c of f.cases) {
      const args = [c.method, urlOf(c), Buffer.from(c.payloadHex, 'hex'), c.accessKey, Buffer.from(c.secretHex, 'hex').toString('utf8'), { region: c.region, sessionToken: c.sessionToken, amzDate: c.amzDate }];
      if (c.refused) {
        assert.throws(() => davParseWasm.s3Sign(...args), (e) => e instanceof davParseWasm.DavParseError && e.reason === 'input', c.name);
        continue;
      }
      const wasm = davParseWasm.s3Sign(...args);
      same(wasm, sign.signS3RequestJs(...args));
      same(wasm, Object.fromEntries(c.expect.headers));
      n++;
    }
    assert.ok(n >= 170, `${n}`);
    for (const r of f.regions) assert.equal(davParseWasm.s3Region(r.input), r.expect, JSON.stringify(r.input));
  });
});

test('differential: seeded random requests, real URLs, lone surrogates where the JS hashes them', { skip: skipWasm }, () => {
  let seed = 0x53;
  const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const segs = ['a', 'notes (1).md', "it's", '😀', '100%', '%41', 'a b', '~', ''];
  withEnv({ DAV_PARSE_WASM: wasmFile }, () => {
    for (let i = 0; i < 300; i++) {
      const url = new URL(`${pick(['https://s3.example.com', 'http://127.0.0.1:9000', 'https://S3.Example.org:443'])}/${pick(segs)}/${pick(segs)}?${pick(['', 'list-type=2&prefix=a%2F', 'a=2&a=1', 'x=%F0%9F%98%80&y=%ED%A0%80'])}`);
      const payload = pick(['', 'body', 'a\ud800b', Buffer.from([0, 255, 1]), undefined, null]);
      const args = [pick(['GET', 'PUT', 'get', 'X\udc00']), url, payload, pick(['AK', 'AKIAIOSFODNN7EXAMPLE', '"q"\\']), pick([SECRET, 'é\ud800', '']),
        { region: pick([undefined, '', 'eu-west-2']), sessionToken: pick([undefined, '', ' tok\ufeff']), amzDate: pick([undefined, DATE, '20260101T120000Z']) }];
      if (args[5].amzDate === undefined) args[5].amzDate = DATE; // the clock must not differ between the two calls
      same(davParseWasm.s3Sign(...args), sign.signS3RequestJs(...args));
    }
    // The flag routes signS3Request itself; normalizeS3Region likewise.
    withEnv({ S3_SIGN_IMPL: 'wasm', DAV_PARSE_WASM: wasmFile }, () => {
      const url = new URL('https://s3.example.com/diary-bucket?list-type=2&max-keys=1');
      same(sign.signS3Request('GET', url, '', 'AK', SECRET, { amzDate: DATE }), sign.signS3RequestJs('GET', url, '', 'AK', SECRET, { amzDate: DATE }));
      assert.equal(region.normalizeS3Region(' EU-West-1 '), 'eu-west-1');
      assert.equal(region.normalizeS3Region(null), 'us-east-1');
      // Without amzDate both stamp the clock: the format is the JS one.
      assert.match(sign.signS3Request('GET', url, '', 'AK', SECRET)['x-amz-date'], /^\d{8}T\d{6}Z$/);
    });
  });
});
