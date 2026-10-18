'use strict';

// GGUF metadata reader (GGUF_META_IMPL, retired in #1071: always Rust). tests/fixtures/gguf-meta.v1.json
// (byte-identical to noevia-rs crates/gguf/tests/fixtures/; CI compares them) holds what the
// former JS reader returned for synthetic headers. It is frozen: the JS reader and its generator are
// gone, and the file must not be regenerated through the Rust path (that would erase the
// independent reference). Here every row runs through readSummaryWasm (the file I/O here, the parse
// in dav-parse.wasm's gguf_summary) and must return the same summary or throw the same message;
// rows nested past 64 must be refused (the one place the Rust reader is stricter). Then the range
// reads (skipped bytes never read), the 24 MiB cap, real-size vocabularies, bounded rounds, a
// frozen seeded corpus of mutated and truncated headers (tests/fixtures/gguf-meta-mutations.v1.json),
// the reply-shape checks and the fail-closed paths. The WebAssembly half needs
// server/wasm/dav-parse.wasm (or DAV_PARSE_WASM); skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const gguf = require('../../server/gguf-meta.cjs');
const { readSummary, readSummaryWasm } = gguf;

const FILE = path.join(__dirname, '../fixtures/gguf-meta.v1.json');
const MUTATIONS_FILE = path.join(__dirname, '../fixtures/gguf-meta-mutations.v1.json');
const MUTATIONS = JSON.parse(fs.readFileSync(MUTATIONS_FILE, 'utf8'));
// The frozen references are pinned: changing either is a deliberate act that also changes these.
const PINS = { [FILE]: '3d41ef6b089b244da6640b4f28ba69084425c49e8c89aa9d41ef30c254b2b659', [MUTATIONS_FILE]: 'e58ec0e34a3253c9d387dab9750ae12f204afb9ad119316f0b3f076c70bfa726' };
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const gen = require('./gguf-fixture-lib.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-diff-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
let n = 0;
const tmp = (buf) => { const f = path.join(dir, `f${n++}.gguf`); fs.writeFileSync(f, buf); return f; };

// What a header with no keys summarizes to; the expectations below override single fields.
const EMPTY = { arch: '', name: '', contextLength: null, embeddingLength: null, blockCount: null, headCount: null, headCountKv: null, keyLength: null, valueLength: null,
  keyLengthSwa: null, valueLengthSwa: null, slidingWindow: null, slidingWindowPattern: null, sharedKvLayers: null, fullAttentionInterval: null, ssmStateSize: null,
  expertCount: null, nextnPredictLayers: null, hasChatTemplate: false };

/** The summary readSummaryWasm returns, or the message it throws. */
function rs(file, opts) { try { return { summary: readSummaryWasm(file, opts) }; } catch (e) { return { error: e.message }; } }

async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('the fixture file is frozen: its limits are the reader limits and no generator or JS reader remains', () => {
  assert.equal(fixtures.limits.maxArrayKept, 1024);
  assert.equal(fixtures.limits.maxStringKept, 256 * 1024);
  assert.equal(fixtures.version, 1);
  for (const [file, pin] of Object.entries(PINS)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), pin, path.basename(file));
  assert.equal(MUTATIONS.version, 1);
  for (const gone of ['readGguf', 'summarize', 'ggufImpl', 'MAX_ARRAY_KEPT']) assert.equal(gguf[gone], undefined, gone);
  assert.deepEqual(Object.keys(gguf).sort(), ['MAX_ROUNDS', 'MAX_SENT_WINDOWS', 'readSummary', 'readSummaryWasm']);
});

test('every fixture row: the frozen summary or the frozen error through the Rust port', { skip: skipWasm }, () => {
  davParseWasm.reset();
  let same = 0, refused = 0;
  for (const row of fixtures.cases) {
    const file = tmp(gen.unpackBytes(row.bytes));
    const got = rs(file);
    if ((row.nest || 0) > 64) {
      assert.deepEqual(got, { error: 'GGUF header could not be checked (depth)' }, row.name);
      refused++;
    } else if (row.summary !== undefined) {
      assert.ok(got.summary, `${row.name}: ${got.error}`);
      assert.equal(gen.encodeSummary(got.summary), row.summary, row.name);
      same++;
    } else {
      assert.deepEqual(got, { error: row.error }, row.name);
      same++;
    }
  }
  assert.ok(same > 380 && refused === 2, `${same} ${refused}`);
});

