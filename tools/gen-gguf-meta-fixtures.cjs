#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for the GGUF metadata reader (GGUF_META_IMPL, gguf-meta.cjs).
// The same file is committed byte-for-byte in sbstndalton/noevia-rs
// (crates/gguf/tests/fixtures/gguf-meta.v1.json); noevia-core CI compares them.
//   node tools/gen-gguf-meta-fixtures.cjs > tests/fixtures/gguf-meta.v1.json
//
// Every file is synthetic, built here; every expectation is what the JS itself returns:
// summarize(readGguf(file)) written as canonical ASCII JSON (encodeSummary below: keys in the JS
// order, numbers as Number#toString, NaN/±Infinity/-0 as {"$num":"…"}, every unit outside
// 0x20-0x7e escaped), or the message readGguf throws.
//
// Rows: { name, bytes, summary } | { name, bytes, error }; `bytes` is a list of parts, a hex
// string or [byteHex, count] for a run of one byte (so 256 KiB strings stay small). `nest` (when present) is the deepest
// array nesting in the file: the Rust port refuses more than 64 levels, which the JS accepts.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readGguf, summarize } = require(path.join(__dirname, '..', 'server', 'gguf-meta.cjs'));

const { encodeSummary, packBytes, unpackBytes, T, u32, u64, str, scalar, S, STR, ARR, kv, gguf, arch } = require(path.join(__dirname, '..', 'tests', 'server', 'gguf-fixture-lib.cjs'));

// --- cases -----------------------------------------------------------------------------------
const cases = [];
const add = (name, buf, extra = {}) => cases.push({ name, buf, ...extra });

const FIELDS = ['context_length', 'embedding_length', 'block_count', 'attention.head_count', 'attention.head_count_kv', 'attention.key_length', 'attention.value_length', 'attention.key_length_swa', 'attention.value_length_swa', 'attention.sliding_window', 'attention.sliding_window_pattern', 'attention.shared_kv_layers', 'full_attention_interval', 'ssm.state_size', 'expert_count', 'nextn_predict_layers'];

add('llama_full', gguf([
  arch('llama'), kv('general.name', STR('Synthetic Llama 8B')),
  kv('llama.context_length', S(T.u32, 131072)), kv('llama.embedding_length', S(T.u32, 4096)),
  kv('llama.block_count', S(T.u32, 32)), kv('llama.attention.head_count', S(T.u32, 32)),
  kv('llama.attention.head_count_kv', S(T.u32, 8)), kv('llama.rope.freq_base', S(T.f32, 500000)),
  kv('tokenizer.ggml.tokens', ARR(T.str, Array.from({ length: 1500 }, (_, i) => str(`tok${i}`)))),
  kv('tokenizer.ggml.scores', ARR(T.f32, Array.from({ length: 1500 }, (_, i) => scalar(T.f32, i / 7)))),
  kv('tokenizer.chat_template', STR('{% for m in messages %}{{ m.content }}{% endfor %}')),
], { tensors: 291 }));
add('gemma_swa_arrays', gguf([
  arch('gemma3'), kv('general.name', STR('Synthetic Gemma')),
  kv('gemma3.block_count', S(T.u32, 6)),
  kv('gemma3.attention.head_count_kv', ARR(T.i32, [4, 4, 4, 4, 4, 8].map((v) => scalar(T.i32, v)))),
  kv('gemma3.attention.sliding_window_pattern', ARR(T.bool, [1, 1, 1, 1, 1, 0].map((v) => scalar(T.bool, v)))),
  kv('gemma3.attention.sliding_window', S(T.u32, 1024)), kv('gemma3.attention.key_length', S(T.u32, 256)),
  kv('gemma3.attention.key_length_swa', S(T.u32, 128)), kv('gemma3.attention.shared_kv_layers', S(T.u32, 2)),
  kv('gemma3.attention.head_count', ARR(T.u32, [8, 8, 16, 16, 16].map((v) => scalar(T.u32, v)))),
], { version: 2 }));
add('zero_kv', gguf([]));
add('version_2', gguf([arch('x')], { version: 2 }));
add('no_arch_dot_keys', gguf([kv('.context_length', S(T.u32, 7)), kv('general.name', S(T.u32, 1))]));
add('arch_with_dots', gguf([arch('a.b'), kv('a.b.context_length', S(T.u16, 9)), kv('b.context_length', S(T.u16, 1))]));
add('arch_non_string', gguf([kv('general.architecture', S(T.u32, 5)), kv('.block_count', S(T.u8, 3))]));
add('arch_long_is_null', gguf([kv('general.architecture', STR('a'.repeat(256 * 1024 + 1))), kv('.block_count', S(T.u8, 3))]));
add('arch_exactly_max', gguf([kv('general.architecture', STR('q'.repeat(256 * 1024 - 20))), kv('general.name', STR('n'))]));
add('arch_utf8', gguf([arch('ärch-✓-😀'), kv('ärch-✓-😀.context_length', S(T.u32, 42)), kv('general.name', STR('名前 "quoted" \\ \n\t\u0001'))]));
add('invalid_utf8', gguf([kv('general.architecture', STR(Buffer.from([0x61, 0xff, 0xc3, 0x28, 0xed, 0xa0, 0x80, 0xf0, 0x9f, 0x98]))), kv('general.name', STR(Buffer.from([0xe2, 0x82, 0x41, 0xc0, 0xaf, 0xf4, 0x90, 0x80, 0x80])))]));
add('duplicate_keys_last_wins', gguf([arch('one'), kv('one.context_length', S(T.u32, 1)), arch('two'), kv('two.context_length', S(T.u32, 2)), kv('two.context_length', S(T.u32, 3)), kv('general.name', STR('a')), kv('general.name', S(T.u8, 1))]));
add('proto_key', gguf([kv('__proto__', ARR(T.u32, [scalar(T.u32, 1)])), arch('x'), kv('x.block_count', S(T.u8, 2)), kv('constructor', STR('c')), kv('x.__proto__', S(T.u8, 1))]));
add('long_key_is_null', gguf([kv('k'.repeat(256 * 1024 + 5), S(T.u8, 1)), arch('null'), kv('null', S(T.u8, 9))]));
add('template_empty', gguf([kv('tokenizer.chat_template', STR(''))]));
add('template_non_string', gguf([kv('tokenizer.chat_template', S(T.bool, 1))]));
add('template_long_is_false', gguf([kv('tokenizer.chat_template', STR('t'.repeat(256 * 1024 + 1)))]));
add('template_then_empty', gguf([kv('tokenizer.chat_template', STR('x')), kv('tokenizer.chat_template', STR(''))]));

