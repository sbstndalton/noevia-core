'use strict';

// GGUF_META_IMPL: tests/fixtures/gguf-meta.v1.json (byte-identical to noevia-rs
// crates/gguf/tests/fixtures/; CI compares them) holds what gguf-meta.cjs returns for synthetic
// headers, printed by tools/gen-gguf-meta-fixtures.cjs from the JS itself. Here every row runs
// through readSummaryWasm (the file I/O here, the parse in dav-parse.wasm's gguf_summary) and must
// return the same summary or throw the same message; rows nested past 64 must be refused. Then
// the range reads (skipped bytes never read), the 16 MiB cap, seeded live JS-vs-wasm mutations, the reply-shape checks and
// the fail-closed paths. The WebAssembly half needs server/wasm/dav-parse.wasm (or
// DAV_PARSE_WASM); skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const gguf = require('../../server/gguf-meta.cjs');
const { readGguf, summarize, readSummary, readSummaryWasm, ggufImpl } = gguf;

const FILE = path.join(__dirname, '../fixtures/gguf-meta.v1.json');
const GENERATOR = path.join(__dirname, '../../tools/gen-gguf-meta-fixtures.cjs');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const gen = require('./gguf-fixture-lib.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-diff-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const tmp = (buf) => { const f = path.join(dir, `f${n++}.gguf`); fs.writeFileSync(f, buf); return f; };

/** summarize(readGguf(file)) or the message it throws. */
function js(file) { try { return { summary: summarize(readGguf(file)) }; } catch (e) { return { error: e.message }; } }
function rs(file, opts) { try { return { summary: readSummaryWasm(file, opts) }; } catch (e) { return { error: e.message }; } }

async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GGUF_META_IMPL: 'wasm' } });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
  assert.equal(fixtures.limits.maxArrayKept, gguf.MAX_ARRAY_KEPT);
});

test('every fixture row: the same summary or the same error through the Rust port', { skip: skipWasm }, () => {
  davParseWasm.reset();
  let same = 0, refused = 0;
  for (const row of fixtures.cases) {
    const file = tmp(gen.unpackBytes(row.bytes));
    const want = js(file);
    // The table is the JS today, not only when it was printed.
    if (want.summary) assert.equal(gen.encodeSummary(want.summary), row.summary, row.name);
    else assert.equal(want.error, row.error, row.name);
    const got = rs(file);
    if ((row.nest || 0) > 64) {
      assert.deepEqual(got, { error: 'GGUF header could not be checked (depth)' }, row.name);
      refused++;
    } else {
      assert.deepStrictEqual(got, want, row.name);
      same++;
    }
  }
  assert.ok(same > 380 && refused === 2, `${same} ${refused}`);
});

test('ranges: a header is read in doubling steps, skipped bytes never; past 16 MiB of read bytes it is refused', { skip: skipWasm }, () => {
  const { gguf: build, kv, STR, S, T } = gen;
  // 3 MiB of kept strings, then the architecture: read in doubling steps from 4 KiB.
  const mid = Array.from({ length: 15 }, (_, i) => kv(`pad${i}`, STR('p'.repeat(200 * 1024))));
  const three = tmp(build([...mid, kv('general.architecture', STR('late')), kv('late.block_count', S(T.u32, 12))]));
  const calls = [];
  const held = (segs) => segs.reduce((n, x) => n + x.bytes.length, 0);
  const spy = { ...davParseWasm, ggufSummary: (size, segs) => { calls.push(held(segs)); return davParseWasm.ggufSummary(size, segs); } };
  const got = readSummaryWasm(three, { wasm: spy });
  assert.deepStrictEqual(got, summarize(readGguf(three)));
  assert.equal(got.blockCount, 12);
  assert.ok(calls.length >= 5 && calls.length < 16 && calls[0] === 4096 && calls.at(-1) > 3_000_000, String(calls));
  // A small cap shows the refusal without a big file; the JS reads it fine.
  assert.deepEqual(rs(three, { maxWindow: 1024 * 1024 }), { error: 'GGUF header could not be checked (too_large)' });
  // The real cap: 17 MiB of kept strings before the last key.
  const big = Array.from({ length: 85 }, (_, i) => kv(`pad${i}`, STR('q'.repeat(210 * 1024))));
  const seventeen = tmp(build([...big, kv('general.architecture', STR('x'))]));
  assert.equal(summarize(readGguf(seventeen)).arch, 'x');
  assert.deepEqual(rs(seventeen), { error: 'GGUF header could not be checked (too_large)' });
  // Skipped bytes are never read: a 20 MiB skipped array and 40 skipped 300 KiB strings around
  // the keys, ~32 MiB of header in all, cross as a few KiB.
  const longs = Array.from({ length: 40 }, (_, i) => kv(`long${i}`, STR('L'.repeat(300 * 1024))));
  const skipped = tmp(build([kv('v', [T.arr, Buffer.concat([gen.u32(T.u8), gen.u64(20 * 1024 * 1024), Buffer.alloc(20 * 1024 * 1024)])]), ...longs, kv('general.architecture', STR('s')), kv('s.block_count', S(T.u8, 5))]));
  calls.length = 0;
  assert.deepStrictEqual(readSummaryWasm(skipped, { wasm: spy }), summarize(readGguf(skipped)));
  assert.equal(js(skipped).summary.blockCount, 5);
  assert.ok(Math.max(...calls) < 512 * 1024 && fs.statSync(skipped).size > 30 * 1024 * 1024, String(calls));
  // Even with a 1 MiB cap the skipped regions cost nothing.
  assert.deepStrictEqual(rs(skipped, { maxWindow: 1024 * 1024 }), js(skipped));
  davParseWasm.reset();
});

