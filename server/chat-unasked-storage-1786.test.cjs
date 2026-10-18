'use strict';
// Needs dav-parse.wasm: provider egress is Rust-only since #1071. Skipped without it unless DAV_PARSE_WASM_REQUIRED=1.
if (!require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1') {
  require('node:test').test('needs dav-parse.wasm (not built)', { skip: 'dav-parse.wasm not built' }, () => {});
  return;
}
// sbstndalton/noevia#1786: a generic request ("a three-day packing checklist") on a chat with Google Drive
// connected. The tool gate answered "none", but the answering model was still offered the Drive tools with
// nothing telling it they were not wanted, read a QA tag in the message as a file reference, searched Drive
// and refused. With a gate that picked no tool and a message that does not ask about stored files, the model
// is now told to answer directly and not to search the person's storage. A gate that wants a tool, a message
// that does ask about files, and a chat with no storage connector are unchanged. Fake gate and provider only.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const { toolRouteNotes } = require('./tool-route-notes.cjs');

const stream = (...frames) => ({ ok: true, body: (async function* () { for (const f of frames) yield Buffer.from('data: ' + JSON.stringify(f) + '\n\n'); })() });
const tool = (name, description) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: { query: { type: 'string' } } } } });
const DRIVE_TOOL = tool('drive_search_files', 'Search Google Drive files by name or content');
const CORE_TOOL = tool('core_clock', 'Current time');
const BOXES = [{ id: 'gdrive', tools: [DRIVE_TOOL] }, { id: 'core', tools: [CORE_TOOL] }];
const PACKING = 'QA-SYNTH-7 Make me a three-day packing checklist for a trip to a coastal city.';
const UNASKED = /does not ask about the person's stored files/;

async function turn(t, message, gateDecision, { connected = ['gdrive'], tools = [DRIVE_TOOL, CORE_TOOL] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1786-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const res = new EventEmitter();
  res.writeHead = () => {}; res.write = () => {}; res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const requests = [], gateCalls = [];
  const fetch = async (url, init) => { requests.push(JSON.parse(init.body)); return stream({ choices: [{ delta: { content: 'synthetic reply' } }] }); };
  const toolGate = { evaluate: async (msg, offered) => { gateCalls.push(offered.map((x) => x.function.name)); return gateDecision; }, record() {} };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {} }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', model: 'answer-model', assets: [] }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://default.invalid' }), providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: ['core'], CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => connected,
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) },
    resolveTools: () => ({ tools, dropped: [] }), isWriteTool: () => false, toolGate,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: () => ({ text: 'reduced' }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => BOXES, chatWideApproved: () => false, recordUsage() {}, recordToolUse() {},
    executeToolCall: async () => 'unused', awaitApproval: async () => 'approve',
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message });
  const system = requests[0].messages.find((m) => m.role === 'system')?.content || '';
  return { system, first: requests[0], gateCalls };
}

const NONE = { decision: 'none', source: 'none', confidence: 0.98, elapsedMs: 5 };

test('#1786: a generic request with Drive offered and a gate that picked no tool tells the model not to search storage', async (t) => {
  const { system, first, gateCalls } = await turn(t, PACKING, NONE);
  assert.deepEqual(gateCalls, [['drive_search_files', 'core_clock']], 'the gate saw the Drive tool');
  assert.match(system, UNASKED);
  assert.match(system, /Google Drive/);
  assert.match(system, /label, code or ID/);
  assert.equal(first.tool_choice, undefined, 'nothing is forced');
  assert.ok(first.tools.some((x) => x.function.name === 'drive_search_files'), 'the tools themselves are unchanged');
});

test('#1786: a gate that wants the Drive tool gets no such note', async (t) => {
  const { system } = await turn(t, PACKING, { decision: { tool: 'drive_search_files', mode: 'require' }, source: 'decision', confidence: 0.9, elapsedMs: 5 });
  assert.doesNotMatch(system, UNASKED);
});

test('#1786: a request that asks about files keeps the Drive tools without the note', async (t) => {
  const { system } = await turn(t, 'Find the packing list document I saved last year.', NONE);
  assert.doesNotMatch(system, UNASKED);
});

test('#1786: a chat with no storage connector offered gets no note', async (t) => {
  const { system } = await turn(t, PACKING, NONE, { connected: [], tools: [CORE_TOOL] });
  assert.doesNotMatch(system, UNASKED);
});

test('#1786: toolRouteNotes only adds the note for a gate that picked no tool', () => {
  const base = { message: PACKING, offered: ['gdrive', 'nextcloud-files', 'core'], onServer: ['gdrive', 'nextcloud-files', 'core'], automatic: true };
  assert.match(toolRouteNotes({ ...base, gateNone: true }), /search Nextcloud Files or Google Drive for it/);
  assert.equal(toolRouteNotes({ ...base, gateNone: false }), '');
  assert.equal(toolRouteNotes(base), '');
  assert.equal(toolRouteNotes({ ...base, message: 'What is in the Lisbon folder on my Nextcloud?', gateNone: true }).includes('does not ask about'), false);
});
