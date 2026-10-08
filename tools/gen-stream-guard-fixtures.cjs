#!/usr/bin/env node
'use strict';
// Regenerates the shared fixtures for the stream-guard validator (STREAM_GUARD_IMPL,
// server/stream-guard.cjs #516, its Executor-guard caller code-tool-schemas.cjs #704). The same
// file is committed byte-for-byte in sbstndalton/noevia-rs
// (crates/stream-guard/tests/fixtures/stream-guard.v1.json); noevia-core CI compares them.
//   node tools/gen-stream-guard-fixtures.cjs > tests/fixtures/stream-guard.v1.json
//
// Every expectation is what the JS IncrementalValidator itself does. Inputs are synthetic: the
// real caller schemas (code-tool-schemas.cjs toolCallSchema / FS_SCHEMAS) plus adversarial ones,
// and texts written here or derived from them by a seeded PRNG (prefixes, mutations, chunkings).
//
// Text that is not well-formed UTF-16 (a lone surrogate) is written as { "units": [..] }; every
// other string is a plain JSON string; text over 256 units is { "seq": [[piece, count], ..] }. Sections:
//   whitespace:  every UTF-16 unit /\s/ matches
//   limits:      the port's caps (the loader and the crate must agree)
//   schemas:     JSON.stringify of each schema, as the loader sends it
//   cases:       { s, o?, chunks, first, v, done, unit, splits? }
//                s: schema index; o: { maxDepth?, maxBytes? }; first: the index of the feed that
//                first returned a violation (chunks.length: end(); null: none); v: that violation
//                { message, path, reason } or null; done: isDone() after end(); unit: the same
//                text fed one unit at a time, { at, v } (at: units fed when the violation came;
//                null: none; -1: at end()); splits (single-chunk texts of at most 40 units): for
//                every cut point where feeding the two halves differs from `v`, [cut, v].
//   corrections: { message, path, clip, out } buildCorrectionRequest after code-tool-schemas'
//                clip (out is the object, with its strings encoded as above).

const path = require('node:path');

delete process.env.STREAM_GUARD_IMPL;
const server = path.join(__dirname, '..', 'server');
const { createValidator, buildCorrectionRequest } = require(path.join(server, 'stream-guard.cjs'));
const { toolCallSchema, FS_SCHEMAS, ACP_KINDS } = require(path.join(server, 'code-tool-schemas.cjs'));

// --- deterministic PRNG (mulberry32) ---------------------------------------------------------
let seed = 0x516704;
function rnd() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (n) => Math.floor(rnd() * n);

const plain = (s) => (s.isWellFormed() ? s : { units: Array.from({ length: s.length }, (_, i) => s.charCodeAt(i)) });
// Long text (over 256 units) as runs of one unit: { seq: [[piece, count], ..] }, pieces as above.
function enc(s) {
  if (s.length <= 256) return plain(s);
  const runs = [];
  for (let i = 0; i < s.length;) {
    let j = i + 1;
    while (j < s.length && s.charCodeAt(j) === s.charCodeAt(i)) j += 1;
    const last = runs[runs.length - 1];
    if (j - i === 1 && last && last[1] === 1 && last[0].length < 64) last[0] += s[i];
    else runs.push([s[i], j - i]);
    i = j;
  }
  return { seq: runs.map(([p, n]) => [plain(p), n]) };
}

