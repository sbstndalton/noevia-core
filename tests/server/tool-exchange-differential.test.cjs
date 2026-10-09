'use strict';

// Tool exchange (TOOL_EXCHANGE_IMPL, retired in #1071): tests/fixtures/tool-exchange.v1.json (byte-identical to noevia-rs
// crates/tool-exchange/tests/fixtures/; CI compares them) holds tool-exchange.cjs's answers,
// dedupe keys and failed-call texts, printed by tools/gen-tool-exchange-fixtures.cjs from the JS
// references (tests/server/oracle/tool-exchange.cjs; synthetic text only). Here every row runs through dav-parse.wasm's tool_exchange and must
// agree unit for unit; then whole exchanges against the JS reference (the same results, the same
// executions, the same dedupe and write invalidation), seeded live JSON arguments, the depth and
// size refusals, and the fail-closed paths: a fault never runs the tool. The WebAssembly half needs
// server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const exchange = require('../../server/tool-exchange.cjs');
const oracle = require('./oracle/tool-exchange.cjs');

const FILE = path.join(__dirname, '../fixtures/tool-exchange.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-tool-exchange-fixtures.cjs');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** Run `calls` through one exchange; every result and every execution. */
async function session(impl, calls, { allowed = ['read', 'write', 't'], aborted = false, fail = () => null } = {}) {
  const executed = [];
  const make = impl === 'js' ? oracle.createToolExchangeJs : exchange.createToolExchange;
  const run = make({ allowed: new Set(allowed), isWrite: (n) => n === 'write', signal: { aborted } });
  const results = [];
  for (const call of calls) {
    results.push(await run(call, async (mark) => {
      executed.push(call.name);
      mark();
      const err = fail(call, executed.length);
      if (err) throw err;
      return `result-${executed.length}`;
    }));
  }
  return { results, executed };
}

test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env } });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('check rows: the same answer or the same dedupe key through the Rust port', { skip: skipWasm }, () => {
  fixtures.check.forEach((row, i) => {
    assert.deepStrictEqual(davParseWasm.toolExchangeCheck(row.aborted, row.allowed, row.name, row.args), row.want, `row ${i}`);
  });
});

test('error rows: the same failed-call text', { skip: skipWasm }, () => {
  fixtures.error.forEach((row, i) => assert.equal(davParseWasm.toolExchangeError(row.name, row.message), row.want, `row ${i}`));
  // Only the first 64 Ki units cross; the text keeps 300.
  const huge = 'é'.repeat(200000);
  assert.equal(davParseWasm.toolExchangeError('t', huge), oracle.callErrorJs('t', { message: huge }));
});

test('whole exchanges: the same results, executions, dedupe and write invalidation', { skip: skipWasm }, async () => {
  const sessions = [
    [{ name: 'read', args: '{"b":1,"a":2}' }, { name: 'read', args: '{ "a":2, "b":1 }' }, { name: 'read', args: '{"a":2,"b":1.0}' }],
    [{ name: 'read', args: '{}' }, { name: 'read' }, { name: 'read', args: '' }, { name: 'read', args: null }],
    [{ name: 'read', args: '{"p":"x"}' }, { name: 'write', args: '{"p":"x"}' }, { name: 'read', args: '{"p":"x"}' }, { name: 'write', args: '{"p":"x"}' }],
    [{ name: 'nope', args: '{}' }, { name: 'read', args: '[1]' }, { name: 'read', args: '{bad' }, { name: 'read', args: 5 }, { name: 'read', args: ['{"q":1}'] }],
    [{ name: 'read', args: { toString: () => '{"z":1}' } }, { name: 'read', args: '{"z":1}' }, { name: 'read', args: '{"n":-0}' }, { name: 'read', args: '{"n":0}' }],
    [{ name: 'read', args: '{"s":"\\ud800"}' }, { name: 'read', args: '{"s":"\ud800"}' }, { name: 'read', args: '{"a":1,"a":2}' }, { name: 'read', args: '{"a":2}' }],
  ];
  for (const [i, calls] of sessions.entries()) {
    assert.deepStrictEqual(await session('wasm', calls), await session('js', calls), `session ${i}`);
    assert.deepStrictEqual(await session('wasm', calls, { aborted: true }), await session('js', calls, { aborted: true }), `session ${i} (aborted)`);
  }
  // A failed call: the same text, no retry of the same call.
  const fail = (call, n) => (n === 1 ? Object.assign(new Error(`boom ${'x'.repeat(400)}`), {}) : null);
  const calls = [{ name: 'write', args: '{"a":1}' }, { name: 'write', args: '{"a":1}' }];
  assert.deepStrictEqual(await session('wasm', calls, { fail }), await session('js', calls, { fail }));
});

