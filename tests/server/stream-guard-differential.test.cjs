'use strict';

// STREAM_GUARD_IMPL (#516, #704): tests/fixtures/stream-guard.v1.json (byte-identical to
// noevia-rs crates/stream-guard/tests/fixtures/; CI compares them) holds what the JS
// IncrementalValidator and buildCorrectionRequest do, printed by tools/gen-stream-guard-fixtures.cjs.
// Here every row runs through dav-parse.wasm's stream_guard (state held here between chunks) and
// must agree exactly; then a seeded live comparison of the JS and the wasm validator on fresh
// texts and splits, the Executor guard (code-tool-schemas.cjs) under both settings, the reply
// shape checks, and the fail-closed paths. The WebAssembly half needs server/wasm/dav-parse.wasm
// (or DAV_PARSE_WASM); skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const guard = require('../../server/stream-guard.cjs');
const tools = require('../../server/code-tool-schemas.cjs');

const FILE = path.join(__dirname, '../fixtures/stream-guard.v1.json');
const fixtures = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** A fixture string: plain, { units } or { seq }. */
function text(v) {
  if (typeof v === 'string') return v;
  if (v.units) return String.fromCharCode(...v.units);
  return v.seq.map(([p, n]) => text(p).repeat(n)).join('');
}
const vio = (v) => (v ? { message: text(v.message), path: text(v.path), reason: v.reason } : null);
const plainV = (v) => (v ? { message: v.message, path: v.path } : null);
const noReason = (v) => (v ? { message: v.message, path: v.path } : null);

function feedAll(validator, chunks) {
  let first = null, got = null;
  chunks.forEach((c, i) => {
    const r = validator.feed(c);
    if (r && first === null) { first = i; got = r; }
  });
  const e = validator.end();
  if (e && first === null) { first = chunks.length; got = e; }
  return { first, v: plainV(got), done: validator.isDone() };
}

const GENERATOR = path.join(__dirname, '../../tools/gen-stream-guard-fixtures.cjs');
test('the fixture file is what the generator prints', { skip: !fs.existsSync(GENERATOR) && 'no generator here' }, () => {
  const out = execFileSync(process.execPath, [GENERATOR], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, STREAM_GUARD_IMPL: 'wasm' } });
  assert.equal(out, fs.readFileSync(FILE, 'utf8'));
});

test('limits match the loader', () => {
  const l = fixtures.limits;
  assert.equal(l.maxGuardBytes, davParseWasm.MAX_GUARD_BYTES);
  assert.equal(l.maxDepthCap, davParseWasm.MAX_GUARD_DEPTH);
  assert.equal(l.maxSchemaBytes, davParseWasm.MAX_GUARD_SCHEMA_BYTES);
  assert.equal(l.maxStateBytes, davParseWasm.MAX_GUARD_STATE_BYTES);
  assert.equal(l.maxCorrectionUnits, davParseWasm.MAX_CORRECTION_UNITS);
  assert.ok(fixtures.cases.length >= 9000 && fixtures.schemas.length >= 30 && fixtures.corrections.length >= 100);
});

test('every fixture row: the wasm validator agrees with the JS exactly, incrementally and one-shot', { skip: skipWasm }, () => {
  davParseWasm.reset();
  const schemas = fixtures.schemas.map((s) => JSON.parse(s));
  const reasons = {};
  for (const [n, row] of fixtures.cases.entries()) {
    const schema = schemas[row.s];
    const chunks = row.chunks.map(text);
    const want = { first: row.first, v: noReason(vio(row.v)), done: row.done };
    const got = feedAll(guard.createValidatorWasm(schema, row.o), chunks);
    assert.deepEqual(got, want, `case ${n}`);
    if (chunks.length === 1) {
      const one = guard.checkTextWasm(schema, chunks[0], row.o);
      assert.deepEqual(plainV(one), want.v, `case ${n} (check)`);
      const raw = davParseWasm.streamGuardCheck(davParseWasm.streamGuardSchema(schema), davParseWasm.streamGuardOptions(row.o), chunks[0]);
      assert.deepEqual(raw.violation, vio(row.v), `case ${n} (reason)`);
    }
    if (row.v) reasons[row.v.reason] = (reasons[row.v.reason] || 0) + 1;
  }
  assert.ok(Object.keys(reasons).length >= 25, JSON.stringify(reasons));
});