// Every scalar type and awkward value, on an int() field and on the two raw fields.
const scalars = [
  ['u8', S(T.u8, 255)], ['i8', S(T.i8, -128)], ['u16', S(T.u16, 65535)], ['i16', S(T.i16, -32768)],
  ['u32', S(T.u32, 4294967295)], ['i32', S(T.i32, -2147483648)], ['f32_frac', S(T.f32, 2.7)], ['f32_negfrac', S(T.f32, -0.4)],
  ['f32_nan', S(T.f32, NaN)], ['f32_inf', S(T.f32, Infinity)], ['f32_neginf', S(T.f32, -Infinity)], ['f32_negzero', S(T.f32, -0)],
  ['f32_tiny', S(T.f32, 1.4e-45)], ['f32_big', S(T.f32, 3.4e38)], ['bool_true', S(T.bool, 1)], ['bool_false', S(T.bool, 0)],
  ['bool_byte7', [T.bool, Buffer.from([7])]], ['u64_max', S(T.u64, 18446744073709551615n)], ['u64_2p53p1', S(T.u64, 9007199254740993n)],
  ['i64_min', S(T.i64, -9223372036854775808n)], ['f64_1e21', S(T.f64, 1e21)], ['f64_1e-7', S(T.f64, 1e-7)], ['f64_123e-9', S(T.f64, 1.23e-6)],
  ['f64_denorm', S(T.f64, 5e-324)], ['f64_max', S(T.f64, Number.MAX_VALUE)], ['f64_neg', S(T.f64, -123.456)], ['f64_nan', [T.f64, Buffer.from('010000000000f87f', 'hex')]],
  ['f64_1e20', S(T.f64, 123456789012345680000)], ['f64_0p1', S(T.f64, 0.1)], ['f64_negtiny', S(T.f64, -1e-300)],
  ['str', STR('12')], ['str_long', STR('s'.repeat(256 * 1024 + 1))], ['big_array', ARR(T.u8, [], 2000)],
];
for (const [label, v] of scalars) {
  const tail = label === 'big_array' ? [Buffer.alloc(2000)] : [];
  add(`scalar_${label}`, Buffer.concat([gguf([arch('m'), kv('m.context_length', v), kv('m.attention.head_count_kv', v), kv('m.attention.sliding_window_pattern', v)]), ...tail]));
}
// Fix the big_array row: its payload must follow its own header, so build it directly.
cases.splice(cases.findIndex((c) => c.name === 'scalar_big_array'), 1);
const big = [T.arr, Buffer.concat([u32(T.u8), u64(2000), Buffer.alloc(2000, 3)])];
add('scalar_big_array', gguf([arch('m'), kv('m.context_length', big), kv('m.attention.head_count_kv', big), kv('m.attention.sliding_window_pattern', big)]));

