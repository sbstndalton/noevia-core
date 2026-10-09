const { reportedTokenRate } = require('./engine-stats.cjs');
const reasoningEffort = require('./reasoning-effort.cjs');
const diaryExtras = require('./diary-extras.cjs');
const { projectAppearance } = require('./project-appearance.cjs');
// Cowork UI proxy server — zero-dependency Node http server.
//
// This server IS the app's backend:
//   - Router: space → model dispatch through OpenAI-compatible providers
//     (/v1/chat/completions) with the space's
//     system prompt + memories injected; the Diary tab routes through the
//     diary-companion sidecar (called exactly ONCE per exchange — it logs
//     every call, no retry).
//   - Optional model manager: adapter for provider-specific management verbs
//     (list installed + loaded, HF search, variant enumeration, pull with
//     progress, delete, load, unload). DANGEROUS verbs (delete/pull) are
//     proxied verbatim; the UI is the only client on this network.
//   - Spaces config: JSON file (model, system prompt, memories per space).
//
// Secrets enter only via environment (ui.env on the server). Never hardcoded.

'use strict';
const { bindBoxes } = require('./mcp-boxes.cjs');
const { createMcpWiring, createDirectoryUrlAllowed, createCredentialOriginCheck } = require('./mcp-wiring.cjs');

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { AsyncLocalStorage } = require('async_hooks');
const rag = require('./rag.cjs');
const mcp = require('./mcp.cjs');
const prefill = require('./prefill.cjs');
const { reduceToolResult } = require('./tool-result-reduce.cjs');
const { createToolExchange } = require('./tool-exchange.cjs');
const storageClient = require('./storage-client.cjs');
const documents = require('./documents.cjs');
const documentSources = require('./document-sources.cjs');
const { TOOL_RESULT_CAP, TOOL_PREFILL_TARGET_MS, estimateToolTokens, toolCapFor, createToolboxes } = require('./toolboxes.cjs');
const { createVisionProbe } = require('./vision.cjs');
const { createModelManager } = require('./model-manager.cjs');
const { createAuth, createRateLimiter } = require('./auth.cjs');
const { createWorkspaceStore } = require('./workspace.cjs');
const { createSecretStore } = require('./secrets.cjs');
const { isPublicUrl, createEndpointApproved } = require('./ssrf.cjs');
// One JSON reply shape, the 401, a bounded body read and the JSON fetch (http.cjs).
const { json, unauthorized, fetchJson, readBody, readJson, authResult, errorResponse, answerUnhandled, parseRequestUrl, badRequestUrl, readCappedJson } = require('./http.cjs');

