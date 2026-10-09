'use strict';

// Policy leaves (POLICY_LEAVES_IMPL, retired in #1071): tests/fixtures/policy-leaves.v1.json (byte-identical to noevia-rs
// crates/policy-leaves/tests/fixtures/; CI compares them) holds what auth-tokens.cjs and
// tool-policy.cjs return, printed by tools/gen-policy-leaves-fixtures.cjs from the JS references
// (tests/server/oracle/auth-tokens.cjs and tool-policy.cjs; synthetic tokens only). Here every row runs through dav-parse.wasm's auth_tokens and
// tool_policy: auth and set must agree exactly; mode must agree wherever the stored mode is one
// the table allows, and be `block` (never weaker) otherwise. Then a real database against the JS
// reference, seeded live JS-vs-wasm tokens, and the fail-closed paths: mode() blocks, set() writes
// nothing, startup stops, and no error ever carries a token. The WebAssembly half needs
// server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createRequire } = require('node:module');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const auth = require('../../server/auth-tokens.cjs');
const { createToolPolicy } = require('../../server/tool-policy.cjs');
const { resolveAuthTokensJs } = require('./oracle/auth-tokens.cjs');
const { createToolPolicyJs } = require('./oracle/tool-policy.cjs');

const FILE = path.join(__dirname, '../fixtures/policy-leaves.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-policy-leaves-fixtures.cjs');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const str = (u) => String.fromCharCode(...u);
const STRENGTH = { allow: 0, ask: 1, block: 2 };

function fakeDb(stored) {
  const writes = [];
  return {
    writes,
    exec() {},
    prepare: () => ({ get: () => (stored == null ? undefined : { mode: stored }), all: () => [], run: (...a) => writes.push(a) }),
    transaction: (fn) => fn,
  };
}

async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env } });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('auth rows: the same tokens, flag and warnings through the Rust port', { skip: skipWasm }, async () => {
  for (const row of fixtures.auth) {
    const env = Object.fromEntries(Object.entries(row.env).map(([k, v]) => [k, str(v)]));
    const want = { diaryToken: str(row.want.diaryToken), uiAuthToken: str(row.want.uiAuthToken), legacyCompat: row.want.legacyCompat, warnings: row.want.warnings };
    assert.deepStrictEqual(resolveAuthTokensJs(env), want);
    assert.deepStrictEqual(auth.resolveAuthTokens(env), want);
    // A secret call: the instance is dropped (and its memory wiped) every time.
    assert.equal(davParseWasm.memoryBytes(), 0);
  }
  assert.deepStrictEqual(auth.resolveAuthTokens({ DIARY_AUTH_TOKEN: ' d ', UI_AUTH_TOKEN: 'u' }), resolveAuthTokensJs({ DIARY_AUTH_TOKEN: ' d ', UI_AUTH_TOKEN: 'u' }));
  // The coercion stays in the JS: non-string fakes behave as String(v || '').
  for (const env of [{ DIARY_AUTH_TOKEN: 0 }, { DIARY_AUTH_TOKEN: 42, UI_AUTH_TOKEN: null, LEGACY_AUTH_COMPAT: true }, {}]) {
    assert.deepStrictEqual(auth.resolveAuthTokens(env), resolveAuthTokensJs(env));
  }
});

test('seeded live tokens agree', { skip: skipWasm }, () => {
  const pool = [' ', '\t', '\n', ' ', '﻿', ' ', '　', '\u0085', '​', 'a', 'Z', '9', '-', '\ud800', '\udc00', '😀', 'é'];
  let seed = 99;
  const rnd = (m) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % m; };
  const s = () => Array.from({ length: rnd(12) }, () => pool[rnd(pool.length)]).join('');
  for (let i = 0; i < 300; i++) {
    const env = { DIARY_AUTH_TOKEN: s(), UI_AUTH_TOKEN: s(), LEGACY_AUTH_COMPAT: rnd(2) ? 'true' : s() };
    assert.deepStrictEqual(auth.resolveAuthTokens(env), resolveAuthTokensJs(env), `iteration ${i}`);
  }
});

