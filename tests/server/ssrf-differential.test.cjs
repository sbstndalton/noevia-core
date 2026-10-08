'use strict';

// SSRF_IMPL (#795): tests/fixtures/ssrf.v1.json (byte-identical to noevia-rs
// crates/ssrf-policy/tests/fixtures/; CI compares them) holds what the JS does, printed by
// tools/gen-ssrf-fixtures.cjs from ssrf.cjs / public-fetch.cjs with the network stubbed. Here the
// same rows run through dav-parse.wasm's ssrf_policy and through the JS entry points with
// SSRF_IMPL=wasm: the Rust side must never accept what the JS refuses, and may refuse only for the
// documented extra strictness. Then the fail-closed paths. The WebAssembly half needs
// server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it unless
// DAV_PARSE_WASM_REQUIRED=1. Nothing here resolves a name or opens a socket.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const dns = require('node:dns');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const ssrf = require('../../server/ssrf.cjs');
const { createPublicFetch, createPublicOnlyLookup } = require('../../server/public-fetch.cjs');

const FILE = path.join(__dirname, '../fixtures/ssrf.v1.json');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const EXTRA = { check: ['trailing_dot', 'idn'], fetch: ['trailing_dot', 'idn', 'blocked_name'] };

/** Run `fn` with SSRF_IMPL (and optionally DAV_PARSE_WASM) set, restoring both afterwards. */
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

const GENERATOR = path.join(__dirname, '../../tools/gen-ssrf-fixtures.cjs');
test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, SSRF_IMPL: 'wasm' } });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('limits match the loader', () => {
  assert.equal(fixtures.limits.maxInputBytes, davParseWasm.MAX_SSRF_BYTES);
  assert.equal(fixtures.limits.maxAddresses, davParseWasm.MAX_SSRF_ADDRESSES);
  assert.ok(fixtures.addresses.length >= 900 && fixtures.urls.length >= 4000);
});

test('addresses: wasm agrees with isPrivateIp exactly, and so does isPrivateIp under SSRF_IMPL=wasm', { skip: skipWasm }, async () => {
  davParseWasm.reset();
  await withEnv({ SSRF_IMPL: 'wasm' }, () => {
    for (const { address, private: priv } of fixtures.addresses) {
      assert.equal(davParseWasm.ssrfAddressesPublic([address]), !priv, address);
      assert.equal(ssrf.isPrivateIp(address), priv, address);
    }
  });
  assert.equal(davParseWasm.ssrfAddressesPublic(['8.8.8.8', '2606:4700::1111']), true);
  assert.equal(davParseWasm.ssrfAddressesPublic(['8.8.8.8', '10.0.0.1']), false);
  assert.equal(davParseWasm.ssrfAddressesPublic([]), false);
});

test('urls: wasm never accepts what the JS refuses, accepts the same host, refuses only as documented', { skip: skipWasm }, () => {
  davParseWasm.reset();
  const extra = {};
  for (const row of fixtures.urls) {
    for (const mode of ['check', 'fetch']) {
      const js = row[mode];
      const got = davParseWasm.ssrfUrl(row.url, { mode, loopback: row.loopback });
      const where = `${mode} ${JSON.stringify(row.url)} loopback=${row.loopback}`;
      assert.notEqual(got.reason, 'host_mismatch', where);
      if (got.ok) {
        assert.equal(js.ok, true, `wasm accepts what the JS refuses: ${where}`);
        assert.deepEqual(got, { ok: true, kind: js.kind, host: js.host }, where);
      } else if (js.ok) {
        assert.ok(EXTRA[mode].includes(got.reason), `wasm refuses (${got.reason}) what the JS accepts: ${where}`);
        extra[`${mode}:${got.reason}`] = (extra[`${mode}:${got.reason}`] || 0) + 1;
      } else if (mode === 'fetch') {
        // ada rejects some non-special-scheme URLs that the url crate parses; both refuse.
        assert.ok(got.reason === js.reason || (js.reason === 'unparseable' && got.reason === 'scheme'), where);
      }
    }
  }
  assert.ok(extra['check:trailing_dot'] >= 1 && extra['fetch:blocked_name'] >= 1, JSON.stringify(extra));
});

