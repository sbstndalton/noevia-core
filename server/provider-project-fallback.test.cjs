'use strict';
// Needs dav-parse.wasm: provider egress is Rust-only since #1071. Skipped without it unless DAV_PARSE_WASM_REQUIRED=1.
if (!require('node:fs').existsSync(process.env.DAV_PARSE_WASM || require('./dav-parse-wasm.cjs').DEFAULT_WASM) && process.env.DAV_PARSE_WASM_REQUIRED !== '1') {
  require('node:test').test('needs dav-parse.wasm (not built)', { skip: 'dav-parse.wasm not built' }, () => {});
  return;
}
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createProviderRegistry } = require('./providers.cjs');
const { createWorkspaceStore } = require('./workspace.cjs');
const { createSecretStore } = require('./secrets.cjs');
const { createStubStore } = require('../tests/server/project-store-stub.cjs');
const { createChatHandler } = require('./chat.cjs');
const { createToolboxes } = require('./toolboxes.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');

// Removing a provider is the Rust front's (noevia-rs provider_routes.rs, tested through the real
// route in tests/providers.rs `removing_follows_core_and_projects_fall_back`: the row goes and the
// account's projects on it lose `provider` and `model`, others untouched). This test is the Core
// half: the workspace and the chat read what the front leaves in the files, with no copy of their
// own, and the manual chat that was going to the removed provider uses the loaded default model.
test('a manual chat follows the files: on the provider before the front removes it, on the loaded default model after', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noevia-provider-fallback-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const USER = 'cccccccc-3333-4333-8333-333333333333';
  const defaultProvider = { id: 'default', label: 'Local', baseUrl: 'http://local.fixture.invalid', apiKey: 'local' };
  const userDir = path.join(dir, 'users', USER);
  fs.mkdirSync(userDir, { recursive: true });
  /** What the front writes: an atomic rename, so the files' change signals move. */
  const frontWrites = (file, value) => { fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2)); fs.renameSync(`${file}.tmp`, file); };
  const project = { id: 'p1', name: 'Synthetic', routing: 'manual', files: [], toolboxes: [] };
  frontWrites(path.join(userDir, 'providers.json'), { providers: [{ id: 'prov-cloud', label: 'Cloud', baseUrl: 'https://cloud.fixture.invalid', apiKey: '', shared: false }] });
  frontWrites(path.join(userDir, 'projects.json'), { projects: [{ ...project, provider: 'prov-cloud', model: 'cloud-only-model' }] });
  const store = createWorkspaceStore(dir, defaultProvider, createSecretStore(dir), { projectStore: createStubStore(dir) });
  const workspace = () => store.get(USER);
  // The request-scoped view index.cjs builds over the workspace: every read goes to the current one.
  const PROVIDERS = new Proxy([], { get: (_t, key) => { const v = workspace().providers; const x = v[key]; return typeof x === 'function' ? x.bind(v) : x; } });
  const registry = createProviderRegistry({ PROVIDERS, DEFAULT_PROVIDER_ID: 'default' });
  const requestScope = { getStore: () => ({ workspace: workspace(), authn: { user: { id: USER } } }), run: (_scope, fn) => fn() };
  const toolbox = createToolboxes({
    boxes: [], driveTools: { box: { id: 'gdrive', tools: [] }, connected: () => false, execute: async () => 'unused' }, offered: () => false,
    mcpBoxes: () => [], mcpTools: () => new Map(), prefill: { budgetFor: () => null, rateFor: () => 0 }, requestScope, scope: requestScope,
    documentSources: { notice: () => '' }, workspace: () => ({ dir: userDir }),
  });
  const requests = [], errors = [];
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
    requestScope, currentWorkspace: () => workspace(), json: (_res, status, body) => errors.push({ status, body }), getProject: id => workspace().projects.find(p => p.id === id),
    getProvider: registry.getProvider, providerHeaders: registry.providerHeaders, saveChats() {}, endpointApproved: () => true,
    diaryHeaders: () => ({}), diaryExtras: require('./diary-extras.cjs'), autoRoles: () => null, lastLoadedModel: () => 'local-model',
    classifyFastOrSmart: async () => 'fast', servedCatalogue: async () => [{ name: 'local-model', labels: ['chat'] }], modelsInstalled: async () => [], missingRoles: () => [], staleRolesError: () => null,
    visionProbe: async () => ({ supported: false, reason: 'none' }), visionDescriptions: new Map(), skillsIndexFor: () => [],
    chatSkillRouter: { select: async () => ({ loaded: [] }) }, chatToolRouter: { select: async ids => ({ ids, routed: false }) },
    ...toolbox, oauthServerIds: () => new Set(), accountReady: () => true,
    grantContext: async raw => require('../tests/server/chat-grant-fixture.cjs').context(raw, { holder: { kind: 'absent' } }), chatWideApproved: () => false, awaitApproval: async () => 'approve', recordUsage() {}, recordToolUse() {},
  });
  const chat = async (chatId) => {
    const events = [];
    const res = new EventEmitter();
    res.writeHead = () => {};
    res.write = (line) => { if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6))); };
    res.end = () => { res.writableEnded = true; res.emit('finish'); };
    await handler.handleChat({}, res, { message: 'Synthetic question', projectId: 'p1', chatId, history: [] }, { user: { id: USER, role: 'member' } });
    assert.equal(events.some(event => event.type === 'error'), false, JSON.stringify(events.filter(event => event.type === 'error')));
  };
  await chat('synthetic-chat-1');
  assert.deepEqual(requests.map(request => [request.url, request.body.model]), [['https://cloud.fixture.invalid/v1/chat/completions', 'cloud-only-model']], 'on the provider it names while the row is there');
  requests.length = 0;
  // The front removes the row and clears provider and model of the projects that used it.
  frontWrites(path.join(userDir, 'providers.json'), { providers: [] });
  frontWrites(path.join(userDir, 'projects.json'), { projects: [project] });
  await chat('synthetic-chat-2');
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.map(request => [request.url, request.body.model]), [['http://local.fixture.invalid/v1/chat/completions', 'local-model']]);
});
