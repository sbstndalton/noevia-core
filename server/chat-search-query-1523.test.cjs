'use strict';
// #1523 end to end: a search tool call whose query copied the request wrapper runs with the question
// only, and the next round carries the same cleaned call. Synthetic provider and tool; no network.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');

const WRAPPED = ': the latest stable version of the Rust compiler? Cite the source';
const toolFrame = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-search', function: { name: 'synthetic_search', arguments: JSON.stringify({ query: WRAPPED }) } }] } }] };
const stream = (...frames) => ({ ok: true, body: (async function* () { for (const f of frames) yield Buffer.from('data: ' + JSON.stringify(f) + '\n\n'); })() });

test('#1523: the executed search query and the next round\'s tool call carry the question, not the wrapper', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-search-query-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], res = new EventEmitter();
  res.writeHead = () => {}; res.write = (line) => events.push(JSON.parse(line.slice(6))); res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const requests = [], executed = [];
  const fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    if (requests.length === 1) return stream(toolFrame);
    return stream({ choices: [{ delta: { content: 'synthetic final answer' } }] });
  };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {} }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', model: 'answer-model', assets: [] }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://default.invalid' }), providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) },
    resolveTools: () => ({ tools: [{ type: 'function', function: { name: 'synthetic_search', parameters: { type: 'object' } } }], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: () => ({ text: 'reduced' }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], chatWideApproved: () => false, recordUsage() {}, recordToolUse() {},
    executeToolCall: async (project, name, rawArgs) => { executed.push({ name, rawArgs }); return 'synthetic search result'; },
    awaitApproval: async () => 'approve',
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: 'Search the web: what is the latest stable version of the Rust compiler? Cite the source.' });

  assert.equal(executed.length, 1, 'the search runs once');
  assert.deepEqual(JSON.parse(executed[0].rawArgs), { query: 'the latest stable version of the Rust compiler' });
  assert.equal(requests.length, 2, 'the next round follows the tool result');
  const assistant = requests[1].body.messages.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { query: 'the latest stable version of the Rust compiler' }, 'the model is shown its own call cleaned');
  assert.ok(!JSON.stringify(events).includes('Cite the source'), 'the wrapper text is not streamed back to the user');
});