test('mode rows: never weaker than the JS; exact for every stored mode the table allows', { skip: skipWasm }, () => {
  let exact = 0, stronger = 0;
  for (const row of fixtures.mode) {
    const stored = row.stored === null ? null : str(row.stored);
    const policy = createToolPolicy({ db: fakeDb(stored) });
    const got = policy.mode('user-1', 'tool', row.isWrite);
    assert.equal(createToolPolicyJs({ db: fakeDb(stored) }).mode('user-1', 'tool', row.isWrite), row.want);
    if (stored === null || stored === '' || Object.hasOwn(STRENGTH, stored)) { assert.equal(got, row.want); exact++; } else {
      assert.equal(got, 'block');
      if (Object.hasOwn(STRENGTH, row.want)) assert.ok(STRENGTH[got] >= STRENGTH[row.want]);
      stronger++;
    }
  }
  assert.ok(exact >= 10 && stronger >= 16, `${exact} ${stronger}`);
  // No user: the row is never read, as in the JS.
  assert.equal(createToolPolicy({ db: fakeDb('block') }).mode('', 'tool', false), 'allow');
});

test('set rows: the same refusal (400, public message) or the same write', { skip: skipWasm }, () => {
  for (const row of fixtures.set) {
    const tools = row.writes.map((_, i) => `t${i}`);
    const isWrite = (t) => row.writes[Number(t.slice(1))];
    const value = row.value === null ? undefined : str(row.value);
    const db = fakeDb(null);
    const policy = createToolPolicy({ db });
    let got = 'ok';
    try { policy.set('user-1', tools, value, isWrite); } catch (e) {
      assert.equal(e.status, 400);
      assert.equal(e.publicMessage, e.message);
      got = e.message;
    }
    assert.equal(got, row.want, JSON.stringify(row));
    assert.equal(db.writes.length, got === 'ok' ? tools.length : 0);
  }
});

// The server's own dependency, wherever the workspace put this test. The image build's test stage
// has no native modules installed; the Server tests job does and runs this.
const serverRequire = createRequire(path.join(__dirname, '../../server/index.cjs'));
const noSqlite = (() => { try { serverRequire.resolve('better-sqlite3'); return false; } catch { return 'better-sqlite3 not installed here'; } })();

test('a real table behaves the same through Rust as through the JS reference', { skip: skipWasm || noSqlite }, () => {
  const Database = serverRequire('better-sqlite3');
  for (const [impl, make] of [['oracle', createToolPolicyJs], ['rust', createToolPolicy]]) {
    const db = new Database(':memory:');
    db.exec("CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('u1'),('u2');");
    const policy = make({ db });
    const isWrite = (t) => !t.startsWith('read');
    assert.equal(policy.mode('u1', 'read_a', false), 'allow');
    assert.equal(policy.mode('u1', 'write_a', true), 'ask');
    policy.set('u1', ['read_a'], 'ask', isWrite);
    assert.equal(policy.mode('u1', 'read_a', false), 'ask');
    assert.equal(policy.mode('u2', 'read_a', false), 'allow', impl);
    assert.throws(() => policy.set('u1', ['read_a', 'write_a'], 'allow', isWrite), /Writes always ask first/);
    assert.equal(policy.mode('u1', 'read_a', false), 'ask');
    policy.set('u1', ['write_a'], 'block', isWrite);
    assert.equal(policy.mode('u1', 'write_a', true), 'block');
    policy.set('u1', ['read_b'], 'allow', isWrite);
    assert.equal(policy.mode('u1', 'read_b', true), 'ask');
    assert.throws(() => policy.set('u1', ['read_a'], 'sometimes', isWrite), /Choose allow, ask or block/);
    assert.throws(() => policy.set('u1', [], 'ask', isWrite), /Choose a tool/);
    assert.deepEqual(policy.stored('u1'), { read_a: 'ask', write_a: 'block', read_b: 'allow' });
  }
});

