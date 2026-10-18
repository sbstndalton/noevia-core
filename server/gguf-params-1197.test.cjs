'use strict';
// #1197: (read through the Rust reader since #1071) a GGUF that declares no general.parameter_count still has a parameter count: the element
// counts of its tensor-info block, summed (never the weights). Synthetic headers only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const davParseWasm = require('./dav-parse-wasm.cjs');
const { readSummaryWasm } = require('./gguf-meta.cjs');
const { gguf, kv, STR, S, str, u32, u64, arch } = require('../tests/server/gguf-fixture-lib.cjs');

const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skip = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const BASE = [arch('llama'), kv('llama.block_count', S(4, 1))];
const info = (name, dims, type = 0) => Buffer.concat([str(name), u32(dims.length), ...dims.map((d) => u64(d)), u32(type), u64(0)]);
const build = (kvs, infos = [], tensors = infos.length) => Buffer.concat([gguf(kvs, { tensors }), ...infos]);
const TENSORS = [info('token_embd.weight', [4096, 32000]), info('blk.0.attn_q.weight', [4096, 4096]), info('output_norm.weight', [4096])];
const TOTAL = 4096 * 32000 + 4096 * 4096 + 4096;

function write(t, buf) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-params-1197-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'synthetic.gguf');
  fs.writeFileSync(file, buf);
  return file;
}
const countOf = (t, buf) => readSummaryWasm(write(t, buf)).parameterCount;

test('#1197 the count is the sum of the tensor element counts when the header declares none', { skip }, (t) => {
  assert.equal(countOf(t, build(BASE, TENSORS)), TOTAL);
});

test('#1197 a declared general.parameter_count still wins', { skip }, (t) => {
  assert.equal(countOf(t, build([...BASE, kv('general.parameter_count', S(10, 7000000000))], TENSORS)), 7000000000);
});

test('#1197 a zero-dimension tensor is one element; no tensors means no count key', { skip }, (t) => {
  assert.equal(countOf(t, build(BASE, [info('scalar', [])])), 1);
  assert.equal(Object.hasOwn(readSummaryWasm(write(t, build(BASE, []))), 'parameterCount'), false);
});

test('#1197 a cut-short tensor block gives no count and does not throw', { skip }, (t) => {
  assert.equal(Object.hasOwn(readSummaryWasm(write(t, build(BASE, TENSORS.slice(0, 1), 3))), 'parameterCount'), false);
});

test('#1197 hostile tensor blocks give no count', { skip }, (t) => {
  assert.equal(Object.hasOwn(readSummaryWasm(write(t, build(BASE, [], 2 ** 40))), 'parameterCount'), false, 'too many tensors');
  assert.equal(Object.hasOwn(readSummaryWasm(write(t, build(BASE, [info('odd', [1, 1, 1, 1, 1])]))), 'parameterCount'), false, 'more than four dimensions');
  assert.equal(Object.hasOwn(readSummaryWasm(write(t, build(BASE, [info('huge', [2 ** 40, 2 ** 40, 2 ** 40])]))), 'parameterCount'), false, 'overflow');
});

test('#1591 shard 1 of a split model has no count of its own: its tensors are a fraction of the model', { skip }, (t) => {
  const split = (count) => [...BASE, kv('split.no', S(2, 0)), kv('split.count', S(2, count))];
  assert.equal(Object.hasOwn(readSummaryWasm(write(t, build(split(3), TENSORS))), 'parameterCount'), false, 'three shards: no count');
  assert.equal(countOf(t, build([...split(3), kv('general.parameter_count', S(10, 7000000000))], TENSORS)), 7000000000, 'a declared count still wins');
  assert.equal(countOf(t, build(split(1), TENSORS)), TOTAL, 'split.count 1 is a whole file');
  assert.equal(countOf(t, build(split(0), TENSORS)), TOTAL, 'split.count 0 is a whole file');
});
