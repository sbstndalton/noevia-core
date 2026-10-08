'use strict';

// CODE_NET_GUARD_IMPL: tests/fixtures/code-net-guard.v1.json (byte-identical to noevia-rs
// crates/code-net-guard/tests/fixtures/; CI compares them) holds code-net-guard.cjs's spec readings,
// kept lookup answers and refusals, printed by tools/gen-code-net-guard-fixtures.cjs from the JS
// itself (synthetic addresses only). Here every row runs through dav-parse.wasm's code_net_guard and
// through createCodeNetGuard with the switch on; then seeded live specs, answers and local addresses
// against the runtime's own net.isIP: the port either agrees or refuses, and never serves a request
// the JS refuses. The WebAssembly half needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped
// without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const { createCodeNetGuard, parseCodeNetSpec, normalizeAddress } = require('../../server/code-net-guard.cjs');

const FILE = path.join(__dirname, '../fixtures/code-net-guard.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-code-net-guard-fixtures.cjs');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

const guardOf = (spec, extra = {}) => createCodeNetGuard({ spec, impl: 'wasm', lookup: async () => [], ...extra });

test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('spec rows: the same reading through the Rust port and the switched guard', { skip: skipWasm }, async () => {
  assert.ok(fixtures.spec.length >= 60);
  for (const [i, row] of fixtures.spec.entries()) {
    assert.deepStrictEqual(davParseWasm.codeNetSpec(row.spec), row.want, `row ${i}: ${JSON.stringify(row.spec)}`);
    if (row.want.malformed !== undefined) {
      assert.throws(() => guardOf(row.spec), /COWORK_CODE_NET_ADDR/, `row ${i}`);
      assert.throws(() => parseCodeNetSpec(row.spec), /COWORK_CODE_NET_ADDR/, `row ${i} (js)`);
    } else {
      const g = guardOf(row.spec);
      assert.equal(g.enabled, row.want.literals.length + row.want.hosts.length > 0, `row ${i}`);
      await g.ready;
      for (const lit of row.want.literals) assert.equal(await g.refuses(lit), true, `row ${i}: ${lit}`);
      g.stop();
    }
  }
});

test('strict rows: the port refuses as ambiguous; the switched guard will not start', { skip: skipWasm }, () => {
  const groups = [['strictSpec', (r) => davParseWasm.codeNetSpec(r.spec)], ['strictAnswers', (r) => davParseWasm.codeNetResolved(r.answers)],
    ['strictRefuses', (r) => davParseWasm.codeNetRefuses(r.addresses, r.local)]];
  // Startup stops either way: the JS throws on a malformed entry, the switch on the port's refusal.
  for (const [key, fn] of groups) {
    fixtures[key].forEach((row, i) => {
      assert.deepStrictEqual(row.want, { refused: 'ambiguous' });
      assert.throws(() => fn(row), { reason: 'ambiguous' }, `${key} row ${i}`);
    });
  }
  fixtures.strictSpec.forEach((row, i) => assert.throws(() => guardOf(row.spec), /COWORK_CODE_NET_ADDR/, `row ${i}`));
});

test('answer and refusal rows agree; stricter rows refuse where the JS serves', { skip: skipWasm }, () => {
  fixtures.answers.forEach((row, i) => assert.deepStrictEqual({ addresses: davParseWasm.codeNetResolved(row.answers) }, row.want, `answers row ${i}`));
  fixtures.refuses.forEach((row, i) => assert.equal(davParseWasm.codeNetRefuses(row.addresses, row.local), row.want, `refuses row ${i}`));
  fixtures.stricter.forEach((row, i) => {
    assert.equal(new Set(row.addresses).has(normalizeAddress(row.local)), false, `stricter row ${i} (js)`);
    assert.equal(davParseWasm.codeNetRefuses(row.addresses, row.local), true, `stricter row ${i}`);
  });
});

test('the switched guard: refused where either refuses, served only where both serve', { skip: skipWasm }, async () => {
  const resolved = ['172.30.0.2', '0:0::1'];
  const g = guardOf('egress', { lookup: async () => resolved.map((address) => ({ address })) });
  await g.ready;
  const js = createCodeNetGuard({ spec: 'egress', impl: 'js', lookup: async () => resolved.map((address) => ({ address })) });
  await js.ready;
  for (const local of ['172.30.0.2', '::ffff:172.30.0.2', '0:0::1']) {
    assert.equal(await g.refuses(local), true, local);
    assert.equal(await js.refuses(local), true, `${local} (js)`);
  }
  // Stricter: the same IP spelled the way the kernel reports it.
  assert.equal(await g.refuses('::1'), true);
  assert.equal(await js.refuses('::1'), false);
  for (const local of ['172.18.0.5', '127.0.0.1', undefined]) assert.equal(await g.refuses(local), false, String(local));
  // A non-ASCII local address is a fault: refused.
  assert.equal(await g.refuses(' 172.18.0.5'), true);
  g.stop(); js.stop();
});

test('seeded live inputs: the port agrees with this runtime, or refuses; it never serves what the JS refuses', { skip: skipWasm }, () => {
  let seed = 853;
  const rnd = (m) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 16) % m; };
  const pick = (xs) => xs[rnd(xs.length)];
  const ALPHA = ['0', '1', '2', '5', '9', 'a', 'f', 'F', 'g', ':', ':', '.', '.', '%', 'x', '-', '_', 'e', 's', ' '];
  const PIECES = ['172.30.0.2', '::ffff:', '::', '::1', 'fe80::', '%eth0', '255', '256', '01', '0x7f', 'egress', 'xn--', 'EGRESS', '1.2.3.4', 'ac1e:2'];
  const word = () => Array.from({ length: 1 + rnd(4) }, () => (rnd(3) ? pick(PIECES) : Array.from({ length: 1 + rnd(5) }, () => pick(ALPHA)).join(''))).join('');
  let agreed = 0, refusedCount = 0;
  for (let n = 0; n < 3000; n++) {
    const entries = Array.from({ length: rnd(4) }, word);
    const spec = entries.join(pick([',', ' ', ', ', '\t']));
    let js;
    try { const p = parseCodeNetSpec(spec); js = { literals: [...p.literals], hosts: p.hosts }; } catch (err) { js = { malformed: /not "([\s\S]*)"$/.exec(err.message)[1] }; }
    let port;
    try { port = davParseWasm.codeNetSpec(spec); } catch (err) { assert.equal(err.reason, 'ambiguous', spec); refusedCount++; continue; }
    assert.deepStrictEqual(port, js, `spec ${JSON.stringify(spec)}`);
    agreed++;
    // Answers: each word as a lookup answer.
    const answers = entries.map((e) => (rnd(5) ? e : null));
    const kept = answers.map((a) => normalizeAddress(a === null ? undefined : a)).filter((a) => net.isIP(a));
    assert.deepStrictEqual(davParseWasm.codeNetResolved(answers), kept, `answers ${JSON.stringify(answers)}`);
    // Refusal: never served where the JS refuses.
    const local = rnd(2) && kept.length ? pick([...kept, ` ${kept[0].toUpperCase()} `, `::ffff:${kept[0]}`]) : word();
    const jsRefuses = new Set(kept).has(normalizeAddress(local));
    let portRefuses;
    try { portRefuses = davParseWasm.codeNetRefuses(kept, local); } catch { portRefuses = true; }
    if (jsRefuses) assert.equal(portRefuses, true, `served ${JSON.stringify(local)} of ${JSON.stringify(kept)}`);
  }
  assert.ok(agreed > 1500 && refusedCount > 50, `${agreed} agreed, ${refusedCount} refused`);
});
