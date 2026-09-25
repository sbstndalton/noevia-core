'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createChatHandler } = require('./chat.cjs');
const { createToolboxes } = require('./toolboxes.cjs');
const { createDriveTools } = require('./gdrive-tools.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');

async function runDriveCall(t, { name, savedMode = null, connected = true, decision = 'approve', autoDecision = null, history = [], sampling = undefined, autoSamplingEnabled = undefined, message = 'Synthetic Drive request', codeRoleConfigured = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-drive-chat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const user = { id: 'synthetic-user' }, project = { id: 'synthetic-project', model: 'synthetic-model', routing: autoDecision ? 'auto' : 'manual', toolboxes: ['core'], files: [], ...(sampling !== undefined ? { sampling } : {}) };
  const store = { workspace: { userId: user.id }, authn: { user } };
  const requestScope = { getStore: () => store, run: (_scope, fn) => fn() };
  const accounts = { forUser: () => ({ drive: { state: () => ({ state: connected ? 'connected' : 'disconnected' }) } }) };
  const definitions = createDriveTools({ accounts });
  const executions = [], approvals = [], requests = [], events = [];
  const driveTools = { ...definitions, execute: async (_user, tool) => { executions.push(tool); return 'synthetic Drive result'; } };
  const toolbox = createToolboxes({
    boxes: [driveTools.box], driveTools, offered: (id) => id !== 'gdrive',
    mcpBoxes: () => [], mcpTools: () => new Map(), prefill: { budgetFor: () => null, rateFor: () => 0 }, requestScope,
    scope: requestScope, documentSources: { notice: () => '' }, workspace: () => ({ dir }),
  });
  const res = new EventEmitter();
  res.writeHead = () => {};
  res.write = (line) => events.push(JSON.parse(line.slice(6)));
  res.end = () => { res.writableEnded = true; res.emit('finish'); };
  let round = 0;
  const fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    const called = round++ === 0;
    const frame = called
      ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'synthetic-call', function: { name, arguments: '{}' } }] } }] }
      : { choices: [{ delta: { content: 'Done.' } }] };
    return { ok: true, body: (async function* () { yield Buffer.from(`data: ${JSON.stringify(frame)}\n\n`); })() };
  };
  const handler = createChatHandler({
    fs, path, crypto, fetch, reasoningEffort: require('./reasoning-effort.cjs'), createToolExchange,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: require('./tool-result-reduce.cjs').reduceToolResult,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000,
    authService: { audit() {}, db: autoSamplingEnabled === undefined ? undefined : { prepare: () => ({ get: () => ({ value: String(autoSamplingEnabled) }) }) } },
    toolPolicy: { mode: (_user, _tool, write) => write ? 'ask' : savedMode || 'allow' },
    modelManager: { enabled: true, load: async () => ({ ok: true }), health: async () => ({ ok: true, body: { all_models_loaded: ['synthetic-model', 'fast-model', 'smart-model', ...(codeRoleConfigured ? ['code-model'] : [])].map(model_name => ({ model_name, loaded: true, recipe_options: { ctx_size: 32768 } })) } }) },
    requestScope, currentWorkspace: () => ({ userId: user.id, dir }), json() {}, getProject: () => project,
    getProvider: () => ({ id: 'default', baseUrl: 'http://fixture.invalid', label: 'Mock' }), providerHeaders: () => ({}), saveChats() {}, endpointApproved: () => true,
    diaryHeaders: () => ({}), diaryExtras: require('./diary-extras.cjs'), autoRoles: () => autoDecision ? { fast: 'fast-model', smart: 'smart-model', ...(codeRoleConfigured ? { code: 'code-model' } : {}) } : null, lastLoadedModel: () => null,
    classifyFastOrSmart: async (message) => typeof autoDecision === 'function' ? autoDecision(message) : autoDecision || 'fast', servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    visionProbe: async () => ({ supported: false, reason: 'none' }), visionDescriptions: new Map(), skillsIndexFor: () => [],
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, chatToolRouter: { select: async (ids) => ({ ids, routed: false }) },
    ...toolbox, oauthServerIds: () => new Set(), accountReady: () => true,
    chatWideApproved: () => false, awaitApproval: async (request) => { approvals.push(request); return decision; },
    recordUsage() {}, recordToolUse() {},
  });
  await handler.handleChat({}, res, { message, projectId: project.id, chatId: 'synthetic-chat', history });
  assert.equal(events.some((event) => event.type === 'error'), false, JSON.stringify(events.filter((event) => event.type === 'error')));
  return { executions, approvals, requests, events };
}