// --- the reason each JS message stands for (the JS has only the message) ----------------------
const S = '[\\s\\S]*';
const REASONS = [
  ['max_bytes', /^Input exceeds maxBytes -?\d+$/],
  ['unexpected_char', new RegExp(`^Unexpected character '${S}' while expecting a value at ${S}$`)],
  ['type_mismatch', new RegExp(`^Type mismatch at ${S}: expected ${S}, got (string|object|array|boolean|null|number)$`)],
  ['max_depth', new RegExp(`^Nesting exceeds maxDepth -?\\d+ at ${S}$`)],
  ['expected_key', new RegExp(`^Expected a property name( or '\\}')? at ${S}$`)],
  ['expected_colon', new RegExp(`^Expected ':' after property name at ${S}$`)],
  ['expected_comma_or_brace', new RegExp(`^Expected ',' or '\\}' at ${S}$`)],
  ['expected_comma_or_bracket', new RegExp(`^Expected ',' or '\\]' at ${S}$`)],
  ['unknown_property', new RegExp(`^Unknown property '${S}' at ${S}$`)],
  ['missing_required', new RegExp(`^Missing required propert(y|ies) ${S} at ${S}$`)],
  ['max_items', new RegExp(`^Array at ${S} exceeds maxItems -?\\d+$`)],
  ['invalid_unicode_escape', new RegExp(`^Invalid unicode escape in string at ${S}$`)],
  ['invalid_escape', new RegExp(`^Invalid escape sequence '\\\\${S}' in string at ${S}$`)],
  ['max_length', new RegExp(`^String at ${S} exceeds maxLength -?\\d+$`)],
  ['enum_prefix', new RegExp(`^String at ${S} cannot match any allowed value \\(prefix '${S}' is impossible\\)$`)],
  ['enum_string', new RegExp(`^String '${S}' at ${S} is not one of the allowed enum values$`)],
  ['invalid_number', new RegExp(`^Invalid number literal '[0-9eE+\\-.]*' at ${S}$`)],
  ['not_integer', new RegExp(`^Expected an integer at ${S}, got [0-9eE+\\-.]*$`)],
  ['enum_number', new RegExp(`^Number [0-9eE+\\-.]* at ${S} is not one of the allowed enum values$`)],
  ['invalid_literal', new RegExp(`^Invalid literal at ${S}: expected '(true|false|null)'$`)],
  ['enum_literal', new RegExp(`^Literal (true|false|null) at ${S} is not one of the allowed enum values$`)],
  ['unterminated_string', /^Unterminated string at end of stream$/],
  ['unterminated_literal', /^Unterminated literal \(expected '(true|false|null)'\) at end of stream$/],
  ['unterminated_container', /^Unexpected end of stream: unterminated object or array$/],
  ['no_value', /^Unexpected end of stream: no JSON value was produced$/],
];
function reason(message) {
  const hits = REASONS.filter(([, re]) => re.test(message)).map(([r]) => r);
  // A key or a string value can itself contain words of another message; the first rule in the
  // validator's own order that matches is the one it raised (checked against the Rust port).
  if (!hits.length) throw new Error(`no reason for ${JSON.stringify(message)}`);
  return hits[0];
}
const vio = (v) => (v ? { message: enc(v.message), path: enc(v.path), reason: reason(v.message) } : null);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function run(schema, options, chunks) {
  const v = createValidator(schema, options);
  let first = null, got = null;
  chunks.forEach((c, i) => {
    const r = v.feed(c);
    if (r && first === null) { first = i; got = r; }
  });
  const e = v.end();
  if (e && first === null) { first = chunks.length; got = e; }
  return { first, v: vio(got), done: v.isDone() };
}

function unitwise(schema, options, text) {
  const v = createValidator(schema, options);
  for (let i = 0; i < text.length; i += 1) {
    const r = v.feed(text[i]);
    if (r) return { at: i + 1, v: vio(r) };
  }
  const e = v.end();
  return e ? { at: -1, v: vio(e) } : { at: null, v: null };
}

// --- schemas --------------------------------------------------------------------------------
const SCHEMAS = [];
const schemaIndex = new Map();
function schemaId(schema) {
  const text = JSON.stringify(schema === undefined ? null : schema);
  if (!schemaIndex.has(text)) { schemaIndex.set(text, SCHEMAS.length); SCHEMAS.push(text); }
  return schemaIndex.get(text);
}
const parsed = (text) => JSON.parse(text);

