'use strict';
// sbstndalton/noevia#1788 (after #1475): "Say hello in one short sentence." was routed Fast by the decision service,
// but the account's default effort (High) was applied anyway: the gemma reply got the High hint and the 8,192-token
// thinking cap, showed "Effort: high", and thought for about 19 s before "Hello there.". The #1475 fix capped
// thinking per effort; it never looked at the route. An Automatic turn routed Fast now runs at Low (the Low hint
// and its 512-token cap), so a trivial turn does not get extended reasoning. Smart and Code turns, and chats not
// on Automatic, keep the effort they had. Synthetic provider; no network.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const reasoningEffort = require('./reasoning-effort.cjs');

const ROLES = { fast: 'synthetic-fast', smart: 'synthetic-smart' };
const catalogue = [{ name: 'synthetic-fast' }, { name: 'synthetic-smart' }, { name: 'synthetic-manual' }];

async function turn(t, { route, project = { routing: 'auto' }, globalEffort = 'high' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1788-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = [], requests = [];
  const res = new EventEmitter(); res.writeHead = () => {}; res.end = () => { res.writableEnded = true; res.emit('finish'); };
  res.write = (chunk) => { for (const line of String(chunk).split('\n')) if (line.startsWith('data:')) { try { events.push(JSON.parse(line.slice(5))); } catch { /* not json */ } } };
  const fetch = async (url, init) => {
    if (String(url).endsWith('/chat/completions')) requests.push(JSON.parse(init.body));
    return { ok: true, status: 200, body: (async function* () { yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello there.' } }] })}\n\n`); })() };
  };
  const settings = { reasoning_effort_default: globalEffort };
  const { handleChat } = createChatHandler({
    modelManager: { enabled: true, health: async () => ({ ok: true, body: { all_models_loaded: catalogue.map((m) => ({ model_name: m.name, loaded: true, recipe_options: { ctx_size: 32768 } })) } }) },
    reasoningEffort, crypto: require('node:crypto'), path, fs, fetch,
    authService: { audit() {}, db: { prepare: (sql) => ({ get: () => { const key = /key='([a-z_]+)'/.exec(sql)?.[1]; return key in settings ? { value: settings[key] } : undefined; } }) } },
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', createToolExchange,
    currentWorkspace: () => ({ userId: 'synthetic-user', dir, assetDir: () => '/synthetic-only' }),
    getProject: () => ({ id: 'fixture-project', assets: [], ...project }),
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://default.invalid' }), providerHeaders: () => ({}), autoRoles: () => ROLES,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: ['core'], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) }, resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: () => ({ text: 'reduced' }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => route, servedCatalogue: async () => catalogue, modelsInstalled: async () => catalogue, missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [{ id: 'core' }], chatWideApproved: () => false, recordUsage() {}, recordToolUse() {}, executeToolCall: async () => 'unused', awaitApproval: async () => 'approve',
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message: 'QA-SYNTH-1 Say hello in one short sentence.' });
  const meta = events.find((e) => e.type === 'meta' && e.reasoningEffort);
  return { request: requests[0], effort: meta?.reasoningEffort, thinkingCap: meta?.thinkingCap };
}

test('#1788: an Automatic turn routed Fast runs at Low, not at the High default', async (t) => {
  const { request, effort, thinkingCap } = await turn(t, { route: 'fast' });
  assert.equal(request.model, 'synthetic-fast');
  assert.equal(effort, 'low');
  assert.equal(thinkingCap, 512);
  assert.equal(request.messages[0].content, reasoningEffort.HINTS.low);
});

test('#1788: an Automatic turn routed Smart keeps High', async (t) => {
  const { request, effort, thinkingCap } = await turn(t, { route: 'smart' });
  assert.equal(request.model, 'synthetic-smart');
  assert.equal(effort, 'high');
  assert.equal(thinkingCap, require('./thinking-budget.cjs').thinkingCap('high', 8192), 'the High cap for this 32k context');
  assert.equal(request.messages[0].content, reasoningEffort.HINTS.high);
});

test('#1788: a chat not on Automatic keeps its effort whatever the model', async (t) => {
  const { request, effort } = await turn(t, { route: 'fast', project: { routing: 'manual', model: 'synthetic-manual' } });
  assert.equal(request.model, 'synthetic-manual');
  assert.equal(effort, 'high');
});

test('#1788: effortForRoute lowers only a Fast route, and never raises', () => {
  assert.equal(reasoningEffort.effortForRoute('high', 'fast'), 'low');
  assert.equal(reasoningEffort.effortForRoute('default', 'fast'), 'low');
  assert.equal(reasoningEffort.effortForRoute('low', 'fast'), 'low');
  for (const role of ['smart', 'code', null, undefined]) for (const e of ['high', 'default', 'low']) assert.equal(reasoningEffort.effortForRoute(e, role), e);
});

// Review of core#119: only the account default is lowered. A project's own effort is an explicit choice and wins.
test('#1788: a project set to High keeps High on a Fast route', async (t) => {
  const { request, effort } = await turn(t, { route: 'fast', project: { routing: 'auto', reasoningEffort: 'high' }, globalEffort: 'default' });
  assert.equal(request.model, 'synthetic-fast');
  assert.equal(effort, 'high');
  assert.equal(request.messages[0].content, reasoningEffort.HINTS.high);
});

test('#1788: a project set to Standard (default) keeps it on a Fast route', async (t) => {
  const { effort } = await turn(t, { route: 'fast', project: { routing: 'auto', reasoningEffort: 'default' }, globalEffort: 'high' });
  assert.notEqual(effort, 'low');
});
