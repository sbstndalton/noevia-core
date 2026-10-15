'use strict';
// sbstndalton/noevia#1667: the Creative chat role. Owner decision (2026-10-15): prompts the sampling classifier already
// marks creative (sampling-presets.cjs) go to a Creative role, with creative sampling. Unassigned, the router's pick
// stands with creative sampling (the behaviour before #1667). Explicit model picks (a project's or the user's own) win.
// Synthetic provider and synthetic prompts only; no network, no model runs.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const { createVisionProbe } = require('./vision.cjs');
const reasoningEffort = require('./reasoning-effort.cjs');
const { PRESETS, creativeRoute, classifyTaskForSampling } = require('./sampling-presets.cjs');
const { missingRoles, staleRolesError } = require('./auto-roles-check.cjs');

let ROLES = { fast: 'synthetic-fast', smart: 'synthetic-smart' };
const catalogue = [{ name: 'synthetic-fast' }, { name: 'synthetic-smart' }, { name: 'synthetic-manual' }, { name: 'synthetic-creative' }];

async function turn(t, { route, project = { routing: 'auto' }, globalEffort = 'default', local = true, message, roles = ROLES }) {
  // The default provider is the local llama.cpp engine unless a case says otherwise (reasoning-effort.cjs localEngine).
  const saved = { kind: process.env.MODEL_MANAGER_KIND, base: process.env.INFERENCE_BASE_URL };
  if (local) { process.env.MODEL_MANAGER_KIND = 'llamacpp'; process.env.INFERENCE_BASE_URL = 'http://default.invalid'; }
  else { delete process.env.MODEL_MANAGER_KIND; delete process.env.INFERENCE_BASE_URL; }
  t.after(() => { for (const [k, v] of [['MODEL_MANAGER_KIND', saved.kind], ['INFERENCE_BASE_URL', saved.base]]) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-1667-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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
    skillsIndexFor: () => [], getProvider: () => ({ id: 'default', baseUrl: 'http://default.invalid' }), providerHeaders: () => ({}), autoRoles: () => roles,
    visionDescriptions: new Map(), visionProbe: createVisionProbe({ fetchImpl: fetch }),
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, oauthServerIds: () => new Set(), accountReady: () => true, mcpOAuth: { connected: () => false },
    chatToolRouter: { select: async (ids) => ({ ids, routed: false }) }, DEFAULT_TOOLBOXES: ['core'], CONNECTOR_BOXES: new Set(), connectedBoxes: () => [],
    toolPolicy: { mode: () => 'allow' }, requestScope: { getStore: () => ({}) }, resolveTools: () => ({ tools: [], dropped: [] }), isWriteTool: () => false,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: () => ({ text: 'reduced' }), diaryExtras: require('./diary-extras.cjs'),
    DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000, json: () => {}, saveChats() {}, endpointApproved: () => true, diaryHeaders: () => ({}),
    lastLoadedModel: () => null, classifyFastOrSmart: async () => route, servedCatalogue: async () => catalogue, modelsInstalled: async () => catalogue, missingRoles: () => [], staleRolesError: () => null,
    allToolboxes: () => [{ id: 'core' }], chatWideApproved: () => false, recordUsage() {}, recordToolUse() {}, executeToolCall: async () => 'unused', awaitApproval: async () => 'approve',
  });
  await handleChat({}, res, { projectId: 'fixture-project', chatId: 'fixture-chat', message });
  const meta = events.find((e) => e.type === 'meta' && e.model);
  return { request: requests[0], meta };
}


const CREATIVE = 'QA-SYNTH-1667 Write a short poem about a synthetic kettle.';
const PLAIN = 'QA-SYNTH-1667 What is the capital of a synthetic country?';
const WITH_CREATIVE = { fast: 'synthetic-fast', smart: 'synthetic-smart', creative: 'synthetic-creative' };