test('ranges: a header is read in doubling steps, skipped bytes never; past 24 MiB of read bytes it is refused', { skip: skipWasm }, () => {
  const { gguf: build, kv, STR, S, T } = gen;
  // 3 MiB of kept strings, then the architecture: read in doubling steps from 4 KiB.
  const mid = Array.from({ length: 15 }, (_, i) => kv(`pad${i}`, STR('p'.repeat(200 * 1024))));
  const three = tmp(build([...mid, kv('general.architecture', STR('late')), kv('late.block_count', S(T.u32, 12))]));
  const calls = [];
  const held = (segs) => segs.reduce((n, x) => n + x.bytes.length, 0);
  const spy = { ...davParseWasm, ggufSummary: (size, segs) => { calls.push(held(segs)); return davParseWasm.ggufSummary(size, segs); } };
  const got = readSummaryWasm(three, { wasm: spy });
  assert.deepStrictEqual(got, { ...EMPTY, arch: 'late', blockCount: 12 });
  assert.ok(calls.length >= 5 && calls.length < 16 && calls[0] === 4096 && calls.at(-1) > 3_000_000, String(calls));
  // A small cap shows the refusal without a big file.
  assert.deepEqual(rs(three, { maxWindow: 1024 * 1024 }), { error: 'GGUF header could not be checked (too_large)' });
  // The real cap: 25 MiB of kept strings before the last key.
  const big = Array.from({ length: 125 }, (_, i) => kv(`pad${i}`, STR('q'.repeat(210 * 1024))));
  const seventeen = tmp(build([...big, kv('general.architecture', STR('x'))]));
  // Intended: the 24 MiB read cap refuses this header (the former JS reader accepted any size up to 128 MiB).
  assert.deepEqual(rs(seventeen), { error: 'GGUF header could not be checked (too_large)' });
  // Skipped bytes are never read: a 20 MiB skipped array and 40 skipped 300 KiB strings around
  // the keys, ~32 MiB of header in all, cross as a few KiB.
  const longs = Array.from({ length: 40 }, (_, i) => kv(`long${i}`, STR('L'.repeat(300 * 1024))));
  const skipped = tmp(build([kv('v', [T.arr, Buffer.concat([gen.u32(T.u8), gen.u64(20 * 1024 * 1024), Buffer.alloc(20 * 1024 * 1024)])]), ...longs, kv('general.architecture', STR('s')), kv('s.block_count', S(T.u8, 5))]));
  calls.length = 0;
  const SKIPPED = { ...EMPTY, arch: 's', blockCount: 5 };
  assert.deepStrictEqual(readSummaryWasm(skipped, { wasm: spy }), SKIPPED);
  assert.ok(Math.max(...calls) < 512 * 1024 && fs.statSync(skipped).size > 30 * 1024 * 1024, String(calls));
  // Even with a 1 MiB cap the skipped regions cost nothing.
  assert.deepStrictEqual(rs(skipped, { maxWindow: 1024 * 1024 }), { summary: SKIPPED });
  davParseWasm.reset();
});

test('realistic vocabularies cross in few ranges and rounds', { skip: skipWasm }, () => {
  const { gguf: build, kv, STR, S, T, str, u32, u64 } = gen;
  let seed = 7;
  const rnd = (m) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % m; };
  const word = () => 'ab▁cdéfgh'.slice(0, 1 + rnd(8)) + rnd(100000);
  const strArr = (n, f) => [T.arr, Buffer.concat([u32(T.str), u64(n), ...Array.from({ length: n }, () => str(f()))])];
  const numArr = (type, n, w) => [T.arr, Buffer.concat([u32(type), u64(n), Buffer.alloc(n * w, 1)])];
  // In the order of `shapes` below (the architecture is masked: it is whatever the shape declares).
  const wants = [{ ...EMPTY, blockCount: 48, contextLength: 131072, hasChatTemplate: true }, { ...EMPTY, blockCount: 28, contextLength: 32768 }];
  let shapeNo = 0;
  const shapes = {
    gemma_262k: [kv('general.architecture', STR('gemma3')), kv('gemma3.block_count', S(T.u32, 48)), kv('tokenizer.ggml.model', STR('llama')),
      kv('tokenizer.ggml.tokens', strArr(262144, word)), kv('tokenizer.ggml.scores', numArr(T.f32, 262144, 4)), kv('tokenizer.ggml.token_type', numArr(T.i32, 262144, 4)),
      kv('tokenizer.chat_template', STR('{{ x }}'.repeat(2000))), kv('gemma3.context_length', S(T.u32, 131072))],
    qwen_151k_merges: [kv('general.architecture', STR('qwen2')), kv('qwen2.block_count', S(T.u32, 28)),
      kv('tokenizer.ggml.tokens', strArr(151936, word)), kv('tokenizer.ggml.token_type', numArr(T.i32, 151936, 4)),
      kv('tokenizer.ggml.merges', strArr(151387, () => `${word()} ${word()}`)), kv('qwen2.context_length', S(T.u32, 32768))],
  };
  for (const [name, kvs] of Object.entries(shapes)) {
    const file = tmp(build(kvs));
    let rounds = 0, most = 0;
    const spy = { ...davParseWasm, ggufSummary: (size, segs) => { rounds++; most = Math.max(most, segs.length); return davParseWasm.ggufSummary(size, segs); } };
    const got = readSummaryWasm(file, { wasm: spy });
    assert.ok(got.arch, name);
    assert.deepStrictEqual({ ...got, arch: '' }, wants[shapeNo++], name);
    assert.ok(rounds < 40 && most < 16, `${name}: ${rounds} rounds, ${most} ranges`);
    fs.rmSync(file);
  }
  davParseWasm.reset();
});

