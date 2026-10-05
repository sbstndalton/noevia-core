'use strict';
// #848: with no model picked, the loaded local model is a fallback for the local provider only. A
// manual chat on another provider answers 400, and that error must not claim "none loaded" while a
// local model is loaded. Synthetic fixtures; no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');

async function send(t, { provider, loaded }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-no-model-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const replies = [], upstream = []; // replies: json() answers and raw SSE writes
  const fetch = async (url, init) => { upstream.push({ url: String(url), body: init?.body }); return { ok: false, status: 500, json: async () => ({}), text: async () => '', body: null }; };
  const res = new EventEmitter(); res.writeHead = () => {}; res.write = (c) => { replies.push({ sse: String(c).slice(0, 300) }); }; res.end = () => { res.emit('finish'); };
  const rows = { default: { id: 'default', label: 'Local', baseUrl: 'http://fixture.invalid' }, 'cloud-a': { id: 'cloud-a', label: 'Synthetic Cloud', baseUrl: 'https://cloud.invalid', external: true } };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {}, diaryEnabled: () => false },
    crypto: require('node:crypto'), path, fs, fetch, HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', routing: 'manual', provider, assets: [], toolboxes: [] }),
    skillsIndexFor: () => [], getProvider: (id) => rows[id], providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => false,
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' },
    requestScope: { getStore: () => ({ authn: { user: { id: 'synthetic-user', role: 'member' } }, workspace: { userId: 'synthetic-user' } }) },
    resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: (r) => ({ text: String(r) }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => loaded, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], chatWideApproved: () => false, awaitApproval: async () => 'deny', recordUsage() {}, recordToolUse() {}, executeToolCall: async () => '',
    json: (_res, status, body) => { replies.push({ status, body }); },
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: 'hello' });
  return { replies, upstream };
}

test('#848: a cloud provider with no model answers 400 naming the provider, not "none loaded"', async (t) => {
  const r = await send(t, { provider: 'cloud-a', loaded: 'synthetic-local-model' });
  assert.equal(r.replies.length, 1);
  assert.equal(r.replies[0].status, 400);
  assert.match(r.replies[0].body.error, /no model selected for Synthetic Cloud/);
  assert.doesNotMatch(r.replies[0].body.error, /none loaded/);
  assert.equal(r.upstream.length, 0, 'nothing is sent upstream, and the loaded local model is never borrowed');
});

test('#848: the local provider keeps its fallback and its "none loaded" wording', async (t) => {
  const none = await send(t, { provider: undefined, loaded: null });
  assert.equal(none.replies[0].status, 400);
  assert.match(none.replies[0].body.error, /no model selected and none loaded/);
  const loaded = await send(t, { provider: undefined, loaded: 'synthetic-local-model' });
  assert.equal(loaded.replies.some((x) => x.status === 400), false, 'a loaded local model still answers a local chat');
  assert.ok(loaded.replies.some((x) => x.sse && x.sse.includes('"model":"synthetic-local-model"')), 'the stream starts on the loaded local model');
});