const PORT = Number(process.env.UI_PORT || 8021);
const HOST = process.env.UI_HOST || '0.0.0.0';
const INFERENCE_BASE = process.env.INFERENCE_BASE_URL || process.env.LEMONADE_BASE_URL || 'http://host.docker.internal:11434';
const INFERENCE_KEY = process.env.INFERENCE_API_KEY || process.env.LEMONADE_API_KEY || '';
const DEFAULT_PROVIDER_ID = process.env.DEFAULT_PROVIDER_ID || 'default';
const DEFAULT_PROVIDER_LABEL = process.env.DEFAULT_PROVIDER_LABEL || 'Local inference';
const MODEL_MANAGER_KIND = process.env.MODEL_MANAGER_KIND || (process.env.LEMONADE_BASE_URL ? 'lemonade' : 'none');
const MODEL_MANAGER_BASE = process.env.MODEL_MANAGER_BASE_URL || process.env.LEMONADE_BASE_URL || INFERENCE_BASE;
const DIARY_BASE = process.env.DIARY_BASE_URL || 'http://cowork-diary-companion:8010';
// Per-request Diary tenant assertion key (M2, docs/spec-managed-diary.md). Deploy the sidecar first.
const DIARY_TENANT_KEY = (process.env.DIARY_TENANT_KEY || '').trim();
const DIARY_SOURCE = process.env.DIARY_SOURCE || 'sidecar';
// #294: DIARY_AUTH_TOKEN and UI_AUTH_TOKEN are independent — see auth-tokens.cjs.
const authTokens = require('./auth-tokens.cjs').resolveAuthTokens(process.env);
const DIARY_TOKEN = authTokens.diaryToken;
const UI_AUTH_TOKEN = authTokens.uiAuthToken;
const DIST_DIR = path.join(__dirname, '..', 'dist');
const DATA_DIR = process.env.UI_DATA_DIR || path.join(__dirname, 'ui-data');
// Messages offered to the context projection per request. Compaction summarizes whatever does not
// fit (and refuses beyond 1000), so this is a safety bound, not a silent cut at 20 exchanges.
const HISTORY_CAP = 1000;
// The saved transcript is the record, not the model window: keep it whole within generous bounds.
const STORED_HISTORY_CAP = 5000;
const STORED_HISTORY_BYTES = 32 * 1024 * 1024;
const staticFiles = require('./static-files.cjs').createStaticFiles(DIST_DIR);
// The build, with index.html for the client's own places (/c/<id>, /p/<id>, /settings/<section>…, #359).
const serveStatic = require('./spa-routes.cjs').createStaticFallback({ staticFiles, indexFile: path.join(DIST_DIR, 'index.html'), json });
const secretStore = createSecretStore(DATA_DIR);
const authService = createAuth({
  dataDir: DATA_DIR,
  publicOrigin: process.env.PUBLIC_ORIGIN || '',
  rpId: process.env.WEBAUTHN_RP_ID || '',
  legacyToken: UI_AUTH_TOKEN,
  legacyCompat: authTokens.legacyCompat,
  secrets: secretStore,
  trustProxy: process.env.TRUST_PROXY === 'true',
  // Lets password/session login also work from e.g. a bare LAN IP alongside
  // the primary (tunnel/HTTPS) origin. Passkeys are exempt from this: the RP
  // ID is fixed to the primary origin's hostname and WebAuthn refuses
  // IP-address origins outright, so passkey sign-in only ever works from the
  // primary origin.
  additionalOrigins: String(process.env.ADDITIONAL_TRUSTED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
});
const decisionSettings = require('./decision-settings.cjs').createDecisionSettings({ store: require('./features.cjs').settingsStore(authService.db), audit: (action,actor,detail)=>authService.audit(action,actor,actor,detail) });
// #697: the inference memory budget (admin setting; INFERENCE_MEMORY_BUDGET_GIB is its initial value).
const inferenceBudget = require('./inference-budget.cjs').createInferenceBudget({ store: require('./features.cjs').settingsStore(authService.db), audit: (action,actor,detail)=>authService.audit(action,actor,actor,detail) });
const features = require('./features.cjs').createFeatures({ store: require('./features.cjs').settingsStore(authService.db), audit: (action, actor, detail) => authService.audit(action, actor, actor, detail),
  // #555 F4: switching native-app sign-in off is a revoke, not a pause (deviceAuth is built below).
  onChange: (name, enabled, actorId) => { if (name === 'nativeClientAuth' && !enabled) deviceAuth.revokeAll(actorId, 'feature-off'); },
  availability:{stepSupervision:()=>decisionSettings.unavailable('choice'),toolGate:()=>decisionSettings.unavailable('choice'),systemOneRouting:()=>decisionSettings.unavailable() && require('./system-one-router.cjs').configuration().reason,chatFraming:()=>decisionSettings.unavailable('choice'),framingReasoner:()=>decisionSettings.unavailable('choice')} });
const featureRoutes = require('./routes/features.cjs').createFeatureRoutes({ features, json, readJson, decisionSettings });
const pluginDirectoryRoutes = require('./routes/plugin-directory.cjs').createPluginDirectoryRoutes({ json });
// Settings → Data: the signed-in user's conversations as a ZIP (routes/export.cjs).
const exportRoutes = require('./routes/export.cjs').createExportRoutes({ json, workspace: () => ({ freeChats: Array.from(FREE_CHATS), projects: PROJECTS.filter((proj) => !diaryExtras.internalProject(proj)) }), readHistory: (id) => readHistory(id), audit: (action, actor, detail) => authService.audit(action, actor, actor, detail) });
const retentionLists = () => ({ freeChats: Array.from(FREE_CHATS), projects: PROJECTS.filter((proj) => !diaryExtras.internalProject(proj)) });
const removeRetainedChat = ({ projectId, id }) => (projectId ? deleteChat(projectId, id) : deleteFreeChat(id));
const accountRoutes = require('./routes/account.cjs').createAccountRoutes({ json, readJson, dir: () => currentWorkspace().dir, chatLists: retentionLists, removeChat: removeRetainedChat });
const importRoutes = require('./routes/import.cjs').createImportRoutes({
  json, readBody: (req, limit) => readBody(req, limit), newId: () => `c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  audit: (action, actor, detail) => authService.audit(action, actor, actor, detail),
  context: () => {
    const lists = require('./chat-lists.cjs');
    const visible = () => PROJECTS.filter((proj) => !diaryExtras.internalProject(proj));
    return {
      projects: () => visible().map((proj) => ({ id: proj.id, name: proj.name })),
      existingChatIds: () => new Set([...Array.from(FREE_CHATS), ...PROJECTS.flatMap((proj) => proj.chats || [])].map((c) => c.id)),
      tombstones: () => lists.readTombstones(currentWorkspace().dir),
      directory: currentWorkspace().dir,
      historyPath: (id) => currentWorkspace().historyPath(id),
      persistedChatIds: () => require('./conversation-import.cjs').persistedChatIds(currentWorkspace().dir),
      addFreeChats: (chats) => { FREE_CHATS.splice(0, FREE_CHATS.length, ...lists.mergeChats(Array.from(FREE_CHATS), chats, lists.readTombstones(currentWorkspace().dir))); saveFreeChats(FREE_CHATS); },
      addProjectChats: (projectId, chats) => saveChats(projectId, chats),
      createProject: (body) => createProject(body),
    };
  },
});
const offsiteBackup = require('./offsite-service.cjs').createOffsiteService({ features, dataDir: DATA_DIR, log: (event) => console.log('[backup]', JSON.stringify(event)) });
const offsiteRoutes = require('./routes/offsite-backup.cjs').createOffsiteRoutes({ service: offsiteBackup, json });
// Google Drive as a chat connector: each account's own connection, per-tool allow/ask/block.
const toolPolicy = require('./tool-policy.cjs').createToolPolicy({ db: authService.db, audit: (action, actor, detail) => authService.audit(action, actor, actor, detail) });
const driveAccounts = require('./drive-accounts.cjs').createDriveAccounts({
  backupDrive: offsiteBackup.drive, backupUsable: () => offsiteBackup.driveUsable(), dataDir: DATA_DIR,
  userKey: () => secretStore.derive('google-drive-user'), userKeyPrevious: () => secretStore.derivePrevious('google-drive-user'),
  makeDrive: ({ tokenFile, backupKey, previousBackupKey }) => require('./gdrive.cjs').createGoogleDrive({
    clientId: String(process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim(), clientSecret: String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim(),
    tokenFile, backupKey, previousBackupKey, oauthBase: process.env.GOOGLE_OAUTH_BASE_URL || undefined, apiBase: process.env.GOOGLE_DRIVE_API_BASE_URL || undefined,
    uploadBase: process.env.GOOGLE_DRIVE_UPLOAD_BASE_URL || undefined, log: (event) => console.log('[gdrive]', JSON.stringify(event)),
  }),
});
const { publicPage } = require('./routes/public-pages.cjs');
const webAddressRoutes = require('./routes/web-address.cjs').createWebAddressRoutes({ auth: authService, json, readBody: (req) => readJson(req) });
const davConfig = require('./dav-settings.cjs').configuration(process.env, authService.origin);
const davSettings = require('./dav-settings.cjs').createDavSettings({ auth: authService, config: davConfig });
if (process.env.LEMONADE_BASE_URL && !process.env.INFERENCE_BASE_URL) console.warn('LEMONADE_BASE_URL is deprecated; use INFERENCE_BASE_URL');
if (process.env.LEMONADE_API_KEY && !process.env.INFERENCE_API_KEY) console.warn('LEMONADE_API_KEY is deprecated; use INFERENCE_API_KEY');
// The default row's capabilities come from the engine kind the deployment declares (providers.cjs).
const DEFAULT_PROVIDER_CAPABILITIES = require('./providers.cjs').engineCapabilities(MODEL_MANAGER_KIND);
const workspaceStore = createWorkspaceStore(DATA_DIR, { id: DEFAULT_PROVIDER_ID, label: DEFAULT_PROVIDER_LABEL, baseUrl: INFERENCE_BASE, apiKey: INFERENCE_KEY, shared: true,
  ...(DEFAULT_PROVIDER_CAPABILITIES ? { capabilities: DEFAULT_PROVIDER_CAPABILITIES } : {}) }, secretStore);

// Per-user throttle for LLM-backed routes. Every hit is a full model call
// against the shared inference endpoint, so one member (or a runaway client)
// must not be able to hog it. Fixed window, shared bucket across chat and
// diary conversations. Admins are throttled like everyone else. Raise
// LLM_RATE_LIMIT for a beefier inference host.
const LLM_RATE_LIMIT = Math.max(1, Number(process.env.LLM_RATE_LIMIT || 60));
const LLM_RATE_WINDOW_MS = 60 * 1000;
const llmRateLimiter = createRateLimiter();
function llmRateLimited(userId) {
  return llmRateLimiter.rateLimited(`llm:${userId}`, LLM_RATE_LIMIT, LLM_RATE_WINDOW_MS);
}
const requestScope = new AsyncLocalStorage();
function currentWorkspace() {
  const workspace = requestScope.getStore()?.workspace;
  if (!workspace) throw new Error('authenticated workspace context required');
  return workspace;
}
function arrayProxy(field) {
  return new Proxy([], {
    get(_target, property) {
      const value = currentWorkspace()[field][property];
      return typeof value === 'function' ? value.bind(currentWorkspace()[field]) : value;
    },
    set(_target, property, value) { currentWorkspace()[field][property] = value; return true; },
    ownKeys() { return Reflect.ownKeys(currentWorkspace()[field]); },
    getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
  });
}
rag.init({ dataDir: DATA_DIR, inferenceUrl: INFERENCE_BASE, headersFn: () => inferenceHeaders(), userDataDirFn: workspaceStore.userDir,
  userActive: (userId) => !workspaceStore.isRemoved(userId), inferenceGuard: () => modelManager.enterInference?.() || (() => {}) });

// User-created projects; the earlier fixed demo spaces were removed.
// spaces were deleted per user request — projects are user-created only.
// Each project: goal/description, custom instructions,
// and text files (pasted/uploaded text injected into context; true doc-RAG is a
// later feature — flagged in MIGRATION.md).

const folderSync = process.env.MODEL_LOADER_URL ? require('./model-folder-sync.cjs').createFolderSync({
  stateFile: path.join(DATA_DIR, 'model-folder-sync.json'),
  listUnregistered: async () => {
    const r = await modelService.managerFetch('models');
    if (!r?.ok) throw Object.assign(Error(r?.body?.error || `model manager HTTP ${r?.status || 'unreachable'}`), { status: r?.status });
    return Array.isArray(r.body?.unregistered) ? r.body.unregistered : [];
  },
  register: async (stem) => {
    const r = await modelService.managerFetch(`sections/${encodeURIComponent(stem)}/safe-defaults`, 'POST');
    if (!r?.ok) throw Object.assign(Error(r?.body?.error || `model manager HTTP ${r?.status || 'unreachable'}`), { status: r?.status });
  },
  reloadPresets: () => modelManager.reloadPresets ? modelManager.reloadPresets({ unload: false }) : { ok: false },
  // #872: never write models.ini while calibration/auto-tune runs or the maintenance gate is held.
  busy: () => !!modelManager.tuningActive?.(),
  log: (message) => console.log(message),
}) : null;

const modelManager = createModelManager({
  kind: MODEL_MANAGER_KIND,
  presetPath: process.env.LLAMACPP_PRESET_PATH,
  // MODELS_INI_WRITER=model-loader makes the sidecar the single models.ini writer (#295).
  presetWriter: require('./models-ini-writer.cjs').createModelsIniWriter({ mode: process.env.MODELS_INI_WRITER, url: process.env.MODEL_LOADER_URL, token: process.env.MODEL_LOADER_TOKEN, fetchJson }),
  autoconfig: {
    modelsPath: process.env.LLAMACPP_MODELS_PATH || '',
    budgetGib: Number(process.env.LLAMACPP_AUTOCONFIG_MEMORY_GIB) || require('./llamacpp-autoconfig.cjs').parseMemoryLimit(process.env.LLAMACPP_MEMORY_LIMIT) || 0,
    // #697: with an inference budget only this explicit figure may lower autoconfig's sizing.
    explicitBudgetGib: Number(process.env.LLAMACPP_AUTOCONFIG_MEMORY_GIB) || 0,
    // #697: the prompt-cache cap autoconfig and new presets write, and the hard maximum every write keeps.
    cacheRamMaxMib: require('./inference-budget.cjs').cacheRamLimits(process.env).capMib,
    cacheRam: require('./inference-budget.cjs').cacheRamLimits(process.env),
    cachePath: process.env.LLAMACPP_CACHE_PATH || '',
    memoryFloorGib: Number(process.env.LLAMACPP_CALIBRATION_MEMORY_FLOOR_GIB) || 2,
  },
  evidenceDir: path.join(DATA_DIR,'evidence-'+require('node:crypto').createHash('sha256').update(MODEL_MANAGER_BASE).digest('hex').slice(0,16)),
  calibrationStatePath: path.join(DATA_DIR,'native-calibration-'+require('node:crypto').createHash('sha256').update(MODEL_MANAGER_BASE).digest('hex').slice(0,16)+'.json'),
  autotuneStatePath: path.join(DATA_DIR,'native-autotune-'+require('node:crypto').createHash('sha256').update(MODEL_MANAGER_BASE).digest('hex').slice(0,16)+'.json'),
  // #1012: the models.ini text the router last read after a reload noevia made.
  reloadStatePath: path.join(DATA_DIR,'native-preset-reload-'+require('node:crypto').createHash('sha256').update(MODEL_MANAGER_BASE).digest('hex').slice(0,16)+'.json'),
  downloadStatePath: path.join(DATA_DIR,'native-downloads-'+require('node:crypto').createHash('sha256').update(MODEL_MANAGER_BASE).digest('hex').slice(0,16)+'.json'),
  baseUrl: MODEL_MANAGER_BASE,
  apiKey: process.env.MODEL_MANAGER_API_KEY || INFERENCE_KEY,
  fetchJson,
  inferenceBudget,
});
// #697 runtime safety net: unload the engine's models when measured inference memory stays
// above the budget by more than INFERENCE_BUDGET_OVERSHOOT_PCT (default 10). Native engine only.
const inferenceBudgetWatch = modelManager.kind === 'llamacpp' ? (() => {
  const watch = require('./inference-budget-watch.cjs');
  const files = watch.gpuMemoryFiles(process.env);
  return watch.createInferenceBudgetWatch({
    budgetGib: inferenceBudget.budgetGib,
    readGpu: () => watch.readGpuMemory(files),
    readEngine: watch.engineReaderFromModelLoader({ env: process.env, fetchJson }),
    // #874: null (unknown) on a failed listing, so the watchdog skips that tick instead of treating it as idle.
    listLoaded: async () => watch.loadedFromListing(await modelManager.listModels()),
    unload: model => modelManager.emergencyUnload(model),
    onUnloaded: (model, budgetGib) => modelManager.quarantine?.(model, budgetGib),
    // #873 follow-up: a sweep's llama-bench memory (gate held) must never become the idle baseline.
    baselineAllowed: () => !modelManager.maintenanceHeld?.(),
  });
})() : null;
inferenceBudgetWatch?.start();
// #697: every web caller of the shared engine admits its model first: within the inference memory
// budget, and with the engine's other model unloaded (one model at a time). Throws a 409 with a
// publicMessage when the model would not fit. A no-op for other managers.
async function admitEngineModel(model, signal) {
  if (!model || typeof modelManager.makeRoomFor !== 'function') return;
  await modelManager.makeRoomFor(model, undefined, signal);
}
// The auto-router's classifier must never cause a swap: it runs only on the resident model, and
// only if that model fits the budget. Null to proceed, or a text-free { cause } to skip.
async function classifierAdmission(model) {
  if (modelManager.kind !== 'llamacpp' || !model) return null;
  if (await modelManager.loadRefusal?.(model)) return { cause: 'over-budget' };
  const listing = await modelManager.listModels();
  if (!listing.ok) return { cause: 'engine-unavailable' };
  return listing.body.data.some(m => m.id === model && m.loaded) ? null : { cause: 'not-resident' };
}
// MODELS_INI_WRITER=web with a read-only /llamacpp-config: log it once; saves then fail explicitly (#269).
require('./models-ini-writer.cjs').reportModelsIniWriter({ mode: process.env.MODELS_INI_WRITER, presetPath: process.env.LLAMACPP_PRESET_PATH });

// What index.cjs builds on the adapter: the installed list and the first loaded model as the
// default, the auto-router roles, the manager service call and the cached folder scan (models.cjs).
const modelService = require('./models.cjs').createModelService({
  fetchJson, env: process.env, modelManager, currentWorkspace,
  // Auto-roles are per workspace: a deleted model's role reference must be cleared out of
  // every workspace's config, not just whichever one happened to make the delete request.
  listWorkspaces: () => authService.listUsers().map((u) => workspaceStore.get(u.id)),
});
const { autoRoles, ensureRolesLoaded, servedCatalogue, modelsInstalled, lastLoadedModel } = modelService;

function inferenceHeaders(extra) {
  const h = { 'Content-Type': 'application/json' };
  if (INFERENCE_KEY && INFERENCE_KEY !== 'local') h.Authorization = `Bearer ${INFERENCE_KEY}`;
  return { ...h, ...extra };
}

// The member-origin policy for providers, storage connections and the Diary corpus (ssrf.cjs).
const endpointApproved = createEndpointApproved();
// The Diary sidecar client: tenant headers, the corpus reads and the connector file bridge (diary.cjs).
const diary = require('./diary.cjs').createDiary({ fs, path, fetchJson, DIARY_BASE, DIARY_TOKEN, DIARY_TENANT_KEY, DIARY_SOURCE, requestScope, authService, endpointApproved, workspaceStore });
const { diaryHeaders, diaryFetchJson } = diary;
// The Diary files client (/api/file, /api/directory, /api/workspace-ops), always as one user and
// with that user's tenant headers. Shared by the DAV listener and the chat mirror (#741).
function diaryAsUser(userId, fn) {
  const workspace = workspaceStore.get(userId);
  const user = authService.publicUser(authService.db.prepare('SELECT * FROM users WHERE id=?').get(userId));
  return requestScope.run({ workspace, authn: { user, legacy: false } }, fn);
}
const diaryFileCall = (userId, endpoint, method, body) => diaryAsUser(userId, async () => {
  const r = await diaryFetchJson(`${DIARY_BASE}/api${endpoint}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }, 15000);
  if (!r.ok) throw Object.assign(Error(r.body?.detail || 'Diary file request failed'), { status: r.status });
  return r.body;
});
const diaryFiles = {
  list: async (id, path) => (await diaryFileCall(id, '/files?path='+encodeURIComponent(path), 'GET')).files,
  read: (id, path) => diaryFileCall(id, '/file', 'POST', { path }),
  write: (id, body) => diaryFileCall(id, '/file', 'PUT', body),
  mkdir: (id, path) => diaryFileCall(id, '/directory', 'POST', { path }),
  ops: (id, body) => diaryFileCall(id, '/workspace-ops', 'POST', body),
};
const PROJECTS = arrayProxy('projects');