// Every field through int() at once (types vary).
add('all_fields', gguf([arch('z'), ...FIELDS.map((f, i) => kv(`z.${f}`, i % 3 === 0 ? S(T.f64, i + 0.75) : i % 3 === 1 ? S(T.i16, -i) : S(T.u64, 1000 * i)))]));

// mode() over lists.
const nums = (type, list) => ARR(type, list.map((v) => scalar(type, v)));
const modeCases = {
  tie_first_seen: nums(T.u32, [3, 5, 5, 3, 7]), single: nums(T.u8, [9]), empty: nums(T.u32, []),
  floats: nums(T.f64, [1.5, 2.5, 2.5]), nan_group: nums(T.f64, [NaN, 1, NaN]), zero_merge: nums(T.f64, [-0, 0, 1]),
  negzero_first: nums(T.f32, [-0, 5]), infs: nums(T.f64, [Infinity, -Infinity, -Infinity]), bools_only: nums(T.bool, [1, 1, 0]),
  strings: ARR(T.str, [str('1'), str('1')]), nested: ARR(T.arr, [Buffer.concat([u32(T.u8), u64(1), Buffer.from([4])]), Buffer.concat([u32(T.u8), u64(0)])]),
  big64: nums(T.u64, [18446744073709551615n, 18446744073709551614n]), max_kept: nums(T.u16, Array.from({ length: 1024 }, (_, i) => i % 10)),
  over_kept: nums(T.u16, Array.from({ length: 1025 }, (_, i) => i % 10)),
};
for (const [label, v] of Object.entries(modeCases)) {
  add(`mode_${label}`, gguf([arch('q'), kv('q.block_count', v), kv('q.attention.head_count_kv', v), kv('q.attention.sliding_window_pattern', v)]));
}

// Large arrays: skipped and summarised.
add('skip_string_array', gguf([kv('v', ARR(T.str, Array.from({ length: 1025 }, (_, i) => str('x'.repeat(i % 5))))), arch('m'), kv('m.block_count', S(T.u8, 1))]));
add('skip_f64_array', gguf([kv('v', [T.arr, Buffer.concat([u32(T.f64), u64(1100), Buffer.alloc(8800)])]), arch('m'), kv('m.block_count', S(T.u8, 1))]));
add('skip_nested_unsupported', gguf([kv('v', [T.arr, Buffer.concat([u32(T.arr), u64(1025)])])]));
add('skip_unknown_unsupported', gguf([kv('v', [T.arr, Buffer.concat([u32(13), u64(1025)])])]));
add('skip_past_eof_last', gguf([arch('m'), kv('m.block_count', S(T.u8, 1)), kv('v', [T.arr, Buffer.concat([u32(T.u32), u64(10000000)])])]));
add('skip_past_eof_then_read', gguf([kv('v', [T.arr, Buffer.concat([u32(T.u32), u64(10000)])]), arch('m')]));
add('skip_string_lengths_eof', gguf([kv('v', [T.arr, Buffer.concat([u32(T.str), u64(5000), u64(1), Buffer.from('a')])])]));
add('skip_string_len_range', gguf([kv('v', [T.arr, Buffer.concat([u32(T.str), u64(2000), u64(2n ** 53n)])])]));
add('skip_string_len_limit', gguf([kv('v', [T.arr, Buffer.concat([u32(T.str), u64(2000), u64(2n ** 40n)])])]));
add('skip_scalar_limit', gguf([kv('v', [T.arr, Buffer.concat([u32(T.u8), u64(128 * 1024 * 1024)])])]));
add('skip_scalar_just_under_limit', gguf([kv('v', [T.arr, Buffer.concat([u32(T.u8), u64(128 * 1024 * 1024 - 200)])])]));
add('skip_scalar_huge_count', gguf([kv('v', [T.arr, Buffer.concat([u32(T.u64), u64(2n ** 53n - 1n)])])]));
add('array_count_range', gguf([kv('v', [T.arr, Buffer.concat([u32(T.u8), u64(2n ** 53n)])])]));
add('long_string_skip_limit', gguf([kv('v', [T.str, u64(200 * 1024 * 1024)])]));
add('long_string_skip_eof', gguf([kv('v', [T.str, u64(300 * 1024)]), arch('m')]));
add('long_string_skip_eof_last', gguf([arch('m'), kv('v', [T.str, u64(300 * 1024)])]));
add('string_len_range', gguf([kv('v', [T.str, u64(2n ** 63n)])]));
add('small_unknown_sub', gguf([kv('v', [T.arr, Buffer.concat([u32(77), u64(1), Buffer.alloc(4)])])]));
add('small_unknown_sub_empty', gguf([kv('v', [T.arr, Buffer.concat([u32(77), u64(0)])]), arch('m')]));
add('unknown_type', gguf([kv('v', [13, Buffer.alloc(0)])]));
add('unknown_type_max', gguf([kv('v', [0xffffffff, Buffer.alloc(0)])]));