const TOOL = ACP_KINDS.map((k) => toolCallSchema(k));
const FS = Object.values(FS_SCHEMAS);
const ADVERSARIAL = [
  {},
  null,
  { type: 'object' },
  { type: 'string', enum: ['read', 'reader', 're\u00e9', 'x\ud800', '', '\ud83d\ude00', 'read'] },
  { type: 'string', maxLength: 3 },
  { type: 'string', maxLength: 0 },
  { type: 'string', maxLength: -1 },
  { type: ['integer', 'null'] },
  { type: 'integer' },
  { type: ['integer', 'number'] },
  { type: 'number', enum: [1, -0, 1e21, 0.1, 1.7976931348623157e308, 5e-324, 123456789012345680000, 2.2250738585072014e-308] },
  { enum: [true, null, 'a', [1], { a: 1 }, 2] },
  { enum: [false] },
  { type: 'string', enum: [] },
  { type: 'string', enum: [1, 2] },
  { type: [] },
  { type: null },
  { type: ['bogus'] },
  { type: ['boolean', 'array'] },
  { type: 'object', required: ['a', 'b', 'a'], properties: { a: {}, b: { type: 'string' } } },
  { type: 'object', required: ['x\ud800', '\u00e9'] },
  { type: 'object', additionalProperties: false, properties: {} },
  { type: 'object', additionalProperties: false, properties: parsed('{"__proto__":{"type":"string"},"\\ud800":{},"\u00e9":{"type":"number"},"a.b":{"type":"null"}}') },
  { additionalProperties: false, properties: { a: null, b: false, c: 0, d: '' } },
  { additionalProperties: true, properties: { a: { type: 'string' } } },
  { type: 'array', maxItems: 2, items: { type: 'object', required: ['path'], properties: { path: { type: 'string', maxLength: 5 } } } },
  { type: 'array', maxItems: 0 },
  { type: 'array', maxItems: -1 },
  { type: 'array', items: { type: 'array', items: { type: 'array', items: { type: 'integer', enum: [7] } } } },
  { enum: 'not-an-array', required: 'x', maxLength: '3', maxItems: null, properties: 0, items: null },
  { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'array', items: { type: 'string', enum: ['z'] } } }, required: ['b'] } } },
];

// --- texts ----------------------------------------------------------------------------------
const GENERAL = [
  '', ' ', '\t\n\r ', '\u00a0\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000\ufeff{}', '\u000b\u000c[]', '\u0085{}', '\u180e{}', '\u200b{}',
  '{}', '[]', 'null', 'true', 'false', 'tru', 'nul', 'nulx', 'trUe', 'fals', 'falsey', 'n', 't',
  '0', '-0', '01', '-', '--1', '1.', '.5', '1e', '1e+', '1E5', '1e-5', '-1.25e-3', '1-2', '1.2.3', '+1', '1.5e3x',
  '1e400', '-1e400', '1e-400', '1'.repeat(400), '-' + '9'.repeat(320), '9007199254740993', '0.1', '5e-324', '2e-324',
  '1.7976931348623157e308', '1.7976931348623159e308', '123456789012345680000', '1e21', '1E21', '7', '[7]', '[[[7]]]', '[[[8]]]', '[[[7.0]]]',
  '"abc"', '"', '"\\', '"\\u', '"\\u12', '"\\u12g4"', '"\\u00e9"', '"\\ud800"', '"\\udc00\\ud800"', '"\\uD83D\\uDE00"', '"\\x"', '"\\/"',
  '"\\b\\f\\n\\r\\t\\"\\\\"', '"\ud800"', '"\udc00"', '"\ud83d\ude00"', '"\u00e9"', '"\u0001\u001f"', '"re', '"read"', '"reader"', '"rea"',
  '"re\u00e9"', '"re\\u00e9"', '"x\\ud800"', '"x\ud800"', '""', '"readx"', '"\\ud83d\\ude00"',
  '{"a":1,}', '{"a" 1}', '{a:1}', '{"a":1 "b":2}', '{"a":}', '{,}', '{"a":1,,}', '{"a"', '{"a":', '{"a":1', '{"a":[1,{"b":null}]} trailing',
  '[1,]', '[,1]', '[1 2]', '[1,2]]', '[1,2', '[', '[[', '{}{}', '{} x', '{}x', '1 2', '"a" "b"', 'null null',
  '{"a":"x","b":"y"}', '{"b":"y"}', '{"a":1,"a":2,"b":"z"}', '{"\\ud800":1}', '{"\ud800":1}', '{"\u00e9":1}', '{"\u00e9":"x"}', '{"\\u00e9":2}',
  '{"__proto__":"s"}', '{"__proto__":1}', '{"constructor":1}', '{"toString":"x"}', '{"hasOwnProperty":[]}', '{"a.b":null}', '{"a.b":0}',
  '{"x\ud800":1,"\u00e9":2}', '{"x\\ud800":1,"\\u00e9":2}', '{"a":null,"b":false,"c":0,"d":""}', '{"e":1}',
  '[{"path":"a"},{"path":"abcdef"}]', '[{"path":"a"},{"path":"b"},{"path":"c"}]', '[{}]', '[{"path":1}]', '[{"path":"a","x":1}]',
  '{"a":{"b":["z","z"]}}', '{"a":{"b":["y"]}}', '{"a":{}}', '{"a":{"b":"z"}}',
  '[true,false,null]', '[tru]', '[nulL]', 'true false', '"\\', '"a\\"', '"\\"',
];
const DEEP = [];
for (const n of [1, 2, 3, 63, 64, 65, 100]) DEEP.push('['.repeat(n) + ']'.repeat(n));
for (const n of [63, 64, 65]) DEEP.push('{"a":'.repeat(n) + '1' + '}'.repeat(n));
DEEP.push('['.repeat(70), '{"a":'.repeat(70), '['.repeat(64) + '1' + ']'.repeat(63));

