'use strict';

// Code net guard: the Rust port is the authority (#1071; CODE_NET_GUARD_IMPL is retired and
// server/code-net-guard.cjs holds no reading of its own). tests/fixtures/code-net-guard.v1.json
// (byte-identical to noevia-rs crates/code-net-guard/tests/fixtures/; CI compares them) holds the old
// JavaScript guard's spec readings, kept lookup answers and refusals, printed by
// tools/gen-code-net-guard-fixtures.cjs from the byte-pinned copy of that guard,
// tests/reference/code-net-guard-js.cjs (synthetic addresses only). Here every row runs through
// dav-parse.wasm's code_net_guard and through the production guard; then seeded live specs, answers
// and local addresses against the runtime's own net.isIP, and whole guards against the old guard run
// for real: the Rust-only guard agrees, or is stricter, and never serves a request the old guard
// refused ("weaker" is counted and must be 0). The frozen record of the same relations, which does
// not depend on this runtime, is code-net-guard-frozen.test.cjs. The WebAssembly half needs
// server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const { createCodeNetGuard } = require('../../server/code-net-guard.cjs');
const oracle = require('../reference/code-net-guard-js.cjs');
const { parseCodeNetSpec, normalizeAddress } = oracle;

const FILE = path.join(__dirname, '../fixtures/code-net-guard.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-code-net-guard-fixtures.cjs');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const WASM = { wasmLoader: () => davParseWasm };

// Every row or case a guarded body below worked through. A body that was skipped, or that stopped
// looping early, leaves this short; test.after asserts the exact total.
const EXPECTED_RAN = 3452; // rows and cases the guarded bodies below work through (fixture rows, 3000 seeded specs, 300 seeded guards, limits)
let ran = 0;
test.after(() => assert.equal(ran, skipWasm ? 0 : EXPECTED_RAN, 'every guarded row ran'));

const guardOf = (spec, extra = {}) => createCodeNetGuard({ spec, lookup: async () => [], ...extra });
const quiet = { log: () => {}, retryMs: 3_600_000 };

test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('spec rows: the same reading through the Rust port and the guard', { skip: skipWasm }, async () => {
  assert.ok(fixtures.spec.length >= 60);
  for (const [i, row] of fixtures.spec.entries()) {
    ran++;
    assert.deepStrictEqual(davParseWasm.codeNetSpec(row.spec), row.want, `row ${i}: ${JSON.stringify(row.spec)}`);
    if (row.want.malformed !== undefined) {
      assert.throws(() => guardOf(row.spec), { message: `COWORK_CODE_NET_ADDR should list IP addresses or host names, not "${row.want.malformed}"` }, `row ${i}`);
      assert.throws(() => parseCodeNetSpec(row.spec), /COWORK_CODE_NET_ADDR/, `row ${i} (old guard)`);
    } else {
      const looked = [];
      const g = guardOf(row.spec, { lookup: async (host) => { looked.push(host); return []; }, ...quiet });
      assert.equal(g.enabled, row.want.literals.length + row.want.hosts.length > 0, `row ${i}`);
      await g.ready;
      assert.deepStrictEqual(looked, row.want.hosts, `row ${i}: the names looked up`);
      for (const lit of row.want.literals) assert.equal(await g.refuses(lit), true, `row ${i}: ${lit}`);
      g.stop();
    }
  }
});

test('strict rows: the port refuses as ambiguous; the guard will not start', { skip: skipWasm }, () => {
  const groups = [['strictSpec', (r) => davParseWasm.codeNetSpec(r.spec)], ['strictAnswers', (r) => davParseWasm.codeNetResolved(r.answers)],
    ['strictRefuses', (r) => davParseWasm.codeNetRefuses(r.addresses, r.local)]];
  for (const [key, fn] of groups) {
    fixtures[key].forEach((row, i) => {
      ran++;
      assert.deepStrictEqual(row.want, { refused: 'ambiguous' });
      assert.throws(() => fn(row), { reason: 'ambiguous' }, `${key} row ${i}`);
    });
  }
  // Startup stops: the crate refuses the spec.
  fixtures.strictSpec.forEach((row, i) => assert.throws(() => guardOf(row.spec), /Rust port refused COWORK_CODE_NET_ADDR \(ambiguous\)/, `row ${i}`));
});

test('answer and refusal rows agree; stricter rows refuse where the old guard served', { skip: skipWasm }, () => {
  fixtures.answers.forEach((row, i) => { ran++; assert.deepStrictEqual({ addresses: davParseWasm.codeNetResolved(row.answers) }, row.want, `answers row ${i}`); });
  fixtures.refuses.forEach((row, i) => { ran++; assert.equal(davParseWasm.codeNetRefuses(row.addresses, row.local), row.want, `refuses row ${i}`); });
  fixtures.stricter.forEach((row, i) => {
    ran++;
    assert.equal(new Set(row.addresses).has(normalizeAddress(row.local)), false, `stricter row ${i} (old guard serves)`);
    assert.equal(davParseWasm.codeNetRefuses(row.addresses, row.local), true, `stricter row ${i}`);
  });
});