test('corrections: buildCorrectionRequestWasm is buildCorrectionRequest after the clip', { skip: skipWasm }, () => {
  davParseWasm.reset();
  for (const row of fixtures.corrections) {
    const out = guard.buildCorrectionRequestWasm({ message: text(row.message), path: row.path === null ? null : text(row.path) }, row.clip);
    assert.deepEqual(out, { type: row.out.type, violation: { message: text(row.out.violation.message), path: row.out.violation.path === null ? null : text(row.out.violation.path) } });
  }
});

// --- live differential on fresh texts ---------------------------------------------------------
let seed = 0x7041516;
function rnd() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (a) => a[Math.floor(rnd() * a.length)];
const PIECES = ['{', '}', '[', ']', '"', ':', ',', '\\', ' ', 'u', '0', '1', '-', '.', 'e', 'a', 'x', 't', 'f', 'n', 'l',
  'é', '\ud800', '\udc00', '😀', ' ', ' ', '{"kind":', '"read"', '"execute"', '"rawInput":{', '"command":',
  '"locations":[', '{"path":"a"}', '"line":', 'true', 'null', '1.5', '"toolCallId":"c"', '"\\u00e9"', '"\\ud800"'];

test('live: JS and wasm validators agree on seeded texts, any split, every caller schema', { skip: skipWasm }, () => {
  davParseWasm.reset();
  const schemas = [...tools.ACP_KINDS.map((k) => tools.toolCallSchema(k)), ...Object.values(tools.FS_SCHEMAS), {}, null];
  let refused = 0;
  for (let i = 0; i < 600; i += 1) {
    const schema = pick(schemas);
    let t = '';
    for (let k = Math.floor(rnd() * 30); k > 0; k -= 1) t += pick(PIECES);
    const cuts = [...new Set(Array.from({ length: Math.floor(rnd() * 5) }, () => Math.floor(rnd() * (t.length + 1))))].sort((a, b) => a - b);
    const chunks = [];
    let prev = 0;
    for (const c of cuts) { chunks.push(t.slice(prev, c)); prev = c; }
    chunks.push(t.slice(prev));
    const options = rnd() < 0.2 ? { maxDepth: Math.floor(rnd() * 4), maxBytes: Math.floor(rnd() * 80) } : undefined;
    const js = feedAll(guard.createValidator(schema, options), chunks);
    const wasm = feedAll(guard.createValidatorWasm(schema, options), chunks);
    assert.deepEqual(wasm, js, JSON.stringify({ i, chunks, options }));
    if (js.v) refused += 1;
  }
  assert.ok(refused > 300, String(refused));
});

test('the violation is a SchemaViolation, the same object every time, and later calls do not reach the module', { skip: skipWasm }, (t) => {
  davParseWasm.reset();
  const v = guard.createValidatorWasm({ type: 'object', additionalProperties: false, properties: {} });
  assert.equal(v.feed('{"a'), null);
  const first = v.feed('"');
  assert.ok(first instanceof guard.SchemaViolation);
  assert.deepEqual(plainV(first), { message: "Unknown property 'a' at $", path: '$.a' });
  const feed = t.mock.method(davParseWasm, 'streamGuardFeed');
  const end = t.mock.method(davParseWasm, 'streamGuardEnd');
  assert.equal(v.feed('}'), first);
  assert.equal(v.end(), first);
  assert.equal(v.getViolation(), first);
  assert.equal(feed.mock.callCount() + end.mock.callCount(), 0);
  assert.throws(() => guard.createValidatorWasm({}).feed(1), TypeError);
});