test('a crafted header cannot make the reads go on: rounds are bounded, the cap fails fast', { skip: skipWasm }, () => {
  const { gguf: build, kv, STR, T, u32, u64, str } = gen;
  // 6000 skipped strings of 5000 bytes: each skip jumps past a chunk, and the doubling reads that
  // bridge them would pass the 24 MiB cap.
  const many = tmp(build([kv('v', [T.arr, Buffer.concat([u32(T.str), u64(6000), ...Array.from({ length: 6000 }, () => str('z'.repeat(5000)))])]), kv('general.architecture', STR('m'))]));
  let calls = 0;
  const counting = { ...davParseWasm, ggufSummary: (size, segs) => { calls++; return davParseWasm.ggufSummary(size, segs); } };
  assert.deepEqual(rs(many, { wasm: counting }), { error: 'GGUF header could not be checked (too_large)' });
  assert.ok(calls < 64, String(calls));
  // Near a small cap the read fills it, so the next request over it fails at once.
  calls = 0;
  const three = tmp(build(Array.from({ length: 15 }, (_, i) => kv(`p${i}`, STR('p'.repeat(200 * 1024))))));
  assert.deepEqual(rs(three, { wasm: counting, maxWindow: 1024 * 1024 }), { error: 'GGUF header could not be checked (too_large)' });
  assert.ok(calls < 12, String(calls));
  // A module that keeps asking for scraps further on is cut off by the round limit.
  calls = 0;
  const big = tmp(Buffer.alloc(64 * 1024 * 1024));
  const scraps = { MAX_GGUF_WINDOW_BYTES: davParseWasm.MAX_GGUF_WINDOW_BYTES, MAX_GGUF_SEGMENTS: davParseWasm.MAX_GGUF_SEGMENTS, ggufSummary: () => { calls++; return { need: { at: calls * 10000, end: calls * 10000 + 1 } }; } };
  assert.deepEqual(rs(big, { wasm: scraps }), { error: 'GGUF header could not be checked (too_large)' });
  // MAX_ROUNDS calls in all, no more (#1107: the header comment and the limit agree).
  assert.equal(calls, gguf.MAX_ROUNDS);
  // Scraps each just past the held run: every round doubles the run, so the cap ends it fast.
  calls = 0;
  let last = 0;
  const onward = { ...scraps, ggufSummary: (size, segs) => { calls++; last = segs.at(-1).off + segs.at(-1).bytes.length; return { need: { at: last + 100, end: last + 101 } }; } };
  assert.deepEqual(rs(big, { wasm: onward }), { error: 'GGUF header could not be checked (too_large)' });
  assert.ok(calls < 20, String(calls));
  fs.rmSync(big);
});