test('the guard: refused where the crate refuses, including the same IP in another spelling', { skip: skipWasm }, async () => {
  const resolved = ['172.30.0.2', '0:0::1'];
  const g = guardOf('egress', { lookup: async () => resolved.map((address) => ({ address })) });
  await g.ready;
  for (const local of ['172.30.0.2', '::ffff:172.30.0.2', '0:0::1', '::1']) { ran++; assert.equal(await g.refuses(local), true, local); }
  for (const local of ['172.18.0.5', '127.0.0.1', undefined, null, '']) { ran++; assert.equal(await g.refuses(local), false, String(local)); }
  // A non-ASCII local address is a fault: refused.
  ran++;
  assert.equal(await g.refuses('\xa0172.18.0.5'), true);
  g.stop();
});

test('limits the crate keeps: a spec or address list the old guard read is refused, never half-read', { skip: skipWasm }, async () => {
  const unique = (n, a) => Array.from({ length: n }, (_, i) => `10.${a}.${Math.floor(i / 200)}.${(i % 200) + 1}`);
  const filled = unique(1024, 1);
  assert.equal(new Set(filled).size, 1024);
  ran++;
  assert.equal(guardOf(filled.join(',')).enabled, true, '1024 literals are the most one call takes');
  const tooMany = [...filled, '10.9.9.9'];
  assert.equal(parseCodeNetSpec(tooMany.join(',')).literals.size, 1025, 'the old guard read them');
  ran++;
  assert.throws(() => guardOf(tooMany.join(',')), /Rust port refused COWORK_CODE_NET_ADDR \((too_large|input|reply)\)/);
  const huge = Array(17500).fill('a.b').join(' ');
  assert.ok(huge.length > 64 * 1024);
  assert.deepEqual(parseCodeNetSpec(huge).hosts.length, 17500, 'the old guard read it');
  ran++;
  assert.throws(() => guardOf(huge), /Rust port refused COWORK_CODE_NET_ADDR \(too_large\)/);
  // More guarded addresses than one call takes: every request is refused (the host cannot send them).
  const logs = [];
  const lookups = { one: unique(600, 2), two: unique(600, 3) };
  const g = guardOf('one,two', { lookup: async (host) => lookups[host], log: (e) => logs.push(e) });
  await g.ready;
  ran++;
  assert.equal(await g.refuses('172.18.0.5'), true);
  assert.ok(logs.some((e) => e.event === 'codenet.wasm_fault' && e.where === 'request' && e.reason === 'input'));
  g.stop();
  // A lookup with more answers than one call takes is a fault in the reading: refuse everything.
  const flood = [];
  const g2 = guardOf('one', { lookup: async () => unique(1025, 4), log: (e) => flood.push(e) });
  await g2.ready;
  ran++;
  assert.equal(await g2.refuses('172.18.0.5'), true);
  assert.ok(flood.some((e) => e.event === 'codenet.wasm_fault' && e.where === 'resolve'));
  g2.stop();
});

// A small deterministic generator for the seeded cases below.
function lcg(start) {
  let seed = start;
  const rnd = (m) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 16) % m; };
  return { rnd, pick: (xs) => xs[rnd(xs.length)] };
}