test('isPublicUrl under SSRF_IMPL=wasm: same answers as the JS on every row, DNS stubbed', { skip: skipWasm }, async (t) => {
  davParseWasm.reset();
  const real = dns.promises.lookup;
  let answers = [];
  dns.promises.lookup = async () => answers;
  t.after(() => { dns.promises.lookup = real; });
  await withEnv({ SSRF_IMPL: 'wasm' }, async () => {
    for (const row of fixtures.urls) {
      if (row.loopback) continue;
      const js = row.check;
      const where = JSON.stringify(row.url);
      // A name resolving to public addresses only: accepted unless refused for extra strictness.
      answers = [{ address: '192.0.78.9', family: 4 }, { address: '2606:4700::1111', family: 6 }];
      const got = await ssrf.isPublicUrl(row.url);
      const strict = davParseWasm.ssrfUrl(row.url, { mode: 'check' });
      assert.equal(got, js.ok && strict.ok, where);
      if (js.ok && js.kind === 'name' && strict.ok) {
        // ...and refused as soon as one answer is private (rebinding at check time).
        answers = [{ address: '192.0.78.9', family: 4 }, { address: '169.254.169.254', family: 4 }];
        assert.equal(await ssrf.isPublicUrl(row.url), false, where);
        answers = [];
        assert.equal(await ssrf.isPublicUrl(row.url), false, where);
      }
    }
  });
});

test('publicFetch under SSRF_IMPL=wasm: refuses what the JS refuses with the same error type, connects to the same host', { skip: skipWasm }, async (t) => {
  davParseWasm.reset();
  const realHttp = http.request, realHttps = https.request;
  const NOT_CONNECTING = Symbol('not connecting');
  let connected = null;
  http.request = https.request = (opts) => { connected = opts.hostname; throw NOT_CONNECTING; };
  t.after(() => { http.request = realHttp; https.request = realHttps; });
  const failResolve = (_h, _o, cb) => cb(Object.assign(new Error('no dns here'), { code: 'ENOTFOUND' }));
  const fetchers = { false: createPublicFetch({ resolve: failResolve }), true: createPublicFetch({ resolve: failResolve, allowLoopbackLiteral: true }) };
  await withEnv({ SSRF_IMPL: 'wasm' }, async () => {
    for (const row of fixtures.urls) {
      const js = row.fetch;
      const where = JSON.stringify(row.url);
      connected = null;
      let err = null;
      try { await fetchers[row.loopback](row.url); } catch (e) { err = e; }
      if (err === NOT_CONNECTING) {
        assert.equal(js.ok, true, `wasm connects where the JS refuses: ${where}`);
        assert.equal(connected, js.host, where);
        continue;
      }
      if (js.ok) {
        assert.equal(err.code, 'EPRIVATEADDR', where);
        continue;
      }
      if (js.reason === 'unparseable') assert.equal(err.code === 'ERR_INVALID_URL' || err instanceof TypeError, true, where);
      else if (js.reason === 'private_address') assert.equal(err.code, 'EPRIVATEADDR', where);
      else assert.ok(err instanceof TypeError && !err.code, `${where}: ${err}`);
    }
  });
});

