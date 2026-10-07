'use strict';

// #1002: CHAT_TEMPLATE_CAPS_IMPL. A native-engine model whose chat template cannot take tools
// (Gemma 3) is sent none; an engine that still answers with the template/tools 400 gets one retry
// without tools; failures show the upstream's sanitised reason. Synthetic models, templates and
// hosts only; nothing is loaded or run.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const caps = require('./chat-template-caps.cjs');
const davParseWasm = require('./dav-parse-wasm.cjs');
const context = require('./chat-context.cjs');

const wasmFile = process.env.DAV_PARSE_WASM || davParseWasm.DEFAULT_WASM;
const skipWasm = !fs.existsSync(wasmFile) && process.env.DAV_PARSE_WASM_REQUIRED !== '1' && 'dav-parse.wasm not built';
const MISSING = path.join(os.tmpdir(), 'no-such-1002-dav-parse.wasm');

const GEMMA3 = fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'chat-templates', 'google-gemma-3-12b-it.jinja'), 'utf8');
const QWEN = fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'chat-templates', 'Qwen-Qwen2.5-7B-Instruct.jinja'), 'utf8');
const ALTERNATE_400 = JSON.stringify({ error: { code: 400, message: 'Jinja Exception: Conversation roles must alternate user/assistant/user/assistant/...' } });
const SYSTEM_400 = JSON.stringify({ error: 'System role not supported' });
const GEMMA_400 = JSON.stringify({ error: { code: 400, message: 'Unable to generate parser for this template. Automatic parser generation failed: \n------------\n{{ raise_exception("Conversation roles must alternate user/assistant/user/assistant/...") }}', type: 'invalid_request_error' } });
const TOOL = { type: 'function', function: { name: 'synthetic_search', description: 'Search synthetic notes.', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } };
const SSE_OK = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n';

test('mode: unset is wasm, off and unknown values are off, explicit wasm is wasm', () => {
  assert.equal(caps.mode({}), 'wasm');
  assert.equal(caps.mode({ CHAT_TEMPLATE_CAPS_IMPL: ' WASM ' }), 'wasm');
  assert.equal(caps.mode({ CHAT_TEMPLATE_CAPS_IMPL: 'off' }), 'off');
  assert.equal(caps.mode({ CHAT_TEMPLATE_CAPS_IMPL: 'js' }), 'off');
  assert.ok(davParseWasm.IMPL_FLAGS.includes('CHAT_TEMPLATE_CAPS_IMPL'));
  assert.deepEqual(davParseWasm.wasmFlags({}), [], 'the default does not make startup fatal');
});

test('startup: the default with an unusable module warns and runs off; explicit values are kept', () => {
  const warnings = [];
  assert.equal(caps.startup({ DAV_PARSE_WASM: MISSING }, { warn: (m) => warnings.push(m) }), 'off');
  assert.match(warnings[0], /defaults to wasm, but dav-parse.wasm is unusable \(missing\); running with it off/);
  assert.equal(caps.mode({}), 'off');
  assert.equal(caps.startup({ CHAT_TEMPLATE_CAPS_IMPL: 'off', DAV_PARSE_WASM: MISSING }, { warn() {} }), 'off');
  davParseWasm.reset();
  caps.startup({ CHAT_TEMPLATE_CAPS_IMPL: 'wasm' }, { warn() {} });
  assert.equal(caps.mode({}), 'wasm', 'defaultDisabled cleared');
});

test('startup: the default with the pinned module stays wasm', { skip: skipWasm }, () => {
  davParseWasm.reset();
  assert.equal(caps.startup({ DAV_PARSE_WASM: wasmFile }, { warn: () => assert.fail('no warning') }), 'wasm');
});

test('failureText falls back to null (the fixed sentences) when the module cannot run', () => {
  const prev = process.env.DAV_PARSE_WASM;
  process.env.DAV_PARSE_WASM = MISSING;
  davParseWasm.reset();
  try {
    assert.equal(caps.failureText(400, GEMMA_400), null);
    assert.equal(context.providerError(GEMMA_400, 400), context.STREAM_FAILED_TEXT);
    assert.equal(context.providerError({ message: 'Context size has been exceeded.' }), context.CONTEXT_FULL_TEXT);
  } finally {
    if (prev === undefined) delete process.env.DAV_PARSE_WASM; else process.env.DAV_PARSE_WASM = prev;
    davParseWasm.reset();
  }
});

