'use strict';

// The retired JavaScript code-net guard, frozen (#1071). tests/fixtures/code-net-guard-frozen.v1.json
// records, for 1439 specs, 1317 sets of lookup answers and 400 whole guards over 4000 requests, what
// the old guard answered (the byte-pinned tests/reference/code-net-guard-js.cjs, JS AND Rust) beside
// what the pinned Rust module answers, printed by tools/gen-code-net-guard-frozen.cjs before any of
// the JavaScript was deleted. Nothing here depends on this runtime's net.isIP or String methods:
// the old answers are data. This file
//   * pins the frozen files, the oracle and the module they were made with by sha256, and the
//     relation counts as literals, and recomputes the counts from the rows;
//   * asserts "the JavaScript refused, Rust permits" is 0 in every section, in the data and again
//     through the production guard (which asks only Rust);
//   * runs every frozen spec, answer set and guard through the production guard and compares its
//     decisions with the frozen Rust-only answers exactly.
// The production-guard half needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it
// unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const { createCodeNetGuard } = require('../../server/code-net-guard.cjs');

const FIXTURES = path.join(__dirname, '../fixtures');
const FROZEN = path.join(FIXTURES, 'code-net-guard-frozen.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-code-net-guard-frozen.cjs');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const frozen = JSON.parse(fs.readFileSync(FROZEN, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

const PINS = {
  frozen: 'd3fba0cc4b4c8959eaea170a6977ef109920e37ce0198556236d18b91c6460ad',
  fixture: '430f13c7cef59e4b473f94af6296bf65a317f10ab7fc5d2285f2e07981225e39',
  oracle: '6235e2ceaffd571f78f1cfaadc7b5d70e01e5edad60819b36e645b2dcda202a6',
  wasm: 'aebb50e1a63848fe309cec9470f9d441ec738ef095e7a52b3053d53f79a892d0',
  noeviaRs: '88f50c5c65a166c08bd27c736ce1aef69ba38f32',
  coreCommit: 'b2582357c93cad605524a276090114082de1b2e1',
};
const COUNTS = {
  spec: { rows: 1439, bothStart: 393, jsMalformedRefused: 695, rustStricter: 351, weaker: 0 },
  answers: { rows: 1317, same: 972, noAddress: 155, rustFault: 190, rustExtra: 0, weaker: 0 },
  guard: { rows: 400, requests: 4000, same: 3989, refusedBoth: 1648, rustStricter: 11, weaker: 0 },
};
// Every frozen row the production-guard tests below worked through (1439 + 1317 + 400); a body that was
// skipped or stopped early leaves this short.
const EXPECTED_RAN = 3156;
let ran = 0;
test.after(() => assert.equal(ran, skipWasm ? 0 : EXPECTED_RAN, 'every frozen row ran through the production guard'));

const decodeLocal = (e) => (e[0] === 's' || e[0] === 'num' || e[0] === 'bool' ? e[1] : e[0] === 'null' ? null : undefined);
const noop = () => {};

/** The relation counts, recomputed from the rows alone. */
function relations() {
  const spec = { rows: frozen.specRows.length, bothStart: 0, jsMalformedRefused: 0, rustStricter: 0, weaker: 0 };
  for (const { js, port, old } of frozen.specRows) {
    const nextStarts = port.literals !== undefined;
    assert.ok(!old.started || (nextStarts && JSON.stringify(js) === JSON.stringify(port)), 'the old guard started only on the reading Rust gives');
    if (old.started) spec.bothStart++;
    else if (nextStarts) spec.weaker++;
    else if (js.malformed !== undefined) spec.jsMalformedRefused++;
    else spec.rustStricter++;
  }
  const answers = { rows: frozen.answerRows.length, same: 0, noAddress: 0, rustFault: 0, rustExtra: 0, weaker: 0 };
  for (const { jsFound, newHost } of frozen.answerRows) {
    if (newHost.broken) answers.rustFault++;
    else if (newHost.none) { if (jsFound.length) answers.weaker++; else answers.noAddress++; }
    else if (!jsFound.every((x) => newHost.kept.includes(x))) answers.weaker++;
    else if (JSON.stringify(jsFound) === JSON.stringify(newHost.kept)) answers.same++;
    else answers.rustExtra++;
  }
  const guard = { rows: frozen.guardRows.length, requests: 0, same: 0, refusedBoth: 0, rustStricter: 0, weaker: 0 };
  for (const { old, next, locals } of frozen.guardRows) {
    assert.equal(old.length, locals.length);
    assert.equal(next.length, locals.length);
    for (let i = 0; i < old.length; i++) {
      guard.requests++;
      if (old[i] === next[i]) { guard.same++; if (old[i]) guard.refusedBoth++; } else if (next[i]) guard.rustStricter++; else guard.weaker++;
    }
  }
  return { spec, answers, guard };
}

test('the frozen files, the oracle and the module they were made with are the pinned ones', () => {
  assert.equal(sha256(FROZEN), PINS.frozen);
  assert.equal(sha256(path.join(FIXTURES, 'code-net-guard.v1.json')), PINS.fixture);
  assert.equal(sha256(path.join(__dirname, '../reference/code-net-guard-js.cjs')), PINS.oracle);
  assert.deepEqual(frozen.provenance, {
    coreCommit: PINS.coreCommit,
    oracle: 'tests/reference/code-net-guard-js.cjs',
    oracleSha256: PINS.oracle,
    fixtureSha256: PINS.fixture,
    wasmSha256: PINS.wasm,
    noeviaRsRef: PINS.noeviaRs,
    generator: 'tools/gen-code-net-guard-frozen.cjs',
  });
  assert.equal(frozen.version, 1);
  assert.deepEqual(frozen.counts, COUNTS);
  assert.deepEqual(relations(), COUNTS, 'the counts are what the rows say');
  // The crate reading nothing from text that has content would leave the guard off (the host refuses
  // to start then); it never does for a frozen spec the crate parses.
  let withContent = 0, empty = 0;
  for (const { spec, port } of frozen.specRows) {
    if (port.literals === undefined) continue;
    if (/[^\s,]/.test(spec)) { withContent++; if (port.literals.length + port.hosts.length === 0) empty++; }
  }
  assert.ok(withContent > 300, `${withContent} specs with content`);
  assert.equal(empty, 0, 'no frozen spec with content reads as empty');
  assert.equal(frozen.specRows.length + frozen.answerRows.length + frozen.guardRows.length, EXPECTED_RAN);
  for (const section of ['spec', 'answers', 'guard']) assert.equal(COUNTS[section].weaker, 0, `${section}: the JavaScript refused and Rust permits`);
});

test('the frozen file is what the generator prints from the pinned oracle and module', { skip: (!fs.existsSync(GENERATOR) && 'no generator here') || skipWasm }, () => {
  const out = execFileSync(process.execPath, [GENERATOR, '--core-commit', frozen.provenance.coreCommit],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, DAV_PARSE_WASM: wasmFile } });
  assert.equal(out, fs.readFileSync(FROZEN, 'utf8'));
});