const TOOL_CALLS = [
  { toolCallId: 'c1', kind: 'execute', title: 'ls', rawInput: { command: 'ls -la' } },
  { toolCallId: 'c1', kind: 'execute', title: 'ls', rawInput: { command: ['ls', '-la'], cwd: '/w' } },
  { toolCallId: 'c1', kind: 'execute', rawInput: { command: 5 } },
  { toolCallId: 'c1', kind: 'execute', rawInput: 'ls' },
  { toolCallId: 7, kind: 'read' },
  { toolCallId: 'c2', kind: 'readx' },
  { toolCallId: 'c2', kind: 'read', locations: [{ path: 'a.txt', line: 3 }] },
  { toolCallId: 'c2', kind: 'read', locations: [{ path: 'a.txt', line: 3.5 }] },
  { toolCallId: 'c2', kind: 'read', locations: [{ line: 1 }] },
  { toolCallId: 'c2', kind: 'edit', locations: [{ path: 'x'.repeat(10) }], rawInput: { path: 'b', file_path: 'c', filePath: 'd', filepath: 'e' } },
  { toolCallId: 'c2', kind: 'edit', rawInput: { path: ['a'] } },
  { toolCallId: 'c3', kind: 'fetch', rawInput: { url: 'https://example.test/' } },
  { toolCallId: 'c3', kind: 'fetch', rawInput: { url: 9 } },
  { toolCallId: 'c4', kind: 'think', rawInput: {} },
  { toolCallId: 'c4', kind: 'switch_mode', rawInput: [] },
  { toolCallId: 'c5', kind: 'other', title: 't\u00e9\ud83d\ude00', status: 'pending', content: [] },
  { toolCallId: 'c5', kind: 'other', status: 's'.repeat(65) },
  { toolCallId: 'c5', kind: 'delete', locations: Array.from({ length: 65 }, (_, i) => ({ path: `f${i}` })) },
  { toolCallId: 'c6', kind: 'move', locations: [{ path: 'a' }, { path: 'b' }], content: {} },
];
const FS_CALLS = [
  { sessionId: 's', path: '/w/a.txt' }, { sessionId: 's', path: '/w/a.txt', line: 1, limit: 10 }, { path: '/w/a.txt', line: null },
  { path: '/w/a.txt', line: 1.5 }, { line: 1 }, { path: 5 }, { path: '/w/a', content: '' }, { path: '/w/a' }, { content: 'x' },
  { path: '/w/a', content: 3 }, { sessionId: 1, path: '/w/a' },
];

const MUTATE = ['{', '}', '[', ']', '"', ':', ',', '\\', ' ', 'u', '0', '1', '9', 'a', 'e', 'f', 'n', 't', 'l', '-', '+', '.', 'E', 'x',
  '\u00e9', '\ud800', '\udc00', '\u2028', '\u00a0', '\ufeff', '\u0000'];
function mutations(text, count) {
  const out = [];
  for (let k = 0; k < count; k += 1) {
    let t = text;
    for (let m = 1 + int(2); m > 0; m -= 1) {
      const i = int(t.length + 1);
      const op = int(3);
      if (op === 0) t = t.slice(0, i) + pick(MUTATE) + t.slice(i);
      else if (op === 1 && t.length) t = t.slice(0, Math.min(i, t.length - 1)) + t.slice(Math.min(i, t.length - 1) + 1);
      else if (t.length) t = t.slice(0, Math.min(i, t.length - 1)) + pick(MUTATE) + t.slice(Math.min(i, t.length - 1) + 1);
    }
    out.push(t);
  }
  return out;
}