test('failureText shows the sanitised upstream reason, per kind', { skip: skipWasm }, () => {
  davParseWasm.reset();
  assert.equal(caps.failureText(400, GEMMA_400), "The model's chat template cannot handle this request: Unable to generate parser for this template. Automatic parser generation failed (template: Conversation roles must alternate user/assistant/user/assistant/...). Try another model, or ask without tools.");
  assert.equal(caps.failureText(400, '{"error":{"message":"the request exceeds the available context size","type":"exceed_context_size_error"}}'), context.CONTEXT_FULL_TEXT);
  assert.equal(caps.failureText(503, '{"error":{"message":"Loading model"}}'), 'The model backend is not responding (Loading model). Check that the engine is running, then retry.');
  assert.equal(caps.failureText(500, 'terminated: other side closed <synthetic socket 10.0.0.1:443>'), context.STREAM_FAILED_TEXT, '#918: runtime text stays hidden');
  const leaky = caps.failureText(500, '{"error":"failed at http://10.1.2.3:8080/v1 key=sk-synthetic000000"}');
  assert.doesNotMatch(leaky, /10\.1\.2\.3|sk-synthetic|http:/);
  // Off: only this text change remains.
  assert.equal(caps.failureText(422, '{"detail":"temperature must be <= 2"}'), 'The model provider refused the request: temperature must be <= 2. Partial output was preserved.');
});

test('the tools gate reads /props once per model, caches, and treats unknown as allowed', { skip: skipWasm }, async () => {
  davParseWasm.reset();
  let t = 0, calls = 0;
  const gate = caps.createToolsGate({ now: () => t });
  const manager = { props: async (model) => { calls++; return model === 'gemma' ? { ok: true, body: { chat_template: GEMMA3 } } : model === 'qwen' ? { ok: true, body: { chat_template: QWEN } } : { ok: false, status: 404 }; } };
  assert.equal(await gate.allowsTools(manager, 'gemma'), false);
  assert.equal(await gate.allowsTools(manager, 'gemma'), false);
  assert.equal(calls, 1);
  assert.equal(await gate.allowsTools(manager, 'qwen'), true);
  assert.equal(await gate.allowsTools(manager, 'unloaded'), true);
  assert.equal(await gate.allowsTools({ props: async () => { throw new Error('down'); } }, 'other'), true);
  t = 31 * 1000; calls = 0;
  await gate.allowsTools(manager, 'unloaded');
  assert.equal(calls, 1, 'unknown answers expire quickly');
  gate.markUnsupported('unloaded');
  assert.equal(await gate.allowsTools(manager, 'unloaded'), false);
});

async function chatWith(t, { fetch, props, env = 'wasm', tools = [TOOL], gate = caps.createToolsGate(), project = { id: 'fixture-project', routing: 'manual', assets: [], toolboxes: [] }, provider = { id: 'default', label: 'Local', baseUrl: 'http://fixture.invalid' } }) {
  const { createChatHandler } = require('./chat.cjs');
  const { createToolExchange } = require('./tool-exchange.cjs');
  const { createVisionProbe } = require('./vision.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1002-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prev = process.env.CHAT_TEMPLATE_CAPS_IMPL;
  process.env.CHAT_TEMPLATE_CAPS_IMPL = env;
  t.after(() => { if (prev === undefined) delete process.env.CHAT_TEMPLATE_CAPS_IMPL; else process.env.CHAT_TEMPLATE_CAPS_IMPL = prev; });
  const events = [];
  const res = new EventEmitter(); res.writeHead = () => {}; res.write = (c) => { events.push(String(c)); }; res.end = () => { res.emit('finish'); };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, props, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'synthetic-gemma', loaded: true }] } }) },
    templateToolsGate: gate,
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {}, diaryEnabled: () => false },
    crypto: require('node:crypto'), path, fs, fetch, HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => project,
    skillsIndexFor: () => [], getProvider: () => provider, providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => false,
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' },
    requestScope: { getStore: () => ({ authn: { user: { id: 'synthetic-user', role: 'member' } }, workspace: { userId: 'synthetic-user' } }) },
    resolveTools: () => ({ tools, dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (r) => ({ text: String(r) }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => 'synthetic-gemma', classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], chatWideApproved: () => false, awaitApproval: async () => 'deny', recordUsage() {}, recordToolUse() {}, executeToolCall: async () => '',
    json: (_res, status, body) => { events.push(`data: ${JSON.stringify({ type: 'json', status, body })}\n`); },
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: 'hello', model: 'synthetic-gemma' });
  return events.join('').split('\n').filter((l) => l.startsWith('data: ')).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
}

