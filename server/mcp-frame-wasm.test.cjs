'use strict';

// MCP_FRAME_IMPL (#980): js is the default and unchanged; wasm runs mcp-frame inside dav-parse.wasm
// and fails closed with a fixed public message. Also #989: UPLOAD_SNIFF_IMPL=wasm classifies names
// of any length like the JS. Synthetic bodies, schemas and names only.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const davParseWasm = require('./dav-parse-wasm.cjs');
const mcp = require('./mcp.cjs');
const sniff = require('./upload-sniff.cjs');

const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const required = process.env.DAV_PARSE_WASM_REQUIRED === '1';
const skipWasm = !fs.existsSync(wasmFile) && !required && 'dav-parse.wasm not built (set DAV_PARSE_WASM_REQUIRED=1 to require it)';
const MISSING = path.join(os.tmpdir(), 'no-such-mcp-dav-parse.wasm');

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  davParseWasm.reset();
  const done = () => {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    davParseWasm.reset();
  };
  let r;
  try { r = fn(); } catch (e) { done(); throw e; }
  if (r && typeof r.then === 'function') return r.finally(done);
  done();
  return r;
}

const TOOL = { name: 'synthetic_tool', inputSchema: { type: 'object', properties: { a: { $ref: '#/$defs/A' } }, $defs: { A: { type: 'string' } } } };

test('MCP_FRAME_IMPL defaults to js and reads anything else as js', () => {
  assert.equal(mcp.mcpFrameImpl({}), 'js');
  assert.equal(mcp.mcpFrameImpl({ MCP_FRAME_IMPL: ' WASM ' }), 'wasm');
  assert.equal(mcp.mcpFrameImpl({ MCP_FRAME_IMPL: 'rust' }), 'js');
  assert.ok(davParseWasm.IMPL_FLAGS.includes('MCP_FRAME_IMPL'));
});

test('wasm fails closed with the public message when the module is missing', () => withEnv({ DAV_PARSE_WASM: MISSING, MCP_FRAME_IMPL: 'wasm' }, () => {
  assert.throws(() => mcp.parseRpcBody('application/json', '{"id":1}', 1),
    (e) => e.message === mcp.PUBLIC_FAILURE && e.status === 502 && e.code === 'mcp_frame_failed' && e.reason === 'missing');
  assert.deepEqual(mcp.convertTool(TOOL), { ok: false, reason: `unresolvable schema: ${mcp.PUBLIC_FAILURE}` });
  // The JS path is untouched by a broken module.
  assert.equal(mcp.convertTool(TOOL).ok, false);
  assert.equal(mcp.parseRpcBody('application/json', '{"id":1}', 1, { impl: 'js' }).id, 1);
}));

test('wasm keeps the JS errors: SyntaxError text, id mismatch, event-stream refusals', { skip: skipWasm }, () => withEnv({ MCP_FRAME_IMPL: 'wasm' }, () => {
  for (const bad of ['{"id":1,}', '', 'nope', '{"x":"\t"}']) {
    let jsErr; try { JSON.parse(bad); } catch (e) { jsErr = e; }
    assert.throws(() => mcp.parseRpcBody('application/json', bad, 1), (e) => e instanceof SyntaxError && e.message === jsErr.message);
  }
  assert.throws(() => mcp.parseRpcBody('application/json', '{"id":[1,[2]]}', 1), { message: 'MCP: reply id 1,2 does not match request 1' });
  assert.throws(() => mcp.parseRpcBody('application/json', '{"id":{"toString":1}}', 1), TypeError);
  assert.throws(() => mcp.parseRpcBody('text/event-stream', 'data: {"id":1,"method":"sampling/createMessage"}\n', 1), /no reply to request 1 in event stream/);
  assert.throws(() => mcp.parseRpcBody('text/event-stream', ': only a comment\n', 1), { message: 'MCP: no JSON-RPC message in event stream' });
  assert.ok(davParseWasm.memoryBytes() > 0, 'the module ran');
  assert.throws(() => mcp.resolveSchemaRefs(null), { message: "Cannot read properties of null (reading '$defs')" });
}));

test('wasm returns the same values: __proto__ keys and prototypes, -0, Infinity, big integers', { skip: skipWasm }, () => withEnv({ MCP_FRAME_IMPL: 'wasm' }, () => {
  const msg = mcp.parseRpcBody('text/event-stream', 'data: {"id":1,"result":{"__proto__":{"x":1},"n":-0,"i":1e400,"b":9007199254740993,"a":1,"a":2}}\n', 1);
  assert.ok(Object.hasOwn(msg.result, '__proto__'));
  assert.ok(Object.is(msg.result.n, -0));
  assert.equal(msg.result.i, Infinity);
  assert.equal(msg.result.b, 2 ** 53);
  assert.equal(msg.result.a, 2);
  const tool = mcp.convertTool({ name: 't', inputSchema: JSON.parse('{"type":"object","__proto__":{"properties":{"p":{"type":"string"}},"required":["p"]}}') });
  const jsTool = withEnv({ MCP_FRAME_IMPL: 'js' }, () => mcp.convertTool({ name: 't', inputSchema: JSON.parse('{"type":"object","__proto__":{"properties":{"p":{"type":"string"}},"required":["p"]}}') }));
  assert.deepEqual(tool, jsTool);
  assert.deepEqual(tool.tool.function.parameters.required, ['p']);
}));