const PROVIDERS = arrayProxy('providers');
// The provider registry: persistence, lookup, key masking and request headers (providers.cjs).
const providerRegistry = require('./providers.cjs').createProviderRegistry({ currentWorkspace, PROVIDERS, DEFAULT_PROVIDER_ID });
const { getProvider, providerHeaders } = providerRegistry;

const FREE_CHATS = arrayProxy('freeChats');

// Usage accounting (daily rollups per tenant) lives in usage.cjs; its routes in routes/usage.cjs.
const { USAGE_RETENTION_DAYS, usageDayKey, readUsage, recordUsage, recordToolUse } = require('./usage.cjs');

// D9: read-only offline Wikipedia box, only with features.kiwix and an internal KIWIX_URL.
const kiwixTools = features.enabled('kiwix') && process.env.KIWIX_URL ? require('./kiwix.cjs').createKiwixTools({ baseUrl: process.env.KIWIX_URL, cap: TOOL_RESULT_CAP }) : null;
// Offered per request only to accounts with a connected Drive (connectedBoxes).
const driveTools = require('./gdrive-tools.cjs').createDriveTools({ accounts: driveAccounts, cap: TOOL_RESULT_CAP });
// Toolboxes, the resolver, the read/write gate and the built-in executor live in toolboxes.cjs.
// MCP state and the executor are injected as closures: mcpState and toolboxOffered are declared
// further down and only read at call time.
const {
  TOOLBOXES, CONNECTOR_BOXES, DEFAULT_TOOLBOXES, connectedBoxes, allToolboxes, toolTokenBudgetFor,
  resolveTools, isWriteTool, sanitizeToolboxes, toolboxSummaries, executeToolCall,
} = createToolboxes({
  boxes: [kiwixTools && kiwixTools.box, driveTools.box].filter(Boolean),
  kiwixTools, driveTools,
  mcpBoxes: () => mcpState.boxes,
  mcpTools: () => mcpState.tools,
  offered: (id) => toolboxOffered(id),
  prefill,
  scope: requestScope,
  getProject: (id) => getProject(id),
  documentSources,
  workspace: () => currentWorkspace(),
  executeMcp: (name, args, signal, serverId) => executeMcpToolCall(name, args, signal, serverId),
});
// The per-turn permitted-tools view is cached for 30 s; every write that changes what it shows
// (a tool permission, a project's toolbox selection) clears it so the picker is never stale (#796).
const permittedToolsCache = require('./toolboxes-permitted.cjs').createTtlCache({ ttlMs: 30000 });
const connectorRoutes = require('./routes/connectors.cjs').createConnectorRoutes({
  onPolicyChange: () => permittedToolsCache.clear(),
  accounts: driveAccounts, driveTools, policy: toolPolicy, offsite: offsiteBackup, isWrite: (name) => isWriteTool(name), json, readBody: (req) => readJson(req),
  // Nextcloud's tools ride on the account's storage connection, so this only reports what that
  // connection allows and owns the per-tool permissions.
  nextcloud: {
    state(user) {
      const storage = authService.getStorage(user.id, true);
      const connected = ['nextcloud', 'webdav'].includes(storage.kind) && !!storage.username && !!storage.secret;
      if (!MCP_SERVERS.some((sv) => sv.auth === 'nextcloud')) {
        return { configured: false, state: 'not-configured', message: 'This server has no Nextcloud MCP server configured, so there are no Nextcloud tools to offer.' };
      }
      if (!connected) return { configured: true, state: 'disconnected', message: 'Connect Nextcloud under Settings → Diary & storage; its tools then use that same connection.' };
      if (!mcpCredentialOriginAllowed(storage.baseUrl)) {
        return { configured: true, state: 'error', account: storage.username, baseUrl: storage.baseUrl,
          message: 'Your Nextcloud address is not on this server\'s allowed list (MCP_NEXTCLOUD_ORIGINS), so noevia will not send your credential to it.' };
      }
      return { configured: true, state: 'connected', account: storage.username, baseUrl: storage.baseUrl, message: '' };
    },
    boxes: () => allToolboxes().filter((b) => b.server === 'nextcloud').map((b) => ({ id: b.id, label: b.label, toolCount: b.tools.length })),
    tools: () => allToolboxes().filter((b) => b.server === 'nextcloud').flatMap((b) => b.tools.map((t) => t.function.name)),
  },
});
// Account-level connectors are not a project choice: they join every chat of an account that
// connected them, and never appear in a project's toolbox picker.
// Skill auto-loading shares the router's switch and embedding model (chat-skill-routing.cjs).
const chatSkillRouter = require('./chat-skill-routing.cjs').createChatSkillRouter({ enabled: () => features.enabled('toolRouter'), embed: (texts) => rag.embed(texts) });
// Roadmap E: narrows each message's toolboxes to the matching ones when features.toolRouter is on.
const chatToolRouter = require('./chat-tool-routing.cjs').createChatToolRouter({
  enabled: () => features.enabled('toolRouter'), boxes: () => allToolboxes(), embed: (texts) => rag.embed(texts),
  embedModel: () => rag.embedModel(),
});