test('#1667 creativeRoute: only a creative prompt with a Creative model assigned moves; code turns never do', () => {
  assert.equal(creativeRoute({ routedRole: 'fast', message: CREATIVE, roles: WITH_CREATIVE }), 'creative');
  assert.equal(creativeRoute({ routedRole: 'smart', message: CREATIVE, roles: WITH_CREATIVE }), 'creative');
  assert.equal(creativeRoute({ routedRole: 'code', message: CREATIVE, roles: WITH_CREATIVE }), null, 'an explicit code classification wins, as for sampling');
  assert.equal(creativeRoute({ routedRole: 'fast', message: PLAIN, roles: WITH_CREATIVE }), null);
  assert.equal(creativeRoute({ routedRole: 'fast', message: CREATIVE, roles: ROLES }), null, 'unassigned: no move');
  assert.equal(creativeRoute({ routedRole: 'fast', message: CREATIVE, roles: { ...ROLES, creative: '' } }), null);
  assert.equal(creativeRoute({ routedRole: 'fast', message: CREATIVE, roles: null }), null);
  assert.equal(classifyTaskForSampling({ routedRole: 'creative', message: '' }), 'creative', 'a Creative turn samples creatively');
});

test('#1667 routing: a creative prompt goes to the assigned Creative model with creative sampling', async (t) => {
  for (const route of ['fast', 'smart']) {
    const { request, meta } = await turn(t, { route, message: CREATIVE, roles: WITH_CREATIVE });
    assert.equal(request.model, 'synthetic-creative', `${route} verdict moves to Creative`);
    assert.equal(meta.route, 'creative');
    assert.equal(request.temperature, PRESETS.creative.temperature);
    assert.equal(request.top_p, PRESETS.creative.top_p);
    assert.equal(meta.sampling.preset, 'creative');
  }
});

test('#1667 routing: unassigned Creative keeps the router pick, still with creative sampling (behaviour before #1667)', async (t) => {
  const { request, meta } = await turn(t, { route: 'smart', message: CREATIVE, roles: ROLES });
  assert.equal(request.model, 'synthetic-smart');
  assert.equal(meta.route, 'smart');
  assert.equal(request.temperature, PRESETS.creative.temperature);
  assert.equal(meta.sampling.preset, 'creative');
});

test('#1667 routing: a non-creative prompt never goes to Creative', async (t) => {
  const { request, meta } = await turn(t, { route: 'smart', message: PLAIN, roles: WITH_CREATIVE });
  assert.equal(request.model, 'synthetic-smart');
  assert.equal(meta.route, 'smart');
  assert.notEqual(meta.sampling?.preset, 'creative');
});

test('#1667 routing: explicit picks win: a project or chat on a chosen model keeps it for a creative prompt', async (t) => {
  const { request, meta } = await turn(t, { route: 'fast', message: CREATIVE, roles: WITH_CREATIVE, project: { routing: 'manual', model: 'synthetic-manual' } });
  assert.equal(request.model, 'synthetic-manual');
  assert.equal(meta.route, undefined, 'not an Automatic turn');
  // Creative sampling still applies to the explicit pick (the message heuristic, as before #1667) ...
  assert.equal(request.temperature, PRESETS.creative.temperature);
  // ... and explicit sampling values win over the preset, key by key.
  const own = await turn(t, { route: 'fast', message: CREATIVE, roles: WITH_CREATIVE, project: { routing: 'auto', sampling: { temperature: 0.3 } } });
  assert.equal(own.request.model, 'synthetic-creative');
  assert.equal(own.request.temperature, 0.3);
  assert.equal(own.request.top_p, PRESETS.creative.top_p);
});

test('#1667 a Creative model that is no longer installed is reported like the other roles', () => {
  const missing = missingRoles({ ...WITH_CREATIVE, creative: 'gone-creative' }, catalogue);
  assert.deepEqual(missing, [{ role: 'creative', model: 'gone-creative' }]);
  assert.match(staleRolesError(missing), /Creative \(gone-creative\)/);
});