function chunkings(text, count) {
  const out = [];
  for (let k = 0; k < count; k += 1) {
    const cuts = new Set();
    for (let m = 1 + int(4); m > 0; m -= 1) cuts.add(int(text.length + 1));
    const sorted = [...cuts].sort((a, b) => a - b);
    const chunks = [];
    let prev = 0;
    for (const c of sorted) { chunks.push(text.slice(prev, c)); prev = c; }
    chunks.push(text.slice(prev));
    if (rnd() < 0.2) chunks.splice(int(chunks.length + 1), 0, '');
    out.push(chunks);
  }
  return out;
}

// --- cases ----------------------------------------------------------------------------------
const CASES = [];
const seen = new Set();
function add(schema, options, chunks, encoded = chunks.map(enc)) {
  const s = schemaId(schema);
  const key = JSON.stringify([s, options || null, encoded]);
  if (seen.has(key)) return;
  seen.add(key);
  const r = run(schema, options, chunks);
  const row = { s };
  if (options) row.o = options;
  row.chunks = encoded;
  row.first = r.first;
  row.v = r.v;
  row.done = r.done;
  const text = chunks.join('');
  row.unit = unitwise(schema, options, text);
  if (chunks.length === 1 && text.length <= 40) {
    const splits = [];
    for (let cut = 1; cut < text.length; cut += 1) {
      const two = run(schema, options, [text.slice(0, cut), text.slice(cut)]);
      if (!same(two.v, r.v) || two.done !== r.done) splits.push([cut, two.v]);
    }
    if (splits.length) row.splits = splits;
  }
  CASES.push(row);
}
const prefixes = (t) => Array.from({ length: t.length }, (_, i) => t.slice(0, i));

for (const schema of ADVERSARIAL) {
  for (const t of GENERAL) add(schema, undefined, [t]);
}
for (const schema of [{}, ADVERSARIAL[3], ADVERSARIAL[22], ADVERSARIAL[25]]) {
  for (const t of GENERAL) {
    for (const m of mutations(t, 3)) add(schema, undefined, [m]);
    if (t.length > 1) for (const c of chunkings(t, 2)) add(schema, undefined, c);
  }
}
for (const t of DEEP) {
  for (const schema of [{}, ADVERSARIAL[28]]) add(schema, undefined, [t]);
  for (const o of [{ maxDepth: 0 }, { maxDepth: 1 }, { maxDepth: 3 }, { maxDepth: -1 }, { maxDepth: 1024 }]) add({}, o, [t]);
}
const OPTION_TEXTS = ['', '{}', '[[[]]]', '"\u00e9\u00e9"', '"\ud83d\ude00"', '"\ud800\ud800"', '{"a":[1,2,3]}', '"abcdefghij"', '[1]   '];
for (const o of [{ maxBytes: 0 }, { maxBytes: -1 }, { maxBytes: 1 }, { maxBytes: 2 }, { maxBytes: 4 }, { maxBytes: 5 }, { maxBytes: 6 },
  { maxBytes: 7 }, { maxBytes: 8 }, { maxBytes: 10 }, { maxBytes: 64 }, { maxBytes: 2097152 }, { maxDepth: 2, maxBytes: 9 }]) {
  for (const t of OPTION_TEXTS) {
    add({}, o, [t]);
    for (let cut = 0; cut <= t.length; cut += 1) add({}, o, [t.slice(0, cut), t.slice(cut)]);
    add({}, o, Array.from(t));
  }
}
const toolTexts = [];
for (const [i, schema] of TOOL.entries()) {
  for (const call of TOOL_CALLS) {
    const t = JSON.stringify(call);
    toolTexts.push(t);
    add(schema, undefined, [t]);
    if (call.kind === ACP_KINDS[i]) {
      for (const p of prefixes(t).filter((_, k) => k % 3 === 0)) add(schema, undefined, [p]);
      for (const m of mutations(t, 6)) add(schema, undefined, [m]);
      for (const c of chunkings(t, 3)) add(schema, undefined, c);
    }
  }
}
for (const schema of FS) {
  for (const call of FS_CALLS) {
    const t = JSON.stringify(call);
    add(schema, undefined, [t]);
    for (const p of prefixes(t)) add(schema, undefined, [p]);
    for (const m of mutations(t, 6)) add(schema, undefined, [m]);
    for (const c of chunkings(t, 2)) add(schema, undefined, c);
  }
}
// Documents at the default cap, one with a
// surrogate pair split across the chunks right at the cap (6 bytes there, 4 whole).
{
  const seq = (...runs) => { const text = runs.map(([p, n]) => p.repeat(n)).join(''); return { text, enc: enc(text) }; };
  for (const pad of [5, 6, 7, 8]) {
    const head = seq(['"', 1], ['a', 2097152 - pad], ['\ud83d', 1]);
    const tail = seq(['\ude00', 1], ['"', 1]);
    add({}, undefined, [head.text, tail.text], [head.enc, tail.enc]);
    const whole = seq(['"', 1], ['a', 2097152 - pad], ['\ud83d\ude00', 1], ['"', 1]);
    add({}, undefined, [whole.text], [whole.enc]);
  }
  for (const n of [2097140, 2097141]) {
    const t = seq(['"', 1], ['b', n], ['"', 1]);
    add({ type: 'string', maxLength: 2097140 }, undefined, [t.text], [t.enc]);
  }
  const deepKey = seq(['{"', 1], ['k', 1048570], ['":', 1], ['[', 3], ['"', 1]);
  add({ type: 'object', additionalProperties: false, properties: { k: {} } }, undefined, [deepKey.text], [deepKey.enc]);
  add({}, undefined, [deepKey.text], [deepKey.enc]);
}