// Endpoint-scoped probes expire, so repairing a model or its projector does
// not require restarting noevia before images work again.
const isEngineUrl = (baseUrl) => String(baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '') === String(getProvider(DEFAULT_PROVIDER_ID)?.baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
const engineVisionProbe = () => createVisionProbe({ admit: (baseUrl, model) => (isEngineUrl(baseUrl) ? admitEngineModel(model) : undefined) });
const visionProbe = engineVisionProbe();
// Cached image descriptions, keyed by model + images + question.
const visionDescriptions = new Map();

// Where a project's own folder lives in the user's storage. One folder per
// project under a single root, so uploads land somewhere the user can open,
// edit and back up like any other folder — rather than inside projects.json
// where only noevia can reach them.
const PROJECT_ROOT_FOLDER = (process.env.PROJECT_ROOT_FOLDER || 'noevia projects').replace(/^\/+|\/+$/g, '');

const { projectFolderName, createProjectFolder } = require('./project-folders.cjs');

const projectSweep = require('./project-sweep.cjs').createProjectSweep({ storage: storageClient, log: event => console.log('[projects]', JSON.stringify(event)) });
// The project store: accessors, chat metas, transcripts and the source pipeline (projects.cjs).
const projectStore = require('./projects.cjs').createProjectStore({
  fs, path, reasoningEffort, projectAppearance, rag, storageClient, documentSources, authService, currentWorkspace,
  PROJECTS, FREE_CHATS, sanitizeToolboxes: (boxes) => sanitizeToolboxes(boxes), defaultToolboxes: () => DEFAULT_TOOLBOXES,
  PROJECT_ROOT_FOLDER, createProjectFolder, projectSweep,
});
const {
  saveProjects, getProject, sanitizeChats, loadChats, saveChats, deleteChat, saveFreeChats, deleteFreeChat, createProject,
  readHistory, writeHistory, ownsFile, ensureProjectFolder, withSourceLock, pruneDocuments, writeProjectTextFile, sweepDeletedProject, indexSource,
} = projectStore;
// ── MCP toolboxes (master step 15): curated in mcp-toolbox-manifest.cjs ─────────
const MCP_TOOLBOX_MANIFEST = require('./mcp-toolbox-manifest.cjs').buildToolboxManifest({ features });


// MCP server list and curated-box filter: parsed in mcp-servers.cjs.
const { parseMcpServers, parseEnabledToolboxes, createToolboxOffered } = require('./mcp-servers.cjs');
const MCP_SERVERS = parseMcpServers(process.env);
const ENABLED_TOOLBOXES = parseEnabledToolboxes(process.env);
const toolboxOffered = createToolboxOffered(ENABLED_TOOLBOXES);

// ── Code mode (spec-agent-execution §3): service in code-service.cjs, routes in routes/code.cjs ──
// `CODE_REPOS=name|/abs/path,...` is the only way a repository becomes reachable: a task can
// never name a host path. The transport is supplied separately, so a deployment without a
// coding harness installed simply has nothing to start.
// One proxy per deployment (it binds CODE_EGRESS_PORT): Code and Browser tasks share it, each
// scoped by its own per-task grant/token.
const codeEgress = require('./code-egress.cjs').startEgressFromEnv(process.env, { secrets: secretStore, log: (entry) => console.log('[egress]', JSON.stringify(entry)) });
// #853: the UI and file-sharing listeners refuse requests that arrive over the internal code
// network (COWORK_CODE_NET_ADDR, code-net-guard.cjs). The egress proxy above is not wrapped.
const codeNetGuard = require('./code-net-guard.cjs').createCodeNetGuard({ spec: process.env.COWORK_CODE_NET_ADDR || '',
  log: (entry) => console.warn('[code-net]', JSON.stringify(entry)) });
// Executor guard (#704, code-tool-schemas.cjs): off unless features.executorGuard. Read once per
// Code task when it starts; it only adds automatic refusals of malformed tool calls.
require('./code-tool-schemas.cjs').useExecutorGuard(() => features.enabled('executorGuard'));
// Planner review (#519, code-review.cjs): off unless features.plannerReview. Advice on a final card
// the person still answers; it runs on the default provider as the web container reaches it, and
// refuses an external one. With the flag on it runs through the role engine (#702, role-engine.cjs):
// the task's model is pinned and the call streams under the Laya guard. Under the model manager's
// admission lock, a different resident chat model (the embedding/rerank sidecars excepted) refuses
// the review instead of swapping (models-max 1); with nothing resident, the review loads the pinned
// model inside that same lock. A client outside this process can still race the router.
// The same role engine runs the Code pipeline's Planner, review and Auditor (#705).
const codeRoleLog = (entry) => console.log('[code]', JSON.stringify(entry));
const codeRoleEndpoint = () => {
  const provider = getProvider(DEFAULT_PROVIDER_ID);
  const base = String(provider?.baseUrl || '').replace(/\/+$/, '');
  return {
    baseUrl: base ? (/\/v1$/.test(base) ? base : `${base}/v1`) : null,
    apiKey: provider?.apiKey || null,
    model: autoRoles()?.code || autoRoles()?.smart || lastLoadedModel() || null,
    external: require('./provider-egress.cjs').isExternalProvider(provider),
    provider,
  };
};
const codeRoleEngine = require('./role-engine.cjs').createRoleEngine({ fetch: (...args) => globalThis.fetch(...args), log: codeRoleLog, engine: codeRoleEndpoint,
  keep: () => [...require('./model-system.cjs').sidecarModelNames(process.env)],
  admission: typeof modelManager.withAdmission === 'function' ? (work, signal) => modelManager.withAdmission(work, signal) : null,
  // #697: never pin or call a model that would not fit the inference memory budget.
  budgetRefusal: typeof modelManager.loadRefusal === 'function' ? (model) => modelManager.loadRefusal(model) : null });
const codeReview = require('./code-review.cjs').createPlannerReview({
  enabled: () => features.enabled('plannerReview'),
  log: codeRoleLog,
  // #697: both paths admit the model within the inference memory budget before any request.
  provider: require('./code-review.cjs').createEngineReviewer({ fetch: (...args) => globalThis.fetch(...args), log: codeRoleLog, engine: codeRoleEndpoint, admit: (model, signal) => admitEngineModel(model, signal) }),
  roleEngine: codeRoleEngine,
});
// The Code pipeline (#705, code-pipeline.cjs, which holds the task-lifecycle authority): offered as
// the "Planner" preparation only with features.codePipeline on and Code mode in the sandbox.
// Verification is #703's one-shot verifier container (code-verify.cjs, CODE_VERIFY_ENDPOINT); unset,
// busy or unreachable, a pipeline task stops as blocked at verification, never as passed.
const { createCodePipeline } = require('./code-pipeline.cjs');
const codeVerify = require('./code-pipeline-verify.cjs').createVerifyAdapter(require('./code-verify.cjs').createCodeVerify({ log: codeRoleLog }));
const codePlanner = require('./planner-plan.cjs').createPlannerPlan({ enabled: () => features.enabled('constrainedPlanDecoding'), engine: codeRoleEndpoint, log: codeRoleLog,
  admit: (model, signal) => admitEngineModel(model, signal) });
const codeService = require('./code-service.cjs').createCodeService({
  repos: process.env.CODE_REPOS,
  // The egress proxy (D15) is the only way a task reaches the internet, and only to the domains
  // its grant names. Unconfigured, network and installs stay unavailable.
  egress: codeEgress,
  log: (entry) => console.log('[code]', JSON.stringify(entry)),
  // Where the agent's model lives, and which one. ACP carries neither, so noevia writes both
  // into the harness's own config file (`code-harness-config.cjs`); a sandbox has no provider
  // configuration of its own and would otherwise have nothing to run on. `CODE_ENGINE_URL`
  // exists because the sandbox may reach the engine by a different name than the web
  // container does — it is on an internal network of its own.
  engine: () => {
    const provider = getProvider(DEFAULT_PROVIDER_ID);
    const base = (process.env.CODE_ENGINE_URL || provider?.baseUrl || '').replace(/\/+$/, '');
    return {
      baseUrl: base ? (/\/v1$/.test(base) ? base : `${base}/v1`) : null,
      apiKey: process.env.CODE_ENGINE_API_KEY || provider?.apiKey || null,
      model: autoRoles()?.code || autoRoles()?.smart || lastLoadedModel() || null,
      contextTokens: Number(process.env.CODE_CONTEXT_TOKENS) || undefined,
    };
  },
  // `CODE_HARNESS_COMMAND` is the ACP agent to run (for example `opencode acp`). Unset, a
  // task cannot start and says so.
  connect: require('./code-acp.cjs').createAcpTransport({ log: (entry) => console.log('[code]', JSON.stringify(entry)) }),
  // Shared context (shared-context.cjs): off unless the project turns on sharing into Code.
  sharedContext: (workspace, project) => require('./shared-context.cjs').forCode(project, loadChats(project.id)),
  // Planner review (#519): see codeReview above.
  review: codeReview,
  // #1062: the agent reaches the engine from the sandbox, outside the gate; a task holds the gate's
  // inference lease while it runs, and none starts while auto-tune or calibration is active.
  inference: typeof modelManager.enterInference === 'function' ? {
    enter: () => modelManager.enterInference(),
    paused: () => modelManager.tuningActive?.() === true,
  } : null,
  pipeline: {
    enabled: () => features.enabled('codeHarness') && features.enabled('codePipeline'),
    create: ({ jobs, workspaces, harness, askApproval }) => createCodePipeline({ jobs, workspaces, harness, askApproval,
      roleEngine: codeRoleEngine, planner: codePlanner, review: codeReview, verify: codeVerify,
      merge: () => features.enabled('codeMerge'), constrain: () => features.enabled('constrainedPlanDecoding'),
      engineKey: () => codeRoleEndpoint().apiKey, log: codeRoleLog }),
  },
});
const codeRoutes = require('./routes/code.cjs').createCodeRoutes({
  features, getProject, projects: () => PROJECTS.filter((project) => !diaryExtras.internalProject(project)), workspace: () => currentWorkspace(), json, readJson, service: codeService,
});

// ── Browser mode (issue #274, spec-agent-execution §6 wired to §4): service in
// browser-service.cjs, routes in routes/browser.cjs. Off (404) unless features.browserExecutor
// is on, and every task still needs the egress proxy (D15) exactly as a networked Code task does.
// `playwright` is an operator-installed dependency, never a hard one: a deployment without it
// simply cannot start a browser task, and says so, rather than falling back to something
// unsandboxed.
const browserService = require('./browser-service.cjs').createBrowserService({
  launch: async () => {
    let playwright;
    try { playwright = require('playwright'); }
    catch { throw Object.assign(Error('Browser mode needs Playwright installed on this server.'), { status: 503, publicMessage: 'Browser mode needs Playwright installed on this server.' }); }
    return playwright.chromium.launch({ headless: true });
  },
  egress: codeEgress,
  log: (entry) => console.log('[browser]', JSON.stringify(entry)),
});
const browserRoutes = require('./routes/browser.cjs').createBrowserRoutes({
  features, getProject, workspace: () => currentWorkspace(), json, readJson, service: browserService,
});

const usageRoutes = require('./routes/usage.cjs').createUsageRoutes({
  readUsage, usageDayKey, retentionDays: USAGE_RETENTION_DAYS, json,
  workspace: () => currentWorkspace(),
  listUsers: () => authService.listUsers(), userDir: (id) => workspaceStore.userDir(id),
});

// ── Deep research (D12): module in research-service.cjs, routes in routes/research.cjs ──
const researchRoutes = require('./routes/research.cjs').createResearchRoutes({
  features, getProject, workspace: () => currentWorkspace(), json, readJson,
  available: () => {
    if (!toolboxOffered('web-search') || !mcpState.tools.has('tavily_search') || !mcpState.tools.has('tavily_extract')) return 'Deep research needs the web-search toolbox (tavily_search and tavily_extract) on this server.';
    if (operatorServerFor('tavily_search') === undefined || operatorServerFor('tavily_extract') === undefined) return 'Web search is not configured on this server.';
    if (!researchModel()) return 'Pick a Smart model for Auto routing, or load a model, before starting research.';
    return null;
  },
  service: require('./research-service.cjs').createResearchService({
    saveFile: (project, name, text) => writeProjectTextFile(project, name, text),
    getProject,
    tools: (workspace, project) => ({
      complete: async (messages, { signal, maxTokens }) => {
        const provider = getProvider(DEFAULT_PROVIDER_ID), model = researchModel(project);
        // Same maintenance gate as chat and RAG: tuning/calibration must not share the engine.
        let leave;
        try { leave = modelManager.enterInference?.() || (() => {}); }
        catch (e) { throw Object.assign(e, { publicMessage: e.publicMessage || (e.status === 503 ? e.message : 'The model is busy. Try again shortly.') }); }
        try {
        await admitEngineModel(model, signal);
        const r = await fetch(`${provider.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/chat/completions`, { method: 'POST', redirect: 'error',
          headers: providerHeaders(provider, { 'Content-Type': 'application/json' }), signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
          body: JSON.stringify({ model, stream: false, max_tokens: maxTokens, messages }) });
        if (!r.ok) throw Object.assign(Error(`The model provider answered ${r.status}.`), { publicMessage: `The model provider answered ${r.status}.` });
        const choice = (await readCappedJson(r, 4 * 1024 * 1024)).choices?.[0];
        if (choice?.finish_reason === 'length') throw Object.assign(Error('A research step was cut off by the output limit.'), { publicMessage: 'A research step was cut off by the output limit.' });
        return String(choice?.message?.content || '');
        } finally { leave(); }
      },
      // The operator's own search server, even if a directory server offers the same name (#865);
      // with none, research fails rather than reaching a directory server (#891).
      search: async (query) => require('./routes/research.cjs').parseSearchResults(await executeOperatorToolCall('tavily_search', { query, max_results: 5 })),
      extract: async (url) => {
        const text = await executeOperatorToolCall('tavily_extract', { urls: [url] });
        if (/^ERROR/.test(text)) throw Error(text);
        return text;
      },
      projectRetrieve: async (question) => rag.ragAvailable()
        ? (await rag.searchProject(project.id, question, workspace.userId)).slice(0, 5).map((h) => ({ file: h.file, text: h.body }))
        : [],
    }),
  }),
});
function researchModel(project) {
  return autoRoles()?.smart || project?.model || lastLoadedModel() || null;
}

// noevia's own capabilities, offered over the same MCP path as everything
// else. Default 0 means the listener never binds, no `internal` entry can
// work, both boxes lose every tool and vanish — the ordinary unconfigured
// state, identical to today for every existing deployment.
const mcpInternal = require('./mcp-internal.cjs');
const { missingRoles, staleRolesError } = require('./auto-roles-check.cjs');
const MCP_INTERNAL_PORT = Number(process.env.MCP_INTERNAL_PORT || 0);
const MCP_INTERNAL_SERVER = MCP_SERVERS.find((sv) => sv.auth === 'internal') || null;
// Derived, not the storage key itself: a signing bug must not become a
// credential-disclosure bug.
const MCP_INTERNAL_KEY = secretStore.derive('mcp-internal-token');

const directoryMcp = require('./directory-mcp.cjs').createDirectoryMcp({ db: authService.db, secrets: secretStore, audit: (action, actor, detail) => authService.audit(action, actor, actor, detail) });
const directoryUrlAllowed = createDirectoryUrlAllowed({ isPublicUrl, allowLoopback: process.env.NOEVIA_QA_ALLOW_LOOPBACK_MCP === '1' });
// Every request to a directory/custom server and its OAuth endpoints: the address is checked
// again at connect time, so a name that re-resolves after directoryUrlAllowed (DNS rebinding,
// #795) cannot reach a private one. The operator's MCP_SERVERS keep the ordinary fetch.
const mcpPublicFetch = require('./public-fetch.cjs').createPublicFetch({ allowLoopbackLiteral: process.env.NOEVIA_QA_ALLOW_LOOPBACK_MCP === '1' });
// OAuth sign-in for directory servers: one sign-in per account per server (mcp-oauth.cjs).
// Its URLs come from strangers' metadata, so they must be https (or the QA loopback) and public.
const mcpOAuth = require('./mcp-oauth.cjs').createMcpOAuth({
  db: authService.db, secrets: secretStore, audit: (action, actor, detail) => authService.audit(action, actor, actor, detail),
  fetchImpl: mcpPublicFetch,
  urlAllowed: async (url) => require('./directory-mcp.cjs').hostedUrlOk(url) && directoryUrlAllowed(url),
  redirectUri: () => `${String(authService.origin || process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '')}/api/mcp-oauth/callback`,
});
// Sign in with ChatGPT (#447): per-account tokens, encrypted and bound to their owner, used only
// while features.chatgptOAuth is on. The table exists either way so a disconnect always works.
const chatgptOAuth = require('./chatgpt-oauth.cjs').createChatGptOAuth({
  db: authService.db, secrets: secretStore, audit: (action, actor, detail) => authService.audit(action, actor, actor, detail),
  config: { codexClientVersion: process.env.NOEVIA_CHATGPT_CODEX_VERSION },
});
const mcpCredentialOriginAllowed = createCredentialOriginCheck(process.env.MCP_NEXTCLOUD_ORIGINS);
// The live server list, discovery, per-server credentials and the MCP executor: mcp-wiring.cjs.
// It appends the directory servers to MCP_SERVERS itself and keeps that array current.
const mcpWiring = createMcpWiring({
  servers: MCP_SERVERS, manifest: MCP_TOOLBOX_MANIFEST, mcp, bindBoxes, directoryMcp, mcpOAuth, directoryUrlAllowed,
  publicFetch: mcpPublicFetch,
  credentialOriginAllowed: mcpCredentialOriginAllowed, scope: requestScope,
  storageFor: (userId) => authService.getStorage(userId, true),
  isWriteTool: (name) => isWriteTool(name),
  internal: mcpInternal, internalKey: MCP_INTERNAL_KEY,
  reduceToolResult, resultCap: TOOL_RESULT_CAP,
  isUserDisabled: (userId) => !!authService.listUsers().find((u) => u.id === userId)?.disabled,
});
const { state: mcpState, oauthServerIds, accountReady, probeMcpAuth, syncDirectoryServers, discoverOneServer, discoverMcpTools, executeMcpToolCall, operatorServerFor, executeOperatorToolCall } = mcpWiring;

// The approval gate's state lives in approvals.cjs; the chat loop below and the
// /api/tool-approvals route are its only callers.
const { pendingApprovals, chatWideApproved, revokeChatGrant, awaitApproval, awaitRouteChoice } = require('./approvals.cjs').createApprovals();
// #917: which of the signed-in workspace's lists holds a chat id ('free', a project id, or null).
// Outside an authenticated request it throws, which the chat gate treats as "no chat-wide grant".
const chatListHolder = (chatId) => require('./chat-lists.cjs').listHolding(chatId, Array.from(FREE_CHATS), Array.from(PROJECTS));

// ── SKILL.md awareness (Hermes-style convention, master step 13) ─────────
// A project knowledge file that starts with SKILL.md frontmatter is treated
// as a skill: its name/description go into the system prompt as a always-on
// index (L0), and the model is told it can request the full body through the
// read_project_file tool (L1) — progressive disclosure, zero extra deps.
function skillsIndexFor(project) {
  return require('./instruction-skills.cjs').enabled(project);
}

// Deterministic pre-escalation: obviously complex messages go to the smart
// role without burning a classifier round-trip (zero false negatives on the
// patterns below; everything else falls through to the classifier).
// Tuned against an 8-message battery (2026-09-03): the two misses were a
// multi-step word problem (5 numbers, no keywords) and an explicit
// "write 600 words" request — hence the numbers>=3 and effort-phrase rules.
// The auto router's classifier lives in auto-router.cjs: a heuristic, one cheap call, and how
// to read a verdict. Everything it needs from here is injected.
const autoRouter = require('./auto-router.cjs').createAutoRouter({
  roles: () => autoRoles(),
  provider: () => getProvider(DEFAULT_PROVIDER_ID),
  headers: (p) => providerHeaders(p),
  fetchJson: (url, init, timeoutMs) => fetchJson(url, init, timeoutMs),
  admit: (model) => classifierAdmission(model),
  record: (entry) => recordDecision('route', entry),
});
const { heuristicWantsSmart, heuristicWantsCode, classifierVerdict, CLASSIFIER_MAX_TOKENS } = autoRouter;
// Text-free decision record in the state directory: docker logs do not survive a deploy.
const recordDecision = require('./decision-log.cjs').createDecisionLog({ dir: DATA_DIR });
const systemOneRouter = require('./system-one-router.cjs').createSystemOneRouter({
  log: (entry) => recordDecision('route', entry),
  getBackend: decisionSettings.backend, getDeadlineMs:()=>decisionSettings.get().timeoutMs,
  enabled: () => features.enabled('systemOneRouting'),
  roles: () => autoRoles(),
  fallback: message => autoRouter.classify(message),
});
const classifyFastOrSmart = (message) => systemOneRouter.classifyWithDetails(message);
// Tool gate (features.toolGate): rules first, then the same decision service as System-One.
// One decision layer per configured backend, so its deadline benching survives between chats.
let toolGateBackend = null, toolGateDecisions = null;
const toolGate = require('./tool-gate.cjs').createToolGate({
  enabled: () => features.enabled('toolGate'),
  isWriteTool: (name) => isWriteTool(name),
  deadlineMs: () => decisionSettings.get().timeoutMs,
  log: (entry) => recordDecision('tool-gate', entry),
  // #682: what the service accepts (option count, label and token budget), and whether it can
  // answer `choice` at all; an unsupported service is reported once and in Settings.
  limits: () => decisionSettings.backend()?.limits || null,
  unavailable: () => decisionSettings.unavailable('choice'),
  decide: (request) => {
    const backend = decisionSettings.backend();
    if (!backend) throw Error('Decision service unavailable');
    if (backend !== toolGateBackend) { toolGateBackend = backend; toolGateDecisions = require('./decision/index.cjs').createDecisions({ backends: { configured: backend }, chains: { 'tool.gate': ['configured'] } }); }
    return toolGateDecisions.decide(request);
  },
});
// Chat framing (features.chatFraming, #737): the router role suggests a frame for a new chat through
// the same decision service; related chats by embedding. Read-only, fails open to no frame.
const framingSettings = require('./chat-framing.cjs').createFramingSettings({ store: require('./features.cjs').settingsStore(authService.db), audit: (action, actor, detail) => authService.audit(action, actor, actor, detail) });
let framingBackend = null, framingDecisions = null;
const chatFraming = require('./chat-framing.cjs').createChatFraming({
  enabled: () => features.enabled('chatFraming') && !decisionSettings.unavailable('choice'),
  roles: () => framingSettings.get(),
  deadlineMs: () => decisionSettings.get().timeoutMs,
  embed: (texts, opts) => rag.embed(texts, opts),
  log: (entry) => recordDecision('chat-frame', entry),
  // decide() aborts its backend at constraints.deadlineMs (never past the suggest deadline); the
  // suggest signal only stops a decision from starting once the deadline has passed (#760).
  decide: (request, { signal } = {}) => {
    if (signal?.aborted) throw Object.assign(Error('deadline'), { deadline: true });
    const backend = decisionSettings.backend();
    if (!backend) throw Error('Decision service unavailable');
    if (backend !== framingBackend) { framingBackend = backend; framingDecisions = require('./decision/index.cjs').createDecisions({ backends: { configured: backend }, chains: { 'chat.frame.kind': ['configured'], 'chat.frame.project': ['configured'], 'chat.frame.tag': ['configured'] } }); }
    return framingDecisions.decide(request);
  },
});
// Chat framing phase 4 (features.framingReasoner, needs chatFraming; #740): the reasoner role
// condenses a pre-run read into a task packet on the local engine. Skips (raw result) unless the
// reasoner model is set and fits the inference budget without swapping the answer model out.
const framingReasoner = require('./framing-reasoner.cjs').createFramingReasoner({
  enabled: () => features.enabled('framingReasoner') && features.enabled('chatFraming'),
  model: () => framingSettings.get().framingReasonerModel,
  complete: require('./framing-reasoner.cjs').createEngineCompletion({ getProvider, providerHeaders, providerId: DEFAULT_PROVIDER_ID, fetch: (...a) => fetch(...a) }),
  admit: (model, { answerModel, answerIsLocal }) => require('./framing-reasoner.cjs').admitReasoner({ model, answerModel, answerIsLocal,
    keep: require('./llamacpp-manager.cjs').keepAlongside(), loadRefusal: typeof modelManager.loadRefusal === 'function' ? modelManager.loadRefusal : null }),
  log: (entry) => recordDecision('chat-reasoner', entry),
});
const reasoningTraces = { enabled: (dir) => require('./chat-framing.cjs').readPreferences(dir).keepReasoningTraces === true,
  append: (dir, entry) => require('./framing-reasoner.cjs').appendTrace(dir, entry) };
// #760: about ten suggests a minute per user (one embed + three decisions each), on the LLM limiter.
const FRAMING_RATE_LIMIT = 10;
const chatFramingRoutes = require('./routes/chat-framing.cjs').createChatFramingRoutes({ json, readJson, framing: chatFraming, settings: framingSettings,
  rateLimited: (userId) => llmRateLimiter.rateLimited(`chat-frame:${userId}`, FRAMING_RATE_LIMIT, LLM_RATE_WINDOW_MS),
  preferences: { get: () => require('./chat-framing.cjs').readPreferences(currentWorkspace().dir), save: (value) => require('./chat-framing.cjs').writePreferences(currentWorkspace().dir, value) },
  // #810: only Chat-mode, unarchived projects are offered as a destination; every own chat still counts for links and tags.
  workspace: () => { const projects = PROJECTS.filter((proj) => !diaryExtras.internalProject(proj)); return { projects: projects.filter(require('./project-modes.cjs').chatDestination).map((proj) => ({ id: proj.id, name: proj.name })), chats: [...Array.from(FREE_CHATS), ...projects.flatMap((proj) => proj.chats || [])] }; } });
// #741: "Mirror chats to Diary", per user and off by default. One-way, debounced, through the Diary
// files client above, as the chat's own user. Runs only with chatFraming on and the Diary add-on on.
const vaultMirrorLib = require('./chat-vault-mirror.cjs');
const chatBrainLib = require('./chat-brain.cjs');
const vaultMirrorAvailable = (userId) => features.enabled('chatFraming') && authService.diaryEnabled(userId);
const chatVaultMirror = vaultMirrorLib.createChatVaultMirror({
  enabled: (userId) => vaultMirrorAvailable(userId) && vaultMirrorLib.readPreferences(workspaceStore.get(userId).dir).enabled,
  lists: (userId) => diaryAsUser(userId, () => ({ freeChats: Array.from(FREE_CHATS), projects: PROJECTS.filter((proj) => !diaryExtras.internalProject(proj)) })),
  deleted: (userId) => diaryAsUser(userId, () => require('./chat-lists.cjs').readTombstones(currentWorkspace().dir)),
  readHistory: (userId, chatId) => diaryAsUser(userId, () => readHistory(chatId)),
  readBrain: (userId, chatId) => chatBrainLib.readBrain(workspaceStore.get(userId).dir, chatId)?.brain || null,
  files: diaryFiles,
  index: { read: (userId) => vaultMirrorLib.readIndex(workspaceStore.get(userId).dir), write: (userId, state) => vaultMirrorLib.writeIndex(workspaceStore.get(userId).dir, state) },
  log: (...args) => console.warn(...args),
});
// #742: each mirrored chat gets a small "brain" when it goes idle, built by the reasoner role (same
// engine and budget gate as #740; skipped without a reasoner model). Needs framingReasoner +
// chatFraming AND the user's mirror opt-in. Stored per chat in the user's own workspace.
const brainStore = { read: (userId, chatId) => chatBrainLib.readBrain(workspaceStore.get(userId).dir, chatId),
  write: (userId, chatId, record) => chatBrainLib.writeBrain(workspaceStore.get(userId).dir, chatId, record),
  remove: (userId, chatId) => chatBrainLib.removeBrain(workspaceStore.get(userId).dir, chatId) };
const chatBrains = chatBrainLib.createBrainScheduler({
  enabled: (userId) => features.enabled('framingReasoner') && vaultMirrorAvailable(userId) && vaultMirrorLib.readPreferences(workspaceStore.get(userId).dir).enabled,
  chat: (userId, chatId) => diaryAsUser(userId, () => [...Array.from(FREE_CHATS), ...PROJECTS.filter((proj) => !diaryExtras.internalProject(proj)).flatMap((proj) => proj.chats || [])].find((c) => c && c.id === chatId) || null),
  readHistory: (userId, chatId) => diaryAsUser(userId, () => readHistory(chatId)),
  deleted: (userId) => diaryAsUser(userId, () => require('./chat-lists.cjs').readTombstones(currentWorkspace().dir)),
  store: brainStore,
  builder: chatBrainLib.createBrainBuilder({
    enabled: () => features.enabled('framingReasoner') && features.enabled('chatFraming'),
    model: () => framingSettings.get().framingReasonerModel,
    complete: require('./framing-reasoner.cjs').createEngineCompletion({ getProvider, providerHeaders, providerId: DEFAULT_PROVIDER_ID, fetch: (...a) => fetch(...a) }),
    admit: (model, { answerModel, answerIsLocal }) => require('./framing-reasoner.cjs').admitReasoner({ model, answerModel, answerIsLocal,
      keep: require('./llamacpp-manager.cjs').keepAlongside(), loadRefusal: typeof modelManager.loadRefusal === 'function' ? modelManager.loadRefusal : null }),
    loadedModel: () => lastLoadedModel(),
    log: (entry) => recordDecision('chat-brain', entry),
  }),
  built: (userId, chatId) => chatVaultMirror.schedule(userId, chatId),
  log: (...args) => console.warn(...args),
});
const chatVaultMirrorRoutes = require('./routes/chat-vault-mirror.cjs').createChatVaultMirrorRoutes({ json, readJson,
  preferences: { get: () => vaultMirrorLib.readPreferences(currentWorkspace().dir), save: (value) => vaultMirrorLib.writePreferences(currentWorkspace().dir, value) },
  available: vaultMirrorAvailable, schedule: chatVaultMirror.schedule, audit: (action, actor, detail) => authService.audit(action, actor, actor, detail) });
// #682: a decision experiment switched on that cannot run (no service, or one without `choice`)
// says so once at startup; Settings shows the same reason, and the chat path skips it silently.
for (const f of features.describe()) {
  if (['toolGate', 'stepSupervision', 'systemOneRouting', 'chatFraming'].includes(f.id) && f.enabled && f.unavailable) console.warn(`[system-one] ${f.id} is on but cannot run: ${f.unavailable}`);
}

// #778: one decision layer for the sensitivity check, rebuilt only when the backend changes.
let sensitivityBackend = null, sensitivityDecisions = null;
// ── Chat: the loop lives in chat.cjs; everything it needs is handed over here ──
const { handleChat } = require('./chat.cjs').createChatHandler({
  stepSupervision: require('./step-supervision.cjs').createStepSupervision({
    enabled: () => features.enabled('stepSupervision'),
    log: (entry) => recordDecision('supervise', entry),
    getDeadlineMs:()=>decisionSettings.get().timeoutMs,
    provider: {decide:(...args)=>{const backend=decisionSettings.backend();if(!backend)throw Error('Decision service unavailable');return backend.supervise(...args);}}, deadlineMs:1500,
  }),
  recordOutcome: (entry) => recordDecision('outcome', entry),
  codeTasksFor: (project) => codeService.list(currentWorkspace(), project),
  // fetch is resolved per call, not captured: tests and QA swap the global at runtime.
  fs, path, crypto, fetch: (...args) => globalThis.fetch(...args), reasoningEffort, diaryExtras, createToolExchange, rag, prefill, reduceToolResult,
  HISTORY_CAP, STORED_HISTORY_CAP, DEFAULT_PROVIDER_ID, DIARY_BASE, TOOL_RESULT_CAP,
  authService, toolPolicy, modelManager, requestScope, currentWorkspace, json,
  getProject, getProvider, providerHeaders, saveChats, endpointApproved, diaryHeaders, diaryStorageRetry: diary.withStorageCredential,
  autoRoles, lastLoadedModel, classifyFastOrSmart, servedCatalogue, modelsInstalled, missingRoles, staleRolesError,
  visionProbe, visionDescriptions, skillsIndexFor, chatSkillRouter, chatToolRouter, toolGate,
  // #739: a confirmed frame steers the answer; looked up in the signed-in user's own lists only.
  chatFramingEnabled: () => features.enabled('chatFraming'), freeChats: () => Array.from(FREE_CHATS),
  framingReasoner, reasoningTraces,
  // #769: tainted sensitive arguments of a write always get their own approval card.
  provenancePolicy: { enabled: () => features.enabled('provenancePolicy') },
  // #778: routing modes. The setting is the signed-in account's own; the sensitivity check is the
  // router role through the decision service (cloud forbidden), failing closed to "ask".
  routingModes: {
    enabled: () => features.enabled('routingModes'),
    // #1007: a chat's or project's own override (project.routingMode) replaces the mode and the
    // sensitive handling; an administrator's allowed list still applies to the result.
    settings: (project) => { const rm = require('./routing-modes.cjs'); const s = rm.withProjectOverride(rm.read(currentWorkspace().dir), project); return { ...s, mode: rm.effectiveMode(s, rm.allowedModes(require('./features.cjs').settingsStore(authService.db))) }; },
    sensitivity: require('./routing-modes.cjs').createSensitivity({
      deadlineMs: () => decisionSettings.get().timeoutMs,
      log: (entry) => recordDecision('sensitivity', entry),
      decide: (request) => {
        const backend = decisionSettings.backend();
        if (!backend) throw Error('Decision service unavailable');
        if (backend !== sensitivityBackend) { sensitivityBackend = backend; sensitivityDecisions = require('./decision/index.cjs').createDecisions({ backends: { configured: backend }, chains: { 'routing.sensitivity': ['configured'] } }); }
        return sensitivityDecisions.decide(request);
      },
    }),
    // #779: each router input is cut to the decision service's real state budget.
    chunkChars: () => require('./routing-modes.cjs').chunkCharsFor(decisionSettings.backend()),
    // Router calls per turn: 1 by default (Laya is single-worker), NOEVIA_ROUTER_CHUNKS 1-4.
    maxChunks: () => require('./routing-modes.cjs').routerMaxChunks(),
    awaitChoice: awaitRouteChoice,
    log: (entry) => recordDecision('routing', entry),
    setChatFlags: (projectId, chatId, patch) => {
      const list = projectId ? getProject(projectId)?.chats : FREE_CHATS;
      const meta = Array.isArray(list) ? list.find((c) => c && c.id === chatId) : null;
      if (!meta) return false;
      Object.assign(meta, patch);
      if (projectId) saveProjects(PROJECTS); else saveFreeChats(FREE_CHATS);
      return true;
    },
  },
  // #742: linked chats' brains, read from the signed-in user's own workspace and lists only.
  brainContext: { enabled: () => features.enabled('brainContext') && features.enabled('chatFraming'), maxChars: () => framingSettings.get().brainContextChars,
    chats: () => [...Array.from(FREE_CHATS), ...PROJECTS.filter((proj) => !diaryExtras.internalProject(proj)).flatMap((proj) => proj.chats || [])],
    read: (chatId) => chatBrainLib.readBrain(currentWorkspace().dir, chatId) },
  DEFAULT_TOOLBOXES, CONNECTOR_BOXES, connectedBoxes, allToolboxes, resolveTools, isWriteTool, executeToolCall,
  oauthServerIds, accountReady, chatWideApproved, awaitApproval, recordUsage, recordToolUse,
  // #917: which of the signed-in workspace's lists holds a chat id ('free', a project id, or null).
  chatListHolder,
  chatgptOAuth, chatgptEnabled: () => features.enabled('chatgptOAuth'),
  projectEditTool: (name) => require('./project-edit-target.cjs').EDIT_TOOLS.has(name) && !!MCP_INTERNAL_SERVER && mcpState.tools.get(name)?.serverId === MCP_INTERNAL_SERVER.id,
  // #687: a plain-named project file is edited by moving it into the project folder when storage is connected.
  editStorageAccount: (userId) => { try { const c = userId ? authService.getStorage(userId, true) : null; return c && storageClient.isBrowsable(c) ? require('./project-edit-target.cjs').storageAccount(c) : null; } catch { return null; } },
  // #659: the Google Drive writes name the Drive file they change on the approval card.
  writeTargetFor: (name, rawArgs, { user }) => (driveTools.names.has(name) ? driveTools.describeTarget(user, name, rawArgs) : null),
});
// POST /api/chat: rate limit, body cap and the Diary gate, then the loop (routes/chat.cjs).
const chatRoutes = require('./routes/chat.cjs').createChatRoutes({
  json, readBody, bodyCap: STORED_HISTORY_BYTES, rateLimited: (userId) => llmRateLimited(userId),
  diaryEnabled: (userId) => authService.diaryEnabled(userId), handleChat,
  // Cowork sessions (#236) start a task on the existing code path; the route guards admin and the flag.
  harnessEnabled: () => features.enabled('codeHarness'),
  startCoworkTask: async (body) => {
    const project = getProject(String(body.projectId));
    if (!project) throw Object.assign(Error('project not found'), { status: 404, publicMessage: 'project not found' });
    return codeService.start(currentWorkspace(), project, { repository: body.repository, prompt: body.message });
  },
});

// Projects, sources and uploads (routes/projects.cjs). Background source jobs re-enter the router.
const projectRoutes = require('./routes/projects.cjs').createProjectRoutes({
  json, readBody, readJson, requestScope, dispatch: (req, res) => handleRequestScoped(req, res), currentWorkspace, authService, storageClient, documents, documentSources, rag, fs, path,
  reasoningEffort, projectAppearance, diaryExtras, PROJECTS, DEFAULT_TOOLBOXES, sanitizeToolboxes, allToolboxes, getProvider, ensureRolesLoaded, servedCatalogue, DEFAULT_PROVIDER_ID, store: projectStore,
  onToolboxesChange: () => permittedToolsCache.clear(),
});
// The provider registry's routes: list, connect, test and remove (routes/providers.cjs), plus
// Sign in with ChatGPT (chatgptOAuth, built beside mcpOAuth above) while features.chatgptOAuth is on.
const providerRoutes = require('./routes/providers.cjs').createProviderRoutes({
  json, readBody, readJson, fetchJson, endpointApproved, PROVIDERS, PROJECTS, DEFAULT_PROVIDER_ID, modelManager, currentWorkspace, saveProjects, registry: providerRegistry,
  chatgptOAuth, chatgptEnabled: () => features.enabled('chatgptOAuth'),
});
// Statistics, the auto-router roles, the model manager proxy and /api/models/* (routes/models.cjs).
const modelRoutes = require('./routes/models.cjs').createModelRoutes({
  json, readBody, readJson, fetchJson, env: process.env, modelManager, getProvider, providerHeaders, DEFAULT_PROVIDER_ID, createVisionProbe: engineVisionProbe, reportedTokenRate, missingRoles, currentWorkspace, service: modelService, inferenceBudget,
});
// ── Routing ────────────────────────────────────────────────────────────────

const diaryConnectors = require('./diary-connectors.cjs').createCredentials(authService);
const connectorRate = require('./auth.cjs').createRateLimiter();
// The Diary routes: the connector endpoint, the connector credentials and /api/diary/* (routes/diary.cjs).
const diaryRoutes = require('./routes/diary.cjs').createDiaryRoutes({
  json, readBody, readJson, fetchJson, DIARY_BASE, authService, currentWorkspace, rateLimited: (userId) => llmRateLimited(userId), connectorRate, diaryConnectors, diary,
  clientAddress: (req) => require('./auth.cjs').clientAddress(req, process.env.TRUST_PROXY === 'true'),
  addressesTrusted: process.env.TRUST_PROXY === 'true',
});
// Sign-in, the signed-in account and /api/admin/* (routes/auth.cjs). The open set is also the
// router's own list of what a signed-out browser may call.
const publicAuthRoutes = new Set([
  '/api/setup/status', '/api/setup/complete', '/api/auth/login/password',
  '/api/auth/login/passkey/options', '/api/auth/login/passkey/verify',
  '/api/auth/invitations/accept', '/api/auth/recovery/complete',
]);
// Native-client sign-in (#555): the RFC 8628 device flow and per-device tokens (device-auth.cjs),
// only while features.nativeClientAuth is on. requestAuth is the router's single credential check.
const nativeClientAuth = () => features.enabled('nativeClientAuth');
const deviceAuth = require('./device-auth.cjs').createDeviceAuth({
  db: authService.db, audit: authService.audit, publicUser: authService.publicUser, rate: createRateLimiter(),
  clientAddress: (req) => require('./auth.cjs').clientAddress(req, process.env.TRUST_PROXY === 'true'),
  origin: () => authService.origin || process.env.PUBLIC_ORIGIN || '',
  // Without TRUST_PROXY every request carries the tunnel's address: not shown, not rate-limited on.
  addressesTrusted: process.env.TRUST_PROXY === 'true',
});
// Started with the feature off: grants from an earlier "on" period are revoked, not kept dormant.
if (!nativeClientAuth()) deviceAuth.revokeAll(null, 'feature-off');
const requestAuth = require('./device-auth.cjs').createRequestAuth({ enabled: nativeClientAuth, deviceAuth, authService });
const deviceRoutes = require('./routes/device-auth.cjs').createDeviceAuthRoutes({ json, authResult, readJson, deviceAuth, authService, enabled: nativeClientAuth });
const authRoutes = require('./routes/auth.cjs').createAuthRoutes({
  json, authResult, readJson, authService, publicAuthRoutes, davSettings, davConfig, workspaceStore, driveAccounts, fetchJson, DIARY_BASE, DIARY_TOKEN, diaryTenantHeaders: diary.tenantHeaders, env: process.env,
  mcpOAuth, directoryMcp, chatgptOAuth, onToolsChange: () => permittedToolsCache.clear(),
  // POST /api/admin/secrets/rotate (CSRF-checked by the router like every signed-in POST).
  rotateSecrets: (actorId) => require('./secrets-rotate.cjs').runRotation({ secrets: secretStore, db: authService.db, dataDir: DATA_DIR, audit: authService.audit, actorId }),
});
// The user's own storage connection: read, save, test, browse, one folder, the Nextcloud login flow
// (routes/storage.cjs). fetch is resolved per call: tests swap the global at runtime.
const storageRoutes = require('./routes/storage.cjs').createStorageRoutes({ json, readJson, authService, storageClient, endpointApproved, fetch: (...args) => globalThis.fetch(...args), crypto });
// The human's answer to a pending write (routes/approvals.cjs); the gate itself is approvals.cjs.
const approvalRoutes = require('./routes/approvals.cjs').createApprovalRoutes({ json, readBody, pendingApprovals, requestScope });
// The workspace view, free-chat metas, context meters and transcripts (routes/chat-lists.cjs); it also
// runs the delete-old-chats sweep as the workspace loads, at most hourly.
const chatListRoutes = require('./routes/chat-lists.cjs').createChatListRoutes({
  json, readBody, currentWorkspace, PROJECTS, FREE_CHATS, diaryExtras, crypto, STORED_HISTORY_BYTES, STORED_HISTORY_CAP,
  chatLists: retentionLists, removeChat: removeRetainedChat, store: projectStore, revokeChatGrant,
});
// The reasoning-effort default and per-project resolution (routes/reasoning-settings.cjs).
const routingModeRoutes = require('./routes/routing-mode.cjs').createRoutingModeRoutes({ json, readBody, enabled: () => features.enabled('routingModes'), currentWorkspace,
  store: require('./features.cjs').settingsStore(authService.db), audit: (action, actor, detail) => authService.audit(action, actor, actor, detail) });
const reasoningSettingsRoutes = require('./routes/reasoning-settings.cjs').createReasoningSettingsRoutes({ json, readBody, authService, getProject, getProvider, reasoningEffort, DEFAULT_PROVIDER_ID });
// The automatic sampling presets on/off default (routes/sampling-settings.cjs). Selection and
// precedence live in sampling-presets.cjs; this only toggles whether chat.cjs applies a preset.
const samplingSettingsRoutes = require('./routes/sampling-settings.cjs').createSamplingSettingsRoutes({ json, readBody, authService });
// GET /api/health: the default provider, the Diary sidecar and retrieval (routes/health.cjs).
const healthRoutes = require('./routes/health.cjs').createHealthRoutes({ json, fetchJson, getProvider, providerHeaders, DEFAULT_PROVIDER_ID, DIARY_BASE, diaryHeaders, authService, rag });
// GET /api/ready (#297): unauthenticated, mounted before the session gate below alongside the
// sign-in routes. isReady is set once startup wiring under require.main finishes (see below).
const readyRoutes = require('./routes/health.cjs').createReadyRoutes({
  json, isReady: () => processReady, version: require('./version-resolve.cjs').resolveVersion(),
});
// GET /api/toolboxes: the picker view (routes/toolboxes.cjs). MCP state is read at call time.
const toolboxRoutes = require('./routes/toolboxes.cjs').createToolboxRoutes({
  discoverMcpTools: () => discoverMcpTools(), toolboxSummaries, connectedBoxes, json, cache: permittedToolsCache,
  prefill: { targetMs: TOOL_PREFILL_TARGET_MS, stats: () => prefill.stats() },
  mcp: () => ({ enabled: mcpWiring.enabled(), state: mcpState, servers: MCP_SERVERS, manifest: MCP_TOOLBOX_MANIFEST }),
  // The per-turn catalogue (#237). getProject is scoped to the signed-in account's workspace.
  permitted: ({ authn, projectId, mode }) => {
    const project = projectId ? getProject(projectId) : null;
    if (projectId && !project) return null;
    return { project, boxes: require('./toolboxes-permitted.cjs').computePermittedTools({
      user: authn.user, project, mode, boxes: allToolboxes(),
      manifest: mcpWiring.enabled() ? MCP_TOOLBOX_MANIFEST.filter((b) => toolboxOffered(b.id)) : [],
      defaultToolboxes: DEFAULT_TOOLBOXES, connectorBoxes: CONNECTOR_BOXES, connected: connectedBoxes(authn.user),
      oauthServerIds: oauthServerIds(), accountReady, policyMode: (u, t, w) => toolPolicy.mode(u, t, w), isWriteTool,
      diaryEnabled: authService.diaryEnabled(authn.user.id), harnessEnabled: features.enabled('codeHarness'),
      repositories: codeService.repositories().map((r) => r.id),
    }) };
  },
});
const mcpDirectoryRoutes = require('./routes/mcp-directory.cjs').createMcpDirectoryRoutes({
  json, readJson, auth: authService, servers: MCP_SERVERS, mcpState, directoryMcp, mcpOAuth,
  discoverOneServer, discoverMcpTools, probeMcpAuth, syncDirectoryServers, directoryUrlAllowed,
  onToolsChange: () => permittedToolsCache.clear(),
});

async function handleRequestInner(req, res) {
  const preAuth = requestAuth.authenticate(req);
  // accountRole: a device token acts as a member, but its account's workspace is the same one.
  const workspace = preAuth ? workspaceStore.get(preAuth.user.id, { claim: (preAuth.accountRole || preAuth.user.role) === 'admin' }) : null;
  if (workspace && preAuth.user.role === 'admin' && authService.diaryEnabled(preAuth.user.id) && fs.existsSync(path.join(workspace.dir, 'migration.json')) &&
      process.env.CORPUS_BACKEND === 'webdav' && authService.getStorage(preAuth.user.id).kind === 'local') {
    authService.saveStorage(preAuth.user.id, { kind: 'webdav', baseUrl: process.env.WEBDAV_BASE_URL || '', username: process.env.WEBDAV_USERNAME || '', secret: process.env.WEBDAV_PASSWORD || '', corpusRoot: process.env.CORPUS_ROOT || '' });
  }
  return requestScope.run({ workspace, authn: preAuth }, () => handleRequestScoped(req, res));
}

async function handleRequestScoped(req, res) {
  // A Host header that is not a valid host makes this parse fail even when the path did not.
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url) return badRequestUrl(res);
  const p = url.pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");

  try {
    if ((req.method === 'GET' || req.method === 'HEAD') && publicPage(p)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      return res.end(req.method === 'HEAD' ? undefined : publicPage(p));
    }
    if (await diaryRoutes.connector(req, res, { path: p })) return;
    if ((p === '/api/instance' || p === '/.well-known/webauthn') && await webAddressRoutes(req, res, { path: p, authn: null })) return;
    if (await deviceRoutes.open(req, res, { path: p })) return;
    if (await authRoutes.open(req, res, { path: p })) return;
    if (await readyRoutes(req, res, { path: p })) return;

    const authn = p.startsWith('/api/') ? requestAuth.authenticate(req) : null;
    if (p.startsWith('/api/') && !publicAuthRoutes.has(p) && !authn) return unauthorized(res);
    if (authn && !['GET', 'HEAD', 'OPTIONS'].includes(req.method || 'GET') && (!authService.originValid(req) || !requestAuth.csrfValid(req, authn))) {
      return json(res, 403, { error: 'invalid CSRF token' });
    }
    if (requestAuth.browserOnly(authn, p, req.method || 'GET')) {
      return json(res, 403, { error: 'This needs a signed-in browser session.', code: 'browser_session_required' });
    }
    if (authn && await deviceRoutes.account(req, res, { path: p, authn })) return;
    if (authn && await featureRoutes(req, res, { path: p, authn })) return;
    if (authn && await chatFramingRoutes(req, res, { path: p, authn })) return;
    if (authn && await chatVaultMirrorRoutes(req, res, { path: p, authn })) return;
    // #741: a successful change to the user's chats nudges their mirror (debounced; a no-op unless opted in).
    const mirrorNudge = authn ? vaultMirrorLib.mirrorTrigger(req.method, p) : null;
    if (mirrorNudge && typeof res.once === 'function') res.once('finish', () => { if (res.statusCode >= 200 && res.statusCode < 300) { chatVaultMirror.schedule(authn.user.id, mirrorNudge.chatId); if (mirrorNudge.chatId) chatBrains.schedule(authn.user.id, mirrorNudge.chatId); } });
    if (authn && await exportRoutes(req, res, { path: p, authn })) return;
    if (authn && await importRoutes(req, res, { path: p, authn })) return;
    if (authn && await accountRoutes(req, res, { path: p, authn })) return;
    if (authn && await offsiteRoutes(req, res, { path: p, authn })) return;
    if (authn && await connectorRoutes(req, res, { path: p, authn })) return;
    if (authn && await pluginDirectoryRoutes(req, res, { path: p, authn })) return;
    if (await mcpDirectoryRoutes(req, res, { path: p, authn })) return;
    if (authn && await webAddressRoutes(req, res, { path: p, authn })) return;
    if (authn && p.startsWith('/api/projects/') && await researchRoutes(req, res, { path: p, authn })) return;
    if (authn && (p === '/api/code/active' || p.startsWith('/api/projects/')) && await codeRoutes(req, res, { path: p, authn })) return;
    if (authn && p.startsWith('/api/projects/') && await browserRoutes(req, res, { path: p, authn })) return;
    if (await diaryRoutes.connectors(req, res, { path: p, authn })) return;
    if (await projectRoutes(req, res, { path: p, authn, url })) return;
    if (await authRoutes.account(req, res, { path: p, authn })) return;
    if (await storageRoutes(req, res, { path: p, authn })) return;
    if (await approvalRoutes(req, res, { path: p, authn })) return;

    if (await toolboxRoutes(req, res, { path: p, authn, url })) return;

    if (await chatListRoutes(req, res, { path: p, authn })) return;

    if (await providerRoutes(req, res, { path: p, authn, url })) return;

    if (authn && await usageRoutes(req, res, { path: p, authn })) return;
    if (await reasoningSettingsRoutes(req, res, { path: p, authn, url })) return;
    if (await routingModeRoutes(req, res, { path: p, authn, url })) return;
    if (await samplingSettingsRoutes(req, res, { path: p, authn, url })) return;

    if (await healthRoutes(req, res, { path: p, authn })) return;

    if (await modelRoutes(req, res, { path: p, authn, url })) return;

    if (await diaryRoutes.diary(req, res, { path: p, authn, url })) return;

    if (await chatRoutes(req, res, { path: p, authn })) return;

    // Static files with SPA fallback (spa-routes.cjs).
    return serveStatic(req, res, p);
  } catch (err) {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) {
      res.end(`data: ${JSON.stringify({ type: 'error', text: 'The request could not be completed. Please retry.' })}\n\n`);
    } else {
      const failure = errorResponse(err);
      if (failure.status >= 500) console.error('[request] unhandled error:', err);
      json(res, failure.status, failure.body);
    }
  }
}