test('specs: the production guard starts exactly where the pinned Rust parses, with its reading, and never where the old guard stopped', { skip: skipWasm }, async () => {
  let weaker = 0;
  for (const [i, row] of frozen.specRows.entries()) {
    ran++;
    const looked = [];
    let g = null, error = null;
    try { g = createCodeNetGuard({ spec: row.spec, lookup: async (host) => { looked.push(host); return []; }, log: noop, retryMs: 3_600_000 }); } catch (err) { error = err; }
    const where = `spec row ${i}: ${JSON.stringify(row.spec)}`;
    if (row.old.started) assert.equal(error, null, `${where}: the old guard started`);
    if (!row.old.started && g) weaker++;
    if (row.port.literals !== undefined) {
      assert.ok(g, where);
      assert.equal(g.enabled, row.port.literals.length + row.port.hosts.length > 0, where);
      await g.ready;
      assert.deepEqual(looked, row.port.hosts, `${where}: the names looked up`);
      for (const literal of row.port.literals) assert.equal(await g.refuses(literal), true, `${where}: ${literal}`);
      g.stop();
    } else if (row.port.malformed !== undefined) {
      assert.equal(error?.message, `COWORK_CODE_NET_ADDR should list IP addresses or host names, not "${row.port.malformed}"`, where);
    } else {
      assert.equal(error?.message, `the Rust port refused COWORK_CODE_NET_ADDR (${row.port.fault}); list plain IP addresses or host names`, where);
    }
  }
  assert.equal(weaker, 0, 'Rust starts where the old guard stopped startup');
});

test('lookup answers: every address the old guard kept is kept, or everything is refused; the pinned Rust decides the rest', { skip: skipWasm }, async () => {
  let weaker = 0;
  for (const [i, row] of frozen.answerRows.entries()) {
    ran++;
    const logs = [];
    const g = createCodeNetGuard({ spec: 'egress', lookup: async () => row.answers, log: (e) => logs.push(e), retryMs: 3_600_000 });
    await g.ready;
    const where = `answers row ${i}: ${JSON.stringify(row.answers)}`;
    const wasFaults = logs.filter((e) => e.event === 'codenet.wasm_fault');
    if (row.newHost.broken) {
      assert.deepEqual(wasFaults.map((e) => [e.where, e.reason]), [['resolve', row.newHost.broken]], where);
      assert.equal(await g.refuses('203.0.113.99'), true, `${where}: everything is refused`);
    } else if (row.newHost.none) {
      assert.equal(wasFaults.length, 0, where);
      assert.ok(logs.some((e) => e.event === 'codenet.resolve_failed' && e.reason === 'no address'), where);
      assert.equal(await g.refuses('203.0.113.99'), false, where);
      if (row.jsFound.length) weaker++;
    } else {
      assert.equal(wasFaults.length, 0, where);
      for (const kept of row.newHost.kept) assert.equal(await g.refuses(kept), true, `${where}: ${kept}`);
      assert.equal(await g.refuses('203.0.113.99'), false, where);
    }
    if (!row.newHost.broken) for (const found of row.jsFound) { if ((await g.refuses(found)) !== true) weaker++; }
    g.stop();
  }
  assert.equal(weaker, 0, 'an address the old guard kept would be served');
});

test('whole guards: the production decisions are the frozen Rust-only ones, and never serve what the old guard refused', { skip: skipWasm }, async () => {
  const counts = { rows: 0, requests: 0, same: 0, refusedBoth: 0, rustStricter: 0, weaker: 0 };
  for (const [i, row] of frozen.guardRows.entries()) {
    ran++;
    counts.rows++;
    const lookup = async (host) => { const l = row.lookups[host]; if (l.fail) throw Error('synthetic lookup failure'); return l.answers; };
    const g = createCodeNetGuard({ spec: row.spec, lookup, log: noop, retryMs: 3_600_000 });
    await g.ready;
    for (const [j, local] of row.locals.entries()) {
      const now = await g.refuses(decodeLocal(local));
      assert.equal(now, row.next[j], `guard row ${i} (${row.spec}) local ${JSON.stringify(local)}`);
      counts.requests++;
      if (row.old[j] === now) { counts.same++; if (now) counts.refusedBoth++; } else if (now) counts.rustStricter++; else counts.weaker++;
    }
    g.stop();
  }
  assert.deepEqual(counts, COUNTS.guard);
  assert.equal(counts.weaker, 0, 'a request the old guard refused would be served');
});