test('a chunk over the cap is decided without crossing, as the JS decides it', { skip: skipWasm }, () => {
  davParseWasm.reset();
  const huge = 'x'.repeat(davParseWasm.MAX_GUARD_BYTES + 1);
  for (const options of [undefined, { maxBytes: 5 }]) {
    assert.deepEqual(plainV(guard.createValidatorWasm({}, options).feed(huge)), plainV(guard.createValidator({}, options).feed(huge)));
    assert.deepEqual(plainV(guard.checkTextWasm({}, huge, options)), plainV(guard.createValidator({}, options).feed(huge)));
  }
  // An earlier violation still wins.
  const v = guard.createValidatorWasm({});
  v.feed(']');
  assert.equal(v.feed(huge).message, "Unexpected character ']' while expecting a value at $");
});

test('state is bounded and lives in the validator; large calls drop the instance', { skip: skipWasm }, () => {
  davParseWasm.reset();
  const v = guard.createValidatorWasm({ type: 'array' });
  for (let i = 0; i < 200; i += 1) v.feed('[1,"abc",');
  assert.ok(v.state.length < 512 + 48 * 2000, String(v.state.length));
  const big = guard.createValidatorWasm({});
  big.feed(`"${'a'.repeat(1_200_000)}`);
  assert.equal(davParseWasm.memoryBytes(), 0, 'a call over RESET_AFTER_BYTES drops the instance');
  assert.equal(big.feed('"'), null);
  assert.equal(big.end(), null);
  assert.equal(big.isDone(), true);
});

test('the port refuses what it does not take: non-JSON schemas, options outside its caps', { skip: skipWasm }, () => {
  davParseWasm.reset();
  const refuses = (fn, reason) => assert.throws(fn, (e) => e instanceof davParseWasm.DavParseError && e.reason === reason);
  refuses(() => guard.createValidatorWasm({ type: 'string', maxLength: undefined }), 'input');
  refuses(() => guard.createValidatorWasm({ enum: [() => 1] }), 'input');
  refuses(() => guard.createValidatorWasm({ maxLength: Infinity }), 'input');
  refuses(() => guard.createValidatorWasm(Object.create({ type: 'string' })), 'input');
  refuses(() => guard.createValidatorWasm({ type: 5 }), 'schema');
  refuses(() => guard.createValidatorWasm({}, { maxBytes: davParseWasm.MAX_GUARD_BYTES + 1 }), 'options');
  refuses(() => guard.createValidatorWasm({}, { maxDepth: 1.5 }), 'options');
  refuses(() => guard.createValidatorWasm({}, { maxDepth: NaN }), 'options');
  refuses(() => guard.createValidatorWasm({ properties: { a: 1 } }), 'schema');
  // A tampered state is refused, never decided on.
  const v = guard.createValidatorWasm({});
  v.state = v.state.slice(0, 5);
  refuses(() => v.feed('1'), 'state');
  // Refusals never carry input.
  try { guard.createValidatorWasm({ type: 'secret-ish-value' }).feed(['nope']); } catch (e) { assert.ok(!String(e.message).includes('nope')); }
});

test('the loader checks the reply shape', () => {
  const R = davParseWasm.streamGuardReply;
  const reply = (json, state = [0x53, 0x47, 0x31, 0, 1]) => {
    const j = Buffer.from(json, 'latin1');
    const out = new Uint8Array(4 + j.length + state.length);
    new DataView(out.buffer).setUint32(0, j.length, true);
    out.set(j, 4); out.set(state, 4 + j.length);
    return out;
  };
  assert.deepEqual(R(reply('{"violation":null,"done":false}'), true).violation, null);
  const ok = R(reply('{"violation":{"message":"m\\ud800","path":"$.a","reason":"unknown_property"},"done":false}'), true);
  assert.equal(ok.violation.message, 'm\ud800');
  assert.deepEqual(R(reply('{"violation":null,"done":true}', []), false), { violation: null, done: true, state: null });
  for (const [json, state, withState] of [
    ['{"violation":null}', undefined, true],
    ['{"violation":null,"done":"no"}', undefined, true],
    ['{"violation":null,"done":false,"x":1}', undefined, true],
    ['{"violation":{"message":"","path":"$","reason":"no_value"},"done":false}', undefined, true],
    ['{"violation":{"message":"m","path":"a","reason":"no_value"},"done":false}', undefined, true],
    ['{"violation":{"message":"m","path":"$","reason":"other"},"done":false}', undefined, true],
    ['{"violation":{"message":"m","path":"$","reason":"no_value"},"done":true}', undefined, true],
    ['{"violation":null,"done":false}', [1, 2, 3, 4], true],
    ['{"violation":null,"done":false}', [], true],
    ['{"violation":null,"done":false}', [0x53, 0x47, 0x31, 0], false],
    ['{"violation":null,"done":false}é', undefined, true],
    ['not json', undefined, true],
  ]) {
    assert.throws(() => R(reply(json, state), withState), (e) => e instanceof davParseWasm.DavParseError && e.reason === 'reply', json);
  }
  assert.throws(() => R(new Uint8Array([9, 0, 0, 0, 1]), true), (e) => e.reason === 'reply');
  assert.ok(davParseWasm.plainJson({ a: [1, 'x', null, true, { b: -0 }] }));
  for (const bad of [undefined, NaN, [, 1], { a: undefined }, Object.create(null, { a: { get() { return 1; } , enumerable: true } }), new Date(), { [Symbol('s')]: 1 }].entries()) {
    assert.equal(davParseWasm.plainJson(bad[1]), false, `bad value ${bad[0]}`);
  }
});

