'use strict';

// #1550 end to end through the chat handler: in Automatic tools mode, a turn routed to a model whose
// chat template cannot take tools is sent to the first tool-capable role model, with its tools. Manual
// tools mode is unchanged. Synthetic models, template gate and provider only; nothing is loaded.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const templateCaps = require('./chat-template-caps.cjs');

const SYNTHETIC_TOOL = { type: 'function', function: { name: 'synthetic_search', description: 'Search synthetic notes.', parameters: { type: 'object', properties: {} } } };
const ROLES = { fast: 'fast-model', smart: 'smart-model', code: 'code-model' };
const streamOk = () => ({ ok: true, body: (async function* () { yield Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n\n'); })() });

/** One chat turn. `project` is the stored record; `incapable` are the models whose template cannot take tools. */
async function run(t, { project, incapable = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-tools-mode-route-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], res = new EventEmitter();
  res.writeHead = () => {}; res.write = (line) => events.push(JSON.parse(line.slice(6))); res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const requests = [];
  const fetch = async (url, init) => { requests.push({ url: String(url), body: JSON.parse(init.body) }); return streamOk(); };
  const gate = { allowsTools: async (_manager, model) => !incapable.includes(model), markUnsupported() {}, forget() {}, size: () => 0 };
  const { handleChat } = createChatHandler({
    // Every role model reports as loaded, so the context check does not try to load one (a real switch would).
    modelManager: { enabled: true, props: async () => ({ ok: false, status: 404 }), health: async () => ({ ok: true, body: { all_models_loaded: Object.values(ROLES).map((name) => ({ model_name: name, loaded: true, backend_alive: true, recipe_options: { ctx_size: 32768 } })) } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {} }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange, templateToolsGate: gate,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => project, getProvider: () => ({ id: 'default', baseUrl: 'http://default.invalid' }), providerHeaders: () => ({}),
    autoRoles: () => ({ ...ROLES }), classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [],
    missingRoles: () => [], staleRolesError: () => null, lastLoadedModel: () => null,
    skillsIndexFor: () => [], visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: ['core'], CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) },
    resolveTools: () => ({ tools: [SYNTHETIC_TOOL], dropped: [], routes: [] }), isWriteTool: () => false, allToolboxes: () => [],
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: () => ({ text: 'reduced' }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    chatWideApproved: () => false, recordUsage() {}, recordToolUse() {}, executeToolCall: async () => 'unused', awaitApproval: async () => 'decline',
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: 'Synthetic question that needs a lookup' });
  return { events, requests, warnings: events.filter((e) => e.type === 'warning').map((e) => e.text) };
}

const automatic = { id: 'fixture-project', name: 'Synthetic', routing: 'auto', toolsMode: 'auto', assets: [], files: [] };
const manual = { ...automatic, toolsMode: 'manual', toolboxes: ['core'] };

test('#1550: Automatic tools on a Fast model that cannot take tools moves the turn to Smart, with its tools', async (t) => {
  const r = await run(t, { project: automatic, incapable: [ROLES.fast] });
  assert.equal(r.requests.length, 1);
  assert.equal(r.requests[0].body.model, ROLES.smart, 'the turn is answered by the tool-capable role');
  assert.deepEqual(r.requests[0].body.tools.map((x) => x.function.name), ['synthetic_search'], 'tools are sent, not dropped');
  assert.deepEqual(r.warnings, [], 'no "answers without tools" notice when the turn kept its tools');
});

test('#1550: Automatic tools where Fast can take tools stay on Fast, unchanged', async (t) => {
  const r = await run(t, { project: automatic, incapable: [] });
  assert.equal(r.requests[0].body.model, ROLES.fast);
  assert.equal(r.requests[0].body.tools.length, 1);
  assert.deepEqual(r.warnings, []);
});

test('#1550: Manual tools mode is unchanged: a Fast model that cannot take tools is kept, and the notice says so', async (t) => {
  const r = await run(t, { project: manual, incapable: [ROLES.fast] });
  assert.equal(r.requests[0].body.model, ROLES.fast, 'a hand-picked project is not re-routed');
  assert.equal(r.requests[0].body.tools, undefined, 'the template still gets no tools');
  assert.deepEqual(r.warnings, [templateCaps.TOOLS_OFF_NOTICE]);
});

test('#1550: Automatic with no tool-capable role keeps the routed model and shows the notice, not a silent answer', async (t) => {
  const r = await run(t, { project: automatic, incapable: [ROLES.fast, ROLES.smart, ROLES.code] });
  assert.equal(r.requests[0].body.model, ROLES.fast);
  assert.equal(r.requests[0].body.tools, undefined);
  assert.deepEqual(r.warnings, [templateCaps.TOOLS_OFF_NOTICE]);
});