test('seeded live inputs: the port agrees with this runtime, or refuses; it never serves what the old guard refused', { skip: skipWasm }, () => {
  const { rnd, pick } = lcg(853);
  const ALPHA = ['0', '1', '2', '5', '9', 'a', 'f', 'F', 'g', ':', ':', '.', '.', '%', 'x', '-', '_', 'e', 's', ' '];
  const PIECES = ['172.30.0.2', '::ffff:', '::', '::1', 'fe80::', '%eth0', '255', '256', '01', '0x7f', 'egress', 'xn--', 'EGRESS', '1.2.3.4', 'ac1e:2'];
  const word = () => Array.from({ length: 1 + rnd(4) }, () => (rnd(3) ? pick(PIECES) : Array.from({ length: 1 + rnd(5) }, () => pick(ALPHA)).join(''))).join('');
  let agreed = 0, refusedCount = 0, weaker = 0;
  for (let n = 0; n < 3000; n++) {
    ran++;
    const entries = Array.from({ length: rnd(4) }, word);
    const spec = entries.join(pick([',', ' ', ', ', '\t']));
    let js;
    try { const p = parseCodeNetSpec(spec); js = { literals: [...p.literals], hosts: p.hosts }; } catch (err) { js = { malformed: /not "([\s\S]*)"$/.exec(err.message)[1] }; }
    let port;
    try { port = davParseWasm.codeNetSpec(spec); } catch (err) { assert.equal(err.reason, 'ambiguous', spec); refusedCount++; continue; }
    // The crate parsed it: it must be the reading the old guard had (a different one would be the old guard refusing where the crate permits).
    if (JSON.stringify(port) !== JSON.stringify(js)) weaker++;
    assert.deepStrictEqual(port, js, `spec ${JSON.stringify(spec)}`);
    agreed++;
    // Answers: each word as a lookup answer.
    const answers = entries.map((e) => (rnd(5) ? e : null));
    const kept = answers.map((a) => normalizeAddress(a === null ? undefined : a)).filter((a) => net.isIP(a));
    assert.deepStrictEqual(davParseWasm.codeNetResolved(answers), kept, `answers ${JSON.stringify(answers)}`);
    // Refusal: never served where the old guard refused.
    const local = rnd(2) && kept.length ? pick([...kept, ` ${kept[0].toUpperCase()} `, `::ffff:${kept[0]}`]) : word();
    const jsRefuses = new Set(kept).has(normalizeAddress(local));
    let portRefuses;
    try { portRefuses = davParseWasm.codeNetRefuses(kept, local); } catch { portRefuses = true; }
    if (jsRefuses && !portRefuses) weaker++;
    if (jsRefuses) assert.equal(portRefuses, true, `served ${JSON.stringify(local)} of ${JSON.stringify(kept)}`);
  }
  assert.equal(weaker, 0, 'the Rust-only answer never permits where the old guard refused');
  assert.ok(agreed > 1500 && refusedCount > 50, `${agreed} agreed, ${refusedCount} refused`);
});

test('seeded live guards: the Rust-only guard against the old guard run for real never serves what the old guard refused', { skip: skipWasm }, async () => {
  const { rnd, pick } = lcg(1071);
  const IPS = ['172.30.0.2', '172.30.0.3', '172.18.0.5', '127.0.0.1', '::1', '0:0::1', 'fe80::1', 'FE80::1%ETH0', '2001:db8::1', '::ffff:172.30.0.2', '::ffff:ac1e:2', '1.2.3', '01.2.3.4', '::'];
  const spell = (s) => pick([s, s, s, s.toUpperCase(), ` ${s}`, `${s} `, `\t${s}\n`]);
  const item = () => {
    const k = rnd(14);
    if (k < 6) return spell(pick(IPS));
    if (k < 8) return { address: spell(pick(IPS)), family: 4 };
    if (k < 9) return null;
    if (k < 10) return { address: ['172.30.0.2'] };
    if (k < 11) return { address: pick([null, 5, true, {}, '']) };
    if (k < 12) return pick(['nope', '', 'host']);
    return { family: 6 };
  };
  const SPECS = ['egress', '172.30.0.2', '172.30.0.2,egress', 'egress,web', '::1 web.internal', '0:0::1,egress', 'FE80::1 egress', 'a.b,c.d,e.f'];
  const locals = [undefined, null, '', '172.30.0.2', '172.30.0.3', ' 172.30.0.2 ', '::ffff:172.30.0.2', '::1', '0:0::1', 'fe80::1', 'fe80::1%eth0', '2001:db8::1', '127.0.0.1', '172.18.0.5', 'egress', 5];
  const counts = { requests: 0, same: 0, refusedBoth: 0, stricter: 0, weaker: 0 };
  for (let n = 0; n < 300; n++) {
    ran++;
    const spec = pick(SPECS);
    const answers = {};
    for (const host of parseCodeNetSpec(spec).hosts) {
      const k = rnd(10);
      answers[host] = k < 7 ? Array.from({ length: rnd(5) }, item) : k < 8 ? 'fail' : [];
    }
    const lookup = async (host) => { if (answers[host] === 'fail') throw Error('synthetic lookup failure'); return answers[host]; };
    const old = oracle.createCodeNetGuard({ spec, lookup, wasmLoader: WASM.wasmLoader, ...quiet });
    const next = createCodeNetGuard({ spec, lookup, ...quiet });
    await Promise.all([old.ready, next.ready]);
    for (const local of locals) {
      const was = await old.refuses(local), now = await next.refuses(local);
      counts.requests++;
      if (was === now) { counts.same++; if (was) counts.refusedBoth++; } else if (now) counts.stricter++; else counts.weaker++;
    }
    old.stop(); next.stop();
  }
  assert.equal(counts.weaker, 0, JSON.stringify(counts));
  assert.equal(counts.requests, 300 * locals.length);
  assert.ok(counts.refusedBoth > 400 && counts.same > 3000, JSON.stringify(counts));
});