test('fails closed: mode() blocks, set() writes nothing, auth stops without echoing a token', (t) => {
  t.mock.method(console, 'warn', () => {});
  const broken = () => { throw new davParseWasm.DavParseError('dav-parse module failed', 'trap'); };
  const db = fakeDb('allow');
  const policy = createToolPolicy({ db, wasmLoader: () => ({ toolPolicyMode: broken, toolPolicySet: broken }) });
  assert.equal(policy.mode('u1', 'read_a', false), 'block');
  assert.throws(() => policy.set('u1', ['read_a'], 'ask', () => false), (e) => e.status === 500 && !e.publicMessage);
  assert.equal(db.writes.length, 0);
  // A reply of the wrong shape is a fault too.
  const odd = createToolPolicy({ db: fakeDb(null), wasmLoader: () => ({ toolPolicyMode: () => { throw new davParseWasm.DavParseError('x', 'reply'); } }) });
  assert.equal(odd.mode('u1', 'x', false), 'block');

  const token = 'synthetic-secret-token-7f3a';
  const leaky = { authTokens: () => { throw Object.assign(new Error(`bad ${token}`), { reason: `trap ${token}` }); } };
  assert.throws(() => auth.resolveAuthTokens({ DIARY_AUTH_TOKEN: token }, { wasm: leaky }), (e) => {
    assert.ok(!e.message.includes(token) && !/7f3a|synthetic|secret/.test(e.message), e.message);
    assert.equal(e.message, 'Auth tokens could not be checked by the Rust port (unexpected).');
    assert.match(e.message, /Auth tokens could not be checked/);
    return true;
  });
});

test('loader: refusals and shape checks never carry a token', { skip: skipWasm }, () => {
  const token = 'tok-'.repeat(20000); // over MAX_POLICY_UNITS
  assert.throws(() => davParseWasm.authTokens(token, '', undefined), (e) => e.reason === 'too_large' && !e.message.includes('tok-'));
  assert.throws(() => davParseWasm.authTokens(1, '', undefined), (e) => e.reason === 'input');
  assert.throws(() => davParseWasm.toolPolicyMode('allow', 1), (e) => e.reason === 'input');
  assert.throws(() => davParseWasm.toolPolicySet('ask', [1]), (e) => e.reason === 'input');
  assert.equal(davParseWasm.toolPolicyMode(undefined, false), 'allow');
  assert.equal(davParseWasm.toolPolicyMode('mystery', false), 'block');
  assert.deepEqual(davParseWasm.toolPolicySet('allow', [false, true]), { ok: false, reason: 'write' });
  assert.deepEqual(davParseWasm.toolPolicySet('block', [true]), { ok: true, mode: 'block' });
});

test('POLICY_LEAVES_IMPL is retired: no switch, no JS path, a missing module fails closed whatever the environment says', async () => {
  assert.equal(auth.policyLeavesImpl, undefined);
  assert.equal(auth.resolveAuthTokensJs, undefined);
  assert.equal(auth.resolveAuthTokensWasm, undefined);
  assert.equal(require('../../server/tool-policy.cjs').createToolPolicyJs, undefined);
  assert.ok(!davParseWasm.IMPL_FLAGS.includes('POLICY_LEAVES_IMPL'));
  assert.deepEqual(davParseWasm.wasmFlags({ POLICY_LEAVES_IMPL: 'wasm' }), []);
  assert.equal(davParseWasm.RETIRED_FLAGS.POLICY_LEAVES_IMPL, 'wasm');
  // An old =js is ignored: with no usable module the Rust path fails closed, it does not fall back.
  for (const old of ['js', 'wasm', undefined]) {
    await withEnv({ POLICY_LEAVES_IMPL: old, DAV_PARSE_WASM: path.join(__dirname, 'no-such.wasm') }, () => {
      if (old === undefined) delete process.env.POLICY_LEAVES_IMPL;
      davParseWasm.reset();
      assert.throws(() => auth.resolveAuthTokens({ DIARY_AUTH_TOKEN: 'synthetic-d' }), (e) => /could not be checked/.test(e.message) && !e.message.includes('synthetic-d'));
      assert.equal(createToolPolicy({ db: fakeDb(null) }).mode('u', 't', false), 'block');
      assert.throws(() => davParseWasm.verifyAtStartup(process.env), /dav-parse\.wasm \(always required\) failed verification/);
    });
  }
  davParseWasm.reset();
});