// Fixed header.
add('magic_wrong', Buffer.concat([Buffer.from('GGUG'), u32(3), u64(0), u64(0)]));
add('magic_lower', Buffer.concat([Buffer.from('gguf'), u32(3), u64(0), u64(0)]));
add('empty_file', Buffer.alloc(0));
add('three_bytes', Buffer.from('GGU'));
add('magic_only', Buffer.from('GGUF'));
for (const v of [0, 1, 4, 0xffffffff]) add(`version_${v}`, gguf([], { version: v }));
add('tensor_count_range', gguf([], { tensors: 2n ** 53n }));
add('kv_count_range', gguf([], { kvCount: 2n ** 63n }));
add('kv_count_huge_safe', gguf([arch('m')], { kvCount: 2n ** 53n - 1n }));
add('kv_count_short', gguf([arch('m')], { kvCount: 2 }));
add('kv_count_fewer', gguf([arch('m'), kv('m.block_count', S(T.u8, 1))], { kvCount: 1 }));

// Nesting (the port refuses past 64 levels; the JS accepts).
function nested(depth) {
  let inner = Buffer.concat([u32(T.u8), u64(1), Buffer.from([depth])]);
  for (let d = 1; d < depth; d++) inner = Buffer.concat([u32(T.arr), u64(1), inner]);
  return [T.arr, inner];
}
for (const d of [1, 2, 63, 64, 65, 100]) add(`nest_${d}`, gguf([arch('n'), kv('n.attention.head_count_kv', nested(d)), kv('n.block_count', nested(d))]), { nest: d });
add('nest_kept_skipped', gguf([kv('other', nested(30)), arch('n')]), { nest: 30 });

// Every prefix of a small file.
const base = gguf([arch('t'), kv('general.name', STR('Tiny')), kv('t.block_count', S(T.u32, 4)), kv('t.attention.head_count_kv', nums(T.u16, [2, 2, 4])), kv('tokenizer.chat_template', STR('{{x}}')), kv('t.context_length', S(T.u64, 4096))]);
for (let n = 0; n < base.length; n++) add(`prefix_${n}`, base.subarray(0, n));

// Random doubles through both number paths.
let seed = 0x9e3779b9;
const rnd = () => { seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0; return seed; };
for (let r = 0; r < 12; r++) {
  const items = Array.from({ length: 64 }, () => { const b = Buffer.alloc(8); b.writeUInt32LE(rnd(), 0); b.writeUInt32LE(rnd(), 4); return b; });
  const f32s = Array.from({ length: 64 }, () => u32(rnd()));
  add(`random_doubles_${r}`, gguf([arch('r'), kv('r.attention.head_count_kv', [T.arr, Buffer.concat([u32(T.f64), u64(64), ...items])]), kv('r.attention.sliding_window_pattern', [T.arr, Buffer.concat([u32(T.f32), u64(64), ...f32s])]), kv('r.block_count', [T.arr, Buffer.concat([u32(T.f64), u64(64), ...items])])]));
}

// --- run the JS ------------------------------------------------------------------------------
function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-fixtures-'));
  const rows = [];
  try {
    for (const c of cases) {
      const file = path.join(dir, 'f.gguf');
      fs.writeFileSync(file, c.buf);
      const row = { name: c.name, bytes: packBytes(c.buf) };
      if (!unpackBytes(row.bytes).equals(c.buf)) throw Error(`pack ${c.name}`);
      if (c.nest) row.nest = c.nest;
      try { row.summary = encodeSummary(summarize(readGguf(file))); } catch (e) { row.error = e.message; }
      rows.push(row);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const out = {
    version: 1,
    limits: { maxHeaderBytes: 128 * 1024 * 1024, maxArrayKept: 1024, maxStringKept: 256 * 1024 },
    cases: rows,
  };
  process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
}

if (require.main === module) main();