// --- corrections ----------------------------------------------------------------------------
const clip = (text, max) => String(text ?? '').slice(0, max);
const CORRECTIONS = [];
for (const message of ['Type mismatch at $: expected object, got array', '', 'x'.repeat(299) + '\ud83d\ude00', 'y'.repeat(300) + 'z',
  'Unknown property \'\ud800\' at $', 'm\u00e9\u2028\u0000"\\', 'a'.repeat(1000)]) {
  for (const p of ['$', '', null, '$.a\ud800', '$.locations[0].path']) {
    for (const c of [300, null, 0, 1]) {
      const out = buildCorrectionRequest({ message: c === null ? message : clip(message, c), path: p || null });
      CORRECTIONS.push({ message: enc(message), path: p === null ? null : enc(p), clip: c,
        out: { type: out.type, violation: { message: enc(out.violation.message), path: out.violation.path === null ? null : enc(out.violation.path) } } });
    }
  }
}

// --- output ---------------------------------------------------------------------------------
const whitespace = [];
for (let u = 0; u < 0x10000; u += 1) if (/\s/.test(String.fromCharCode(u))) whitespace.push(u);

const lines = [];
lines.push('{');
lines.push('  "version": 1,');
lines.push(`  "generator": "noevia-core tools/gen-stream-guard-fixtures.cjs (from server/stream-guard.cjs)",`);
lines.push(`  "limits": ${JSON.stringify({ defaultMaxDepth: 64, defaultMaxBytes: 2097152, maxGuardBytes: 2097152, maxDepthCap: 1024, maxSchemaBytes: 262144, maxStateBytes: 20971520, maxCorrectionUnits: 1048576 })},`);
lines.push(`  "whitespace": ${JSON.stringify(whitespace)},`);
lines.push('  "schemas": [');
SCHEMAS.forEach((s, i) => lines.push(`    ${JSON.stringify(s)}${i + 1 < SCHEMAS.length ? ',' : ''}`));
lines.push('  ],');
lines.push('  "cases": [');
CASES.forEach((c, i) => lines.push(`    ${JSON.stringify(c)}${i + 1 < CASES.length ? ',' : ''}`));
lines.push('  ],');
lines.push('  "corrections": [');
CORRECTIONS.forEach((c, i) => lines.push(`    ${JSON.stringify(c)}${i + 1 < CORRECTIONS.length ? ',' : ''}`));
lines.push('  ]');
lines.push('}');
process.stdout.write(`${lines.join('\n')}\n`);
