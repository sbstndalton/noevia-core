'use strict';

// #1108: does readSummaryWasm's byte budget (MAX_SENT_WINDOWS x maxWindow, #1106) refuse a REAL
// large-vocabulary header? The first 32 MiB (one Range request each, no full download) of public
// Gemma 3 / Gemma 4 (262k vocab) and Qwen3 (151k vocab, merges) GGUFs are fetched by
// tools/fetch-real-gguf-headers.cjs into tests/fixtures/real-gguf-headers/ (gitignored). Each
// becomes a sparse file of the real total size (only the head holds bytes; the reader never goes
// past the key/value block), then the Rust path must return exactly the JS summary, inside the
// budget with margin. Skipped without the fixtures or dav-parse.wasm unless
// REAL_GGUF_HEADERS_REQUIRED=1 / DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const gguf = require('../../server/gguf-meta.cjs');
const { readGguf, summarize, readSummaryWasm, MAX_ROUNDS, MAX_SENT_WINDOWS } = gguf;

const DIR = path.join(__dirname, '../fixtures/real-gguf-headers');
const manifestFile = path.join(DIR, 'manifest.json');
const have = fs.existsSync(manifestFile);
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skip = (!have && process.env.REAL_GGUF_HEADERS_REQUIRED !== '1' && 'real GGUF headers not fetched (node tools/fetch-real-gguf-headers.cjs)')
  || (!fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built');
const manifest = have ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : [];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-real-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('the fixtures are present when required', () => {
  if (process.env.REAL_GGUF_HEADERS_REQUIRED === '1') assert.ok(manifest.length >= 3);
});

for (const entry of manifest) {
  test(`${entry.name}: the real header is not refused by the byte budget and equals the JS summary`, { skip }, (t) => {
    const file = path.join(dir, `${entry.name}.gguf`);
    fs.writeFileSync(file, fs.readFileSync(path.join(DIR, `${entry.name}.head`)));
    fs.truncateSync(file, entry.totalSize); // sparse: the size the module sees is the real one
    const want = summarize(readGguf(file));
    let rounds = 0, sent = 0, widest = 0;
    const spy = { ...davParseWasm, ggufSummary: (size, segs) => {
      rounds++;
      const held = segs.reduce((n, x) => n + x.bytes.length, 0);
      sent += held; widest = Math.max(widest, held);
      return davParseWasm.ggufSummary(size, segs);
    } };
    const got = readSummaryWasm(file, { wasm: spy });
    assert.deepStrictEqual(got, want);
    const budget = MAX_SENT_WINDOWS * davParseWasm.MAX_GGUF_WINDOW_BYTES;
    const mib = (n) => (n / 1048576).toFixed(2);
    t.diagnostic(`${entry.name}: arch=${got.arch} rounds=${rounds}/${MAX_ROUNDS} widest window=${mib(widest)} MiB sent=${mib(sent)} of ${mib(budget)} MiB (${(100 * sent / budget).toFixed(1)}%)`);
    console.log(`[budget] ${entry.name}: rounds ${rounds}/${MAX_ROUNDS}, window ${mib(widest)}/${mib(davParseWasm.MAX_GGUF_WINDOW_BYTES)} MiB, sent ${mib(sent)}/${mib(budget)} MiB`);
    // Meaningful bound, real headroom: a real header uses at most half the budget and a fraction of the rounds.
    assert.ok(sent <= budget / 2, `uses ${sent} of ${budget}`);
    assert.ok(rounds <= MAX_ROUNDS / 2, `${rounds} rounds`);
    davParseWasm.reset();
  });
}

// Always on (no download): the real layout (tokens, scores, token_type, merges, chat template) scaled
// to a ~20 MiB metadata block, near the 24 MiB window cap and about twice the largest real header
// above. It must still be summarised, and stay inside the budget.
test('a synthetic ~20 MiB large-vocabulary header stays inside the byte budget', { skip: !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built' }, (t) => {
  const gen = require('./gguf-fixture-lib.cjs');
  const { gguf: build, kv, STR, S, T, str, u32, u64 } = gen;
  const n = 262144;
  const tok = (i) => str(`▁tok${i}`.padEnd(40, 'x')); // ~48 bytes each: 12.5 MiB of tokens
  const strArr = (count, f) => [T.arr, Buffer.concat([u32(T.str), u64(count), ...Array.from({ length: count }, (_, i) => f(i))])];
  const numArr = (type, count, w) => [T.arr, Buffer.concat([u32(type), u64(count), Buffer.alloc(count * w, 1)])];
  const file = path.join(dir, 'synthetic20.gguf');
  fs.writeFileSync(file, build([
    kv('general.architecture', STR('gemma4')), kv('gemma4.block_count', S(T.u32, 48)), kv('gemma4.context_length', S(T.u32, 131072)),
    kv('tokenizer.ggml.tokens', strArr(n, tok)), kv('tokenizer.ggml.scores', numArr(T.f32, n, 4)), kv('tokenizer.ggml.token_type', numArr(T.i32, n, 4)),
    kv('tokenizer.ggml.merges', strArr(60000, (i) => str(`m${i} `.padEnd(60, 'y')))), kv('tokenizer.chat_template', STR('{{ x }}'.repeat(8000))),
  ]));
  const size = fs.statSync(file).size;
  assert.ok(size > 18 * 1048576 && size < 22 * 1048576, String(size));
  let sent = 0;
  const spy = { ...davParseWasm, ggufSummary: (s, segs) => { sent += segs.reduce((a, x) => a + x.bytes.length, 0); return davParseWasm.ggufSummary(s, segs); } };
  assert.deepStrictEqual(readSummaryWasm(file, { wasm: spy }), summarize(readGguf(file)));
  const budget = MAX_SENT_WINDOWS * davParseWasm.MAX_GGUF_WINDOW_BYTES;
  t.diagnostic(`synthetic ${(size / 1048576).toFixed(1)} MiB header: sent ${(sent / 1048576).toFixed(1)} MiB of ${(budget / 1048576).toFixed(0)} MiB`);
  console.log(`[budget] synthetic ${(size / 1048576).toFixed(1)} MiB: sent ${(sent / 1048576).toFixed(1)}/${(budget / 1048576).toFixed(0)} MiB`);
  assert.ok(sent <= budget / 2, `uses ${sent} of ${budget}`);
  davParseWasm.reset();
});