test('seeded live differential: mutated and truncated headers agree', { skip: skipWasm }, () => {
  const { gguf: build, kv, STR, S, ARR, T, str, u32, u64 } = gen;
  const base = build([
    kv('general.architecture', STR('m')), kv('general.name', STR('Mut')),
    kv('m.block_count', S(T.u32, 8)), kv('m.context_length', S(T.u64, 8192)),
    kv('m.attention.head_count_kv', ARR(T.i32, [2, 2, 4].map((v) => S(T.i32, v)))),
    kv('m.attention.sliding_window_pattern', ARR(T.bool, [1, 0].map((v) => S(T.bool, v)))),
    kv('tokens', [T.arr, Buffer.concat([u32(T.str), u64(1030), ...Array.from({ length: 1030 }, (_, i) => str(`t${i}`))])]),
    kv('tokenizer.chat_template', STR('{{m}}')), kv('m.expert_count', S(T.f32, 3.5)),
  ]);
  let seed = 1234567;
  const rnd = (m) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % m; };
  for (let i = 0; i < 400; i++) {
    const buf = Buffer.from(base);
    for (let k = rnd(5); k > 0; k--) buf[rnd(buf.length)] = rnd(256);
    const file = tmp(rnd(3) === 0 ? buf.subarray(0, rnd(buf.length)) : buf);
    assert.deepStrictEqual(rs(file), js(file), `iteration ${i}`);
  }
  davParseWasm.reset();
});

test('reply checks: the summary shape is exact, numbers revive, nothing else passes', () => {
  const s = summarize({});
  const enc = JSON.parse(gen.encodeSummary(s));
  assert.deepStrictEqual(davParseWasm.ggufSummaryReply(enc), s);
  const tagged = { ...enc, contextLength: { $num: '-0' }, headCountKv: [{ $num: 'NaN' }, { array: true, count: 2000 }, 'x', null, true] };
  const r = davParseWasm.ggufSummaryReply(tagged);
  assert.ok(Object.is(r.contextLength, -0));
  assert.ok(Number.isNaN(r.headCountKv[0]));
  assert.deepStrictEqual(r.headCountKv.slice(1), [{ array: true, count: 2000 }, 'x', null, true]);
  const bad = [
    { ...enc, extra: 1 }, { ...enc, arch: 1 }, { ...enc, hasChatTemplate: 'yes' },
    { ...enc, contextLength: { $num: 'nan' } }, { ...enc, contextLength: 'x' }, { ...enc, contextLength: [] },
    { ...enc, headCountKv: { array: true, count: 5 } }, { ...enc, headCountKv: { array: true, count: 2000, more: 1 } },
    { ...enc, slidingWindowPattern: { a: 1 } },
  ];
  const { arch: _drop, ...missing } = enc;
  bad.push(missing);
  for (const b of bad) assert.throws(() => davParseWasm.ggufSummaryReply(b), (e) => e instanceof davParseWasm.DavParseError && e.reason === 'reply');
  const seg = (off, n) => ({ off, bytes: new Uint8Array(n) });
  for (const [size, segs] of [[3, [seg(0, 4)]], ['4', [seg(0, 4)]], [100, [seg(10, 2), seg(0, 4)]], [100, [seg(0, 4), seg(2, 4)]], [100, [seg(0, 0)]], [100, 'x'], [100, [{ off: 0, bytes: [1] }]]]) {
    assert.throws(() => davParseWasm.ggufSummary(size, segs), (e) => e.reason === 'input', JSON.stringify([size, segs]));
  }
  assert.throws(() => davParseWasm.ggufSummary(1e9, [seg(0, davParseWasm.MAX_GGUF_WINDOW_BYTES + 1)]), (e) => e.reason === 'too_large');
  assert.throws(() => davParseWasm.ggufSummary(1e9, Array.from({ length: davParseWasm.MAX_GGUF_SEGMENTS + 1 }, (_, i) => seg(i * 2, 1))), (e) => e.reason === 'too_large');
});