test('wasm refuses what the module cannot check exactly, with the public message', { skip: skipWasm }, () => withEnv({ MCP_FRAME_IMPL: 'wasm' }, () => {
  const cyclic = { type: 'object', properties: {} };
  cyclic.properties.self = cyclic;
  for (const schema of [cyclic, { type: 'object', properties: { a: undefined } }, { type: 'object', properties: new Map() }, { type: 'object', d: new Date(0) }, { type: 'object', n: NaN }]) {
    assert.throws(() => mcp.resolveSchemaRefs(schema), { message: mcp.PUBLIC_FAILURE });
  }
  const huge = { type: 'object', $defs: { big: 'x'.repeat(davParseWasm.MCP_SCHEMA_UNITS) } };
  assert.equal(mcp.resolveSchemaRefs(huge, { impl: 'js' }).type, 'object');
  assert.throws(() => mcp.resolveSchemaRefs(huge), (e) => e.message === mcp.PUBLIC_FAILURE && e.reason === 'too_large');
  // Deep but within limits: no recursion limit on the way in or out.
  const deep = JSON.parse(`{"type":"object","properties":{"a":{"$ref":"#/$defs/A","x":${'['.repeat(20000)}${']'.repeat(20000)}}},"$defs":{"A":{"t":1}}}`);
  const depth = (v) => { let n = 0; while (Array.isArray(v) && v.length) { v = v[0]; n++; } return n + (Array.isArray(v) ? 1 : 0); };
  const out = mcp.resolveSchemaRefs(deep);
  assert.equal(out.properties.a.t, 1);
  assert.equal(depth(out.properties.a.x), 20000);
  // The JS charges siblings with JSON.stringify, which is recursive on some runtimes (Node 22: a
  // RangeError at this depth). listTools stringifies every tool first, so such a schema never
  // reaches convertTool there; where it does not overflow, both answers are equal.
  let js;
  try { js = mcp.resolveSchemaRefs(deep, { impl: 'js' }); } catch (e) { assert.ok(e instanceof RangeError); assert.throws(() => JSON.stringify(deep), RangeError); }
  if (js) assert.equal(depth(js.properties.a.x), 20000);
}));

test('wasm applies the readBodyCapped limit to the body and to the res.text() fallback', { skip: skipWasm }, async () => {
  const limit = 'MCP: response body exceeded the 8 MB limit';
  await withEnv({ MCP_FRAME_IMPL: 'wasm' }, () => {
    assert.throws(() => mcp.parseRpcBody('application/json', ' '.repeat(mcp.MAX_RESPONSE_BYTES + 1), 1), { message: limit });
  });
  const res = { body: null, text: async () => 'é'.repeat(mcp.MAX_RESPONSE_BYTES / 2 + 1) };
  await assert.rejects(mcp.readBodyCapped(res, new AbortController(), mcp.MAX_RESPONSE_BYTES, { impl: 'wasm' }), { message: limit });
  assert.equal((await mcp.readBodyCapped(res, new AbortController())).length, mcp.MAX_RESPONSE_BYTES / 2 + 1);
});

test('connect/listTools/callTool run end to end under wasm (synthetic server)', { skip: skipWasm }, async () => {
  const fake = async (_url, init) => {
    if (init.method === 'DELETE') return new Response(null, { status: 200 });
    const body = JSON.parse(init.body);
    if (!('id' in body)) return new Response(null, { status: 202 });
    const result = body.method === 'initialize' ? { serverInfo: { name: 'synthetic' } }
      : body.method === 'tools/list' ? { tools: [TOOL] } : { content: [{ type: 'text', text: 'ok' }] };
    const sse = `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id + 1000, method: 'sampling/createMessage' })}\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`;
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' } });
  };
  await withEnv({ MCP_FRAME_IMPL: 'wasm' }, async () => {
    const m = mcp.withFetch(fake);
    const { session, serverInfo } = await m.connect('http://mcp.invalid/');
    assert.equal(serverInfo.name, 'synthetic');
    const tools = await m.listTools('http://mcp.invalid/', session);
    assert.deepEqual(tools, [TOOL]);
    assert.deepEqual(mcp.convertTool(tools[0]).tool.function.parameters.properties, { a: { type: 'string' } });
    assert.equal(mcp.resultToText(await m.callTool('http://mcp.invalid/', session, 'synthetic_tool', {})), 'ok');
  });
});

test('#989: UPLOAD_SNIFF_IMPL=wasm classifies a name over 64 KiB like the JS', { skip: skipWasm }, () => {
  davParseWasm.reset();
  const long = 'a'.repeat(70 * 1024);
  for (const name of [`${long}.md`, `${long}.PDF`, `${long}.png`, long, `${long}/x.txt`, `x.${long}`, `${long}.txt/`, `.${long}`, `dir.d/${long}`, `a.${'é'.repeat(30000)}`])
    assert.equal(sniff.classify(name, { impl: 'wasm' }), sniff.classifyJs(name), name.slice(-20));
  assert.equal(sniff.classify(`${long}.md`, { impl: 'wasm' }), 'Text');
  for (const name of ['.txt', 'a.txt', 'a.', '.', '..', 'a.tar.gz', 'x.txt/', 'x/.md', '', 'a.\ud800', 'A.DOCX'])
    assert.equal(sniff.classify(name, { impl: 'wasm' }), sniff.classifyJs(name), JSON.stringify(name));
});
