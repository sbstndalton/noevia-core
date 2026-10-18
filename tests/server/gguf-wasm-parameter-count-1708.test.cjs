'use strict';
// #1708: the Rust GGUF reader (the only reader since #1071; was GGUF_META_IMPL=wasm, live) returns parameterCount since #1197, but the
// glue refused any summary with that key ("unexpected keys"). Every real model has a parameter count,
// so every footprint read failed and Performance -> Memory budget said "No estimate" for every row.
// Synthetic headers only; skipped without dav-parse.wasm unless DAV_PARSE_WASM_REQUIRED=1.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const { readSummaryWasm } = require('../../server/gguf-meta.cjs');
const { gguf, kv, S, str, u32, u64, arch } = require('./gguf-fixture-lib.cjs');

const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skip = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const EMPTY = { arch: '', name: '', contextLength: null, embeddingLength: null, blockCount: null, headCount: null, headCountKv: null, keyLength: null, valueLength: null,
  keyLengthSwa: null, valueLengthSwa: null, slidingWindow: null, slidingWindowPattern: null, sharedKvLayers: null, fullAttentionInterval: null, ssmStateSize: null,
  expertCount: null, nextnPredictLayers: null, hasChatTemplate: false };
const LLAMA = { ...EMPTY, arch: 'llama', blockCount: 1, contextLength: 8192 };
const BASE = [arch('llama'), kv('llama.block_count', S(4, 1)), kv('llama.context_length', S(4, 8192))];
const info = (name, dims, type = 0) => Buffer.concat([str(name), u32(dims.length), ...dims.map((d) => u64(d)), u32(type), u64(0)]);
const build = (kvs, infos = []) => Buffer.concat([gguf(kvs, { tensors: infos.length }), ...infos]);
const TENSORS = [info('token_embd.weight', [4096, 32000]), info('output_norm.weight', [4096])];

function write(t, buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-wasm-1708-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'synthetic.gguf');
  fs.writeFileSync(file, buf);
  return file;
}

test('#1708 a header with a tensor-info parameter count reads through the Rust path with the frozen summary', { skip }, (t) => {
  const file = write(t, build(BASE, TENSORS));
  assert.deepStrictEqual(readSummaryWasm(file), { parameterCount: 4096 * 32000 + 4096, ...LLAMA });
});

test('#1708 a declared general.parameter_count reads through the Rust path with the frozen summary', { skip }, (t) => {
  const file = write(t, build([...BASE, kv('general.parameter_count', S(10, 7000000000))], TENSORS));
  assert.deepStrictEqual(readSummaryWasm(file), { parameterCount: 7000000000, ...LLAMA });
});

test('#1708 no tensors still means no parameterCount key on the Rust path', { skip }, (t) => {
  const file = write(t, build(BASE, []));
  const summary = readSummaryWasm(file);
  assert.equal(Object.hasOwn(summary, 'parameterCount'), false);
  assert.deepStrictEqual(summary, LLAMA);
});

test('#1708 the glue still refuses a summary with a stray key or a bad parameterCount', { skip }, () => {
  const reply = davParseWasm.ggufSummaryReply;
  const ok = { arch: 'llama', name: '', contextLength: 8192, embeddingLength: null, blockCount: 1, headCount: null, headCountKv: null, keyLength: null, valueLength: null, keyLengthSwa: null, valueLengthSwa: null, slidingWindow: null, slidingWindowPattern: null, sharedKvLayers: null, fullAttentionInterval: null, ssmStateSize: null, expertCount: null, nextnPredictLayers: null, hasChatTemplate: false };
  assert.deepStrictEqual(reply({ parameterCount: 12, ...ok }), { parameterCount: 12, ...ok });
  assert.deepStrictEqual(reply(ok), ok);
  assert.throws(() => reply({ ...ok, stray: 1 }), /unexpected keys/);
  for (const bad of [null, 'x', -1, 0, { $num: 'NaN' }, { $num: 'Infinity' }]) assert.throws(() => reply({ parameterCount: bad, ...ok }), /parameterCount|unexpected/, JSON.stringify(bad));
});