test('fails closed: a fault, a bad need or an unknown fail never falls back to the JS', () => {
  const file = tmp(gen.gguf([gen.kv('general.architecture', gen.STR('x'))]));
  const fake = (reply) => ({ MAX_GGUF_WINDOW_BYTES: davParseWasm.MAX_GGUF_WINDOW_BYTES, ggufSummary: () => (typeof reply === 'function' ? reply() : reply) });
  const trap = () => { throw new davParseWasm.DavParseError('dav-parse module failed', 'trap'); };
  assert.throws(() => readSummaryWasm(file, { wasm: fake(trap) }), { message: 'GGUF header could not be checked (trap)' });
  assert.throws(() => readSummaryWasm(file, { wasm: fake({ need: 3 }) }), { message: 'GGUF header could not be checked (reply)' });
  assert.throws(() => readSummaryWasm(file, { wasm: fake({ need: { at: 5, end: 5 } }) }), { message: 'GGUF header could not be checked (reply)' });
  assert.throws(() => readSummaryWasm(file, { wasm: fake({ need: { at: 0, end: 1e9 } }) }), { message: 'GGUF header could not be checked (reply)' });
  assert.throws(() => readSummaryWasm(file, { wasm: fake({ fail: 'other' }) }), { message: 'GGUF header could not be checked (reply)' });
  assert.throws(() => readSummaryWasm(file, { wasm: fake({ fail: 'version', value: 9 }) }), { message: 'Unsupported GGUF version 9' });
  // A file that shrinks while it is read: the missing bytes are an end of header.
  const shrunk = tmp(Buffer.alloc(10));
  const lying = { MAX_GGUF_WINDOW_BYTES: 64, ggufSummary: () => { fs.truncateSync(shrunk, 0); return { need: { at: 0, end: 10 } }; } };
  assert.throws(() => readSummaryWasm(shrunk, { wasm: lying }), { message: 'Unexpected end of GGUF header' });
});

test('GGUF_META_IMPL: js by default, wasm when asked, anything else is js with a warning', async (t) => {
  assert.equal(ggufImpl({}), 'js');
  assert.equal(ggufImpl({ GGUF_META_IMPL: '' }), 'js');
  assert.equal(ggufImpl({ GGUF_META_IMPL: ' WASM ' }), 'wasm');
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(ggufImpl({ GGUF_META_IMPL: 'rust' }), 'js');
  assert.equal(warn.mock.callCount(), 1);
  assert.ok(davParseWasm.IMPL_FLAGS.includes('GGUF_META_IMPL'));
  assert.deepEqual(davParseWasm.wasmFlags({ GGUF_META_IMPL: 'wasm' }), ['GGUF_META_IMPL']);
  const file = tmp(gen.gguf([gen.kv('general.architecture', gen.STR('d'))]));
  // The default path never touches the module, even a missing one; wasm with a missing one throws.
  await withEnv({ GGUF_META_IMPL: 'js', DAV_PARSE_WASM: path.join(dir, 'no-such.wasm') }, () => {
    davParseWasm.reset();
    assert.equal(readSummary(file).arch, 'd');
  });
  await withEnv({ GGUF_META_IMPL: 'wasm', DAV_PARSE_WASM: path.join(dir, 'no-such.wasm') }, () => {
    davParseWasm.reset();
    assert.throws(() => readSummary(file), /GGUF header could not be checked/);
    assert.throws(() => davParseWasm.verifyAtStartup(process.env), /GGUF_META_IMPL set to wasm/);
  });
  davParseWasm.reset();
});
