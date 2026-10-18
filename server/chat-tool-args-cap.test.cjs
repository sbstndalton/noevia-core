'use strict';
// Needs dav-parse.wasm: provider egress is Rust-only since #1071. Skipped without it unless DAV_PARSE_WASM_REQUIRED=1.
if (!require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1') {
  require('node:test').test('needs dav-parse.wasm (not built)', { skip: 'dav-parse.wasm not built' }, () => {});
  return;
}
// A streamed tool call whose arguments pass 8 MiB is not run, for a local and an external provider alike: the
// arguments are dropped while they stream (nothing downstream buffers an unbounded model output), the call is
// answered with a refusal and the history carries `{}`. Stubbed model output only; no engine, no model.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');

const MIB = 1024 * 1024;
const frame = (call) => ({ choices: [{ delta: { tool_calls: [call] } }] });
const stream = (...frames) => ({ ok: true, body: (async function* () { for (const f of frames) yield Buffer.from('data: ' + JSON.stringify(f) + '\n\n'); })() });

async function run(t, { frames, fallbackCalls = null, external = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-tool-args-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], res = new EventEmitter();
  res.writeHead = () => {}; res.write = (line) => events.push(JSON.parse(line.slice(6))); res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const requests = [];
  let executions = 0, executedArgs = null;
  const fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    if (requests.length === 1) return fallbackCalls ? stream() : stream(...frames); // an empty stream makes chat.cjs retry without streaming
    if (fallbackCalls && requests.length === 2) {
      return new Response(JSON.stringify({ choices: [{ message: { content: '', tool_calls: fallbackCalls } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return stream({ choices: [{ delta: { content: 'synthetic final answer' } }] });
  };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {} }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', model: 'answer-model', assets: [] }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://default.invalid', ...(external ? { external: true } : {}) }), providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) },
    resolveTools: () => ({ tools: [{ type: 'function', function: { name: 'synthetic_read', parameters: { type: 'object' } } }], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (text) => ({ text: String(text) }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], chatWideApproved: () => false, recordUsage() {}, recordToolUse() {},
    executeToolCall: async (_project, _name, args) => { executions++; executedArgs = args; return 'synthetic result'; },
    awaitApproval: async () => 'approve', stepSupervision: null,
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: 'Read it.' });
  return { events, requests, executions, executedArgs };
}

const last = (r) => r.requests.at(-1).body.messages;
const toolMessage = (r) => last(r).find((m) => m.role === 'tool');
const assistantCall = (r) => last(r).find((m) => m.role === 'assistant' && m.tool_calls).tool_calls[0];
const START = frame({ index: 0, id: 'call-fixture', function: { name: 'synthetic_read', arguments: '' } });
const argsFrames = (...parts) => [START, ...parts.map((a) => frame({ index: 0, function: { arguments: a } }))];
const REFUSAL = 'was not run: its name, id or arguments were larger than about 8 million characters, which is not a real tool call. Nothing was changed.';

for (const external of [false, true]) {
  test(`arguments over the cap: the call is not run and the history carries {} (${external ? 'external' : 'local'} provider)`, async (t) => {
    // Nine 1 MiB fragments: the cap is passed on the ninth.
    const r = await run(t, { frames: argsFrames(...Array.from({ length: 9 }, () => 'x'.repeat(MIB))), external });
    assert.equal(r.executions, 0, 'the tool was not executed');
    assert.ok(toolMessage(r).content.includes(`ERROR: synthetic_read ${REFUSAL}`), toolMessage(r).content.slice(0, 300));
    assert.equal(assistantCall(r).function.arguments, '{}');
    // What was streamed to the client never grew past the cap.
    for (const e of r.events.filter((x) => x.type === 'tool')) assert.ok(String(e.args).length <= 8 * MIB, 'streamed args bounded');
  });
}

test('a tool name that streams past the cap is not run, and the name is cut for the message and the history', async (t) => {
  const first = frame({ index: 0, id: 'call-fixture', function: { name: 'n'.repeat(5 * MIB), arguments: '{}' } });
  const more = frame({ index: 0, function: { name: 'n'.repeat(5 * MIB) } });
  const r = await run(t, { frames: [first, more] });
  assert.equal(r.executions, 0);
  // The cut name is no tool of this project, so the call is refused as an unknown tool (or as too large): either way it did not run.
  assert.ok(toolMessage(r).content.includes(`ERROR: `) && toolMessage(r).content.length < 500, toolMessage(r).content.slice(0, 300));
  assert.ok(assistantCall(r).function.name.length <= 64);
  for (const e of r.events.filter((x) => x.type === 'tool')) assert.ok(String(e.name).length <= 5 * MIB, 'streamed names bounded');
});

test('a tool call id over the cap is not run and is replaced by a short one', async (t) => {
  const r = await run(t, { frames: [frame({ index: 0, id: 'i'.repeat(8 * MIB + 1), function: { name: 'synthetic_read', arguments: '{}' } })] });
  assert.equal(r.executions, 0);
  assert.ok(toolMessage(r).content.includes(`ERROR: synthetic_read ${REFUSAL}`));
  assert.ok(assistantCall(r).id.length < 64, 'the id is not carried');
});

for (const field of ['arguments', 'name', 'id']) {
  test(`non-streamed fallback: one tool call with a ${field} over the cap is not run, the next one in the same reply still is`, async (t) => {
    const big = 'z'.repeat(8 * MIB + 1);
    const over = { id: field === 'id' ? big : 'call-over', function: { name: field === 'name' ? big : 'synthetic_read', arguments: field === 'arguments' ? big : '{}' } };
    const fine = { id: 'call-fine', function: { name: 'synthetic_read', arguments: '{"q":"ok"}' } };
    const r = await run(t, { fallbackCalls: [over, fine] });
    assert.equal(r.requests.length, 3, 'the empty stream was retried without streaming');
    assert.equal(r.executions, 1, 'only the call within the cap ran');
    assert.equal(r.executedArgs, '{"q":"ok"}');
    const messages = last(r);
    const calls = messages.find((m) => m.role === 'assistant' && m.tool_calls).tool_calls;
    assert.equal(calls[0].function.arguments, '{}');
    assert.ok(calls[0].function.name.length <= 64 && calls[0].id.length <= 64, 'name and id are not carried over the cap');
    const results = messages.filter((m) => m.role === 'tool').map((m) => m.content);
    assert.ok(results[0].includes('ERROR: ') && results[0].length < 500, results[0].slice(0, 200));
    if (field !== 'name') assert.ok(results[0].includes(REFUSAL), results[0].slice(0, 200));
    assert.ok(results[1].includes('synthetic result'));
  });
}

test('arguments under the cap still run (the bound is on size only)', async (t) => {
  const r = await run(t, { frames: argsFrames('{"q":"', 'x'.repeat(MIB), '"}') });
  assert.equal(r.executions, 1);
  assert.equal(r.executedArgs.length, '{"q":"'.length + MIB + '"}'.length);
});

// Every body above must have run (a wrong test signature would make node:test skip it silently).
let ran = 0;
test.afterEach(() => { ran++; });
test.after(() => assert.equal(ran, 8, 'every test body ran'));