/** A fake engine: records each chat request body; answers with `reply(body, n)`. */
function engine(reply) {
  const bodies = [];
  const fetch = async (url, init) => {
    if (!String(url).endsWith('/chat/completions')) return new Response('{}', { status: 404 });
    const body = JSON.parse(init.body);
    bodies.push(body);
    return reply(body, bodies.length);
  };
  return { fetch, bodies };
}
const sse = () => new Response(SSE_OK, { status: 200, headers: { 'content-type': 'text/event-stream' } });
const toolsRefused = (body) => (body.tools ? new Response(GEMMA_400, { status: 400, headers: { 'content-type': 'application/json' } }) : sse());

test('wasm: a Gemma 3 template from /props means no tools are sent, with a notice', { skip: skipWasm }, async (t) => {
  davParseWasm.reset();
  const e = engine(toolsRefused);
  const events = await chatWith(t, { fetch: e.fetch, props: async () => ({ ok: true, body: { chat_template: GEMMA3 } }) });
  assert.equal(e.bodies.length, 1);
  assert.equal(e.bodies[0].tools, undefined);
  assert.equal(e.bodies[0].tool_choice, undefined);
  assert.ok(events.some((v) => v.type === 'warning' && v.text === caps.TOOLS_OFF_NOTICE));
  assert.ok(events.some((v) => v.type === 'delta' && v.text === 'Hi'));
  assert.ok(!events.some((v) => v.type === 'error'));
});

test('wasm: a template with native tools keeps them', { skip: skipWasm }, async (t) => {
  davParseWasm.reset();
  const e = engine(() => sse());
  await chatWith(t, { fetch: e.fetch, props: async () => ({ ok: true, body: { chat_template: QWEN } }) });
  assert.deepEqual(e.bodies[0].tools, [TOOL]);
});

test('wasm: template unknown, engine refuses tools: one retry without tools, with a notice', { skip: skipWasm }, async (t) => {
  davParseWasm.reset();
  const e = engine(toolsRefused);
  const events = await chatWith(t, { fetch: e.fetch, props: async () => ({ ok: false, status: 404 }) });
  assert.equal(e.bodies.length, 2);
  assert.deepEqual(e.bodies[0].tools, [TOOL]);
  assert.equal(e.bodies[1].tools, undefined);
  assert.ok(events.some((v) => v.type === 'warning' && v.text === caps.TOOLS_RETRY_NOTICE));
  assert.ok(events.some((v) => v.type === 'delta' && v.text === 'Hi'));
  assert.ok(!events.some((v) => v.type === 'error'));
});

test('wasm: the retry happens once; a second refusal shows the real reason', { skip: skipWasm }, async (t) => {
  davParseWasm.reset();
  const e = engine(() => new Response(GEMMA_400, { status: 400 }));
  const events = await chatWith(t, { fetch: e.fetch, props: async () => ({ ok: false, status: 404 }) });
  assert.equal(e.bodies.length, 2);
  assert.deepEqual(e.bodies.map((b) => !!b.tools), [true, false]);
  const err = events.find((v) => v.type === 'error');
  assert.match(err.text, /Conversation roles must alternate/);
  assert.doesNotMatch(err.text, /The model stream failed/);
});

test('wasm: another 400 is not retried', { skip: skipWasm }, async (t) => {
  davParseWasm.reset();
  const e = engine(() => new Response('{"error":{"message":"synthetic bad sampling value"}}', { status: 400 }));
  const events = await chatWith(t, { fetch: e.fetch, props: async () => ({ ok: false }) });
  assert.ok(e.bodies.every((b) => b.tools), 'tools never dropped');
  assert.ok(!events.some((v) => v.type === 'warning' && v.text === caps.TOOLS_RETRY_NOTICE));
  assert.match(events.find((v) => v.type === 'error').text, /synthetic bad sampling value/);
});

test('off: tools are sent as before and no retry, but the error shows the real reason', { skip: skipWasm }, async (t) => {
  davParseWasm.reset();
  let propsCalls = 0;
  const e = engine(toolsRefused);
  const events = await chatWith(t, { env: 'off', fetch: e.fetch, props: async () => { propsCalls++; return { ok: true, body: { chat_template: GEMMA3 } }; } });
  assert.equal(propsCalls, 0);
  assert.ok(e.bodies.every((b) => b.tools));
  assert.ok(!events.some((v) => v.type === 'warning' && /chat template/.test(v.text)));
  assert.match(events.find((v) => v.type === 'error').text, /chat template cannot handle this request: Unable to generate parser/);
});

