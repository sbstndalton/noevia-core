'use strict';
// #1520 / #1521 end to end: the system text the provider receives carries the connector and Web search
// note for the message, and an ordinary message's system text gets no route note. Synthetic provider; no network.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');

const stream = (...frames) => ({ ok: true, body: (async function* () { for (const f of frames) yield Buffer.from('data: ' + JSON.stringify(f) + '\n\n'); })() });

async function systemTextFor(t, message, { onServer = [{ id: 'nextcloud-files' }, { id: 'web-search' }, { id: 'core' }] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-route-note-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const res = new EventEmitter();
  res.writeHead = () => {}; res.write = () => {}; res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return stream({ choices: [{ delta: { content: 'synthetic reply' } }] });
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
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: ['core'], CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) },
    resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: () => ({ text: 'reduced' }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => onServer, chatWideApproved: () => false, recordUsage() {}, recordToolUse() {},
    executeToolCall: async () => 'unused', awaitApproval: async () => 'approve',
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message });
  const system = requests[0].body.messages.find((m) => m.role === 'system');
  return system ? system.content : '';
}

test('#1520: a Nextcloud request with Nextcloud Files off reaches the model with the not-available note', async (t) => {
  const sys = await systemTextFor(t, 'List the folders at the top of my Nextcloud files (names only).');
  assert.match(sys, /named Nextcloud Files, but Nextcloud Files is not available in this chat/);
  assert.match(sys, /Do not use another storage's tools in its place/);
});

test('#1521: a latest-version question with Web search off reaches the model with the cannot-verify note', async (t) => {
  const sys = await systemTextFor(t, 'What is the latest stable version of the Rust compiler?', { onServer: [{ id: 'web-search' }, { id: 'core' }] });
  assert.match(sys, /Web search is off for this chat, so you cannot check current information/);
});

test('an ordinary message gets no route note in its system text', async (t) => {
  const sys = await systemTextFor(t, 'Summarise the plan for the garden.');
  assert.doesNotMatch(sys, /named|Web search is|Connectors in this chat/);
});
