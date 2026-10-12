'use strict';
// #1513 end to end: a 2 MB-style text source that the reply only partly reads is said so to the model
// (system text) and to the user (a warning event). Synthetic source, provider and retrieval; no network.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');

const stream = (...frames) => ({ ok: true, body: (async function* () { for (const f of frames) yield Buffer.from('data: ' + JSON.stringify(f) + '\n\n'); })() });
const BIG = 'lorem ipsum dolor sit amet '.repeat(90000) + 'LARGE FILE END MARKER: HERON-9001';

test('#1513: an excerpt-only read of a large source is told to the model and warned to the user', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-coverage-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], res = new EventEmitter();
  res.writeHead = () => {}; res.write = (line) => events.push(JSON.parse(line.slice(6))); res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return stream({ choices: [{ delta: { content: 'synthetic reply' } }] });
  };
  const project = { id: 'fixture-project', model: 'answer-model', assets: [], files: [{ name: 'qa_large_2mb.txt', content: BIG }] };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {} }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => project,
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://default.invalid' }), providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) },
    resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => false,
    // Retrieval returns one excerpt of the large file, as the index does for a question.
    rag: { filesContext: async (projectId, files, query, userId, onSources) => { onSources([{ file: 'qa_large_2mb.txt', body: 'LARGE FILE excerpt around line 904' }]); return 'Sources attached to this project (1): "qa_large_2mb.txt". Excerpts of the relevant ones follow.'; } },
    prefill: { recordSample() {} }, reduceToolResult: () => ({ text: 'reduced' }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], chatWideApproved: () => false, recordUsage() {}, recordToolUse() {},
    executeToolCall: async () => 'unused', awaitApproval: async () => 'approve',
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: 'Does the file contain HERON-9001 anywhere?' });

  const system = requests[0].body.messages.find((m) => m.role === 'system').content;
  assert.match(system, /Source text was truncated for this reply: "qa_large_2mb\.txt" is \d[\d,]* characters long and this reply read only 34 characters/);
  assert.match(system, /Do not say that some text is absent from a file, or answer "no"/);
  const warning = events.find((e) => e.type === 'warning');
  assert.ok(warning, 'the user is warned');
  assert.match(warning.text, /Only part of "qa_large_2mb\.txt" was read for this reply \(34 of \d[\d,]* characters\)/);
});

test('#1513: a project whose sources were all read in full gets no truncation note or warning', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-coverage-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], res = new EventEmitter();
  res.writeHead = () => {}; res.write = (line) => events.push(JSON.parse(line.slice(6))); res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const requests = [];
  const fetch = async (url, init) => { requests.push({ body: JSON.parse(init.body) }); return stream({ choices: [{ delta: { content: 'ok' } }] }); };
  const project = { id: 'fixture-project', model: 'answer-model', assets: [], files: [{ name: 'short.md', content: 'short note' }] };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'answer-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    reasoningEffort: require('./reasoning-effort.cjs'), authService: { audit() {} }, crypto: require('node:crypto'), path, fs, fetch,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => project,
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://default.invalid' }), providerHeaders: () => ({}), autoRoles: () => null,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: [], CONNECTOR_BOXES: new Set(['gdrive']), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) },
    resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async (projectId, files, query, userId, onSources) => { onSources([{ file: 'short.md', body: 'short note', kind: 'file' }]); return 'Sources attached to this project (1): "short.md".'; } },
    prefill: { recordSample() {} }, reduceToolResult: () => ({ text: 'reduced' }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [], chatWideApproved: () => false, recordUsage() {}, recordToolUse() {},
    executeToolCall: async () => 'unused', awaitApproval: async () => 'approve',
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: 'What does short.md say?' });
  const system = requests[0].body.messages.find((m) => m.role === 'system').content;
  assert.doesNotMatch(system, /Source text was truncated/);
  assert.equal(events.some((e) => e.type === 'warning' && /Only part of/.test(e.text)), false);
});
