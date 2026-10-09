#!/usr/bin/env node
'use strict';
// Regenerates the shared differential fixtures for MCP framing (#980). Expectations come from the
// JS references (tests/server/oracle/mcp.cjs parseRpcBodyJs, resolveSchemaRefsJs). The same file is committed
// byte-for-byte in sbstndalton/noevia-rs (crates/mcp-frame/tests/fixtures/mcp-frame.v1.json);
// noevia-core CI compares them.
//   node tools/gen-mcp-fixtures.cjs > tests/fixtures/mcp-frame.v1.json
// Every body and schema below is synthetic. No real MCP server output.
//
// rpc cases: `sse` (the content-type decision), `id` ({kind: never|null|true|false} or
// {kind: 'num', bits: f64 big-endian hex} or {kind: 'str', u16: UTF-16 hex}), the body as `text`
// (or `textU16`, UTF-16 hex, when it holds a raw lone surrogate), and `expect`: the module's tag
// ('reply' | 'mismatch' | 'none' | 'other' | 'invalid') and, for reply/mismatch, `out`: the exact
// UTF-8 text it returns (the selected message, lone surrogates as \uXXXX).
// schema cases: `json` (text whose JSON.parse is the schema), `input` (mcp.cjs schemaWire of it,
// what crosses) and `expect`: { ok, out }, the module's exact reply after its tag byte: the
// encoded tree (keys "=k", a set prototype "^") or {"code","ref"} for what the JS throws.

const mcp = require('../server/mcp.cjs');
const mcpOracle = require('../tests/server/oracle/mcp.cjs');

const { encodeTree } = require('../tests/server/mcp-frame-tree.cjs');

const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const escapeLone = (s) => s.replace(LONE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const u16hex = (s) => { const b = Buffer.alloc(s.length * 2); for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), i * 2); return b.toString('hex'); };

const SCHEMA_ERRORS = [
  [/^schema nests deeper than we will walk$/, 'nest'],
  [/^refs expand deeper than we will inline$/, 'ref_depth'],
  [/^schema expands past \d+ nodes$/, 'nodes'],
  [/^schema expands past \d+ characters$/, 'chars'],
  [/^cannot resolve non-local ref ([\s\S]*)$/, 'non_local'],
  [/^circular ref ([\s\S]*)$/, 'circular'],
  [/^ref ([\s\S]*) points at a definition that is not present$/, 'missing'],
];

/** The JS reference's answer as the module's reply (after the tag byte). */
function schemaExpect(schema) {
  try {
    return { ok: true, out: encodeTree(mcpOracle.resolveSchemaRefsJs(schema)) };
  } catch (err) {
    for (const [re, code] of SCHEMA_ERRORS) {
      const m = re.exec(err.message);
      if (m) return { ok: false, out: JSON.stringify(m[1] === undefined ? { code } : { code, ref: m[1] }) };
    }
    throw err;
  }
}

/** Which data: payload parseRpcBodyJs picked (mirrors its loop; checked against its result). */
function ssePick(text, expectedId) {
  let found = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const msg = JSON.parse(payload);
      if (!msg || !Object.prototype.hasOwnProperty.call(msg, 'id')) continue;
      if (msg.id === expectedId && !msg.method) found = payload;
    } catch { /* skipped */ }
  }
  return found;
}

function rpcExpect(sse, text, expectedId) {
  const ct = sse ? 'text/event-stream' : 'application/json';
  try {
    const msg = mcpOracle.parseRpcBodyJs(ct, text, expectedId);
    const payload = sse ? ssePick(text, expectedId) : text;
    if (encodeTree(JSON.parse(payload)) !== encodeTree(msg)) throw new Error('generator picked a different frame');
    return { kind: 'reply', out: escapeLone(payload) };
  } catch (err) {
    if (err instanceof SyntaxError && !sse) return { kind: 'invalid' };
    // A TypeError comes from formatting `${msg.id}` (e.g. {"toString":1}): still the mismatch branch.
    if (!sse && (err.message.startsWith('MCP: reply id ') || err instanceof TypeError)) return { kind: 'mismatch', out: escapeLone(text) };
    if (err.message.startsWith('MCP: no reply to request ')) return { kind: 'other' };
    if (err.message === 'MCP: no JSON-RPC message in event stream') return { kind: 'none' };
    throw err;
  }
}

