'use strict';
// handleChat's per-turn toolbox selection (#237): which boxes reach the tool router and which
// tools reach the model. Synthetic fixtures only; the model is a fake that answers once.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');

const BOXES = [
  { id: 'core', tools: [{ type: 'function', function: { name: 'core_time' } }] },
  { id: 'web-search', tools: [{ type: 'function', function: { name: 'web_search' } }, { type: 'function', function: { name: 'web_blocked' } }] },
  { id: 'diary', tools: [{ type: 'function', function: { name: 'diary_search' } }] },
  { id: 'gdrive', tools: [{ type: 'function', function: { name: 'gdrive_list' } }] },
  { id: 'oauth-box', tools: [{ type: 'function', function: { name: 'oauth_list' } }] },
];

async function run(t, { turnToolboxes, projectToolboxes = ['core'], diary = false, user = { id: 'synthetic-user', role: 'member' } }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-turn-boxes-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const res = new EventEmitter(); res.writeHead = () => {}; res.write = () => {}; res.end = () => { res.writableEnded = true; res.emit('finish'); };
  let routed = null, offered = null;
  const fetch = async (_url, init) => {
    offered = (JSON.parse(init.body).tools || []).map((x) => x.function.name);
    return { ok: true, body: (async function* () { yield Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }) + '\n\n'); })() };
  };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {}, diaryEnabled: () => diary },
    crypto: require('node:crypto'), path, fs, fetch, HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: user && user.id, dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', model: 'answer-model', assets: [], toolboxes: projectToolboxes }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://fixture.invalid' }), providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(['oauth-box']), accountReady: () => false, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => { routed = [...ids]; return { ids, routed: false }; } }, DEFAULT_TOOLBOXES: ['core'],
    CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => [],
    toolPolicy: { mode: (_u, name) => (name === 'web_blocked' ? 'block' : 'allow') }, requestScope: { getStore: () => ({ authn: user ? { user } : null }) },
    // The real resolver's contract: the selected boxes' tools minus the blocked ones.
    resolveTools: (project, _model, blocked) => ({ tools: BOXES.filter((b) => project.toolboxes.includes(b.id)).flatMap((b) => b.tools).filter((x) => !blocked(x.function.name)), dropped: [] }),
    isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: () => ({ text: 'reduced' }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => BOXES, executeToolCall: async () => 'unused', chatWideApproved: () => false, awaitApproval: async () => 'deny', recordUsage() {}, recordToolUse() {},
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: 'synthetic question', ...(turnToolboxes ? { turnToolboxes } : {}) });
  return { routed, offered };
}

test('a turn toolbox the server offers is added for that turn', async (t) => {
  const f = await run(t, { turnToolboxes: ['web-search'] });
  assert.deepEqual(f.routed, ['core', 'web-search']);
  assert.ok(f.offered.includes('web_search'));
});

test('unoffered, connector and signed-out turn toolboxes are dropped; blocked tools never reach the model', async (t) => {
  const f = await run(t, { turnToolboxes: ['no-such-box', 'gdrive', 'oauth-box', 'web-search', 42] });
  assert.deepEqual(f.routed, ['core', 'web-search']);
  for (const name of ['gdrive_list', 'oauth_list', 'web_blocked']) assert.equal(f.offered.includes(name), false, name);
});

test('Diary tools are not offered when the Diary add-on is off, from the turn or the project', async (t) => {
  const off = await run(t, { turnToolboxes: ['diary'], projectToolboxes: ['core', 'diary'] });
  assert.equal(off.routed.includes('diary'), false);
  assert.equal(off.offered.includes('diary_search'), false);
  const on = await run(t, { turnToolboxes: ['diary'], diary: true });
  assert.ok(on.offered.includes('diary_search'));
});
