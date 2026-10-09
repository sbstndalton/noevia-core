'use strict';

// Differential tests for MCP framing (#980): the JS references (tests/server/oracle/mcp.cjs parseRpcBodyJs,
// resolveSchemaRefsJs) and their Rust port in dav-parse.wasm (sbstndalton/noevia-rs
// crates/mcp-frame) must agree on every synthetic fixture in tests/fixtures/mcp-frame.v1.json
// (byte-identical to noevia-rs's copy; CI compares them) and on seeded random bodies and schemas:
// the same value (key order, prototypes, -0 and ±Infinity included) or the same error class and
// message. Node-dependent (JSON.parse, String#trim, Object.prototype), so CI also runs this on the
// shipped runtime image. The WebAssembly half needs server/wasm/dav-parse.wasm (or DAV_PARSE_WASM);
// it is skipped without it unless DAV_PARSE_WASM_REQUIRED=1.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mcp = require('../../server/mcp.cjs');
const oracle = require('./oracle/mcp.cjs');
const davParseWasm = require('../../server/dav-parse-wasm.cjs');
const { encodeTree } = require('./mcp-frame-tree.cjs');
const GENERATOR = path.join(__dirname, '../../tools/gen-mcp-fixtures.cjs');

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/mcp-frame.v1.json'), 'utf8'));
const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';

const fromHex16 = (h) => { let s = ''; for (let i = 0; i < h.length; i += 4) s += String.fromCharCode(parseInt(h.slice(i, i + 4), 16)); return s; };
const idOf = (spec) => ({ never: undefined, null: null, true: true, false: false }[spec.kind] ?? (spec.kind === 'num' ? Buffer.from(spec.bits, 'hex').readDoubleBE() : spec.kind === 'str' ? fromHex16(spec.u16) : undefined));
const textOf = (c) => (c.text !== undefined ? c.text : fromHex16(c.textU16));
const ctOf = (c) => (c.sse ? 'text/event-stream; charset=utf-8' : 'application/json');

/** Outcome of fn as comparable text: the encoded value or the thrown class and message. */
function outcome(fn) {
  try { return `value ${encodeTree(fn())}`; } catch (err) { return `throw ${err?.constructor?.name}: ${err?.message}`; }
}

test('the JS references reproduce every committed expectation; the limits and Object.prototype match', () => {
  assert.equal(fixtures.version, 1);
  assert.deepEqual(fixtures.limits, { maxNodes: mcp.MAX_SCHEMA_NODES, maxChars: mcp.MAX_SCHEMA_CHARS, maxRefDepth: mcp.MAX_REF_DEPTH, maxNodeDepth: mcp.MAX_NODE_DEPTH, maxBodyBytes: mcp.MAX_RESPONSE_BYTES });
  // The module answers a key missing from defs with Object.prototype's own names, as of this runtime.
  assert.deepEqual(fixtures.objectPrototype, Object.getOwnPropertyNames(Object.prototype));
  assert.ok(fixtures.rpc.length >= 2500 && fixtures.schema.length >= 800);
  // The runtime image has no tools/: the regeneration check runs in the repo only.
  if (!fs.existsSync(GENERATOR)) return;
  const gen = require(GENERATOR).build();
  assert.equal(JSON.stringify(gen), JSON.stringify(fixtures), 'tools/gen-mcp-fixtures.cjs output differs from the committed table');
});

test('dav-parse.wasm agrees with the JS reference parseRpcBody on every rpc fixture', { skip: skipWasm }, () => {
  davParseWasm.reset();
  const bad = [];
  for (const c of fixtures.rpc) {
    const text = textOf(c), id = idOf(c.id);
    const js = outcome(() => oracle.parseRpcBodyJs(ctOf(c), text, id));
    const wasm = outcome(() => mcp.parseRpcBody(ctOf(c), text, id));
    if (js !== wasm) bad.push(`${c.name}\n  js:   ${js.slice(0, 200)}\n  wasm: ${wasm.slice(0, 200)}`);
  }
  assert.deepEqual(bad, [], `${bad.length} of ${fixtures.rpc.length} rpc fixtures disagree`);
  console.log(`# mcp-frame differential: ${fixtures.rpc.length} rpc fixtures agree`);
});