function idSpec(id) {
  if (typeof id === 'number') { const b = Buffer.alloc(8); b.writeDoubleBE(id); return { kind: 'num', bits: b.toString('hex') }; }
  if (typeof id === 'string') return { kind: 'str', u16: u16hex(id) };
  if (id === null) return { kind: 'null' };
  if (typeof id === 'boolean') return { kind: String(id) };
  return { kind: 'never' };
}

const IDS = { 1: 1, 7: 7, zero: 0, negZero: -0, str1: '1', null: null, true: true, undef: undefined, obj: {}, big: 2 ** 53, half: 1.5, nan: NaN, inf: Infinity, strLone: 'a\ud800' };

function build() {
  let seed = 0x980;
  const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
  const int = (n) => Math.floor(rand() * n);
  const pick = (a) => a[int(a.length)];

  const rpc = [];
  const addR = (name, sse, text, idName = '1') => {
    const id = IDS[idName];
    const c = { name: escapeLone(name), sse, id: idSpec(id) };
    if (text.isWellFormed()) c.text = text; else c.textU16 = u16hex(text);
    c.expect = rpcExpect(sse, text, id);
    rpc.push(c);
  };

  // ── plain JSON bodies ──
  const valid = [
    '{"jsonrpc":"2.0","id":1,"result":{}}', '{"id":1}', '{"id":"1"}', '{"id":1.0}', '{"id":1e0}', '{"id":10e-1}', '{"id":0}', '{"id":-0}', '{"id":0.0e5}',
    '{"id":null}', '{"id":true}', '{"id":false}', '{"id":{}}', '{"id":[]}', '{"id":[1]}', '{"id":[1,[2,3]]}', '{"id":{"toString":1}}',
    '{"id":9007199254740992}', '{"id":9007199254740993}', '{"id":9007199254740993.0}', '{"id":1e400}', '{"id":-1e400}', '{"id":1e-400}', '{"id":1.5}', '{"id":15e-1}',
    '{"id":2,"id":1}', '{"id":1,"id":2}', '{"id":1,"method":"x"}', '{"result":1}', '{}', '[]', '[{"id":2}]', '5', '0', 'null', 'true', 'false', '"str"', '""',
    '{"\\u0069d":2}', '{"i\\u0064":1}', '{"__proto__":{"id":2}}', '{"__proto__":{"id":2},"id":1}', '{"__proto__":null}', '{"id":"\\ud800"}', '{"id":"\\uDC00\\uD800"}',
    '{"id":"a\\ud800"}', '{"x":"\\u0000\\"\\\\\\/\\b\\f\\n\\r\\t"}', '{"x":"\u2028\u2029\u00e9\u{1f600}"}', ' \t\r\n{"id":1} \t\r\n', '{ "id" : 1 , "result" : [ 1 , 2 ] }',
    '{"id":1,"result":{"a":{"b":{"c":[[[[]]]]}}}}', '{"id":1,"result":-0}', '{"id":1,"result":1e400}', '{"id":1,"result":123456789012345678901234567890}',
    '{"id":1,"result":0.1}', '{"id":1,"result":5e-324}', '{"id":1,"result":2.5e-324}', '{"id":1,"result":1.7976931348623157e308}', '{"id":1,"result":1.7976931348623159e308}',
    '{"id":1,"result":{"a":1,"a":2,"1":0,"b":3}}', '{"id":1,"result":"' + 'x'.repeat(5000) + '"}',
    `{"id":1,"result":${'['.repeat(10000)}${']'.repeat(10000)}}`, `{"id":1,"result":${'{"a":'.repeat(3000)}1${'}'.repeat(3000)}}`,
  ];
  const invalid = [
    '', ' ', '{', '}', '{"id":1,}', '[1,]', '{id:1}', "{'id':1}", '{"id":01}', '{"id":1.}', '{"id":.1}', '{"id":+1}', '{"id":1e}', '{"id":-}', '{"id":NaN}',
    '{"id":Infinity}', '{"id":undefined}', '\ufeff{"id":1}', '\u00a0{"id":1}', '{"id":1}\u00a0', '{"id":1} x', '{"id":1}{"id":1}', '{"x":"\t"}', '{"x":"\n"}',
    '{"x":"\\x41"}', '{"x":"\\u12"}', '{"x":"\\u12G4"}', '{"x":"\\U0041"}', '{"x":"\\\'"}', '{"x":"abc}', 'nul', 'tru', 'True', 'NULL', '[', '[[]', '{"a" 1}',
    '{"a":1 "b":2}', '{"a"::1}', '//c\n{}', '/*c*/{}', '{"x":"\u0000"}', '0x10', '1_000', '- 1', '"\\', '\v{}', '\f{}', `${'['.repeat(5000)}`,
  ];
  for (const t of valid) for (const id of ['1', 'str1', 'zero', 'negZero', 'null', 'true', 'undef', 'big', 'inf', 'strLone']) addR(`json ${id}: ${t.slice(0, 60)}`, false, t, id);
  for (const t of invalid) addR(`json invalid: ${JSON.stringify(t.slice(0, 40))}`, false, t);
  addR('json raw lone surrogate in a string', false, '{"id":1,"x":"\ud800"}');
  addR('json raw lone surrogate in a string, other id', false, '{"id":2,"x":"\udfff"}');
  addR('json raw lone surrogate as id', false, '{"id":"a\ud800"}', 'strLone');
  addR('json raw lone surrogate outside a string', false, '{"id":1}\ud800');

  // ── event streams ──
  const R = (id, extra = '"result":{}') => `{"jsonrpc":"2.0","id":${JSON.stringify(id)},${extra}}`;
  const sse = [
    ['one frame', `event: message\ndata: ${R(1)}\n\n`],
    ['missing trailing blank line', `event: message\ndata: ${R(1)}`],
    ['CRLF', `event: message\r\ndata: ${R(1)}\r\n\r\n`],
    ['CR only', `event: message\rdata: ${R(1)}\r\r`],
    ['CR CR LF', `data: ${R(1)}\r\r\n`],
    ['no space after colon', `data:${R(1)}\n`],
    ['two spaces', `data:  ${R(1)}\n`],
    ['tab and nbsp trimmed', `data:\t\u00a0${R(1)}\u3000\ufeff\n`],
    ['vertical tab trimmed', `data:\v${R(1)}\v\n`],
    ['U+2028 trimmed', `data:\u2028${R(1)}\u2029\n`],
    ['U+180E not trimmed', `data:\u180e${R(1)}\n`],
    ['U+200B not trimmed', `data:\u200b${R(1)}\n`],
    ['leading space before data', ` data: ${R(1)}\n`],
    ['uppercase DATA', `DATA: ${R(1)}\n`],
    ['comment and id field', `: keepalive\nid: 9\nretry: 10\nevent: message\ndata: ${R(1)}\n\n`],
    ['empty data line', 'data:\ndata: \n\n'],
    ['notification only', `data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n`],
    ['notification then reply', `data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: ${R(1)}\n\n`],
    ['server request only', `data: ${R(1, '"method":"sampling/createMessage"')}\n\n`],
    ['server request same id then reply', `data: ${R(1, '"method":"elicitation/create"')}\n\ndata: ${R(1)}\n\n`],
    ['reply then server request same id', `data: ${R(1)}\n\ndata: ${R(1, '"method":"elicitation/create"')}\n\n`],
    ['interleaved other ids', `data: ${R(5)}\n\ndata: ${R(1, '"result":"mine"')}\n\ndata: ${R(6)}\n\n`],
    ['other ids only', `data: ${R(5)}\n\ndata: ${R(6)}\n\n`],
    ['last reply wins', `data: ${R(1, '"result":"first"')}\ndata: ${R(1, '"result":"second"')}\n`],
    ['multi-line data is per line', `data: {"id":1,\ndata: "result":2}\n\n`],
    ['multi-line data second line complete', `data: {"id":1,\ndata: ${R(1)}\n\n`],
    ['partial frame', `data: {"jsonrpc":"2.0","id":1,"res\n`],
    ['non-JSON frame then reply', `data: hello\ndata: ${R(1)}\n`],
    ['falsy method', `data: ${R(1, '"method":""')}\n`],
    ['method 0', `data: ${R(1, '"method":0')}\n`],
    ['method -0', `data: ${R(1, '"method":-0')}\n`],
    ['method 0e5', `data: ${R(1, '"method":0e5')}\n`],
    ['method 1e-400', `data: ${R(1, '"method":1e-400')}\n`],
    ['method null', `data: ${R(1, '"method":null')}\n`],
    ['method false', `data: ${R(1, '"method":false')}\n`],
    ['method true', `data: ${R(1, '"method":true')}\n`],
    ['method {}', `data: ${R(1, '"method":{}')}\n`],
    ['method []', `data: ${R(1, '"method":[]')}\n`],
    ['method "\\u0000"', `data: ${R(1, '"method":"\\u0000"')}\n`],
    ['method then falsy method dup', `data: ${R(1, '"method":"x","method":""')}\n`],
    ['escaped key method', `data: ${R(1, '"\\u006dethod":"x"')}\n`],
    ['nested method only', `data: ${R(1, '"params":{"method":"x"}')}\n`],
    ['__proto__ with method', `data: ${R(1, '"__proto__":{"method":"x"}')}\n`],
    ['id in __proto__ only', 'data: {"__proto__":{"id":1}}\n'],
    ['falsy payload 0', 'data: 0\ndata: null\ndata: false\ndata: ""\n'],
    ['array frame', `data: [${R(1)}]\n`],
    ['string id', `data: ${R('1')}\n`],
    ['dup id last wins', 'data: {"id":2,"id":1,"result":1}\n'],
    ['dup id last loses', 'data: {"id":1,"id":2,"result":1}\n'],
    ['id 1.0', 'data: {"id":1.0,"result":1}\n'],
    ['id -0', 'data: {"id":-0,"result":1}\n'],
    ['big id', 'data: {"id":9007199254740993,"result":1}\n'],
    ['huge id', 'data: {"id":1e400,"result":1}\n'],
    ['deep payload', `data: {"id":1,"result":${'['.repeat(20000)}${']'.repeat(20000)}}\n`],
    ['empty body', ''],
    ['only newlines', '\n\n\r\n'],
    ['raw lone surrogate in a frame', `data: {"id":1,"result":"\ud800"}\n`],
    ['raw lone surrogate after data:', `data:\ud800${R(1)}\n`],
    ['raw lone surrogate frame not chosen', `data: {"id":1,"result":"\udc00"}\ndata: ${R(1)}\n`],
    ['ws inside JSON only', `data: { "id" : 1 , "result" : 2 }\n`],
    ['trailing garbage', `data: ${R(1)} x\n`],
    ['BOM inside', `data: {"id":1}\ufeff\n`],
  ];
  for (const [name, t] of sse) for (const id of ['1', 'str1', 'zero', 'negZero', 'null', 'undef', 'big', 'inf', 'nan', 'half', 'strLone', 'true']) addR(`sse ${id}: ${name}`, true, t, id);

  // ── seeded random bodies ──
  const atoms = ['{"id":1}', '{"id":1,"result":{}}', '{"id":2}', '{"id":"1"}', '{"id":1,"method":"m"}', '{"method":"n"}', '{"id":null}', '{"id":-0}', '{"id":1e0}',
    '{"id":1,"id":3}', '[1]', '7', '{"id":1,', '"\\ud800"', '{"id":1,"r":"\\uDFFF"}', '{"id":1,"r":"\u00e9\u{1f600}"}', '{"__proto__":1,"id":1}', 'x', ''];
  const seps = ['\n', '\r\n', '\r', '\n\n', '\r\n\r\n'];
  const heads = ['data: ', 'data:', 'data:\t', 'event: message\ndata: ', ': c\ndata: ', 'id: 4\ndata: ', 'Data: ', ' data: ', 'data:\u00a0'];
  for (let n = 0; n < 1500; n++) {
    let t = '';
    for (let i = int(5); i >= 0; i--) t += pick(heads) + pick(atoms) + (rand() < 0.3 ? pick([' ', '\u3000', '\ufeff', '']) : '') + pick(seps);
    if (rand() < 0.3) t = t.trimEnd();
    if (rand() < 0.1) t += '\ud800';
    const sseMode = rand() < 0.75;
    addR(`random ${n}`, sseMode, sseMode ? t : pick(atoms) + pick(['', ' ', '\n', ' x']), pick(['1', '1', '1', 'str1', 'null', 'negZero', 'undef']));
  }

  // ── schemas ──
  const schema = [];
  const addS = (name, json) => {
    const s = JSON.parse(json);
    const input = mcp.schemaWire(s);
    if (!json.isWellFormed() || !input.isWellFormed()) throw new Error(`fixture json must be well-formed text: ${name}`);
    schema.push({ name: escapeLone(name), json, input, expect: schemaExpect(s) });
  };
  const O = (o) => JSON.stringify(o);
  const obj = (props, defs, extra = '') => `{"type":"object","properties":${props}${defs ? `,"$defs":${defs}` : ''}${extra}}`;
  addS('no refs', obj('{"a":{"type":"string"}}'));
  addS('$defs ref with siblings', obj('{"a":{"$ref":"#/$defs/A","description":"d","type":"x"}}', '{"A":{"type":"string","description":"A"}}'));
  addS('definitions ref', '{"type":"object","properties":{"a":{"$ref":"#/definitions/A"}},"definitions":{"A":{"enum":[1,2]}}}');
  addS('definitions wins over $defs', '{"properties":{"a":{"$ref":"#/$defs/A"}},"$defs":{"A":1},"definitions":{"A":{"t":2}}}');
  addS('cross namespace', '{"properties":{"a":{"$ref":"#/definitions/A"}},"$defs":{"A":{"t":1}}}');
  addS('nested $defs stripped', obj('{"a":{"type":"object","$defs":{"x":1},"definitions":{"y":2},"properties":{}}}'));
  addS('$defs among siblings kept', obj('{"a":{"$ref":"#/$defs/A","$defs":{"x":1}}}', '{"A":{"t":1}}'));
  addS('chain', obj('{"a":{"$ref":"#/$defs/A"}}', '{"A":{"items":{"$ref":"#/$defs/B"}},"B":{"type":"integer"}}'));
  addS('same def twice', obj('{"a":{"$ref":"#/$defs/A"},"b":{"$ref":"#/$defs/A"}}', '{"A":{"type":"string"}}'));
  addS('anyOf refs', obj('{"a":{"anyOf":[{"$ref":"#/$defs/A"},{"type":"null"}]}}', '{"A":{"type":"string"}}'));
  for (const r of ['http://example.test/s.json', '#/properties/a', '#/$defs/', '#/definitions/', '#/$defs', '#/$defs/a\nb', '#/$defs/a\rb', '#/$defs/a\u2028', '#/$defs/a\u2029b', 'other.json#/$defs/A', '#/$DEFS/A', ' #/$defs/A', '#/$defs/A ', '#\\/$defs/A', '#/%24defs/A', '', '#'])
    addS(`ref ${JSON.stringify(r)}`, obj(`{"a":{"$ref":${O(r)}}}`, '{"A":{"t":1},"A ":{"t":2},"a\\u2028":3}'));
  addS('ref key with slash', obj('{"a":{"$ref":"#/$defs/a/b"}}', '{"a/b":{"t":1}}'));
  addS('ref key with tilde escape not decoded', obj('{"a":{"$ref":"#/$defs/a~1b"}}', '{"a/b":{"t":1}}'));
  addS('ref key unicode', obj('{"a":{"$ref":"#/$defs/\u00e9\u{1f600}"}}', '{"\u00e9\u{1f600}":{"t":1}}'));
  addS('ref key lone surrogate', obj('{"a":{"$ref":"#/$defs/\\ud800"}}', '{"\\ud800":{"t":1}}'));
  addS('ref key lone surrogate missing', obj('{"a":{"$ref":"#/$defs/\\udc00x"}}', '{"\\ud800":{"t":1}}'));
  addS('non-string $ref', obj('{"a":{"$ref":5,"type":"x"}}'));
  addS('null $ref', obj('{"a":{"$ref":null}}'));
  addS('object $ref', obj('{"a":{"$ref":{"$ref":"#/$defs/A"}}}', '{"A":{"t":1}}'));
  addS('circular self', obj('{"a":{"$ref":"#/$defs/A"}}', '{"A":{"properties":{"x":{"$ref":"#/$defs/A"}}}}'));
  addS('circular pair', obj('{"a":{"$ref":"#/$defs/A"}}', '{"A":{"items":{"$ref":"#/$defs/B"}},"B":{"items":{"$ref":"#/definitions/A"}}}', ',"definitions":{"A":{"items":{"$ref":"#/$defs/B"}}}'));
  addS('root ref to itself', '{"$ref":"#/$defs/A","$defs":{"A":{"$ref":"#/$defs/A"}}}');
  addS('missing', obj('{"a":{"$ref":"#/$defs/Nope"}}', '{"A":{}}'));
  for (const t of ['null', '0', '-0', '0.0', '""', 'false', '1e-400']) addS(`falsy target ${t}`, obj('{"a":{"$ref":"#/$defs/A","d":1}}', `{"A":${t}}`));
  for (const t of ['"abc"', '"\\ud83d\\ude00"', '"\\ud800"', '5', '-1', '1e400', 'true', '[1,{"$ref":"#/$defs/B"}]', '[]', '{}', '"x"']) addS(`truthy target ${t}`, obj('{"a":{"$ref":"#/$defs/A","d":1,"0":"sib"}}', `{"A":${t},"B":{"t":2}}`));
  for (const k of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', 'length', 'prototype', 'call', 'toJSON'])
    addS(`prototype key ${k}`, obj(`{"a":{"$ref":"#/$defs/${k}","d":1}}`, '{"A":1}'));
  addS('own __proto__ def', obj('{"a":{"$ref":"#/$defs/__proto__"}}', '{"__proto__":{"t":"own"}}'));
  addS('own toString def', obj('{"a":{"$ref":"#/$defs/toString"}}', '{"toString":{"t":"own"}}'));
  addS('own falsy toString def', obj('{"a":{"$ref":"#/$defs/toString"}}', '{"toString":0}'));
  for (const d of ['"ab"', '""', '[{"t":1},{"t":2}]', '5', 'true', 'null', '0', '"\\ud83d\\ude00"']) {
    for (const r of ['0', '1', '01', 'length'])
      addS(`$defs ${d} ref ${r}`, `{"$defs":${d},"properties":{"a":{"$ref":"#/$defs/${r}"}}}`);
  }
  addS('definitions string overrides $defs array', '{"$defs":[{"t":1},{"t":2}],"definitions":"z","properties":{"a":{"$ref":"#/$defs/0"},"b":{"$ref":"#/$defs/1"}}}');
  // depth
  const nest = (n) => '{"a":'.repeat(n) + '1' + '}'.repeat(n);
  for (const n of [62, 63, 64, 65, 66, 200]) addS(`node depth ${n}`, nest(n));
  const arrNest = (n) => '['.repeat(n) + ']'.repeat(n);
  for (const n of [64, 65, 66]) addS(`array depth ${n}`, `{"a":${arrNest(n)}}`);
  const chain = (n) => { const d = {}; for (let i = 0; i < n; i++) d[`D${i}`] = { items: { $ref: `#/$defs/D${i + 1}` } }; d[`D${n}`] = { type: 'string' }; return O({ properties: { a: { $ref: '#/$defs/D0' } }, $defs: d }); };
  for (const n of [7, 8, 9, 10]) addS(`ref chain ${n}`, chain(n));
  addS('deep unreferenced $defs', `{"properties":{},"$defs":{"deep":${arrNest(3000)}}}`);
  addS('deep sibling', obj(`{"a":{"$ref":"#/$defs/A","x":${arrNest(3000)}}}`, '{"A":{"t":1}}'));
  addS('ref deep in nesting', `${'{"a":'.repeat(60)}{"$ref":"#/$defs/A"}${'}'.repeat(60)}`.replace(/^\{/, '{"$defs":{"A":{"b":{"c":{"d":{"e":{"f":1}}}}}},'));
  // budgets
  const bomb = (levels, fan) => { const d = {}; for (let i = 0; i < levels; i++) { const p = {}; for (let j = 0; j < fan; j++) p[`p${j}`] = { $ref: `#/$defs/D${i + 1}` }; d[`D${i}`] = { properties: p }; } d[`D${levels}`] = { type: 'string' }; return O({ properties: { a: { $ref: '#/$defs/D0' } }, $defs: d }); };
  for (const [l, f] of [[8, 10], [6, 20], [4, 11], [4, 12], [3, 27], [2, 140], [2, 141], [5, 7], [3, 26]]) addS(`bomb ${l}x${f}`, bomb(l, f));
  addS('wide array nodes', `{"a":[${Array(19998).fill('0').join(',')}]}`);
  addS('wide array nodes over', `{"a":[${Array(20000).fill('0').join(',')}]}`);
  addS('long string at limit', O({ a: 'x'.repeat(262144 - 1) }));
  addS('long string over', O({ a: 'x'.repeat(262144) }));
  addS('long key over', `{${O('k'.repeat(262144))}:1}`);
  addS('astral string length', O({ a: '\u{1f600}'.repeat(131071) }));
  addS('astral string over', O({ a: '\u{1f600}'.repeat(131072) }));
  addS('escaped string over', `{"a":"${'\\n'.repeat(262144)}"}`);
  const sib = (n) => obj(`{"a":{"$ref":"#/$defs/A","description":${O('d'.repeat(n))}}}`, '{"A":{"t":1}}');
  for (const n of [262144 - 40, 262144 - 33, 262144 - 30, 262144]) addS(`siblings length ${n}`, sib(n));
  addS('siblings with -0 and 1e400 charged as stringify', obj(`{"a":{"$ref":"#/$defs/A","n":[-0,1e400,-1e400,${O('d'.repeat(262144 - 60))}]}}`, '{"A":{"t":1}}'));
  addS('siblings repeated charge', bomb(3, 3).replace(/"\$ref":"#\/\$defs\/D(\d)"/g, (m) => `${m},"description":${O('s'.repeat(9000))}`));
  addS('sibling escapes charged', obj(`{"a":{"$ref":"#/$defs/A","d":"${'\\u0001'.repeat(43700)}"}}`, '{"A":{"t":1}}'));
  // __proto__ members
  for (const v of ['{"x":1}', 'null', '[1,2]', '"s"', '5', 'true', '{"$ref":"#/$defs/A"}', '{"__proto__":{"y":2}}', '{"properties":{"p":{"type":"string"}}}'])
    addS(`__proto__ member ${v}`, `{"type":"object","__proto__":${v},"z":3,"$defs":{"A":{"t":1}}}`);
  addS('__proto__ as sibling', obj('{"a":{"$ref":"#/$defs/A","__proto__":{"x":1}}}', '{"A":{"t":1}}'));
  addS('__proto__ inside target', obj('{"a":{"$ref":"#/$defs/A"}}', '{"A":{"__proto__":{"x":1},"t":1}}'));
  addS('__proto__ in copied sibling', obj('{"a":{"$ref":"#/$defs/A","s":{"__proto__":{"x":1}}}}', '{"A":{"t":1}}'));
  // values
  addS('numbers', O({ properties: { a: { minimum: 0, maximum: 1e21, multipleOf: 1e-7, default: 0.1 } } }).replace('"minimum":0', '"minimum":-0').replace('0.1', '123456789012345678901234567890'));
  addS('infinity', '{"properties":{"a":{"maximum":1e400,"minimum":-1e400,"x":[1e400]}}}');
  addS('dup keys', '{"properties":{"a":{"type":"string","type":"number"}},"properties":{"b":1}}');
  addS('integer keys order', '{"properties":{"b":1,"2":2,"a":3,"1":4,"01":5,"4294967294":6,"4294967295":7,"-1":8,"1.0":9}}');
  addS('integer keys merge order', obj('{"a":{"$ref":"#/$defs/A","1":"s","b":"s"}}', '{"A":{"z":1,"2":2,"b":3}}'));
  addS('string escapes', O({ properties: { a: { description: '\u0000\u001f"\\/\b\f\n\r\t\u007f\u2028\u00e9\u{1f600}' } } }));
  addS('lone surrogates in strings and keys', '{"properties":{"\\ud800":{"description":"\\udc00\\ud800x"}}}');
  addS('top-level array', '[{"$ref":"#/$defs/A"}]');
  addS('top-level string', '"abc"');
  addS('top-level number', '-0');
  addS('top-level null-ish $ref', '{"$ref":"#/$defs/A","$defs":{"A":{"t":1}}}');
  addS('empty object', '{}');

  // seeded random schemas
  const keys = ['a', 'b', 'type', 'properties', 'items', '$ref', '$defs', 'definitions', '__proto__', '0', '1', 'description', 'toString', '\u00e9'];
  const refs = ['#/$defs/A', '#/$defs/B', '#/definitions/C', '#/$defs/toString', '#/$defs/Z', 'http://x', '#/$defs/0', 5];
  const value = (d) => {
    const r = rand();
    if (d > 4 || r < 0.3) return pick([0, -0, 1, 1.5, 1e21, 'str', '', true, false, null, '\ud83d\ude00']);
    if (r < 0.45) return Array.from({ length: int(4) }, () => value(d + 1));
    if (r < 0.6) return { $ref: pick(refs), ...(rand() < 0.5 ? { description: 'd' } : {}) };
    const o = {};
    for (let i = int(4); i > 0; i--) o[pick(keys)] = value(d + 1);
    return o;
  };
  const toJson = (v) => JSON.stringify(v, (k, x) => (Object.is(x, -0) ? JSON.rawJSON('-0') : x));
  for (let n = 0; n < 700; n++) {
    const defs = { A: value(1), B: value(1), toString: rand() < 0.2 ? value(1) : undefined };
    const s = { type: 'object', properties: value(0), $defs: defs, ...(rand() < 0.4 ? { definitions: { C: value(1), A: value(1) } } : {}) };
    addS(`random ${n}`, toJson(s));
  }

  return {
    version: 1,
    limits: { maxNodes: mcp.MAX_SCHEMA_NODES, maxChars: mcp.MAX_SCHEMA_CHARS, maxRefDepth: mcp.MAX_REF_DEPTH, maxNodeDepth: mcp.MAX_NODE_DEPTH, maxBodyBytes: mcp.MAX_RESPONSE_BYTES },
    objectPrototype: Object.getOwnPropertyNames(Object.prototype),
    rpc,
    schema,
  };
}

module.exports = { encodeTree, build };

if (require.main === module) {
  const out = JSON.stringify(build(), null, 1);
  if (!out.isWellFormed()) throw new Error('fixtures must be well-formed text');
  process.stdout.write(`${out}\n`);
}
