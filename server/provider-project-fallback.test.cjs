'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { createProviderRegistry } = require('./providers.cjs');
const { createProviderRoutes } = require('./routes/providers.cjs');
const { createChatHandler } = require('./chat.cjs');
const { createToolboxes } = require('./toolboxes.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');

test('removing a provider lets the next manual chat use the loaded default model', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-provider-fallback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const providers = [
    { id: 'default', label: 'Local', baseUrl: 'http://local.fixture.invalid', apiKey: 'local', shared: true },
    { id: 'prov-cloud', label: 'Cloud', baseUrl: 'https://cloud.fixture.invalid', shared: false },
  ];
  const project = { id: 'p1', name: 'Synthetic', routing: 'manual', provider: 'prov-cloud', model: 'cloud-only-model', files: [], toolboxes: [] };
  const projects = [project];
  const workspace = {
    userId: 'synthetic-user', dir, providers,
    removeProvider(id) {
      const index = providers.findIndex((provider) => provider.id === id);
      if (index < 0) return false;
      providers.splice(index, 1);
      return true;
    },
    saveProviders() {}, saveShared() {},
  };
  const registry = createProviderRegistry({ currentWorkspace: () => workspace, PROVIDERS: providers, DEFAULT_PROVIDER_ID: 'default' });
  const responses = [];
  const route = createProviderRoutes({
    json: (_res, status, body) => responses.push({ status, body }),
    readBody: async () => '', readJson: async () => ({}), fetchJson: async () => { throw Error('unexpected probe'); }, endpointApproved: () => true,
    PROVIDERS: providers, PROJECTS: projects, DEFAULT_PROVIDER_ID: 'default', modelManager: { enabled: true }, currentWorkspace: () => workspace,
    saveProjects: () => {}, registry,
  });
  await route(Object.assign(Readable.from([]), { method: 'DELETE' }), {}, { path: '/api/providers/prov-cloud', authn: { user: { id: workspace.userId } } });
  assert.deepEqual(responses, [{ status: 200, body: { ok: true } }]);
  assert.equal(project.provider, undefined);
  assert.equal(project.model, undefined);

  const requestScope = { getStore: () => ({ workspace, authn: { user: { id: workspace.userId } } }), run: (_scope, fn) => fn() };
  const toolbox = createToolboxes({
    boxes: [], driveTools: { box: { id: 'gdrive', tools: [] }, connected: () => false, execute: async () => 'unused' }, offered: () => false,
    mcpBoxes: () => [], mcpTools: () => new Map(), prefill: { budgetFor: () => null, rateFor: () => 0 }, requestScope, scope: requestScope,
    documentSources: { notice: () => '' }, workspace: () => ({ dir }),
  });
  const requests = [], events = [], errors = [];
  const res = new EventEmitter();
  res.writeHead = () => {};
  res.write = (line) => { if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); };
  res.end = () => { res.writableEnded = true; res.emit('finish'); };
  const handler = createChatHandler({
    fs, path, crypto,
    fetch: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return { ok: true, body: (async function* () { yield Buffer.from('data: {"choices":[{"delta":{"content":"Synthetic reply."}}]}\n\n'); })() };
    },
    reasoningEffort: require('./reasoning-effort.cjs'), createToolExchange,
    rag: { filesContext: async () => null }, prefill: { recordSample() {} }, reduceToolResult: require('./tool-result-reduce.cjs').reduceToolResult,
    HISTORY_CAP: 20, DEFAULT_PROVIDER_ID: 'default', DIARY_BASE: 'http://diary.fixture.invalid', TOOL_RESULT_CAP: 8000,
    authService: { audit() {} }, toolPolicy: { mode: () => 'allow' },
    modelManager: { enabled: true, load: async () => { throw Error('unexpected model load'); }, health: async () => ({ ok: true, body: { all_models_loaded: [{ model_name: 'local-model', loaded: true, recipe_options: { ctx_size: 32768 } }] } }) },
    requestScope, currentWorkspace: () => workspace, json: (_res, status, body) => errors.push({ status, body }), getProject: id => projects.find(p => p.id === id),
    getProvider: registry.getProvider, providerHeaders: registry.providerHeaders, saveChats() {}, endpointApproved: () => true,
    diaryHeaders: () => ({}), diaryExtras: require('./diary-extras.cjs'), autoRoles: () => null, lastLoadedModel: () => 'local-model',
    classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [{ name: 'local-model', labels: ['chat'] }], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    visionProbe: async () => ({ supported: false, reason: 'none' }), visionDescriptions: new Map(), skillsIndexFor: () => [],
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, chatToolRouter: { select: async ids => ({ ids, routed: false }) },
    ...toolbox, oauthServerIds: () => new Set(), accountReady: () => true,
    chatWideApproved: () => false, awaitApproval: async () => 'approve', recordUsage() {}, recordToolUse() {},
  });
  await handler.handleChat({}, res, { message: 'Synthetic question', projectId: 'p1', chatId: 'synthetic-chat', history: [] }, { user: { id: workspace.userId, role: 'member' } });
  assert.deepEqual(errors, []);
  assert.equal(events.some(event => event.type === 'error'), false, JSON.stringify(events.filter(event => event.type === 'error')));
  assert.deepEqual(requests.map(request => [request.url, request.body.model]), [['http://local.fixture.invalid/v1/chat/completions', 'local-model']]);
});