// --- the Executor guard (code-tool-schemas.cjs) under both settings ---------------------------
const CALLS = [
  { toolCallId: 'c1', kind: 'execute', title: 'ls', rawInput: { command: 'ls -la' } },
  { toolCallId: 'c1', kind: 'execute', rawInput: { command: 5 } },
  { toolCallId: 'c1', kind: 'execute', rawInput: { command: '' } },
  { toolCallId: 'c1', kind: 'execute', rawInput: 'ls' },
  { toolCallId: 7, kind: 'read' },
  { toolCallId: 'c2', kind: 'readx' },
  { toolCallId: 'c2', kind: 'read', locations: [{ path: 'a.txt', line: 3.5 }] },
  { toolCallId: 'c2', kind: 'read', locations: [{ line: 1 }] },
  { toolCallId: 'c2', kind: 'edit', rawInput: { path: 'a\u0000b' } },
  { toolCallId: 'c2', kind: 'edit' },
  { toolCallId: 'c3', kind: 'fetch', rawInput: { url: 9 } },
  { toolCallId: 'c3', kind: 'fetch', rawInput: {} },
  { toolCallId: 'c4', kind: 'think', rawInput: [] },
  { toolCallId: 'c5', kind: 'other', title: 't\ud800'.repeat(200), status: 'x'.repeat(65) },
  { toolCallId: 'c5', kind: 'delete', locations: Array.from({ length: 65 }, (_, i) => ({ path: `f${i}` })) },
  { toolCallId: 'c6', kind: 'move', locations: [{ path: 'a' }], content: [{ type: 'diff' }] },
  { toolCallId: 'c7', kind: 'read', rawInput: { ['k\ud800'.repeat(100)]: 1, path: ['x'] } },
  null, [], 'call',
];
const FS = [
  ['fs/read_text_file', { sessionId: 's', path: '/w/a', line: 1, limit: 10 }], ['fs/read_text_file', { path: '/w/a', line: 1.5 }],
  ['fs/read_text_file', { line: 1 }], ['fs/read_text_file', { path: '/w/a', line: 0 }], ['fs/write_text_file', { path: '/w/a', content: 'x' }],
  ['fs/write_text_file', { path: '/w/a', content: 3 }], ['fs/write_text_file', { path: '/w/a' }], ['fs/read_text_file', null],
];

function guardRun() {
  const events = [];
  const g = tools.createExecutorGuard({ event: (type, data) => events.push([type, data]), limit: 50, maxBytes: 4 });
  const out = [];
  for (const c of CALLS) out.push(g.permission(c, 'read'));
  for (const [m, p] of FS) out.push(m === 'fs/read_text_file' ? g.readTextFile(p) : g.writeTextFile(p));
  return JSON.stringify({ out: out.map((o) => (o instanceof Error ? { message: o.message, code: o.code, data: o.data } : o)), events, n: g.violations });
}