test('seeded corpus: mutated and truncated headers give the frozen answers of the former JS reader', { skip: skipWasm }, () => {
  const { gguf: build, kv, STR, S, ARR, T, str, u32, u64 } = gen;
  const base = build([
    kv('general.architecture', STR('m')), kv('general.name', STR('Mut')),
    kv('m.block_count', S(T.u32, 8)), kv('m.context_length', S(T.u64, 8192)),
    kv('m.attention.head_count_kv', ARR(T.i32, [2, 2, 4].map((v) => S(T.i32, v)))),
    kv('m.attention.sliding_window_pattern', ARR(T.bool, [1, 0].map((v) => S(T.bool, v)))),
    kv('tokens', [T.arr, Buffer.concat([u32(T.str), u64(1030), ...Array.from({ length: 1030 }, (_, i) => str(`t${i}`))])]),
    kv('tokenizer.chat_template', STR('{{m}}')), kv('m.expert_count', S(T.f32, 3.5)),
  ]);
  assert.equal(crypto.createHash('sha256').update(base).digest('hex'), MUTATIONS.baseSha256, 'the base header is the one the answers were frozen for');
  assert.equal(MUTATIONS.rows.length, 400);
  let seed = MUTATIONS.seed;
  const rnd = (m) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % m; };
  for (let i = 0; i < 400; i++) {
    const buf = Buffer.from(base);
    for (let k = rnd(5); k > 0; k--) buf[rnd(buf.length)] = rnd(256);
    const file = tmp(rnd(3) === 0 ? buf.subarray(0, rnd(buf.length)) : buf);
    const want = MUTATIONS.outcomes[MUTATIONS.rows[i]];
    const got = rs(file);
    if (want.summary !== undefined) {
      assert.ok(got.summary, `iteration ${i}: ${got.error}`);
      assert.equal(gen.encodeSummary(got.summary), want.summary, `iteration ${i}`);
    } else assert.deepEqual(got, { error: want.error }, `iteration ${i}`);
    fs.rmSync(file);
  }
  davParseWasm.reset();
});

test('reply checks: the summary shape is exact, numbers revive, nothing else passes', () => {
  const s = EMPTY;
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

test('readSummary is always the Rust reader: no switch value selects a JS path (GGUF_META_IMPL retired, #1071)', async () => {
  const file = tmp(gen.gguf([gen.kv('general.architecture', gen.STR('d'))]));
  // A missing module throws whatever the old switch says; before #1071 =js (the default) read the file without it.
  for (const value of [undefined, '', 'js', 'rust', 'wasm']) {
    await withEnv({ GGUF_META_IMPL: value ?? '', DAV_PARSE_WASM: path.join(dir, 'no-such.wasm') }, () => {
      davParseWasm.reset();
      assert.throws(() => readSummary(file), /GGUF header could not be checked/, String(value));
      assert.throws(() => davParseWasm.verifyAtStartup(process.env), /dav-parse\.wasm/);
    });
  }
  davParseWasm.reset();
  if (!skipWasm) {
    await withEnv({ GGUF_META_IMPL: 'js' }, () => assert.deepStrictEqual(readSummary(file), { ...EMPTY, arch: 'd' }));
    davParseWasm.reset();
  }
});

test('a held 20 MiB window asking for jumped 4 KiB ranges stops at the byte budget (#1106)', () => {
  const MiB = 1024 * 1024, maxWindow = 24 * MiB;
  const big = tmp(Buffer.alloc(64 * MiB));
  let calls = 0, sent = 0;
  const stub = { MAX_GGUF_WINDOW_BYTES: maxWindow, MAX_GGUF_SEGMENTS: 512, ggufSummary: (size, segs) => {
    calls++;
    sent += segs.reduce((n, x) => n + x.bytes.length, 0);
    if (calls === 1) return { need: { at: 0, end: 20 * MiB } };
    const at = 21 * MiB + calls * 8192;
    return { need: { at, end: at + 4096 } };
  } };
  assert.deepEqual(rs(big, { wasm: stub }), { error: 'GGUF header could not be checked (too_large)' });
  assert.ok(sent <= gguf.MAX_SENT_WINDOWS * maxWindow, `${sent} bytes`);
  assert.ok(calls <= 12, String(calls));
  fs.rmSync(big);
});

test('a module asking for scraps forever stops at the round limit (#1106)', () => {
  const big = tmp(Buffer.alloc(8 * 1024 * 1024));
  let calls = 0;
  const stub = { MAX_GGUF_WINDOW_BYTES: 24 * 1024 * 1024, MAX_GGUF_SEGMENTS: 512, ggufSummary: () => { calls++; return { need: { at: calls * 10000, end: calls * 10000 + 1 } }; } };
  assert.deepEqual(rs(big, { wasm: stub }), { error: 'GGUF header could not be checked (too_large)' });
  // MAX_ROUNDS calls in all, no more (#1107: the header comment and the limit agree).
  assert.equal(calls, gguf.MAX_ROUNDS);
  fs.rmSync(big);
});
