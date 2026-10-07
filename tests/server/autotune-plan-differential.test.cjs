'use strict';

// Shared fixtures for #1003: tests/fixtures/autotune-plan.v1.json (byte-identical to noevia-rs
// crates/autotune-plan/tests/fixtures/; CI compares them) replayed through dav-parse.wasm's
// autotune_plan. The expectations come from tools/gen-autotune-plan-fixtures.cjs's independent
// JS reference of the planner, so this is Rust against JS, step by step. The WebAssembly half
// needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it unless
// DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');

const FILE = path.join(__dirname, '../fixtures/autotune-plan.v1.json');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

const GENERATOR = path.join(__dirname, '../../tools/gen-autotune-plan-fixtures.cjs');
// The shipped runtime image has no tools/ (CI mounts only tests/ there).
test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

const resultOf = (expect, outcome) => (['probe', 'verify'].includes(expect.step) ? { step: expect.step, ctx: expect.ctx, kv: expect.kv, outcome }
  : expect.step === 'phase' ? { step: 'phase', id: expect.id, outcome } : { step: 'serving', outcome });

test('runs: wasm autotune_plan gives the reference step at every point', { skip: skipWasm }, () => {
  davParseWasm.reset();
  assert.equal(fixtures.limits.maxInputBytes, davParseWasm.MAX_PLAN_BYTES);
  assert.ok(fixtures.runs.length >= 40);
  let steps = 0;
  for (const run of fixtures.runs) {
    const model = fixtures.models[run.model], results = [];
    for (const [n, t] of run.trace.entries()) {
      const request = { facts: model.facts, ladder: model.ladder, memory: fixtures.memory[run.memory], kv: fixtures.kv[run.kv], results };
      assert.deepEqual(davParseWasm.autotunePlan(request), t.expect, `${run.name} step ${n + 1}`);
      steps++;
      if ('outcome' in t) results.push(resultOf(t.expect, t.outcome));
    }
  }
  assert.ok(steps >= 300);
});

test('errors: wasm autotune_plan refuses with a fixed code', { skip: skipWasm }, () => {
  davParseWasm.reset();
  for (const c of fixtures.errors) {
    const text = c.text + ' '.repeat(c.pad);
    assert.throws(() => davParseWasm.autotunePlanText(text), (e) => e instanceof davParseWasm.DavParseError && e.reason === c.expect.error, c.name);
  }
});