test('dav-parse.wasm agrees with resolveSchemaRefs and convertTool on every schema fixture', { skip: skipWasm }, () => {
  davParseWasm.reset();
  const bad = [];
  for (const c of fixtures.schema) {
    const schema = JSON.parse(c.json);
    assert.equal(mcp.schemaWire(schema), c.input, c.name);
    const js = outcome(() => oracle.resolveSchemaRefsJs(schema));
    const wasm = outcome(() => mcp.resolveSchemaRefs(schema));
    if (js !== wasm) bad.push(`${c.name}\n  js:   ${js.slice(0, 200)}\n  wasm: ${wasm.slice(0, 200)}`);
  }
  assert.deepEqual(bad, [], `${bad.length} of ${fixtures.schema.length} schema fixtures disagree`);
  // convertTool reads resolved.properties/required through the prototype chain, as the JS did: the
  // expectation is convertTool's own steps run over the JS reference resolver.
  const convertToolJs = (tool) => {
    const s = tool.inputSchema;
    if (s.properties !== undefined && (typeof s.properties !== 'object' || Array.isArray(s.properties))) return { ok: false, reason: 'inputSchema.properties is not an object' };
    if (s.required !== undefined && !Array.isArray(s.required)) return { ok: false, reason: 'inputSchema.required is not an array' };
    let resolved;
    try { resolved = oracle.resolveSchemaRefsJs(s); } catch (err) { return { ok: false, reason: `unresolvable schema: ${err.message}` }; }
    return { ok: true, tool: { type: 'function', function: { name: tool.name, description: tool.description, parameters: { type: 'object', properties: resolved.properties || {}, required: resolved.required || [] } } } };
  };
  let n = 0;
  for (const c of fixtures.schema) {
    const s = JSON.parse(c.json);
    if (!s || typeof s !== 'object' || Array.isArray(s) || s.type !== 'object') continue;
    const tool = { name: 'synthetic_tool', description: 'x', inputSchema: s };
    assert.equal(encodeTree(mcp.convertTool(tool)), encodeTree(convertToolJs(tool)), c.name);
    n++;
  }
  assert.ok(n > 500);
  console.log(`# mcp-frame differential: ${fixtures.schema.length} schema fixtures agree`);
});

test('dav-parse.wasm agrees with the JS on seeded random bodies and schemas', { skip: skipWasm }, () => {
  let seed = 0x980980;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const int = (n) => Math.floor(rand() * n);
  const pick = (a) => a[int(a.length)];
  const atoms = ['{"id":1}', '{"id":1,"result":[1,-0,1e400]}', '{"id":3}', '{"id":"1"}', '{"id":1,"method":"m"}', '{"id":1,"method":0}', '{"method":"n"}', '{"id":null}',
    '{"id":-0}', '{"id":1,"id":3}', '{"id":3,"id":1}', '[{"id":1}]', '7', '{"id":1,', '"\\ud800"', '{"id":1,"r":"\ud800"}', '{"__proto__":{"id":1}}', 'x', '', '{"id":1} '];
  const seps = ['\n', '\r\n', '\r', '\n\n', '\r\r\n'];
  const heads = ['data: ', 'data:', 'data:　', 'event: m\ndata: ', ': c\ndata: ', ' data: ', 'data:﻿'];
  const ids = [1, 1, 3, '1', null, -0, 0, undefined, NaN];
  let n = 0;
  for (; n < 3000; n++) {
    let t = '';
    for (let i = int(6); i >= 0; i--) t += pick(heads) + pick(atoms) + pick(seps);
    const sse = rand() < 0.7;
    const text = sse ? t : pick(atoms) + pick(['', ' ', '\n']);
    const id = pick(ids);
    const ct = sse ? 'text/event-stream' : 'application/json';
    assert.equal(outcome(() => mcp.parseRpcBody(ct, text, id)), outcome(() => oracle.parseRpcBodyJs(ct, text, id)), `random body ${n}: ${JSON.stringify(text)}`);
  }
  const keys = ['a', 'type', 'properties', 'items', '$ref', '$defs', 'definitions', '__proto__', '0', '2', 'toString', 'required'];
  const refs = ['#/$defs/A', '#/$defs/B', '#/definitions/A', '#/$defs/__proto__', '#/$defs/valueOf', '#/$defs/X', '#/x', 7];
  const value = (d) => {
    const r = rand();
    if (d > 5 || r < 0.3) return pick([0, -0, 1, 1e21, Infinity, 's', '', '\ud800', true, false, null]);
    if (r < 0.45) return Array.from({ length: int(4) }, () => value(d + 1));
    if (r < 0.6) return { $ref: pick(refs), ...(rand() < 0.5 ? { d: value(d + 1) } : {}) };
    const o = {};
    for (let i = int(5); i > 0; i--) Object.defineProperty(o, pick(keys), { value: value(d + 1), enumerable: true, writable: true, configurable: true });
    return o;
  };
  let m = 0;
  for (; m < 2000; m++) {
    const s = { type: 'object', properties: value(0), $defs: { A: value(1), B: value(1) }, definitions: rand() < 0.5 ? { A: value(1) } : undefined };
    if (s.definitions === undefined) delete s.definitions;
    assert.equal(outcome(() => mcp.resolveSchemaRefs(s)), outcome(() => oracle.resolveSchemaRefsJs(s)), `random schema ${m}: ${mcp.schemaWire(s)}`);
  }
  console.log(`# mcp-frame differential: ${n}/${n} random bodies and ${m}/${m} random schemas agree`);
});