test('connected Drive read runs in chat without approval when omitted from ENABLED_TOOLBOXES', async (t) => {
  const r = await runDriveCall(t, { name: 'drive_read_file' });
  assert.ok(r.requests[0].tools.some((tool) => tool.function.name === 'drive_read_file'));
  assert.deepEqual(r.executions, ['drive_read_file']);
  assert.equal(r.approvals.length, 0);
  assert.equal(r.events.some((event) => event.type === 'tool_pending'), false);
});

test('saved ask still prompts for a Drive read and saved block withholds it', async (t) => {
  const ask = await runDriveCall(t, { name: 'drive_read_file', savedMode: 'ask' });
  assert.equal(ask.approvals.length, 1);
  assert.deepEqual(ask.executions, ['drive_read_file']);
  const blocked = await runDriveCall(t, { name: 'drive_read_file', savedMode: 'block' });
  assert.equal(blocked.requests[0].tools.some((tool) => tool.function.name === 'drive_read_file'), false);
  assert.deepEqual(blocked.executions, []);
});

test('Drive writes still require approval and disconnected accounts receive no Drive tools', async (t) => {
  const write = await runDriveCall(t, { name: 'drive_trash_file', decision: 'deny' });
  assert.equal(write.approvals.length, 1);
  assert.deepEqual(write.events.filter((event) => event.type === 'tool_pending').map((event) => [event.name, event.args]),
    [['drive_trash_file', '{}']]);
  assert.deepEqual(write.executions, []);
  const disconnected = await runDriveCall(t, { name: 'drive_read_file', connected: false });
  assert.equal(disconnected.requests[0].tools.some((tool) => tool.function.name === 'drive_read_file'), false);
  assert.deepEqual(disconnected.executions, []);
});