test('the connect-time lookup under SSRF_IMPL=wasm refuses any private answer and keeps addresses out of the message', { skip: skipWasm }, async () => {
  davParseWasm.reset();
  await withEnv({ SSRF_IMPL: 'wasm' }, async () => {
    const lookupWith = (answers) => new Promise((resolve) => {
      createPublicOnlyLookup({ resolve: (_h, _o, cb) => cb(null, answers) })('svc.example', { all: true }, (err, list) => resolve({ err, list }));
    });
    const ok = await lookupWith([{ address: '192.0.78.9', family: 4 }]);
    assert.equal(ok.err, null);
    assert.deepEqual(ok.list, [{ address: '192.0.78.9', family: 4 }]);
    for (const bad of ['10.0.0.1', '::ffff:10.0.0.1', '2002:c0a8:101::1', 'fe80::1%eth0', '100.64.0.1', '169.254.169.254']) {
      const r = await lookupWith([{ address: '192.0.78.9', family: 4 }, { address: bad, family: net.isIP(bad) || 4 }]);
      assert.equal(r.err?.code, 'EPRIVATEADDR', bad);
      assert.ok(!r.err.message.includes(bad), bad);
    }
  });
});

test('the loader checks the reply shape and Node\'s own parse of the host', () => {
  const R = davParseWasm.ssrfUrlReply;
  assert.deepEqual(R({ ok: true, kind: 'ip', host: '8.8.8.8' }, 'http://0x08080808/'), { ok: true, kind: 'ip', host: '8.8.8.8' });
  assert.deepEqual(R({ ok: true, kind: 'name', host: 'a.example' }, 'http://A.example:1/'), { ok: true, kind: 'name', host: 'a.example' });
  assert.deepEqual(R({ ok: false, reason: 'scheme' }, 'ftp://x/'), { ok: false, reason: 'scheme' });
  // A Rust host that is not Node's: refused, whatever it says.
  assert.deepEqual(R({ ok: true, kind: 'ip', host: '8.8.8.8' }, 'http://10.0.0.1/'), { ok: false, reason: 'host_mismatch' });
  assert.deepEqual(R({ ok: true, kind: 'name', host: '8.8.8.8' }, 'http://8.8.8.8/'), { ok: false, reason: 'host_mismatch' });
  assert.deepEqual(R({ ok: true, kind: 'ip', host: 'a.example' }, 'http://a.example/'), { ok: false, reason: 'host_mismatch' });
  assert.deepEqual(R({ ok: true, kind: 'ip', host: '8.8.8.8' }, 'not a url'), { ok: false, reason: 'unparseable' });
  for (const bad of [null, [], {}, { ok: true }, { ok: 'true', kind: 'ip', host: '8.8.8.8' }, { ok: true, kind: 'ipv4', host: '8.8.8.8' },
    { ok: true, kind: 'ip', host: '' }, { ok: true, kind: 'ip', host: '8.8.8.8', extra: 1 }, { ok: false, reason: 'nope' },
    { ok: false, reason: 'scheme', host: 'x' }, { ok: false }]) {
    assert.throws(() => R(bad, 'http://8.8.8.8/'), (e) => e instanceof davParseWasm.DavParseError && e.reason === 'reply', JSON.stringify(bad));
  }
  const A = davParseWasm.ssrfAddressesReply;
  assert.equal(A({ public: true }), true);
  for (const bad of [null, {}, { public: 1 }, { public: true, x: 1 }, [true]]) assert.throws(() => A(bad), (e) => e.reason === 'reply');
});

test('loader input checks: types, lone surrogates and the address cap', { skip: skipWasm }, () => {
  davParseWasm.reset();
  assert.throws(() => davParseWasm.ssrfUrl(1, { mode: 'check' }), (e) => e.reason === 'input');
  assert.throws(() => davParseWasm.ssrfUrl('http://x/', { mode: 'other' }), (e) => e.reason === 'input');
  assert.throws(() => davParseWasm.ssrfUrl('http://x/', { mode: 'fetch', loopback: 'yes' }), (e) => e.reason === 'input');
  assert.deepEqual(davParseWasm.ssrfUrl('http://8.8.8.8/\ud800', { mode: 'check' }), { ok: false, reason: 'unparseable' });
  assert.equal(davParseWasm.ssrfAddressesPublic(['8.8.8.8\ud800']), false);
  assert.throws(() => davParseWasm.ssrfAddressesPublic([1]), (e) => e.reason === 'input');
  assert.throws(() => davParseWasm.ssrfAddressesPublic(new Array(513).fill('8.8.8.8')), (e) => e.reason === 'too_large');
  assert.throws(() => davParseWasm.ssrfUrl(`http://x/${'a'.repeat(128 * 1024)}`, { mode: 'check' }), (e) => e.reason === 'too_large');
});

