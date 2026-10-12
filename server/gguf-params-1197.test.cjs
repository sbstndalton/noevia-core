'use strict';
// #1197: a GGUF that declares no general.parameter_count still has a parameter count: the element
// counts of its tensor-info block, summed (never the weights). Synthetic headers only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { readGguf, summarize } = require('./gguf-meta.cjs');
const { gguf, kv, STR, S, str, u32, u64, arch } = require('../tests/server/gguf-fixture-lib.cjs');

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
const countOf = (t, buf) => summarize(readGguf(write(t, buf))).parameterCount;

test('#1197 the count is the sum of the tensor element counts when the header declares none', (t) => {
  assert.equal(countOf(t, build(BASE, TENSORS)), TOTAL);
});

test('#1197 a declared general.parameter_count still wins', (t) => {
  assert.equal(countOf(t, build([...BASE, kv('general.parameter_count', S(10, 7000000000))], TENSORS)), 7000000000);
});

test('#1197 a zero-dimension tensor is one element; no tensors means no count key', (t) => {
  assert.equal(countOf(t, build(BASE, [info('scalar', [])])), 1);
  assert.equal(Object.hasOwn(summarize(readGguf(write(t, build(BASE, [])))), 'parameterCount'), false);
});

test('#1197 a cut-short tensor block gives no count and does not throw', (t) => {
  assert.equal(Object.hasOwn(summarize(readGguf(write(t, build(BASE, TENSORS.slice(0, 1), 3)))), 'parameterCount'), false);
});

test('#1197 hostile tensor blocks give no count', (t) => {
  assert.equal(Object.hasOwn(summarize(readGguf(write(t, build(BASE, [], 2 ** 40)))), 'parameterCount'), false, 'too many tensors');
  assert.equal(Object.hasOwn(summarize(readGguf(write(t, build(BASE, [info('odd', [1, 1, 1, 1, 1])])))), 'parameterCount'), false, 'more than four dimensions');
  assert.equal(Object.hasOwn(summarize(readGguf(write(t, build(BASE, [info('huge', [2 ** 40, 2 ** 40, 2 ** 40])])))), 'parameterCount'), false, 'overflow');
});

test('#1197 the KV reader is unchanged: the same keys come back as before', (t) => {
  const kvs = readGguf(write(t, build(BASE, TENSORS)));
  assert.deepEqual(Object.keys(kvs).sort(), ['general.architecture', 'llama.block_count']);
});