test('Auto route detail reaches only its reply metadata and model replay stays role/content only', async (t) => {
  const decision = { offered: [{ id: 'fast', label: 'Short answer' }, { id: 'smart', label: 'Reasoning' }],
    scores: { fast: 0.19, smart: 0.81 }, selectedRole: 'smart', effectiveRole: 'smart',
    backend: 'decision-service', model: 'convaiinnovations/laya', calibrated: false,
    latencyMs: 42, status: 'accepted', fallbackReason: null };
  // A leading assistant turn (nothing preceded it) is dropped by server-side
  // history normalization to keep strict chat templates happy, so this fixture
  // leads with the user turn it answers.
  const history = [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer', routingDecision: decision }];
  const result = await runDriveCall(t, { name: 'drive_read_file', autoDecision: { role: 'smart', routingDecision: decision }, history });
  const meta = result.events.find(event => event.type === 'meta');
  assert.equal(meta.model, 'smart-model'); assert.equal(meta.route, 'smart');
  assert.deepEqual(meta.routingDecision, decision);
  assert.deepEqual(result.requests[0].messages.find(message => message.content === 'Earlier answer'),
    { role: 'assistant', content: 'Earlier answer' });
  const guarded = await runDriveCall(t, { name: 'drive_read_file', autoDecision: { role: 'code', routingDecision: { ...decision, selectedRole: 'code' } } });
  const guardedMeta = guarded.events.find(event => event.type === 'meta');
  assert.equal(guardedMeta.route, 'smart'); assert.equal(guardedMeta.routingDecision.selectedRole, 'code');
  assert.equal(guardedMeta.routingDecision.effectiveRole, 'smart');
  const manual = await runDriveCall(t, { name: 'drive_read_file' });
  assert.equal(manual.events.find(event => event.type === 'meta').routingDecision, undefined);
});

test('actual router decision flows through chat SSE with its scores and identity', async (t) => {
  const { createSystemOneRouter } = require('./system-one-router.cjs');
  const router = createSystemOneRouter({ enabled: () => true, roles: () => ({ fast: 'fast-model', smart: 'smart-model' }),
    fallback: async () => 'fast', log: () => {}, backend: { supports: () => true, locality: 'local',
      decide: async () => ({ selected: 'smart', scores: { fast: 0.125, smart: 0.875 }, metadata: { model: 'convaiinnovations/laya' } }) } });
  const result = await runDriveCall(t, { name: 'drive_read_file', autoDecision: message => router.classifyWithDetails(message) });
  const meta = result.events.find(event => event.type === 'meta');
  assert.equal(meta.route, 'smart'); assert.equal(meta.routingDecision.model, 'convaiinnovations/laya');
  assert.deepEqual(meta.routingDecision.scores, { fast: 0.125, smart: 0.875 });
  assert.equal(meta.routingDecision.status, 'accepted');
});

test('the code-routed request applies the coding sampling preset (issue #194)', async (t) => {
  const result = await runDriveCall(t, { name: 'drive_read_file', autoDecision: { role: 'code' }, codeRoleConfigured: true });
  const meta = result.events.find(event => event.type === 'meta');
  assert.equal(meta.sampling.preset, 'coding'); assert.equal(meta.sampling.source, 'auto');
  assert.deepEqual(meta.sampling.values, { temperature: 0.2, top_p: 0.9, repeat_penalty: 1.05 });
  assert.equal(result.requests[0].temperature, 0.2);
  assert.equal(result.requests[0].top_p, 0.9);
  assert.equal(result.requests[0].repeat_penalty, 1.05);
});

test('a fast-routed request with no creative wording sends no sampling override (general preset)', async (t) => {
  const result = await runDriveCall(t, { name: 'drive_read_file', autoDecision: { role: 'fast' } });
  const meta = result.events.find(event => event.type === 'meta');
  assert.equal(meta.sampling, undefined);
  assert.equal(result.requests[0].temperature, undefined);
});

test('an explicit project sampling override wins over the auto preset, key by key', async (t) => {
  const result = await runDriveCall(t, { name: 'drive_read_file', autoDecision: { role: 'code' }, sampling: { temperature: 0.6 }, codeRoleConfigured: true });
  const meta = result.events.find(event => event.type === 'meta');
  assert.equal(meta.sampling.source, 'auto'); // top_p/repeat_penalty still came from the preset
  assert.deepEqual(meta.sampling.values, { temperature: 0.6, top_p: 0.9, repeat_penalty: 1.05 });
  assert.equal(result.requests[0].temperature, 0.6);
});

test('automatic sampling presets off applies only the explicit override, never a preset', async (t) => {
  const result = await runDriveCall(t, { name: 'drive_read_file', autoDecision: { role: 'code' }, sampling: { temperature: 0.6 }, autoSamplingEnabled: false, codeRoleConfigured: true });
  const meta = result.events.find(event => event.type === 'meta');
  assert.equal(meta.sampling.preset, undefined); assert.equal(meta.sampling.source, 'explicit');
  assert.deepEqual(meta.sampling.values, { temperature: 0.6 });
  assert.equal(result.requests[0].temperature, 0.6);
  assert.equal(result.requests[0].top_p, undefined);
});

test('automatic sampling presets off with no explicit override sends nothing at all', async (t) => {
  const result = await runDriveCall(t, { name: 'drive_read_file', autoDecision: { role: 'code' }, autoSamplingEnabled: false, codeRoleConfigured: true });
  const meta = result.events.find(event => event.type === 'meta');
  assert.equal(meta.sampling, undefined);
  assert.equal(result.requests[0].temperature, undefined);
});

test('the creative heuristic promotes an otherwise fast-routed writing prompt', async (t) => {
  const result = await runDriveCall(t, { name: 'drive_read_file', autoDecision: { role: 'fast' }, message: 'Write a short story about a lighthouse keeper.' });
  const meta = result.events.find(event => event.type === 'meta');
  assert.equal(meta.sampling.preset, 'creative');
  assert.deepEqual(meta.sampling.values, { temperature: 0.9, top_p: 0.95 });
});

// #305 (Opus review): a free chat (no project at all — nobody has opened its per-chat model
// popup yet, so there is no explicit choice) routes through Auto when Fast/Smart roles are
// configured, matching the composer label; it falls back to the loaded model exactly as before
// when roles are not configured, so a server with no roles behaves exactly as today.
async function runFreeChat(t, { project = null, rolesConfigured = true, loaded = 'loaded-model', message = 'Hello' } = {}) {
  const os = require('node:os'), path = require('node:path'), fs = require('node:fs'), crypto = require('node:crypto');
  const { EventEmitter } = require('node:events');
  const { createToolboxes } = require('./toolboxes.cjs');
  const { createToolExchange } = require('./tool-exchange.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-free-chat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const user = { id: 'synthetic-user' };
  const store = { workspace: { userId: user.id }, authn: { user } };
  const requestScope = { getStore: () => store, run: (_scope, fn) => fn() };
  const driveTools = { box: { id: 'gdrive', tools: [] }, connected: () => false, execute: async () => 'unused' };
  const toolbox = createToolboxes({
    boxes: [], driveTools, offered: () => false, mcpBoxes: () => [], mcpTools: () => new Map(),
    prefill: { budgetFor: () => null, rateFor: () => 0 }, requestScope, scope: requestScope,
    documentSources: { notice: () => '' }, workspace: () => ({ dir }),
  });
  const events = [], requests = [], jsonReplies = [];
  const res = new EventEmitter();
  res.writeHead = () => {}; res.write = (line) => events.push(JSON.parse(line.slice(6)));
  res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, body: (async function* () { yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Synthetic reply.' } }] })}\n\n`); })() };
  };
  const handler = createChatHandler({
    fs, path, crypto, fetch, reasoningEffort: require('./reasoning-effort.cjs'), createToolExchange,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: require('./tool-result-reduce.cjs').reduceToolResult,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', DIARY_BASE: 'http://fixture.invalid', TOOL_RESULT_CAP: 8000,
    authService: { audit() {} }, toolPolicy: { mode: () => 'allow' },
    modelManager: { enabled: true, load: async () => ({ ok: true }), health: async () => ({ ok: true, body: { all_models_loaded: ['fast-model', 'smart-model', 'the-loaded-model', 'explicitly-chosen-model', 'project-model'].map((model_name) => ({ model_name, loaded: true, recipe_options: { ctx_size: 32768 } })) } }) },
    requestScope, currentWorkspace: () => ({ userId: user.id, dir }), json: (_res, status, body) => jsonReplies.push({ status, body }), getProject: () => project,
    getProvider: () => ({ id: 'default', baseUrl: 'http://fixture.invalid', label: 'Mock' }), providerHeaders: () => ({}), saveChats() {}, endpointApproved: () => true,
    diaryHeaders: () => ({}), diaryExtras: require('./diary-extras.cjs'),
    autoRoles: () => rolesConfigured ? { fast: 'fast-model', smart: 'smart-model' } : null,
    lastLoadedModel: () => loaded,
    classifyFastOrSmart: async () => 'fast',
    servedCatalogue: async () => [], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    visionProbe: async () => ({ supported: false, reason: 'none' }), visionDescriptions: new Map(), skillsIndexFor: () => [],
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, chatToolRouter: { select: async (ids) => ({ ids, routed: false }) },
    ...toolbox, oauthServerIds: () => new Set(), accountReady: () => true,
    chatWideApproved: () => false, awaitApproval: async () => 'approve',
    recordUsage() {}, recordToolUse() {},
  });
  await handler.handleChat({}, res, { message, projectId: project ? project.id : null, chatId: 'synthetic-free-chat', history: [] });
  return { events, requests, jsonReplies };
}

test('a free chat with Fast/Smart roles configured routes via classifyFastOrSmart, not the loaded model', async (t) => {
  const { events, requests } = await runFreeChat(t, { rolesConfigured: true });
  assert.equal(events.some((e) => e.type === 'error'), false, JSON.stringify(events.filter((e) => e.type === 'error')));
  assert.equal(requests[0].model, 'fast-model');
  const meta = events.find((e) => e.type === 'meta');
  assert.equal(meta.route, 'fast');
});

test('a free chat with no Fast/Smart roles configured falls back to the loaded model, exactly as before', async (t) => {
  const { events, requests } = await runFreeChat(t, { rolesConfigured: false, loaded: 'the-loaded-model' });
  assert.equal(events.some((e) => e.type === 'error'), false, JSON.stringify(events.filter((e) => e.type === 'error')));
  assert.equal(requests[0].model, 'the-loaded-model');
  const meta = events.find((e) => e.type === 'meta');
  assert.equal(meta.route, undefined, 'no routing decision when Auto never engaged');
});

test('a free chat with neither roles configured nor a model loaded is refused, exactly as before', async (t) => {
  const { requests, jsonReplies } = await runFreeChat(t, { rolesConfigured: false, loaded: null });
  assert.equal(requests.length, 0);
  assert.equal(jsonReplies.length, 1);
  assert.equal(jsonReplies[0].status, 400);
  assert.match(jsonReplies[0].body.error, /no model selected/);
});

test('an explicit per-chat choice (the free chat\'s own synthetic context project) always wins over Auto', async (t) => {
  // routing: 'manual' + an explicit model is exactly what the composer\'s ModelPopup writes to
  // the chat\'s own context project (diaryExtras.chatProjectId) once the person picks one.
  const explicit = { id: 'cowork-chat-context-c1', model: 'explicitly-chosen-model', routing: 'manual', toolboxes: [], files: [] };
  const { events, requests } = await runFreeChat(t, { project: explicit, rolesConfigured: true });
  assert.equal(events.some((e) => e.type === 'error'), false, JSON.stringify(events.filter((e) => e.type === 'error')));
  assert.equal(requests[0].model, 'explicitly-chosen-model');
  const meta = events.find((e) => e.type === 'meta');
  assert.equal(meta.route, undefined, 'an explicit model choice never goes through Auto routing');
});

test('a project explicitly set to manual routing is unaffected by the free-chat Auto default', async (t) => {
  const project = { id: 'p1', model: 'project-model', routing: 'manual', toolboxes: [], files: [] };
  const { events, requests } = await runFreeChat(t, { project, rolesConfigured: true });
  assert.equal(events.some((e) => e.type === 'error'), false, JSON.stringify(events.filter((e) => e.type === 'error')));
  assert.equal(requests[0].model, 'project-model');
  const meta = events.find((e) => e.type === 'meta');
  assert.equal(meta.route, undefined);
});

test('a project explicitly set to auto routing is unaffected (unchanged pre-existing behaviour)', async (t) => {
  const project = { id: 'p1', model: 'unused', routing: 'auto', toolboxes: [], files: [] };
  const { events, requests } = await runFreeChat(t, { project, rolesConfigured: true });
  assert.equal(events.some((e) => e.type === 'error'), false, JSON.stringify(events.filter((e) => e.type === 'error')));
  assert.equal(requests[0].model, 'fast-model');
  const meta = events.find((e) => e.type === 'meta');
  assert.equal(meta.route, 'fast');
});