test('SSRF_IMPL=wasm fails closed without a usable module: private, not public, refused, startup stops', async () => {
  const missing = path.join(__dirname, 'no-such-dav-parse.wasm');
  davParseWasm.reset();
  try {
    await withEnv({ SSRF_IMPL: 'wasm', DAV_PARSE_WASM: missing }, async () => {
      assert.equal(ssrf.isPrivateIp('8.8.8.8'), true);
      assert.equal(await ssrf.isPublicUrl('http://8.8.8.8/'), false);
      const fetch = createPublicFetch({ resolve: () => { throw new Error('must not resolve'); } });
      await assert.rejects(fetch('http://8.8.8.8/'), (e) => e.code === 'EPRIVATEADDR' && !e.message.includes('8.8.8.8'));
      await assert.rejects(fetch('https://svc.example/'), (e) => e.code === 'EPRIVATEADDR');
      assert.throws(() => davParseWasm.verifyAtStartup({ SSRF_IMPL: 'wasm', DAV_PARSE_WASM: missing }), (e) => e.flags.includes('SSRF_IMPL') && e.reason === 'missing');
    });
  } finally { davParseWasm.reset(); }
});

test('publicFetch under SSRF_IMPL=wasm keeps the JS scheme and credentials checks even if the module would accept', { skip: skipWasm }, async (t) => {
  const davParse = ssrf.ssrfWasm();
  // A module that accepts everything: the JS checks must still refuse first.
  t.mock.method(davParse, 'ssrfUrl', () => ({ ok: true, kind: 'name', host: 'x' }));
  const fetch = createPublicFetch({ resolve: () => { throw new Error('must not resolve'); } });
  await withEnv({ SSRF_IMPL: 'wasm' }, async () => {
    await assert.rejects(fetch('ftp://8.8.8.8/'), (e) => e instanceof TypeError && /is not http\(s\)$/.test(e.message));
    await assert.rejects(fetch('http://u:p@8.8.8.8/'), (e) => e instanceof TypeError && /credentials in the URL$/.test(e.message));
    await assert.rejects(fetch('http://:p@8.8.8.8/'), (e) => e instanceof TypeError && /credentials/.test(e.message));
    // ...and the literal check too.
    await assert.rejects(fetch('http://10.0.0.1/'), (e) => e.code === 'EPRIVATEADDR');
  });
  assert.equal(davParse.ssrfUrl.mock.callCount(), 1);
});

test('SSRF_IMPL: js by default, wasm when asked, anything else is js with a warning', async (t) => {
  assert.equal(ssrf.ssrfImpl({}), 'js');
  assert.equal(ssrf.ssrfImpl({ SSRF_IMPL: '' }), 'js');
  assert.equal(ssrf.ssrfImpl({ SSRF_IMPL: ' WASM ' }), 'wasm');
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(ssrf.ssrfImpl({ SSRF_IMPL: 'rust' }), 'js');
  assert.equal(warn.mock.callCount(), 1);
  assert.ok(davParseWasm.IMPL_FLAGS.includes('SSRF_IMPL'));
  assert.deepEqual(davParseWasm.wasmFlags({ SSRF_IMPL: 'wasm' }), ['SSRF_IMPL']);
  // The default path never touches the module, even a missing one.
  await withEnv({ SSRF_IMPL: 'js', DAV_PARSE_WASM: path.join(__dirname, 'no-such.wasm') }, async () => {
    davParseWasm.reset();
    assert.equal(ssrf.isPrivateIp('8.8.8.8'), false);
    assert.equal(await ssrf.isPublicUrl('http://8.8.8.8/'), true);
  });
  davParseWasm.reset();
});