async function handleRequest(req,res) {
  // An unparseable request target (e.g. `//[`) is the client's error: 400, no stack logged.
  const parsed=parseRequestUrl(req);
  if(!parsed)return badRequestUrl(res);
  const pathname=parsed.pathname;
  // This is a browser/core contract marker, including unauthenticated and error
  // responses. Set it before the maintenance gate, which may return early.
  if (pathname.startsWith('/api/')) res.setHeader('X-Noevia-API', '1');
  const inference=req.method!=='GET' && (pathname==='/api/chat' || pathname.startsWith('/api/diary/'));
  let leave;
  try {if(inference && modelManager.enterInference)leave=modelManager.enterInference();}
  catch(error){return json(res,error.status||503,{error:error.message});}
  if(leave){res.once('finish',leave);res.once('close',leave);}
  try {return await handleRequestInner(req,res);}finally{if(leave && (res.writableEnded||res.destroyed))leave();}
}

// #297: GET /api/ready flips true once startup wiring below has run and the server is listening.
let processReady = false;

if (require.main === module) {
  // #996, #1071: dav-parse.wasm is always required (the retired switches' Rust paths have no JS
  // twin), and so is any *_IMPL=wasm switch's: a missing or tampered module refuses to start,
  // rather than failing closed on every request (for SECRET_ENVELOPE_IMPL: every stored credential).
  const davParseWasm = require('./dav-parse-wasm.cjs');
  davParseWasm.warnRetiredFlags();
  try {
    const wasmFlags = davParseWasm.verifyAtStartup();
    console.log(`[dav-parse] dav-parse.wasm verified${wasmFlags.length ? ` for ${wasmFlags.join(', ')}` : ''}`);
  } catch (err) {
    console.error(`FATAL: ${err.message}. Restore the pinned module (server/dav-parse.lock).`);
    process.exit(1);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  authTokens.warnings.forEach((w) => console.warn(w));
  if (!DIARY_TENANT_KEY) console.warn('WARNING: DIARY_TENANT_KEY is unset; Diary calls carry no tenant assertion and remote storage secrets ride on every call.');
  // A throw outside handleRequestScoped's own try (authentication, the workspace load) answers 500
  // rather than resetting the connection, so one bad request input cannot look like a dead server (#781).
  const server = http.createServer(codeNetGuard.wrap((req, res) => handleRequest(req, res).catch((err) => answerUnhandled(res, err)), 'ui'));
  staticFiles.warm();
  // A chat waiting on a write approval is a legitimately long request. Node's
  // default requestTimeout is 5 minutes measured from the START of the request,
  // so a reply that spent two minutes generating would leave only three for the
  // human — and the connection would be cut mid-decision. Raised to 20 minutes,
  // comfortably past APPROVAL_TIMEOUT_MS, which is the limit that should
  // actually bite. headersTimeout still guards the slow-header attack this
  // setting otherwise protects against.
  if (davConfig.available) {
    const handler = require('./dav.cjs').createDavHandler({ auth: authService, settings: davSettings, config: davConfig, files: diaryFiles });
    const davServer = http.createServer(codeNetGuard.wrap((req, res) => handler(req, res).catch(() => res.destroy()), 'file-sharing'));
    davServer.requestTimeout = 60000; davServer.headersTimeout = 15000;
    davServer.setTimeout(60000, socket => socket.destroy());
    davServer.listen(davConfig.port, HOST, () => console.log(`Diary file sharing listener on port ${davConfig.port}; scope ${davConfig.scope}; per-user opt-in required`));
  }
  // ── noevia's own MCP server ──────────────────────────────────────────
  //
  // Second listener, loopback only, started only when a port is configured
  // AND MCP_SERVERS actually names it. Configuring one without the other is a
  // half-built setup, so say which half is missing rather than binding a port
  // nothing will call or advertising a server that will not answer.
  if (MCP_INTERNAL_PORT && !MCP_INTERNAL_SERVER) {
    console.warn(`[mcp] MCP_INTERNAL_PORT=${MCP_INTERNAL_PORT} is set but no MCP_SERVERS entry uses |internal, so nothing will call it. Add: noevia|http://127.0.0.1:${MCP_INTERNAL_PORT}/mcp|internal`);
  } else if (!MCP_INTERNAL_PORT && MCP_INTERNAL_SERVER) {
    console.warn('[mcp] an MCP_SERVERS entry uses |internal but MCP_INTERNAL_PORT is not set, so noevia\'s own tools will not answer.');
  } else if (MCP_INTERNAL_PORT && MCP_INTERNAL_SERVER) {
    if (MCP_INTERNAL_PORT === PORT || MCP_INTERNAL_PORT === Number(process.env.COWORK_DAV_PORT || 0)) {
      throw new Error('MCP_INTERNAL_PORT must differ from UI_PORT and COWORK_DAV_PORT');
    }
    const definitions = require('./mcp-internal-tools.cjs').createInternalTools({
      cap: TOOL_RESULT_CAP,
      getProject,
      // Reads only. diaryHeaders() carries the tenant header and the storage
      // descriptor, so the sidecar resolves the SAME corpus it would for this
      // user's own browser session and no other.
      diary: async (endpoint) => {
        const userId = requestScope.getStore()?.workspace?.userId;
        if (!userId || !authService.diaryEnabled(userId)) throw new Error('the Diary add-on is not enabled for this account');
        const r = await diaryFetchJson(`${DIARY_BASE}/api${endpoint}`, {}, 15000);
        if (!r.ok) throw new Error(String(r.body?.detail || r.body?.error || `diary sidecar ${r.status}`));
        return r.body || {};
      },
      ...(features.enabled('diaryMcpWrite') ? { diaryAppend: async ({ text, title, timezone }) => {
        const userId = requestScope.getStore()?.workspace?.userId;
        if (!userId || !authService.diaryEnabled(userId)) throw new Error('the Diary add-on is not enabled for this account');
        const body = { text, title, requestId: crypto.randomUUID(), entryTime: require('./mcp-internal-tools.cjs').isoWithOffset(new Date(), timezone) };
        const r = await diaryFetchJson(`${DIARY_BASE}/api/entries/append`, { method: 'POST', body: JSON.stringify(body) }, 30000);
        if (!r.ok) throw new Error(String(r.body?.error || r.body?.detail || `diary sidecar ${r.status}`));
        authService.audit('diary.append', userId, userId, { xid: r.body.xid, chars: text.length });
        return r.body;
      } } : {}),
      readProjectFile: (project, args) => executeToolCall(project, 'read_project_file', JSON.stringify(args), null),
      ragAvailable: () => rag.ragAvailable(),
      search: (projectId, query, userId) => rag.searchProject(projectId, query, userId),
      // One write path, the same one a browser upload takes: the file lands in
      // the project's storage folder and is re-indexed identically, rather
      // than a second kind of file that only the model can make.
      writeTextFile: writeProjectTextFile,
      // #687: the same storage check the chat loop made for the approval card, for this call's account.
      storageAccount: () => { const userId = requestScope.getStore()?.workspace?.userId; try { const c = userId ? authService.getStorage(userId, true) : null; return c && storageClient.isBrowsable(c) ? require('./project-edit-target.cjs').storageAccount(c) : null; } catch { return null; } },
    });
    const internalServer = mcpInternal.startInternalServer({
      port: MCP_INTERNAL_PORT,
      key: MCP_INTERNAL_KEY,
      definitions,
      // The scope comes from the token, never from whatever request happens to
      // be in flight. Same construction the diary backup worker uses.
      runAs: (userId, fn) => {
        const user = authService.listUsers().find((u) => u.id === userId);
        if (!user) throw new Error('that account no longer exists');
        return requestScope.run({ workspace: workspaceStore.get(userId), authn: { user, legacy: false } }, fn);
      },
      path: (() => { try { return new URL(MCP_INTERNAL_SERVER.url).pathname || '/mcp'; } catch { return '/mcp'; } })(),
    });
    internalServer.requestTimeout = 120000;
    internalServer.headersTimeout = 15000;
  }

  offsiteBackup.schedule();
  require('./diary-backup-worker.cjs').startDiaryBackupWorker({
    users: () => authService.listUsers(),
    enabled: id => authService.diaryEnabled(id),
    // Default 30 s so an idle tenant does not build a new ManagedCorpusBackend every
    // 3 s; DIARY_BACKUP_WORKER_INTERVAL_MS keeps the old cadence available for tests.
    interval: Number(process.env.DIARY_BACKUP_WORKER_INTERVAL_MS) > 0 ? Number(process.env.DIARY_BACKUP_WORKER_INTERVAL_MS) : 30000,
    run: user => requestScope.run({ workspace: workspaceStore.get(user.id), authn: { user, legacy: false } }, async () => {
      // The backup copies to the remote destination on every run, so it is the one call that
      // always carries the storage secret (#292); every other call sends only its ref.
      const target = `${DIARY_BASE}/api/storage-backup`;
      const r = await fetchJson(target, { method: 'POST', headers: diaryHeaders('POST', target, { secret: true }) }, 300000);
      if (!r.ok) throw new Error(`storage-backup failed: ${r.status}`);
      return r.body;
    }),
    onError: userId => console.warn(`[diary-backup] ${userId ? `backup failed for ${userId}` : 'backup tick failed'}, backing off`),
  });
  server.requestTimeout = 20 * 60 * 1000;
  // A stray rejected promise in one request or task must not take the whole web process (and
  // every other tenant's session) down with it. Logged loudly with its stack, never silent.
  process.on('unhandledRejection', (reason) => {
    console.error('[noevia] unhandled promise rejection:', reason?.stack || reason);
  });
  server.listen(PORT, HOST, () => {
    processReady = true;
    console.log(`cowork-ui listening on http://${HOST}:${PORT} (inference: ${INFERENCE_BASE}, manager: ${modelManager.kind}, diary: ${DIARY_BASE}, mcp: ${mcpWiring.enabled() ? MCP_SERVERS.map((sv) => sv.id).join('+') : 'disabled'})`);
    // Warm the tool catalogue so the first chat does not pay for discovery.
    // Never blocks startup: a side-car that is still booting must not stop
    // noevia from serving.
    discoverMcpTools().catch(() => undefined);
    // A calibration interrupted by a restart restores the preset it was testing.
    modelManager.calibration?.recover().catch(() => undefined);
    modelManager.autotune?.recover().catch(() => undefined);
    // A GGUF that appears in the models folder becomes usable without anyone opening a page.
    folderSync?.start();
  });
}

module.exports = { handleRequest, chatListHolder, sanitizeChats, MCP_SERVERS, toolboxOffered, ownsFile, projectFolderName, prefill, TOOL_PREFILL_TARGET_MS, isWriteTool, chatWideApproved, pendingApprovals, resolveTools, allToolboxes, mcpCredentialOriginAllowed, toolTokenBudgetFor, MCP_TOOLBOX_MANIFEST, toolboxSummaries, estimateToolTokens, toolCapFor, sanitizeToolboxes, executeToolCall, TOOLBOXES, classifierVerdict, heuristicWantsSmart, heuristicWantsCode, CLASSIFIER_MAX_TOKENS, recordUsage, recordToolUse, readUsage, usageDayKey, USAGE_RETENTION_DAYS };