test('seeded live arguments agree', { skip: skipWasm }, () => {
  let seed = 1234;
  const rnd = (m) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % m; };
  const pick = (xs) => xs[rnd(xs.length)];
  const KEYS = ['a', 'b', 'B', 'aa', '', '10', '2', '__proto__', 'constructor', 'é', '😀', '～', '\\ud800', '\\u0000', 'k\\"q'];
  const NUMS = ['0', '-0', '1', '1.0', '1.50', '1e21', '1e20', '1E-7', '-2.5e-3', '1e400', '-1e400', '5e-324', '123456789012345678901234567890', '0.1', '9007199254740993'];
  const STRS = ['""', '"x"', '"\\ud83d\\ude00"', '"\\ud800"', '"\\n\\t\\u001f"', '"😀é"', '" "', '"\\/"', '"\\\\"'];
  const ws = () => pick(['', '', ' ', '\n', '\t', '\r\n ']);
  const value = (d) => {
    const k = rnd(d > 3 ? 4 : 7);
    if (k === 0) return pick(NUMS);
    if (k === 1) return pick(STRS);
    if (k === 2) return pick(['true', 'false', 'null']);
    if (k === 3) return pick(NUMS);
    if (k === 4) return `[${ws()}${Array.from({ length: rnd(4) }, () => value(d + 1)).join(`${ws()},${ws()}`)}${ws()}]`;
    return object(d + 1);
  };
  const object = (d) => `{${ws()}${Array.from({ length: rnd(5) }, () => `"${pick(KEYS)}"${ws()}:${ws()}${value(d)}`).join(`${ws()},${ws()}`)}${ws()}}`;
  const mutate = (s) => {
    const at = rnd(s.length + 1);
    return pick([() => s.slice(0, at), () => s.slice(0, at) + pick([',', '}', '"', '\\', 'x', '\u0000', '\ud800']) + s.slice(at), () => s + pick([' ', 'x', '}']), () => pick(['﻿', ' ', '']) + s])();
  };
  for (let i = 0; i < 3000; i++) {
    const args = rnd(4) ? object(0) : mutate(object(0));
    const call = { name: pick(['t', 'read']), args };
    const allowed = new Set(['t', 'read']);
    const js = oracle.checkCallJs(call, allowed, { aborted: false });
    assert.deepStrictEqual(davParseWasm.toolExchangeCheck(false, true, call.name, args || null), js, `iteration ${i}: ${JSON.stringify(args)}`);
  }
});

test('depth and size: the port refuses past its caps and the tool is never run', { skip: skipWasm }, async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const deep = (d) => `${'{"a":'.repeat(d)}1${'}'.repeat(d)}`;
    // Up to 1,024 levels both agree.
    const ok = { name: 't', args: deep(1024) };
    assert.deepStrictEqual(await session('wasm', [ok]), await session('js', [ok]));
    // Deeper: the JS still runs it (until V8's stack gives out); the port refuses and never runs it.
    const over = { name: 't', args: deep(1025) };
    assert.deepStrictEqual(await session('wasm', [over]), { results: [exchange.CHECK_FAULT], executed: [] });
    // A deep array at the top is not an object: answered, as the JS answers.
    const arr = { name: 't', args: `${'['.repeat(5000)}${']'.repeat(5000)}` };
    assert.deepStrictEqual(await session('wasm', [arr]), await session('js', [arr]));
    const big = { name: 't', args: `{"a":"${'x'.repeat(davParseWasm.MAX_EXCHANGE_ARGS_UNITS)}"}` };
    assert.deepStrictEqual(await session('wasm', [big]), { results: [exchange.CHECK_FAULT], executed: [] });
    // Large but within the cap: the same key.
    const large = { name: 't', args: `{"a":"${'y'.repeat(2 * 1024 * 1024)}"}` };
    const allowed = new Set(['t']);
    assert.deepStrictEqual(davParseWasm.toolExchangeCheck(false, true, 't', large.args), oracle.checkCallJs(large, allowed, { aborted: false }));
  } finally { console.warn = warn; }
});