test('#1015: a template that fails with or without tools is not remembered; the next chat still sends tools', { skip: skipWasm }, async (t) => {
  davParseWasm.reset();
  const gate = caps.createToolsGate();
  const parser400 = JSON.stringify({ error: { code: 400, message: 'Unable to generate parser for this template. Automatic parser generation failed: roles must alternate' } });
  const e = engine(() => new Response(parser400, { status: 400 }));
  const props = async () => ({ ok: true, body: { chat_template: QWEN } });
  await chatWith(t, { fetch: e.fetch, props, gate });
  assert.equal(e.bodies.length, 2);
  assert.deepEqual(e.bodies.map((b) => !!b.tools), [true, false]);
  const e2 = engine(() => sse());
  await chatWith(t, { fetch: e2.fetch, props, gate });
  assert.deepEqual(e2.bodies[0].tools, [TOOL]);
});

test('#1015: a retry that works is remembered for the next chat', { skip: skipWasm }, async (t) => {
  davParseWasm.reset();
  const gate = caps.createToolsGate();
  const props = async () => ({ ok: false });
  await chatWith(t, { fetch: engine(toolsRefused).fetch, props, gate });
  const e2 = engine(toolsRefused);
  await chatWith(t, { fetch: e2.fetch, props, gate });
  assert.equal(e2.bodies.length, 1);
  assert.equal(e2.bodies[0].tools, undefined);
});

test('#1016: system-role and plain role-order refusals are not retried without tools', { skip: skipWasm }, async (t) => {
  for (const body of [SYSTEM_400, ALTERNATE_400]) {
    davParseWasm.reset();
    const e = engine(() => new Response(body, { status: 400 }));
    const events = await chatWith(t, { fetch: e.fetch, props: async () => ({ ok: false }) });
    assert.ok(e.bodies.every((b) => b.tools), body);
    assert.ok(!events.some((v) => v.type === 'warning' && v.text === caps.TOOLS_RETRY_NOTICE), body);
  }
  assert.equal(caps.toolsRefused(400, '{"error":"tools param requires --jinja flag"}'), true);
  assert.equal(caps.toolsRefused(400, '{"error":"this model does not support tools"}'), true);
  assert.equal(caps.toolsRefused(400, SYSTEM_400), false);
  assert.equal(caps.toolsRefused(400, ALTERNATE_400), false);
});

test('#1018: concurrent misses share one /props lookup; an aborted caller stops waiting', { skip: skipWasm }, async () => {
  davParseWasm.reset();
  const gate = caps.createToolsGate();
  let calls = 0, release;
  const pending = new Promise((r) => { release = r; });
  const manager = { props: async () => { calls++; await pending; return { ok: true, body: { chat_template: GEMMA3 } }; } };
  const ac = new AbortController();
  const a = gate.allowsTools(manager, 'm'), b = gate.allowsTools(manager, 'm'), c = gate.allowsTools(manager, 'm', ac.signal);
  ac.abort();
  assert.equal(await c, true, 'aborted: unknown');
  release();
  assert.deepEqual(await Promise.all([a, b]), [false, false]);
  assert.equal(calls, 1);
  assert.equal(await gate.allowsTools(manager, 'm'), false);
  assert.equal(calls, 1);
});

test('a cloud provider never has tools dropped, and /props is not read', { skip: skipWasm }, async (t) => {
  davParseWasm.reset();
  let propsCalls = 0;
  const e = engine(toolsRefused);
  const events = await chatWith(t, { fetch: e.fetch, props: async () => { propsCalls++; return { ok: true, body: { chat_template: GEMMA3 } }; }, provider: { id: 'synthetic-cloud', label: 'Cloud', baseUrl: 'http://cloud.invalid', shared: true }, project: { id: 'fixture-project', routing: 'manual', assets: [], toolboxes: [], provider: 'synthetic-cloud', model: 'synthetic-cloud-model' } });
  assert.equal(propsCalls, 0);
  assert.ok(e.bodies.length >= 1 && e.bodies.every((b) => b.tools));
  assert.ok(!events.some((v) => v.type === 'warning' && /chat template/.test(v.text)));
});

test('the non-streaming fallback sends no tools when the template gate dropped them', { skip: skipWasm }, async (t) => {
  davParseWasm.reset();
  const e = engine((body) => (body.stream
    ? new Response('', { status: 200, headers: { 'content-type': 'text/event-stream' } })
    : new Response(JSON.stringify({ choices: [{ message: { content: 'Hi' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })));
  await chatWith(t, { fetch: e.fetch, props: async () => ({ ok: true, body: { chat_template: GEMMA3 } }) });
  const fallback = e.bodies.filter((b) => b.stream === false);
  assert.ok(fallback.length >= 1);
  assert.ok(e.bodies.every((b) => b.tools === undefined && b.tool_choice === undefined));
});