test('the Executor guard gives the same refusals, texts and journal under STREAM_GUARD_IMPL=wasm', { skip: skipWasm }, async () => {
  davParseWasm.reset();
  const js = await withEnv({ STREAM_GUARD_IMPL: 'js' }, guardRun);
  const wasm = await withEnv({ STREAM_GUARD_IMPL: 'wasm' }, guardRun);
  assert.equal(wasm, js);
  assert.ok(JSON.parse(js).n >= 15);
});

test('STREAM_GUARD_IMPL=wasm fails closed without a usable module: every call refused as unchecked, startup stops', async () => {
  const missing = path.join(__dirname, 'no-such-dav-parse.wasm');
  davParseWasm.reset();
  try {
    await withEnv({ STREAM_GUARD_IMPL: 'wasm', DAV_PARSE_WASM: missing }, async () => {
      const ok = { toolCallId: 'c1', kind: 'execute', title: 'ls', rawInput: { command: 'ls' } };
      const found = tools.checkToolCall(ok);
      assert.deepEqual({ message: found.message, path: found.path }, { message: 'Arguments could not be checked.', path: '$' });
      assert.equal(tools.checkFsCall('fs/read_text_file', { path: '/w/a' }).message, 'Arguments could not be checked.');
      const g = tools.createExecutorGuard({ limit: 3 });
      const v = g.permission(ok);
      assert.ok(v && v.violation.message === 'Arguments could not be checked.' && v.count === 1);
      assert.throws(() => davParseWasm.verifyAtStartup({ STREAM_GUARD_IMPL: 'wasm', DAV_PARSE_WASM: missing }), (e) => e.flags.includes('STREAM_GUARD_IMPL') && e.reason === 'missing');
    });
  } finally { davParseWasm.reset(); }
});

test('a module that misanswers is refused, not believed', { skip: skipWasm }, async (t) => {
  davParseWasm.reset();
  t.mock.method(davParseWasm, 'streamGuardCheck', () => { throw new davParseWasm.DavParseError('stream-guard reply has an unexpected shape', 'reply'); });
  t.mock.method(davParseWasm, 'streamGuardCorrection', () => { throw new davParseWasm.DavParseError('x', 'reply'); });
  await withEnv({ STREAM_GUARD_IMPL: 'wasm' }, async () => {
    const g = tools.createExecutorGuard({ limit: 3 });
    const v = g.permission({ toolCallId: 'c', kind: 'read' });
    assert.deepEqual(v.violation, { message: 'Arguments could not be checked.', path: '$' });
  });
});

test('STREAM_GUARD_IMPL: js by default, wasm when asked, anything else is js with a warning; js never loads the module', async (t) => {
  assert.equal(guard.streamGuardImpl({}), 'js');
  assert.equal(guard.streamGuardImpl({ STREAM_GUARD_IMPL: '' }), 'js');
  assert.equal(guard.streamGuardImpl({ STREAM_GUARD_IMPL: ' WASM ' }), 'wasm');
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(guard.streamGuardImpl({ STREAM_GUARD_IMPL: 'rust' }), 'js');
  assert.equal(guard.streamGuardImpl({ STREAM_GUARD_IMPL: 'rust' }), 'js');
  assert.equal(warn.mock.callCount(), 1);
  assert.ok(davParseWasm.IMPL_FLAGS.includes('STREAM_GUARD_IMPL'));
  assert.deepEqual(davParseWasm.wasmFlags({ STREAM_GUARD_IMPL: 'wasm' }), ['STREAM_GUARD_IMPL']);
  await withEnv({ STREAM_GUARD_IMPL: 'js', DAV_PARSE_WASM: path.join(__dirname, 'no-such.wasm') }, async () => {
    davParseWasm.reset();
    assert.equal(tools.checkToolCall({ toolCallId: 'c1', kind: 'execute', rawInput: { command: 'ls' } }), null);
    assert.equal(tools.checkToolCall({ kind: 'read', toolCallId: 3 }).message, 'Type mismatch at $.toolCallId: expected string, got number');
  });
  davParseWasm.reset();
});