test('TOOL_EXCHANGE_IMPL is retired: no switch, no JS checks in production, the port always decides', async () => {
  for (const gone of ['toolExchangeImpl', 'checkCallJs', 'callErrorJs', 'canonical']) assert.equal(exchange[gone], undefined, gone);
  assert.ok(!davParseWasm.IMPL_FLAGS.includes('TOOL_EXCHANGE_IMPL'));
  assert.equal(davParseWasm.RETIRED_FLAGS.TOOL_EXCHANGE_IMPL, 'wasm');
  // An old =js is ignored and an exchange asks the port for every call.
  let loads = 0;
  const loader = () => { loads++; return { toolExchangeCheck: () => ({ answer: 'ERROR: stub' }) }; };
  await withEnv({ TOOL_EXCHANGE_IMPL: 'js' }, async () => {
    const run = exchange.createToolExchange({ allowed: new Set(['t']), isWrite: () => false, signal: { aborted: false }, wasmLoader: loader });
    assert.equal(await run({ name: 't', args: '{}' }, async () => 'ran'), 'ERROR: stub');
  });
  assert.equal(loads, 1);
});

test('fail closed: a missing module, a bad reply or a non-string name never runs the tool', async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    await withEnv({ DAV_PARSE_WASM: path.join(__dirname, 'no-such-dav-parse.wasm') }, async () => {
      davParseWasm.reset();
      assert.deepStrictEqual(await session('wasm', [{ name: 'write', args: '{}' }]), { results: [exchange.CHECK_FAULT], executed: [] });
      assert.throws(() => davParseWasm.verifyAtStartup({ DAV_PARSE_WASM: process.env.DAV_PARSE_WASM }, { hostname: () => 'ss.io' }), /dav-parse\.wasm \(always required\) failed verification \(missing\)/);
    });
    davParseWasm.reset();
    const stub = (check, error) => () => ({ toolExchangeCheck: check, toolExchangeError: error });
    const make = (loader) => exchange.createToolExchange({ allowed: new Set(['t', 5]), isWrite: () => true, signal: { aborted: false }, wasmLoader: loader });
    let ran = 0;
    const exec = async () => { ran++; return 'ran'; };
    assert.equal(await make(stub(() => { throw Object.assign(new Error('x'), { reason: 'trap' }); }))({ name: 't', args: '{}' }, exec), exchange.CHECK_FAULT);
    assert.equal(await make(stub(() => ({ key: '["t","{}"]' })))({ name: 5, args: '{}' }, exec), exchange.CHECK_FAULT);
    assert.equal(ran, 0);
    // A fault reading a failed call's error: a fixed text, recorded once (no retry).
    const run = make(stub(() => ({ key: '["t","{}"]' }), () => { throw new Error('trap'); }));
    const boom = async () => { ran++; throw new Error('boom'); };
    assert.equal(await run({ name: 't', args: '{}' }, boom), exchange.ERROR_FAULT);
    assert.equal(await run({ name: 't', args: '{}' }, boom), exchange.ERROR_FAULT);
    assert.equal(ran, 1);
  } finally { console.warn = warn; davParseWasm.reset(); }
});

test('reply checks: a key must be JSON.stringify([name, an object]) for this very name', { skip: skipWasm }, () => {
  assert.deepStrictEqual(davParseWasm.toolExchangeCheck(false, true, 'x"y', '{"b":[1,{"d":2,"c":3}]}'), { key: JSON.stringify(['x"y', '{"b":[1,{"c":3,"d":2}]}']) });
  assert.throws(() => davParseWasm.toolExchangeCheck(false, true, 5, '{}'), { reason: 'input' });
  assert.throws(() => davParseWasm.toolExchangeCheck(false, true, 't', 5), { reason: 'input' });
  assert.throws(() => davParseWasm.toolExchangeCheck(false, true, 'x'.repeat(davParseWasm.MAX_EXCHANGE_NAME_UNITS + 1), '{}'), { reason: 'too_large' });
});
