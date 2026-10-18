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

async function run(t, { argFragments, external = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-tool-args-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], res = new EventEmitter();
  res.writeHead = () => {}; res.write = (line) => events.push(JSON.parse(line.slice(6))); res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const requests = [];
  let executions = 0, executedArgs = null;
  const fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    if (requests.length === 1) {
      return stream(frame({ index: 0, id: 'call-fixture', function: { name: 'synthetic_read', arguments: '' } }),
        ...argFragments.map((a) => frame({ index: 0, function: { arguments: a } })));
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

const toolMessage = (r) => r.requests[1].body.messages.find((m) => m.role === 'tool');
const assistantCall = (r) => r.requests[1].body.messages.find((m) => m.role === 'assistant' && m.tool_calls).tool_calls[0];

for (const external of [false, true]) {
  test(`arguments over 8 MiB: the call is not run and the history carries {} (${external ? 'external' : 'local'} provider)`, async (t) => {
    // Nine 1 MiB fragments: the cap is passed on the ninth.
    const r = await run(t, { argFragments: Array.from({ length: 9 }, () => 'x'.repeat(MIB)), external });
    assert.equal(r.executions, 0, 'the tool was not executed');
    assert.ok(toolMessage(r).content.includes('ERROR: synthetic_read was not run: its arguments were larger than 8 MiB, which is not a real tool call. Nothing was changed.'), toolMessage(r).content.slice(0, 300));
    assert.equal(assistantCall(r).function.arguments, '{}');
    // What was streamed to the client never grew past the cap.
    for (const e of r.events.filter((x) => x.type === 'tool')) assert.ok(String(e.args).length <= 8 * MIB, 'streamed args bounded');
  });
}

test('arguments under the cap still run (the bound is on size only)', async (t) => {
  const r = await run(t, { argFragments: ['{"q":"', 'x'.repeat(MIB), '"}'] });
  assert.equal(r.executions, 1);
  assert.equal(r.executedArgs.length, '{"q":"'.length + MIB + '"}'.length);
});
