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
const { isPublicUrl } = require('./ssrf.cjs');

const PORT = Number(process.env.UI_PORT || 8021);
const HOST = process.env.UI_HOST || '0.0.0.0';
const INFERENCE_BASE = process.env.INFERENCE_BASE_URL || process.env.LEMONADE_BASE_URL || 'http://host.docker.internal:11434';
const INFERENCE_KEY = process.env.INFERENCE_API_KEY || process.env.LEMONADE_API_KEY || '';
const DEFAULT_PROVIDER_ID = process.env.DEFAULT_PROVIDER_ID || 'default';
const DEFAULT_PROVIDER_LABEL = process.env.DEFAULT_PROVIDER_LABEL || 'Local inference';
const MODEL_MANAGER_KIND = process.env.MODEL_MANAGER_KIND || (process.env.LEMONADE_BASE_URL ? 'lemonade' : 'none');
const MODEL_MANAGER_BASE = process.env.MODEL_MANAGER_BASE_URL || process.env.LEMONADE_BASE_URL || INFERENCE_BASE;
const DIARY_BASE = process.env.DIARY_BASE_URL || 'http://cowork-diary-companion:8010';
const DIARY_TOKEN = process.env.DIARY_AUTH_TOKEN || '';
const UI_AUTH_TOKEN = (process.env.UI_AUTH_TOKEN || DIARY_TOKEN).trim();
const DIST_DIR = path.join(__dirname, '..', 'dist');
const DATA_DIR = process.env.UI_DATA_DIR || path.join(__dirname, 'ui-data');
// Messages offered to the context projection per request. Compaction summarizes whatever does not
// fit (and refuses beyond 1000), so this is a safety bound, not a silent cut at 20 exchanges.
const HISTORY_CAP = 1000;
// The saved transcript is the record, not the model window: keep it whole within generous bounds.
const STORED_HISTORY_CAP = 5000;
const STORED_HISTORY_BYTES = 32 * 1024 * 1024;
const SPAFallbacks = ['/', '/chat', '/diary', '/projects', '/settings'];
const staticFiles = require('./static-files.cjs').createStaticFiles(DIST_DIR);
const secretStore = createSecretStore(DATA_DIR);
const authService = createAuth({
  dataDir: DATA_DIR,
  publicOrigin: process.env.PUBLIC_ORIGIN || '',
  rpId: process.env.WEBAUTHN_RP_ID || '',
  legacyToken: UI_AUTH_TOKEN,
  legacyCompat: process.env.LEGACY_AUTH_COMPAT === 'true',
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
const features = require('./features.cjs').createFeatures({ store: require('./features.cjs').settingsStore(authService.db), audit: (action, actor, detail) => authService.audit(action, actor, actor, detail) });
const featureRoutes = require('./routes/features.cjs').createFeatureRoutes({ features, json, readJson });
const pluginDirectoryRoutes = require('./routes/plugin-directory.cjs').createPluginDirectoryRoutes({ json });
// Settings → Data: the signed-in user's conversations as a ZIP (routes/export.cjs).
const exportRoutes = require('./routes/export.cjs').createExportRoutes({ json, workspace: () => ({ freeChats: Array.from(FREE_CHATS), projects: PROJECTS.filter((proj) => !diaryExtras.internalProject(proj)) }), readHistory: (id) => readHistory(id), audit: (action, actor, detail) => authService.audit(action, actor, actor, detail) });
const retentionLists = () => ({ freeChats: Array.from(FREE_CHATS), projects: PROJECTS.filter((proj) => !diaryExtras.internalProject(proj)) });
const removeRetainedChat = ({ projectId, id }) => (projectId ? deleteChat(projectId, id) : deleteFreeChat(id));
const accountRoutes = require('./routes/account.cjs').createAccountRoutes({ json, readJson, dir: () => currentWorkspace().dir, chatLists: retentionLists, removeChat: removeRetainedChat });
// Delete-old-chats sweep (chat-retention.cjs): runs as the user's workspace loads, at most hourly.
function sweepRetention() {
  const retention = require('./chat-retention.cjs');
  const dir = currentWorkspace().dir, settings = retention.read(dir);
  if (!retention.sweepDue(settings)) return;
  for (const chat of retention.expired({ ...retentionLists(), days: settings.days })) removeRetainedChat(chat);
  retention.markSwept(dir);
}
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
      writeHistory: (id, history) => writeHistory(id, history),
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
  userKey: () => secretStore.derive('google-drive-user'),
  makeDrive: ({ tokenFile, backupKey }) => require('./gdrive.cjs').createGoogleDrive({
    clientId: String(process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim(), clientSecret: String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim(),
    tokenFile, backupKey, oauthBase: process.env.GOOGLE_OAUTH_BASE_URL || undefined, apiBase: process.env.GOOGLE_DRIVE_API_BASE_URL || undefined,
    uploadBase: process.env.GOOGLE_DRIVE_UPLOAD_BASE_URL || undefined, log: (event) => console.log('[gdrive]', JSON.stringify(event)),
  }),
});
const { publicPage } = require('./routes/public-pages.cjs');
const webAddressRoutes = require('./routes/web-address.cjs').createWebAddressRoutes({ auth: authService, json, readBody: (req) => readJson(req) });
const davConfig = require('./dav-settings.cjs').configuration(process.env, authService.origin);
const davSettings = require('./dav-settings.cjs').createDavSettings({ auth: authService, config: davConfig });
if (process.env.LEMONADE_BASE_URL && !process.env.INFERENCE_BASE_URL) console.warn('LEMONADE_BASE_URL is deprecated; use INFERENCE_BASE_URL');
if (process.env.LEMONADE_API_KEY && !process.env.INFERENCE_API_KEY) console.warn('LEMONADE_API_KEY is deprecated; use INFERENCE_API_KEY');
const workspaceStore = createWorkspaceStore(DATA_DIR, { id: DEFAULT_PROVIDER_ID, label: DEFAULT_PROVIDER_LABEL, baseUrl: INFERENCE_BASE, apiKey: INFERENCE_KEY, shared: true }, secretStore);

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
const nextcloudFlows = new Map();
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
rag.init({ dataDir: DATA_DIR, inferenceUrl: INFERENCE_BASE, headersFn: () => inferenceHeaders(), userDataDirFn: workspaceStore.userDir, inferenceGuard: () => modelManager.enterInference?.() || (() => {}) });

// User-created projects; the earlier fixed demo spaces were removed.
// spaces were deleted per user request — projects are user-created only.
// Each project: goal/description, custom instructions,
// and text files (pasted/uploaded text injected into context; true doc-RAG is a
// later feature — flagged in MIGRATION.md).

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function unauthorized(res) {
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'WWW-Authenticate': 'Bearer realm="cowork"',
  });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

async function fetchJson(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
  // Honor a caller-supplied signal (e.g. client disconnect) in addition to the timeout.
  const external = opts && opts.signal;
  const onAbort = () => ctrl.abort();
  if (external?.aborted) ctrl.abort();
  else external?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { ...opts, redirect: 'error', signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onAbort);
  }
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw Object.assign(new Error('Request exceeds size limit'), { status: 413 });
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function readJson(req) {
  const raw = await readBody(req);
  return raw ? JSON.parse(raw) : {};
}

function authResult(res, result) {
  return json(res, result.status || 200, result.body ?? result);
}

// One call to the model management service, with its token. Same path the proxy route uses.
function managerFetch(rest, method = 'GET') {
  return fetchJson(`${process.env.MODEL_LOADER_URL.replace(/\/+$/, '')}/api/v1/${rest}`,
    { method, headers: { 'Content-Type': 'application/json', ...(process.env.MODEL_LOADER_TOKEN ? { 'X-Model-Loader-Token': process.env.MODEL_LOADER_TOKEN } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}) }, 120000).catch(() => null);
}

// Model files that appear in the models folder get safe defaults on their own (roadmap C3).
// Needs the model management service; the engine's own preset file is edited through it.
// Last model-folder scan, served instantly by the model-manager proxy (see there).
const modelScanCache = new Map();
let modelScanInflight = null;
function refreshModelScan() {
  if (modelScanInflight || !process.env.MODEL_LOADER_URL) return;
  modelScanInflight = fetchJson(`${process.env.MODEL_LOADER_URL.replace(/\/+$/, '')}/api/v1/models`, { method: 'GET', headers: { 'Content-Type': 'application/json', ...(process.env.MODEL_LOADER_TOKEN ? { 'X-Model-Loader-Token': process.env.MODEL_LOADER_TOKEN } : {}) } })
    .then((r) => { if (r?.ok && r.body && typeof r.body === 'object') modelScanCache.set('models', { at: Date.now(), body: r.body }); })
    .catch(() => undefined).finally(() => { modelScanInflight = null; });
}
const folderSync = process.env.MODEL_LOADER_URL ? require('./model-folder-sync.cjs').createFolderSync({
  stateFile: path.join(DATA_DIR, 'model-folder-sync.json'),
  listUnregistered: async () => {
    const r = await managerFetch('models');
    if (!r?.ok) throw Object.assign(Error(r?.body?.error || `model manager HTTP ${r?.status || 'unreachable'}`), { status: r?.status });
    return Array.isArray(r.body?.unregistered) ? r.body.unregistered : [];
  },
  register: async (stem) => {
    const r = await managerFetch(`sections/${encodeURIComponent(stem)}/safe-defaults`, 'POST');
    if (!r?.ok) throw Object.assign(Error(r?.body?.error || `model manager HTTP ${r?.status || 'unreachable'}`), { status: r?.status });
  },
  reloadPresets: () => modelManager.reloadPresets ? modelManager.reloadPresets({ unload: false }) : { ok: false },
  log: (message) => console.log(message),
}) : null;

const modelManager = createModelManager({
  kind: MODEL_MANAGER_KIND,
  presetPath: process.env.LLAMACPP_PRESET_PATH,
  autoconfig: {
    modelsPath: process.env.LLAMACPP_MODELS_PATH || '',
    budgetGib: Number(process.env.LLAMACPP_AUTOCONFIG_MEMORY_GIB) || require('./llamacpp-autoconfig.cjs').parseMemoryLimit(process.env.LLAMACPP_MEMORY_LIMIT) || 0,
    cacheRamMaxMib: Number(process.env.LLAMACPP_AUTOCONFIG_CACHE_RAM_MAX_MIB) || 1024,
    cachePath: process.env.LLAMACPP_CACHE_PATH || '',
    memoryFloorGib: Number(process.env.LLAMACPP_CALIBRATION_MEMORY_FLOOR_GIB) || 2,
  },
  evidenceDir: path.join(DATA_DIR,'evidence-'+require('node:crypto').createHash('sha256').update(MODEL_MANAGER_BASE).digest('hex').slice(0,16)),
  calibrationStatePath: path.join(DATA_DIR,'native-calibration-'+require('node:crypto').createHash('sha256').update(MODEL_MANAGER_BASE).digest('hex').slice(0,16)+'.json'),
  autotuneStatePath: path.join(DATA_DIR,'native-autotune-'+require('node:crypto').createHash('sha256').update(MODEL_MANAGER_BASE).digest('hex').slice(0,16)+'.json'),
  // Measured settings per architecture, quantisation and hardware; shared across models on this server.
  autotuneTablePath: path.join(DATA_DIR,'native-tuning-table.json'),
  downloadStatePath: path.join(DATA_DIR,'native-downloads-'+require('node:crypto').createHash('sha256').update(MODEL_MANAGER_BASE).digest('hex').slice(0,16)+'.json'),
  baseUrl: MODEL_MANAGER_BASE,
  apiKey: process.env.MODEL_MANAGER_API_KEY || INFERENCE_KEY,
  fetchJson,
});

function inferenceHeaders(extra) {
  const h = { 'Content-Type': 'application/json' };
  if (INFERENCE_KEY && INFERENCE_KEY !== 'local') h.Authorization = `Bearer ${INFERENCE_KEY}`;
  return { ...h, ...extra };
}

function diaryHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (DIARY_TOKEN) h.Authorization = `Bearer ${DIARY_TOKEN}`;
  const workspace = requestScope.getStore()?.workspace;
  if (workspace) {
    h['X-Cowork-User-ID'] = workspace.userId;
    if (fs.existsSync(path.join(workspace.dir, 'migration.json'))) h['X-Cowork-Legacy-Owner'] = '1';
    const storage = authService.getStorage(workspace.userId, true);
    if (storage.kind !== 'local' && !endpointApproved(requestScope.getStore()?.authn, storage.baseUrl)) {
      // The sidecar may serve an already-active app diary, but must never
      // resolve a legacy remote or send credentials to this rejected endpoint.
      h['X-Cowork-Storage-Blocked'] = '1';
      h['X-Cowork-Storage'] = Buffer.from(JSON.stringify({ kind: 'blocked' })).toString('base64url');
      return h;
    }
    h['X-Cowork-Storage'] = Buffer.from(JSON.stringify(storage)).toString('base64url');
  }
  return h;
}

// SSRF guard for storage endpoints. A member must not aim the server's
// outbound traffic — connection tests, file browsing, diary corpus sync — at
// internal addresses (RFC1918, link-local metadata, …). Admins are exempt: a
// self-hosted administrator legitimately connects LAN storage (a home NAS,
// an in-network Nextcloud). Same policy as the provider registry.
const STORAGE_PRIVATE_URL_ERROR = 'An http(s) server URL is required. This server is not approved for member connections. Ask an administrator to add its origin to MEMBER_OUTBOUND_ORIGINS.';
function endpointApproved(authn, rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return false;
    return authn?.user.role === 'admin' || (process.env.MEMBER_OUTBOUND_ORIGINS || '').split(',').map(x => x.trim()).includes(u.origin);
  } catch { return false; }
}
async function storageEndpointAllowed(authn, rawUrl) {
  return endpointApproved(authn, rawUrl);
}

// ── Projects config: instructions, files, memories, model ─────────────────

function saveProjects(projects) {
  for (const project of projects) require("./instruction-skills.cjs").reconcile(project);
  currentWorkspace().projects = Array.from(projects);
  currentWorkspace().saveProjects();
}

const PROJECTS = arrayProxy('projects');

function getProject(id) {
  const project = PROJECTS.find((p) => p.id === id) || null;
  if (project && require('./instruction-skills.cjs').reconcile(project)) currentWorkspace().saveProjects();
  return project;
}

// ── Provider registry (step 9): generic OpenAI-compatible endpoints ────────
// One adapter covers all of them (same /chat/completions shape). Projects
// without a provider field use the environment-configured default provider.
// Syncs the private half of the registry from the current merged view and
// persists ONLY the user's private provider file. Shared rows are excluded:
// a per-user save must never rewrite shared-providers.json (checkpoint 1c —
// a stale snapshot could erase another admin's shared provider).
function saveProviders() {
  const ws = currentWorkspace();
  ws.privateProviders = Array.from(ws.providers).filter((p) => !p.shared && p.id !== DEFAULT_PROVIDER_ID);
  ws.saveProviders();
}

// Admin path: persists the shared half of the registry from the current
// merged view (private rows are synced in memory only, untouched on disk).
function saveSharedProviders() {
  const ws = currentWorkspace();
  ws.privateProviders = Array.from(ws.providers).filter((p) => !p.shared && p.id !== DEFAULT_PROVIDER_ID);
  ws.saveShared();
}

const PROVIDERS = arrayProxy('providers');

function backupOnce(name) {
  const file = path.join(currentWorkspace().dir, name);
  if (!fs.existsSync(file)) return;
  const backup = `${file}.pre-neutral-provider.bak`;
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
}

function getProvider(id) {
  const normalized = id === 'lemonade' ? DEFAULT_PROVIDER_ID : id;
  return PROVIDERS.find((pr) => pr.id === normalized) || PROVIDERS.find((pr) => pr.id === DEFAULT_PROVIDER_ID) || null;
}

function maskKey(key) {
  if (!key || key === 'local') return null;
  return key.length > 8 ? `${key.slice(0, 3)}…${key.slice(-4)}` : `…${key.slice(-4)}`;
}

function providerHeaders(provider, extra) {
  const h = { 'Content-Type': 'application/json', ...(extra || {}) };
  if (provider.apiKey && provider.apiKey !== 'local') h.Authorization = `Bearer ${provider.apiKey}`;
  return h;
}

// Chats are history keys; each project holds ordered chat metadata.
// Self-heal orphaned placeholder entries: a bare chat-id string (or any
// non-object) can land in chats[] if the follow-up POST /chats never fires
// (tab closed mid-send). Every path that hands chat metas to a client must go
// through this — the client spreads these into objects and reads .title, so a
// bare string reaches the sidebar as a title-less record and throws, blanking
// the whole app. The next saveChats drops them from disk for good.
function sanitizeChats(chats) {
  return (chats || []).filter((c) => c && typeof c === 'object' && typeof c.id === 'string');
}

// Each meta: { id, title, updatedAt } — the title is the first user message.
function loadChats(projectId) {
  const p = getProject(projectId);
  if (!p) return [];
  return sanitizeChats(p.chats);
}

function saveChats(projectId, chats) {
  const p = getProject(projectId);
  if (!p) return;
  const lists = require('./chat-lists.cjs');
  p.chats = lists.mergeChats(p.chats, chats, lists.readTombstones(currentWorkspace().dir));
  saveProjects(PROJECTS);
}

function deleteChat(projectId, chatId) {
  const p = getProject(projectId);
  if (!p) return false;
  const before = (p.chats || []).length;
  p.chats = (p.chats || []).filter((c) => c.id !== chatId);
  if (p.chats.length === before) return false;
  require('./chat-lists.cjs').addTombstone(currentWorkspace().dir, chatId);
  saveProjects(PROJECTS);
  try {
    require('./chat-context.cjs').remove(currentWorkspace().dir,chatId);
    fs.unlinkSync(currentWorkspace().historyPath(chatId));
  } catch {
    /* no history file — fine */
  }
  return true;
}

// Free (non-project) chat metas — persisted server-side so recent chats
// survive across browsers/devices (localStorage was the only home before).
function saveFreeChats(list) {
  currentWorkspace().freeChats = Array.from(list);
  currentWorkspace().saveFreeChats();
}

const FREE_CHATS = arrayProxy('freeChats');

function deleteFreeChat(chatId) {
  const before = FREE_CHATS.length;
  const filtered = Array.from(FREE_CHATS).filter((c) => c.id !== chatId);
  FREE_CHATS.splice(0, FREE_CHATS.length, ...filtered);
  if (FREE_CHATS.length === before) return false;
  require('./chat-lists.cjs').addTombstone(currentWorkspace().dir, chatId);
  saveFreeChats(FREE_CHATS);
  try {
    require('./chat-context.cjs').remove(currentWorkspace().dir,chatId);
    fs.unlinkSync(currentWorkspace().historyPath(chatId));
  } catch {
    /* no history file — fine */
  }
  return true;
}

// Creates, saves and indexes a project from a create request body. Throws { status: 400 } on
// invalid input. Shared by POST /api/projects and conversation import.
async function createProject(body) {
  if (body.reasoningEffort !== undefined && !reasoningEffort.validEffort(body.reasoningEffort)) throw Object.assign(Error('Invalid reasoning effort'), { status: 400 });
  const name = String(body.name || '').trim().slice(0, 120);
  if (!name) throw Object.assign(Error('name required'), { status: 400 });
  let modes = ['chat'];
  if (body.modes !== undefined) { try { modes = require('./project-modes.cjs').sanitize(body.modes); } catch (e) { throw Object.assign(Error(e.message), { status: 400 }); } }
  let appearance;
  try { appearance = projectAppearance(body); } catch (e) { throw Object.assign(Error(e.message), { status: 400 }); }
  const project = {
    ...appearance,
    id: `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    goal: String(body.goal || '').slice(0, 2000),
    instructions: String(body.instructions || '').slice(0, 8000),
    pinned: false,
    archived: false,
    sourceFolders: [],
    memories: [],
    files: Array.isArray(body.files)
      ? body.files
          .filter((f) => f && typeof f.name === 'string' && typeof f.content === 'string')
          .slice(0, 20)
          .map((f) => ({ name: f.name.slice(0, 200), content: f.content.slice(0, 200000) }))
      : [],
    model: typeof body.model === 'string' && body.model ? body.model : undefined,
    provider: typeof body.provider === 'string' && body.provider ? body.provider : undefined,
    reasoningEffort: body.reasoningEffort,
    routing: body.routing === 'auto' ? 'auto' : 'manual', // default manual (step 12 guardrail)
    modes,
    toolboxes: sanitizeToolboxes(body.toolboxes) || [...DEFAULT_TOOLBOXES], // step 14: core only by default
    // (files normalization below is shared with the config route's RAG bookkeeping)
    chats: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  // Its own folder in the user's storage, and attached as a source so
  // anything dropped in it — by noevia or by the user, from any device —
  // is picked up on the next sync.
  const ownFolder = await ensureProjectFolder(project);
  if (ownFolder) {
    project.projectFolder = ownFolder;
    project.sourceFolders = [ownFolder];
  }
  PROJECTS.unshift(project);
  saveProjects(PROJECTS);
  // Index any files that arrived with the create call (same RAG bookkeeping
  // as the config route).
  for (const f of project.files) {
    indexSource(project, f);
  }
  return project;
}

// ── History persistence (atomic write, JSON per space) ─────────────────────

function historyPath(spaceId) {
  const safe = String(spaceId).replace(/[^a-zA-Z0-9_-]/g, '');
  return currentWorkspace().historyPath(safe);
}

function readHistory(spaceId) {
  try {
    return JSON.parse(fs.readFileSync(historyPath(spaceId), 'utf8')).history || [];
  } catch {
    return [];
  }
}

function writeHistory(spaceId, history) {
  fs.mkdirSync(currentWorkspace().dir, { recursive: true });
  const file = historyPath(spaceId);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ history }, null, 2));
  fs.renameSync(tmp, file);
}

// ── Optional model manager ─────────────────────────────────────────────────

// The last model the manager reported as loaded — the non-hardcoded default for
// projects that have not picked a model yet (replaces the old DEFAULT_MODEL
// literal per feature doc Item 0 / step 9).
let LAST_LOADED_MODEL = null;

// Usage accounting (daily rollups per tenant) lives in usage.cjs; its routes in routes/usage.cjs.
const { USAGE_RETENTION_DAYS, usageDayKey, readUsage, recordUsage, recordToolUse } = require('./usage.cjs');

// ── Auto model router (feature doc Item 4 / master step 12) ───────────────
// Roles are config, never hardcoded model names: role→model mapping lives in
// ui/server/auto-roles.json (created on first use; never ships a default
// model string). Native llama.cpp owns role-model loading and eviction.
function autoRoles() {
  return currentWorkspace().autoRoles;
}

function setAutoRoles(next) {
  // `vision` and `code` are optional: a deployment with no vision-capable or
  // coding model should not be forced to name one, and an existing config
  // without them keeps working.
  const roles = { fast: String(next.fast), smart: String(next.smart) };
  if (next.vision) roles.vision = String(next.vision);
  if (next.code) roles.code = String(next.code);
  currentWorkspace().autoRoles = roles;
  currentWorkspace().saveAutoRoles();
}

async function ensureModelLoaded(name) {
  const installed = await modelsInstalled();
  const m = installed.find((x) => x.name === name);
  if (!m) throw new Error(`model not installed: ${name}`);
  if (!m.loaded) {
    const result = await modelManager.load(name);
    if (!result.ok) throw new Error(`model could not load: ${name}`);
  }
}

function ensureRolesLoaded() {
  // Native router owns on-demand loading and eviction (including models-max=1).
  if (modelManager.capabilities?.routing) return;
  const roles = autoRoles();
  if (!roles) return;
  void (async () => {
    for (const role of ['fast', 'smart', 'vision', 'code']) {
      if (!roles[role]) continue;
      try {
        await ensureModelLoaded(roles[role]);
      } catch (err) {
        console.warn(`[router] could not load ${role} model (${roles[role]}):`, err?.message || err);
      }
    }
  })();
}

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
  executeMcp: (name, args) => executeMcpToolCall(name, args),
});
const connectorRoutes = require('./routes/connectors.cjs').createConnectorRoutes({
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

// An image source is bytes, not text, and needs its own limits.
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
// Endpoint-scoped probes expire, so repairing a model or its projector does
// not require restarting noevia before images work again.
const visionProbe = createVisionProbe();
// Cached image descriptions, keyed by model + images + question.
const visionDescriptions = new Map();
const IMAGE_UPLOAD_CAP = 8 * 1024 * 1024;
const DOCUMENT_UPLOAD_CAP = 25 * 1024 * 1024;

// Where a project's own folder lives in the user's storage. One folder per
// project under a single root, so uploads land somewhere the user can open,
// edit and back up like any other folder — rather than inside projects.json
// where only noevia can reach them.
const PROJECT_ROOT_FOLDER = (process.env.PROJECT_ROOT_FOLDER || 'noevia projects').replace(/^\/+|\/+$/g, '');

const { projectFolderName, createProjectFolder } = require('./project-folders.cjs');

/** Whether `target` is a file this project may delete: one sitting directly in
 *  a folder the project has attached, including its own.
 *
 *  Bounded to attached folders rather than the project's own, because an
 *  attached folder's files are the user's and deleting them is their call —
 *  but a project must not be a way to delete a path it was never given.
 *  Sub-paths are refused, so a nested directory cannot be reached through a
 *  folder that merely contains it. */
function ownsFile(project, target) {
  if (!project || typeof target !== 'string' || !target) return false;
  if ((project.files || []).some(f => f.name === target && f.attachment && f.source === project.projectFolder && require('./uploads.cjs').GROUPS.some(g => target.startsWith(`${project.projectFolder}/${g}/`) && !target.slice(`${project.projectFolder}/${g}/`.length).includes('/')))) return true;
  const folders = [
    ...(project.projectFolder ? [project.projectFolder] : []),
    ...(Array.isArray(project.sourceFolders) ? project.sourceFolders : []),
  ];
  return folders.some((folder) => {
    if (!folder) return false;
    const prefix = `${folder}/`;
    if (!target.startsWith(prefix)) return false;
    const rel = target.slice(prefix.length);
    return !!rel && !rel.includes('/') && rel !== '.' && rel !== '..';
  });
}

/** Create this project's folder, returning its path, or null when there is no
 *  browsable storage to put it in. Never throws: a project must still be
 *  creatable when storage is down or unconfigured. */
async function ensureProjectFolder(project) {
  let connection;
  try {
    connection = authService.getStorage(currentWorkspace().userId, true);
  } catch {
    return null;
  }
  if (!storageClient.isBrowsable(connection)) return null;
  try {
    return await createProjectFolder(storageClient, connection, PROJECT_ROOT_FOLDER, project);
  } catch (err) {
    console.warn(`[projects] could not create folder for project ${project.id}: ${String((err && err.message) || err)}`);
    return null;
  }
}

// Serialize source operations within one authenticated project. Config edits
// and deletion can still happen while waiting; recheck ownership before commit.
const sourceOperations = new WeakMap();
async function withSourceLock(project, operation) {
  const previous = sourceOperations.get(project) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  sourceOperations.set(project, next);
  try { return await next; }
  finally {
    if (sourceOperations.get(project) === next) {
      sourceOperations.delete(project);
      pruneDocuments(project);
    }
  }
}
function pruneDocuments(project) {
  if (sourceOperations.has(project)) return;
  const workspace = currentWorkspace();
  try { documentSources.prune(workspace, workspace.projects.includes(project) ? project : { id: project.id, files: [] }); }
  catch (err) { console.warn('[documents] cleanup failed:', err.message); }
  try { require('./uploads.cjs').prune(workspace, workspace.projects.includes(project) ? project : { id: project.id, files: [] }); }
  catch (err) { console.warn('[uploads] cleanup failed:', err.message); }
}
// One write path for server-authored project text files (MCP writes, research reports), the
// same one a browser upload takes: the file lands in the project's storage folder and is
// re-indexed identically.
function writeProjectTextFile(project, name, text) {
  return withSourceLock(project, async () => {
    if (getProject(project.id) !== project) throw new Error('the project changed while writing; nothing was saved');
    const uploads = require('./uploads.cjs');
    const bytes = Buffer.from(text, 'utf8');
    uploads.validate(name, bytes);
    const connection = authService.getStorage(currentWorkspace().userId, true);
    const remote = storageClient.isBrowsable(connection) ? connection : null;
    if (remote && !project.projectFolder) project.projectFolder = await ensureProjectFolder(project);
    const file = await uploads.ingest(currentWorkspace(), project, name, bytes, { connection: remote });
    if (remote) project.sourceFolders = [...new Set([...(project.sourceFolders || []), project.projectFolder])];
    project.files = [...(project.files || []).filter((f) => f.name !== file.name), file];
    project.updatedAt = Date.now();
    indexSource(project, file);
    saveProjects(PROJECTS);
    return file;
  });
}
const projectSweep = require('./project-sweep.cjs').createProjectSweep({ storage: storageClient, log: event => console.log('[projects]', JSON.stringify(event)) });
// D8: runs after the delete is saved; empty-only, tenant-scoped, never recursive.
function sweepDeletedProject(project) {
  const workspace = currentWorkspace();
  let connection = null;
  try { connection = project.projectFolder ? authService.getStorage(workspace.userId, true) : null; } catch { connection = null; }
  projectSweep.afterDelete({
    projectId: project.id,
    tenantRoot: workspace.dir,
    localDirs: [require('./uploads.cjs').directory(workspace, project.id), documentSources.directory(workspace, project.id), workspace.assetDir(project.id)],
    connection, folder: project.projectFolder || '', root: PROJECT_ROOT_FOLDER, groups: require('./uploads.cjs').GROUPS,
  }).catch(error => console.warn('[projects] sweep failed:', error.message));
}
function indexSource(project, file) {
  const workspace = currentWorkspace();
  if (require('./instruction-skills.cjs').inspect(file, project) || !file.content) {
    if (file.document) file.document.indexing = 'unavailable';
    rag.deleteProjectFile(project.id, file.name, workspace.userId);
    return;
  }
  if (file.document) file.document.indexing = 'pending';
  rag.indexProjectFile(project.id, file.name, file.content, workspace.userId).then(result => {
    if (!workspace.projects.includes(project) || !project.files.includes(file) || !file.document) return;
    file.document.indexing = !result?.ok ? 'unavailable' : result.direct ? 'direct' : result.embedded < result.stored ? 'partial' : 'ready';
    workspace.saveProjects();
  }).catch(() => {
    if (workspace.projects.includes(project) && project.files.includes(file) && file.document) {
      file.document.indexing = 'failed';
      try { workspace.saveProjects(); } catch (err) { console.warn('[documents] could not save index state:', err.message); }
    }
  });
}

const MAX_PROJECT_IMAGES = 12;

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
const codeRoutes = require('./routes/code.cjs').createCodeRoutes({
  features, getProject, workspace: () => currentWorkspace(), json, readJson,
  service: require('./code-service.cjs').createCodeService({
    repos: process.env.CODE_REPOS,
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
        model: autoRoles()?.code || autoRoles()?.smart || LAST_LOADED_MODEL || null,
        contextTokens: Number(process.env.CODE_CONTEXT_TOKENS) || undefined,
      };
    },
    // `CODE_HARNESS_COMMAND` is the ACP agent to run (for example `opencode acp`). Unset, a
    // task cannot start and says so.
    connect: require('./code-acp.cjs').createAcpTransport({ log: (entry) => console.log('[code]', JSON.stringify(entry)) }),
  }),
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
    if (!researchModel()) return 'Pick a Smart model for Auto routing, or load a model, before starting research.';
    return null;
  },
  service: require('./research-service.cjs').createResearchService({
    saveFile: (project, name, text) => writeProjectTextFile(project, name, text),
    tools: (workspace, project) => ({
      complete: async (messages, { signal, maxTokens }) => {
        const provider = getProvider(DEFAULT_PROVIDER_ID), model = researchModel(project);
        const r = await fetch(`${provider.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/chat/completions`, { method: 'POST', redirect: 'error',
          headers: providerHeaders(provider, { 'Content-Type': 'application/json' }), signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
          body: JSON.stringify({ model, stream: false, max_tokens: maxTokens, messages }) });
        if (!r.ok) throw Object.assign(Error(`The model provider answered ${r.status}.`), { publicMessage: `The model provider answered ${r.status}.` });
        const choice = (await r.json()).choices?.[0];
        if (choice?.finish_reason === 'length') throw Object.assign(Error('A research step was cut off by the output limit.'), { publicMessage: 'A research step was cut off by the output limit.' });
        return String(choice?.message?.content || '');
      },
      search: async (query) => require('./routes/research.cjs').parseSearchResults(await executeMcpToolCall('tavily_search', { query, max_results: 5 })),
      extract: async (url) => {
        const text = await executeMcpToolCall('tavily_extract', { urls: [url] });
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
  return autoRoles()?.smart || project?.model || LAST_LOADED_MODEL || null;
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
// OAuth sign-in for directory servers: one sign-in per account per server (mcp-oauth.cjs).
// Its URLs come from strangers' metadata, so they must be https (or the QA loopback) and public.
const mcpOAuth = require('./mcp-oauth.cjs').createMcpOAuth({
  db: authService.db, secrets: secretStore, audit: (action, actor, detail) => authService.audit(action, actor, actor, detail),
  urlAllowed: async (url) => require('./directory-mcp.cjs').hostedUrlOk(url) && directoryUrlAllowed(url),
  redirectUri: () => `${String(authService.origin || process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '')}/api/mcp-oauth/callback`,
});
const mcpCredentialOriginAllowed = createCredentialOriginCheck(process.env.MCP_NEXTCLOUD_ORIGINS);
// The live server list, discovery, per-server credentials and the MCP executor: mcp-wiring.cjs.
// It appends the directory servers to MCP_SERVERS itself and keeps that array current.
const mcpWiring = createMcpWiring({
  servers: MCP_SERVERS, manifest: MCP_TOOLBOX_MANIFEST, mcp, bindBoxes, directoryMcp, mcpOAuth, directoryUrlAllowed,
  credentialOriginAllowed: mcpCredentialOriginAllowed, scope: requestScope,
  storageFor: (userId) => authService.getStorage(userId, true),
  isWriteTool: (name) => isWriteTool(name),
  internal: mcpInternal, internalKey: MCP_INTERNAL_KEY,
  reduceToolResult, resultCap: TOOL_RESULT_CAP,
});
const { state: mcpState, oauthServerIds, accountReady, probeMcpAuth, syncDirectoryServers, discoverOneServer, discoverMcpTools, executeMcpToolCall } = mcpWiring;

// The approval gate's state lives in approvals.cjs; the chat loop below and the
// /api/tool-approvals route are its only callers.
const { pendingApprovals, chatWideApproved, awaitApproval } = require('./approvals.cjs').createApprovals();

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
});
const { heuristicWantsSmart, heuristicWantsCode, classifierVerdict, CLASSIFIER_MAX_TOKENS } = autoRouter;
const classifyFastOrSmart = (message) => autoRouter.classify(message);

// The served model list, or null when it cannot be read (never treat an outage as "nothing installed").
async function servedCatalogue() {
  if (!modelManager.enabled) return null;
  try { return await modelsInstalled(); } catch { return null; }
}

async function modelsInstalled() {
  modelManager.requireEnabled();
  const [list, health] = await Promise.allSettled([
    modelManager.listModels(),
    modelManager.health(),
  ]);
  if (list.status !== 'fulfilled' || !list.value.ok) {
    throw new Error(`model list failed: ${list.status === 'fulfilled' ? list.value.status : 'unreachable'}`);
  }
  const loadedNames = new Set();
  if (health.status === 'fulfilled' && health.value.ok) {
    for (const m of health.value.body.all_models_loaded || []) {
      if (m.loaded && m.model_name) loadedNames.add(m.model_name);
    }
  }
  const installed = (list.value.body.data || [])
    // Some managers register cosmetic hash-ID duplicates; hide bare hash names.
    .filter((m) => !/^[0-9a-f]{32,40}$/i.test(m.id || m.model_name || ''))
    .map((m) => ({
      name: m.id || m.model_name,
      sizeGB: typeof m.size === 'number' ? Math.round(m.size * 10) / 10 : null,
      loaded: loadedNames.has(m.id || m.model_name),
      labels: Array.isArray(m.labels) ? m.labels : [],
      mtp: require('./mtp.cjs').capability(m),
      maxContext: m.max_context_window || null,
      suggested: !!m.suggested,
      status: m.status?.value || (loadedNames.has(m.id || m.model_name) ? 'loaded' : 'unloaded'),
      failed: m.status?.failed === true,
      canDelete: m.can_remove !== false,
      source: m.source || null,
    }));
  if (!LAST_LOADED_MODEL) {
    const firstLoaded = installed.find((m) => m.loaded && !m.labels.some(label => /^(embedding|embeddings|rerank|reranking|reranker)$/i.test(label)));
    if (firstLoaded) LAST_LOADED_MODEL = firstLoaded.name;
  }
  return installed;
}

// Lemonade's /pull needs a namespaced model_name for any checkpoint it
// doesn't already know about; derive one from the repo/variant the user
// picked (variants() below always hands us `<repo>:<variant>` or a bare
// repo). Lemonade requires the `user.` prefix to avoid colliding with its
// built-in registry.
function deriveUserModelName(checkpoint) {
  const [repo, variant] = String(checkpoint).split(':');
  const base = (repo.split('/').pop() || repo).replace(/[^A-Za-z0-9._-]/g, '-');
  const safeVariant = variant ? variant.replace(/[^A-Za-z0-9._-]/g, '-') : '';
  return `user.${base}${safeVariant ? `-${safeVariant}` : ''}`;
}

// ── Corpus-source adapter (Diary tab reads) ────────────────────────────────
// Contract: listMonths() → [{id,label}]; readMonth(id) → {todayLog, standing}.
// v1 source: 'sidecar' (Nextcloud via diary-companion's read API). Planned:
// 'local' (DIARY_LOCAL_DIR) when/if the corpus moves off Nextcloud. WRITES are
// never here — they go through the sidecar pipeline via the diary alias.
const DIARY_SOURCE = process.env.DIARY_SOURCE || 'sidecar';

const corpusSource =
  DIARY_SOURCE === 'sidecar'
    ? {
        name: 'sidecar',
        async listMonths() {
          // Real month list from the sidecar (PROPFIND over the corpus dir).
          // Returns only months that actually have a corpus file — the client
          // synthesizes a "Today" entry itself, and a first-run user must see
          // an empty list so the diary zero-state can trigger. Tolerant: on
          // failure, return an empty list (today's file still renders when
          // navigated to directly).
          try {
            const r = await fetchJson(`${DIARY_BASE}/api/months`, { headers: diaryHeaders() }, 15000);
            return (r.ok && Array.isArray(r.body?.months) ? r.body.months : [])
              .filter((m) => m && typeof m.id === 'string' && /^\d{4}-\d{2}$/.test(m.id))
              .map((m) => ({ id: m.id, label: m.label || m.id }))
              .sort((a, b) => a.id.localeCompare(b.id));
          } catch {
            return [];
          }
        },
        async readMonth(monthId) {
          const q = monthId ? `?month=${encodeURIComponent(monthId)}` : '';
          const r = await fetchJson(`${DIARY_BASE}/api/day${q}`, { headers: diaryHeaders() }, 15000);
          if (!r.ok) throw new Error(`sidecar ${r.status}`);
          // Whole-month mode returns { month, log }; today mode returns { today_log }.
          const log = (r.body && (r.body.log ?? r.body.today_log)) || '';
          return { todayLog: log, standing: (r.body && r.body.standing) || '' };
        },
      }
    : {
        name: DIARY_SOURCE,
        async listMonths() {
          throw new Error(`corpus source '${DIARY_SOURCE}' not implemented yet (planned: local)`);
        },
        async readMonth() {
          throw new Error(`corpus source '${DIARY_SOURCE}' not implemented yet (planned: local)`);
        },
      };

// ── Chat: the loop lives in chat.cjs; everything it needs is handed over here ──
const { handleChat } = require('./chat.cjs').createChatHandler({
  // fetch is resolved per call, not captured: tests and QA swap the global at runtime.
  fs, path, crypto, fetch: (...args) => globalThis.fetch(...args), reasoningEffort, diaryExtras, createToolExchange, rag, prefill, reduceToolResult,
  HISTORY_CAP, DEFAULT_PROVIDER_ID, DIARY_BASE, TOOL_RESULT_CAP,
  authService, toolPolicy, modelManager, requestScope, currentWorkspace, json,
  getProject, getProvider, providerHeaders, saveChats, endpointApproved, diaryHeaders,
  autoRoles, lastLoadedModel: () => LAST_LOADED_MODEL, classifyFastOrSmart, servedCatalogue, modelsInstalled, missingRoles, staleRolesError,
  visionProbe, visionDescriptions, skillsIndexFor, chatSkillRouter, chatToolRouter,
  DEFAULT_TOOLBOXES, CONNECTOR_BOXES, connectedBoxes, allToolboxes, resolveTools, isWriteTool, executeToolCall,
  oauthServerIds, accountReady, chatWideApproved, awaitApproval, recordUsage, recordToolUse,
});
// POST /api/chat: rate limit, body cap and the Diary gate, then the loop (routes/chat.cjs).
const chatRoutes = require('./routes/chat.cjs').createChatRoutes({
  json, readBody, bodyCap: STORED_HISTORY_BYTES, rateLimited: (userId) => llmRateLimited(userId),
  diaryEnabled: (userId) => authService.diaryEnabled(userId), handleChat,
});

// ── Routing ────────────────────────────────────────────────────────────────

const diaryConnectors = require('./diary-connectors.cjs').createCredentials(authService);
const connectorRate = require('./auth.cjs').createRateLimiter();
async function callDiaryFile(userId, endpoint, method, body) {
  const workspace = workspaceStore.get(userId);
  const user = authService.publicUser(authService.db.prepare('SELECT * FROM users WHERE id=? AND disabled_at IS NULL').get(userId));
  if(!user || !authService.diaryEnabled(userId))throw Object.assign(Error('Diary unavailable'),{status:403});
  return requestScope.run({workspace,authn:{user,legacy:false}},async()=>{
    const r=await fetchJson(`${DIARY_BASE}/api${endpoint}`,{method,headers:diaryHeaders(),body:body===undefined?undefined:JSON.stringify(body)},60000);
    if(!r.ok)throw Object.assign(Error(r.body?.detail || 'Diary request interrupted; read the current version before retrying a write'),{status:r.status||502});
    return r.body;
  });
}
const connectorFiles={
  list:async(id,path)=>(await callDiaryFile(id,'/files?path='+encodeURIComponent(path),'GET')).files,
  read:(id,path)=>callDiaryFile(id,'/file','POST',{path}),
  write:(id,body)=>callDiaryFile(id,'/file','PUT',body),
};
// GET /api/toolboxes: the picker view (routes/toolboxes.cjs). MCP state is read at call time.
const toolboxRoutes = require('./routes/toolboxes.cjs').createToolboxRoutes({
  discoverMcpTools: () => discoverMcpTools(), toolboxSummaries, json,
  prefill: { targetMs: TOOL_PREFILL_TARGET_MS, stats: () => prefill.stats() },
  mcp: () => ({ enabled: mcpWiring.enabled(), state: mcpState, servers: MCP_SERVERS, manifest: MCP_TOOLBOX_MANIFEST }),
});
const mcpDirectoryRoutes = require('./routes/mcp-directory.cjs').createMcpDirectoryRoutes({
  json, readJson, auth: authService, servers: MCP_SERVERS, mcpState, directoryMcp, mcpOAuth,
  discoverOneServer, discoverMcpTools, probeMcpAuth, syncDirectoryServers, directoryUrlAllowed,
});

async function handleRequestInner(req, res) {
  const preAuth = authService.authenticate(req);
  const workspace = preAuth ? workspaceStore.get(preAuth.user.id, { claim: preAuth.user.role === 'admin' }) : null;
  if (workspace && preAuth.user.role === 'admin' && authService.diaryEnabled(preAuth.user.id) && fs.existsSync(path.join(workspace.dir, 'migration.json')) &&
      process.env.CORPUS_BACKEND === 'webdav' && authService.getStorage(preAuth.user.id).kind === 'local') {
    authService.saveStorage(preAuth.user.id, { kind: 'webdav', baseUrl: process.env.WEBDAV_BASE_URL || '', username: process.env.WEBDAV_USERNAME || '', secret: process.env.WEBDAV_PASSWORD || '', corpusRoot: process.env.CORPUS_ROOT || '' });
  }
  return requestScope.run({ workspace, authn: preAuth }, () => handleRequestScoped(req, res));
}

async function handleRequestScoped(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");

  try {
    if ((req.method === 'GET' || req.method === 'HEAD') && publicPage(p)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
      return res.end(req.method === 'HEAD' ? undefined : publicPage(p));
    }
    if(p==='/api/diary-connector') {
      res.setHeader('Cache-Control','no-store');
      if(req.method!=='POST')return json(res,405,{error:'POST required'});
      if(req.headers.origin)return json(res,403,{error:'Use the authenticated connector client'});
      if(connectorRate.rateLimited('diary-connector:'+String(req.socket?.remoteAddress),120,60000))return json(res,429,{error:'Try later'});
      const token=String(req.headers.authorization||'').replace(/^Bearer /,'');
      const identity=diaryConnectors.verify(token);
      if(!identity)return json(res,401,{error:'Diary connector credential required'});
      const body=JSON.parse(await readBody(req,4*1024*1024));
      const result=await require('./diary-connectors.cjs').operate(identity,body,connectorFiles,()=>!!diaryConnectors.verify(token));
      if(body.action==='write')authService.audit('diary-connector.write',identity.userId,identity.userId,{credentialId:identity.id,path:body.path,bytes:Buffer.byteLength(body.content)});
      return json(res,200,result);
    }
    const publicAuthRoutes = new Set([
      '/api/setup/status', '/api/setup/complete', '/api/auth/login/password',
      '/api/auth/login/passkey/options', '/api/auth/login/passkey/verify',
      '/api/auth/invitations/accept', '/api/auth/recovery/complete',
    ]);
    if ((p === '/api/instance' || p === '/.well-known/webauthn') && await webAddressRoutes(req, res, { path: p, authn: null })) return;
    if (p === '/api/setup/status' && req.method === 'GET') {
      return json(res, 200, { configured: authService.userCount() > 0, publicOrigin: authService.origin || process.env.PUBLIC_ORIGIN || '' });
    }
    if (publicAuthRoutes.has(p) && req.method !== 'GET' && !authService.originValid(req)) {
      return json(res, 403, { error: 'origin not allowed' });
    }
    if (p === '/api/setup/complete' && req.method === 'POST') return authResult(res, await authService.setup(req, res, await readJson(req)));
    if (p === '/api/auth/login/password' && req.method === 'POST') return authResult(res, await authService.passwordLogin(req, res, await readJson(req)));
    if (p === '/api/auth/login/passkey/options' && req.method === 'POST') {
      return json(res, 200, await authService.authenticationOptions((await readJson(req)).username));
    }
    if (p === '/api/auth/login/passkey/verify' && req.method === 'POST') {
      try { return json(res, 200, await authService.authenticationVerify(req, res, await readJson(req))); }
      catch { return json(res, 401, { error: 'sign-in failed' }); }
    }
    if (p === '/api/auth/invitations/accept' && req.method === 'POST') return authResult(res, await authService.acceptInvite(req, res, await readJson(req)));
    if (p === '/api/auth/recovery/complete' && req.method === 'POST') {
      try { const ok = await authService.completeRecovery(await readJson(req)); return json(res, ok ? 200 : 400, ok ? { ok: true } : { error: 'recovery link is invalid or expired' }); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }

    const authn = p.startsWith('/api/') ? authService.authenticate(req) : null;
    if (p.startsWith('/api/') && !publicAuthRoutes.has(p) && !authn) return unauthorized(res);
    if (authn && !['GET', 'HEAD', 'OPTIONS'].includes(req.method || 'GET') && (!authService.originValid(req) || !authService.csrfValid(req, authn))) {
      return json(res, 403, { error: 'invalid CSRF token' });
    }
    if (authn && await featureRoutes(req, res, { path: p, authn })) return;
    if (authn && await exportRoutes(req, res, { path: p, authn })) return;
    if (authn && await importRoutes(req, res, { path: p, authn })) return;
    if (authn && await accountRoutes(req, res, { path: p, authn })) return;
    if (authn && await offsiteRoutes(req, res, { path: p, authn })) return;
    if (authn && await connectorRoutes(req, res, { path: p, authn })) return;
    if (authn && await pluginDirectoryRoutes(req, res, { path: p, authn })) return;
    if (await mcpDirectoryRoutes(req, res, { path: p, authn })) return;
    if (authn && await webAddressRoutes(req, res, { path: p, authn })) return;
    if (authn && p.startsWith('/api/projects/') && await researchRoutes(req, res, { path: p, authn })) return;
    if (authn && p.startsWith('/api/projects/') && await codeRoutes(req, res, { path: p, authn })) return;
    if(p==='/api/profile/diary-connectors' && req.method==='GET')return json(res,200,{connectors:diaryConnectors.list(authn.user.id)});
    if(p==='/api/profile/diary-connectors' && req.method==='POST')return json(res,201,diaryConnectors.create(authn.user.id,(await readJson(req)).name));
    const revokeConnector=p.match(/^\/api\/profile\/diary-connectors\/([a-f0-9]{32})$/);
    if(revokeConnector && req.method==='DELETE')return json(res,200,{revoked:diaryConnectors.revoke(authn.user.id,revokeConnector[1])});
    // Opt-in asynchronous source processing; the synchronous API remains compatible.
    const sourceJob = p.match(/^\/api\/projects\/([^/]+)\/source-jobs\/([^/]+)$/);
    if (sourceJob && req.method === 'GET') {
      const projectId = decodeURIComponent(sourceJob[1]);
      if (!getProject(projectId)) return json(res, 404, { error: 'project not found' });
      const job = require('./source-jobs.cjs').read(currentWorkspace(), projectId, sourceJob[2]);
      return json(res, job ? 200 : 404, job || { error: 'Processing status expired or the server restarted; refresh or re-upload to retry.' });
    }
    const backgroundSource = p.match(/^\/api\/projects\/([^/]+)\/(upload|documents|sources\/sync)$/);
    if (backgroundSource && req.method === 'POST' && url.searchParams.get('background') === '1') {
      const projectId = decodeURIComponent(backgroundSource[1]);
      if (!getProject(projectId)) return json(res, 404, { error: 'project not found' });
      const body = JSON.parse(await readBody(req, Math.ceil((backgroundSource[2] === 'upload' ? require('./pdf-reduce.cjs').INPUT_CAP : DOCUMENT_UPLOAD_CAP) / 3) * 4 + 512 * 1024));
      const jobId = require('./source-jobs.cjs').start(currentWorkspace(), projectId, async (progress) => {
        const inner = require('node:stream').Readable.from([Buffer.from(JSON.stringify(body))]);
        Object.assign(inner, { method: req.method, url: p, headers: req.headers, socket: req.socket });
        let status = 500, data = '';
        await requestScope.run({ ...requestScope.getStore(), sourceProgress: progress }, () => handleRequestScoped(inner, { setHeader() {}, writeHead(code) { status = code; }, end(value) { data = String(value || '{}'); } }));
        return { status, body: JSON.parse(data) };
      });
      return json(res, 202, { poll: `/api/projects/${encodeURIComponent(projectId)}/source-jobs/${jobId}` });
    }
    if (p === '/api/auth/session' && req.method === 'GET') {
      const csrfCookie = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('cowork_csrf='));
      return json(res, 200, { user: authn.user, csrfToken: authn.legacy ? null : decodeURIComponent((csrfCookie || '').slice(12)), legacy: authn.legacy });
    }
    if (p === '/api/auth/logout' && req.method === 'POST') return authResult(res, authService.logout(req, res, authn));
    if (p.startsWith('/api/models/') && !['GET', 'HEAD'].includes(req.method || 'GET') && authn.user.role !== 'admin') {
      return json(res, 403, { error: 'administrator required' });
    }
    if (p === '/api/profile/appearance') {
      if(req.method==='GET')return json(res,200,authService.getAppearance(authn.user.id));
      if(req.method==='PUT') {
        const body=await readJson(req);
        try { return json(res,200,authService.setAppearance(authn.user.id,body)); }
        catch(error) { return json(res,400,{error:error.message}); }
      }
      return json(res,405,{error:'method not allowed'});
    }
    if (p === '/api/profile' && req.method === 'GET') return json(res, 200, { user: authn.user, passkeys: authService.listPasskeys(authn.user.id), sessions: authService.listSessions(authn.user.id) });
    if (p === '/api/profile/sharing' && req.method === 'GET') return json(res, 200, davSettings.get(authn.user));
    if (p === '/api/profile/sharing' && req.method === 'PUT') {
      try { return json(res, 200, davSettings.save(authn.user, await readJson(req))); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (p === '/api/profile/app-passwords' && req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store');
      return json(res, 200, { appPasswords: authService.appPasswords.list(authn.user.id), sharingAvailable: davConfig.available });
    }
    if (p === '/api/profile/app-passwords' && req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store');
      try { return json(res, 201, await authService.appPasswords.create(authn.user.id, await readJson(req))); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    const appPasswordRoute = p.match(/^\/api\/profile\/app-passwords\/([a-f0-9]{32})$/);
    if (appPasswordRoute && req.method === 'DELETE') {
      return json(res, authService.appPasswords.revoke(authn.user.id, appPasswordRoute[1]) ? 200 : 404, { ok: true });
    }
    if (p === '/api/profile' && req.method === 'PATCH') {
      const body = await readJson(req); authService.updateProfile(authn.user.id, body.displayName);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/profile/features' && req.method === 'PUT') {
      return json(res, 200, authService.setDiaryEnabled(authn.user.id, !!(await readJson(req)).diaryEnabled));
    }
    if (p === '/api/profile/onboarding' && req.method === 'POST') {
      return json(res, 200, authService.markOnboarded(authn.user.id));
    }
    if (p === '/api/integrations/storage' && req.method === 'GET') return json(res, 200, authService.getStorage(authn.user.id));
    // Browse/read over the user's own connected storage (project knowledge
    // intake; read-only). The saved connection's own credentials are used
    // server-side and never returned to the client.
    const storageBrowse = p.match(/^\/api\/integrations\/storage\/files(?:\/(.*))?$/);
    if (storageBrowse && req.method === 'GET') {
      const connection = authService.getStorage(authn.user.id, true);
      if (!storageClient.isBrowsable(connection)) return json(res, 400, { error: 'no browsable storage connected (local storage needs no browsing — upload files directly)' });
      // Defense in depth: also guard connections saved before the save-time
      // guard existed, and saved by an admin that has since been demoted.
      if (!(await storageEndpointAllowed(authn, connection.baseUrl))) return json(res, 400, { error: STORAGE_PRIVATE_URL_ERROR });
      try {
        const entries = await storageClient.listFiles(connection, decodeURIComponent(storageBrowse[1] || ''));
        return json(res, 200, { entries });
      } catch (e) {
        return json(res, 502, { error: e?.message || 'storage browse failed' });
      }
    }
    // Creating a directory is the one write this integration performs. It is
    // deliberately narrow: MKCOL only, no file writes, no overwrite, no delete.
    const storageMkdir = p.match(/^\/api\/integrations\/storage\/folder$/);
    if (storageMkdir && req.method === 'POST') {
      const body = await readJson(req);
      const connection = authService.getStorage(authn.user.id, true);
      if (!storageClient.isBrowsable(connection)) return json(res, 400, { error: 'no browsable storage connected' });
      if (!(await storageEndpointAllowed(authn, connection.baseUrl))) return json(res, 400, { error: STORAGE_PRIVATE_URL_ERROR });
      try {
        const made = await storageClient.createFolder(connection, body.path);
        return json(res, 200, made);
      } catch (e) {
        const status = e && e.status ? e.status : 502;
        return json(res, status, { error: e?.message || 'could not create folder' });
      }
    }

    const storageRead = p.match(/^\/api\/integrations\/storage\/file$/);
    if (storageRead && req.method === 'POST') {
      const body = await readJson(req);
      const connection = authService.getStorage(authn.user.id, true);
      if (!storageClient.isBrowsable(connection)) return json(res, 400, { error: 'no browsable storage connected' });
      if (!(await storageEndpointAllowed(authn, connection.baseUrl))) return json(res, 400, { error: STORAGE_PRIVATE_URL_ERROR });
      try {
        const file = await storageClient.readTextFile(connection, body.path);
        return json(res, 200, file);
      } catch (e) {
        const status = e && e.status ? e.status : 502;
        return json(res, status, { error: e?.message || 'storage read failed' });
      }
    }
    if (p === '/api/integrations/storage' && req.method === 'PUT') {
      const body = await readJson(req);
      if (body.kind !== 'local' && (!/^https?:\/\//.test(String(body.baseUrl || '')) || !body.username || !body.secret)) {
        return json(res, 400, { error: 'server URL, username, and app password are required' });
      }
      // This is the choke point: everything downstream (tests, browsing,
      // diary corpus sync to the sidecar) fetches the *saved* baseUrl.
      if (body.kind !== 'local' && !(await storageEndpointAllowed(authn, body.baseUrl))) {
        return json(res, 400, { error: STORAGE_PRIVATE_URL_ERROR });
      }
      return json(res, 200, authService.saveStorage(authn.user.id, body));
    }
    if (p === '/api/integrations/storage/test' && req.method === 'POST') {
      const body = await readJson(req);
      if (body.kind === 'local') return json(res, 200, { ok: true });
      const saved = body.useSaved ? authService.getStorage(authn.user.id, true) : body;
      if (saved.kind !== 'local' && !(await storageEndpointAllowed(authn, saved.baseUrl))) {
        return json(res, 400, { error: STORAGE_PRIVATE_URL_ERROR });
      }
      if (saved.kind === 's3') {
        // S3 probe: a signed bucket listing proves endpoint reachability,
        // bucket existence, and the credentials in one shot.
        try {
          const { signS3Request } = require('./s3-sign.cjs');
          const endpoint = String(saved.baseUrl || '').replace(/\/+$/, '');
          if (!/^https?:\/\//.test(endpoint)) return json(res, 400, { error: 'Endpoint URL must start with http:// or https://' });
          const bucket = String(saved.bucket || '').trim();
          if (!bucket) return json(res, 400, { error: 'Bucket is required' });
          const target = `${endpoint}/${encodeURIComponent(bucket)}?list-type=2&max-keys=1`;
          const signed = signS3Request('GET', new URL(target), '', saved.username || '', saved.secret || '');
          const response = await fetch(target, { headers: signed, signal: AbortSignal.timeout(10000), redirect: 'error' });
          if (response.ok) return json(res, 200, { ok: true });
          const detail = response.status === 403 ? ' — check the access key and secret'
            : response.status === 404 ? ' — no such bucket'
            : response.status === 400 ? ' — server rejected the request (unsupported endpoint?)' : '';
          return json(res, 502, { error: `S3 returned ${response.status}${detail}` });
        } catch (e) { return json(res, 502, { error: e.message }); }
      }
      try {
        const target = `${String(saved.baseUrl).replace(/\/+$/, '')}/${String(saved.corpusRoot || '').split('/').map(encodeURIComponent).join('/')}`;
        const response = await fetch(target, { method: 'PROPFIND', headers: { Authorization: `Basic ${Buffer.from(`${saved.username}:${saved.secret}`).toString('base64')}`, Depth: '0' }, signal: AbortSignal.timeout(10000), redirect: 'error' });
        return json(res, response.ok || response.status === 207 ? 200 : 502, response.ok || response.status === 207 ? { ok: true } : { error: `WebDAV returned ${response.status}` });
      } catch (e) { return json(res, 502, { error: e.message }); }
    }
    if (p === '/api/integrations/storage/nextcloud/start' && req.method === 'POST') {
      const baseUrl = String((await readJson(req)).baseUrl || '').replace(/\/+$/, '');
      if (!/^https:\/\//.test(baseUrl)) return json(res, 400, { error: 'HTTPS Nextcloud URL required' });
      if (!(await storageEndpointAllowed(authn, baseUrl))) return json(res, 400, { error: STORAGE_PRIVATE_URL_ERROR });
      try {
        const response = await fetch(`${baseUrl}/index.php/login/v2`, { method: 'POST', signal: AbortSignal.timeout(10000), redirect: 'error' });
        if (!response.ok) return json(res, 502, { error: `Nextcloud returned ${response.status}` });
        const payload = await response.json(); const flowId = crypto.randomUUID();
        for (const [id, flow] of nextcloudFlows) if (flow.expires < Date.now() || flow.userId === authn.user.id) nextcloudFlows.delete(id);
        if (nextcloudFlows.size >= 100) return json(res, 429, { error: 'Too many pending connections' });
        if (!endpointApproved(authn, payload.poll?.endpoint) || new URL(payload.login).protocol !== 'https:') return json(res, 400, { error: 'Invalid connection URLs' });
        nextcloudFlows.set(flowId, { userId: authn.user.id, endpoint: payload.poll.endpoint, token: payload.poll.token, expires: Date.now() + 10 * 60 * 1000 });
        return json(res, 200, { flowId, loginUrl: payload.login, expiresAt: Date.now() + 10 * 60 * 1000 });
      } catch (e) { return json(res, 502, { error: e.message }); }
    }
    if (p === '/api/integrations/storage/nextcloud/poll' && req.method === 'POST') {
      const body = await readJson(req); const flow = nextcloudFlows.get(String(body.flowId || ''));
      if (!flow || flow.userId !== authn.user.id || flow.expires < Date.now()) return json(res, 400, { error: 'login flow expired' });
      // The poll endpoint comes from the remote server's own response, so a
      // malicious Nextcloud could redirect it inward — guard it too.
      if (!(await storageEndpointAllowed(authn, flow.endpoint))) return json(res, 400, { error: STORAGE_PRIVATE_URL_ERROR });
      const response = await fetch(flow.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: flow.token }), signal: AbortSignal.timeout(10000), redirect: 'error' });
      if (response.status === 404) return json(res, 202, { pending: true });
      if (!response.ok) return json(res, 502, { error: `Nextcloud returned ${response.status}` });
      const credentials = await response.json(); nextcloudFlows.delete(String(body.flowId));
      const baseUrl = `${String(credentials.server).replace(/\/+$/, '')}/remote.php/dav/files/${encodeURIComponent(credentials.loginName)}`;
      if (!endpointApproved(authn, baseUrl)) return json(res, 403, { error: STORAGE_PRIVATE_URL_ERROR });
      return json(res, 200, authService.saveStorage(authn.user.id, { kind: 'nextcloud', baseUrl, username: credentials.loginName, secret: credentials.appPassword, corpusRoot: body.corpusRoot || 'Cowork/Diary' }));
    }
    if (p === '/api/auth/passkeys/register/options' && req.method === 'POST') return json(res, 200, await authService.registrationOptions(authn.user.id));
    if (p === '/api/auth/passkeys/register/verify' && req.method === 'POST') {
      try { return json(res, 200, await authService.registrationVerify(authn.user.id, await readJson(req))); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    const passkeyRoute = p.match(/^\/api\/auth\/passkeys\/([^/]+)$/);
    if (passkeyRoute && req.method === 'DELETE') return json(res, authService.deletePasskey(authn.user.id, decodeURIComponent(passkeyRoute[1])) ? 200 : 404, { ok: true });
    if (passkeyRoute && req.method === 'PATCH') {
      const ok = authService.renamePasskey(authn.user.id, decodeURIComponent(passkeyRoute[1]), (await readJson(req)).name);
      return json(res, ok ? 200 : 404, { ok });
    }
    const sessionRoute = p.match(/^\/api\/auth\/sessions\/([^/]+)$/);
    if (sessionRoute && req.method === 'DELETE') return json(res, authService.revokeSession(authn.user.id, decodeURIComponent(sessionRoute[1])) ? 200 : 404, { ok: true });
    if (p.startsWith('/api/admin/')) {
      if (authn.user.role !== 'admin') return json(res, 403, { error: 'administrator required' });
      if (p === '/api/admin/users' && req.method === 'GET') return json(res, 200, { users: authService.listUsers() });
      if (p === '/api/admin/invitations' && req.method === 'POST') return json(res, 201, authService.createInvite(authn.user.id, (await readJson(req)).role));
      const disabledRoute = p.match(/^\/api\/admin\/users\/([^/]+)\/disabled$/);
      if (disabledRoute && req.method === 'PUT') {
        try { return json(res, authService.setDisabled(authn.user.id, decodeURIComponent(disabledRoute[1]), !!(await readJson(req)).disabled) ? 200 : 404, { ok: true }); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      const recoveryRoute = p.match(/^\/api\/admin\/users\/([^/]+)\/recovery$/);
      if (recoveryRoute && req.method === 'POST') {
        const result = authService.createRecovery(authn.user.id, decodeURIComponent(recoveryRoute[1]));
        return json(res, result ? 201 : 404, result || { error: 'no such user' });
      }
      const userRoute = p.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (userRoute && req.method === 'DELETE') {
        try {
          const id = decodeURIComponent(userRoute[1]); const ok = authService.deleteUser(authn.user.id, id, (await readJson(req)).username);
          if (ok) {
            workspaceStore.remove(id);
            await driveAccounts.removeUser(id);
            const headers = { 'X-Cowork-User-ID': id };
            if (DIARY_TOKEN) headers.Authorization = `Bearer ${DIARY_TOKEN}`;
            await fetchJson(`${DIARY_BASE}/api/internal/tenant`, { method: 'DELETE', headers }, 15000).catch(() => null);
          }
          return json(res, ok ? 200 : 400, { ok });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      return json(res, 404, { error: 'not found' });
    }

    const approvalMatch = p.match(/^\/api\/tool-approvals\/([^/]+)$/);
    if (approvalMatch && req.method === 'POST') {
      const id = decodeURIComponent(approvalMatch[1]);
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'invalid JSON' }); }
      const pending = pendingApprovals.get(id);
      // Already decided, timed out, or never existed — all the same answer, so
      // a stale id cannot be used to probe which approvals are outstanding.
      if (!pending) return json(res, 404, { error: 'no such pending approval' });
      // The approval must come from the user whose conversation it is. Without
      // this, any signed-in member could approve another member's write.
      const userId = requestScope.getStore()?.workspace?.userId || null;
      if (!userId || pending.userId !== userId) return json(res, 404, { error: 'no such pending approval' });
      if (!pending.decide(String(body.decision || ''))) {
        return json(res, 400, { error: "decision must be 'approve', 'deny' or 'approve_all'" });
      }
      return json(res, 200, { ok: true });
    }

    if (await toolboxRoutes(req, res, { path: p, authn })) return;

    if (p === '/api/workspace') {
      try { sweepRetention(); } catch (e) { console.warn('[retention] sweep failed:', e?.message || e); }
      // PROJECTS is served raw everywhere else; here it crosses to the client,
      // so chats[] must be sanitized exactly as loadChats does.
      return json(res, 200, {
        projects: PROJECTS.filter(proj => !diaryExtras.internalProject(proj)).map((proj) => ({ ...proj, chats: sanitizeChats(proj.chats) })),
        freeChats: sanitizeChats(FREE_CHATS),
      });
    }

    // ── Provider registry (step 9): list / connect / remove. GET never returns
    // a saved apiKey in plaintext — masked, e.g. sk-…last4.
    if (p === '/api/providers' && req.method === 'GET') {
      return json(res, 200, {
        providers: PROVIDERS.map((pr) => ({
          id: pr.id,
          label: pr.label,
          baseUrl: pr.baseUrl,
          apiKeyMasked: maskKey(pr.apiKey),
          isDefault: pr.id === DEFAULT_PROVIDER_ID,
          managed: pr.id === DEFAULT_PROVIDER_ID && modelManager.enabled,
          shared: !!pr.shared,
          defaultModel: pr.defaultModel || undefined,
        })),
      });
    }
    if (p === '/api/providers' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      const label = String(body.label || '').trim().slice(0, 80);
      let baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
      const apiKey = String(body.apiKey || '').trim();
      const defaultModel = String(body.defaultModel || '').trim().slice(0, 200);
      const shared = body.shared === true;
      if (shared && authn.user.role !== 'admin') return json(res, 403, { error: 'administrator required for shared providers' });
      if (!label) return json(res, 400, { error: 'label required' });
      if (!/^https?:\/\//.test(baseUrl)) return json(res, 400, { error: 'baseUrl must be an http(s) URL' });
      // SSRF guard: a member must not register an endpoint the server can
      // only reach from its own internal network (RFC1918, metadata, etc.).
      // Admins are exempt — local-inference setups legitimately do this.
      if (!endpointApproved(authn, baseUrl)) {
        return json(res, 400, { error: 'Provider origin is not approved for member connections; contact an administrator.' });
      }
      const id = `prov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      PROVIDERS.push({ id, label, baseUrl, apiKey, defaultModel, shared });
      if (shared) saveSharedProviders(); else saveProviders();
      return json(res, 200, { id, label, baseUrl, defaultModel, apiKeyMasked: maskKey(apiKey) });
    }
    if (p === '/api/providers/test' && req.method === 'POST') {
      const body = await readJson(req);
      const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
      if (!/^https?:\/\//.test(baseUrl)) return json(res, 400, { error: 'valid baseUrl required' });
      // Same SSRF guard as registration: the test route must not become a
      // prober for internal addresses on behalf of a member.
      if (!endpointApproved(authn, baseUrl)) {
        return json(res, 400, { error: 'Provider origin is not approved for member connections; contact an administrator.' });
      }
      const headers = { 'Content-Type': 'application/json' };
      if (body.apiKey) headers.Authorization = `Bearer ${String(body.apiKey)}`;
      try {
        // redirect:'error' — same rationale as the storage client: a member-
        // registered endpoint must not bounce the request inward.
        const result = await fetchJson(`${baseUrl.replace(/\/v1$/, '')}/v1/models`, { headers, redirect: 'error' }, 8000);
        const models = Array.isArray(result.body?.data) ? result.body.data.map(m => m.id).filter(Boolean).slice(0, 100) : [];
        return json(res, result.ok ? 200 : 502, result.ok ? { ok: true, models } : { error: `provider returned ${result.status}` });
      } catch (e) { return json(res, 502, { error: e.message }); }
    }
    const provDel = p.match(/^\/api\/providers\/([^/]+)$/);
    if (provDel && req.method === 'DELETE') {
      const id = decodeURIComponent(provDel[1]);
      if (id === DEFAULT_PROVIDER_ID || id === 'lemonade') return json(res, 400, { error: 'the default provider cannot be removed' });
      const selectedProvider = Array.from(PROVIDERS).find(p => p.id === id);
      if (selectedProvider?.shared && authn.user.role !== 'admin') return json(res, 403, { error: 'administrator required' });
      if (!currentWorkspace().removeProvider(id)) return json(res, 404, { error: 'no such provider' });
      // Projects pointing at the removed provider fall back to the configured default.
      for (const pr of PROJECTS) {
        if (pr.provider === id) {
          delete pr.provider;
        }
      }
      saveProjects(PROJECTS);
      return json(res, 200, { ok: true });
    }

    // ── Optional model-manager statistics.
    if (p === '/api/stats') {
      const [gen, sys, mtpHealth, mtpMetrics, mtpModels] = await Promise.allSettled([
        modelManager.enabled ? modelManager.stats() : Promise.resolve({ ok: false }),
        modelManager.enabled ? modelManager.systemStats() : Promise.resolve({ ok: false }),
        modelManager.enabled ? modelManager.health() : Promise.resolve({ok:false}),
        modelManager.enabled ? modelManager.metrics() : Promise.resolve({ok:false}),
        modelManager.enabled ? modelManager.listModels() : Promise.resolve({ok:false}),
      ]);
      const g = gen.status === 'fulfilled' && gen.value.ok ? gen.value.body : {};
      const s = sys.status === 'fulfilled' && sys.value.ok ? sys.value.body : {};
      return json(res, 200, {
        up: gen.status === 'fulfilled' && gen.value.ok,
        telemetryScope: g.scope || null,
        mtp: modelManager.kind === 'llamacpp' ? (g.mtp || []) : require('./mtp.cjs').acceptance(mtpMetrics.status === 'fulfilled' && mtpMetrics.value.ok ? mtpMetrics.value.body : '', mtpHealth.status === 'fulfilled' && mtpHealth.value.ok ? mtpHealth.value.body.all_models_loaded : [], mtpModels.status === 'fulfilled' && mtpModels.value.ok ? mtpModels.value.body.data : [], currentWorkspace().userId),
        tokensPerSecond: reportedTokenRate(g),
        timeToFirstToken: typeof g.time_to_first_token === 'number' ? g.time_to_first_token : null,
        inputTokens: typeof g.input_tokens === 'number' ? g.input_tokens : null,
        outputTokens: typeof g.output_tokens === 'number' ? g.output_tokens : null,
        inputTokensTotal: typeof g.input_tokens_total === 'number' ? g.input_tokens_total : null,
        outputTokensTotal: typeof g.output_tokens_total === 'number' ? g.output_tokens_total : null,
        requestCount: typeof g.request_count_total === 'number' ? g.request_count_total : null,
        cpuPercent: typeof s.cpu_percent === 'number' ? s.cpu_percent : null,
        gpuPercent: typeof s.gpu_percent === 'number' ? s.gpu_percent : null,
        vramGb: typeof s.vram_gb === 'number' ? s.vram_gb : null,
        memoryGb: typeof s.memory_gb === 'number' ? s.memory_gb : null,
      });
    }

    // ── Projects CRUD ──
    if (authn && await usageRoutes(req, res, { path: p, authn })) return;
    const windowMatch=p.match(/^\/api\/chats\/([^/]+)\/context-window$/);
    if(windowMatch && req.method==='GET') return json(res,200,{meter:require('./chat-context.cjs').read(currentWorkspace().dir,decodeURIComponent(windowMatch[1])).meter||null});

    if (p === '/api/reasoning-settings') {
      const globalDefault = () => authService.db.prepare("SELECT value FROM settings WHERE key='reasoning_effort_default'").get()?.value || 'default';
      if (req.method === 'GET') {
        const project = url.searchParams.has('projectId') ? getProject(url.searchParams.get('projectId')) : null;
        if (url.searchParams.has('projectId') && !project) return json(res,404,{error:'no such project'});
        const effort = reasoningEffort.resolveEffort(project,globalDefault());
        const provider = getProvider(project?.provider || DEFAULT_PROVIDER_ID);
        return json(res,200,{default:globalDefault(),effort,mode:reasoningEffort.modeFor(provider,project?.model || '',effort),admin:authn.user.role === 'admin'});
      }
      if (req.method === 'PUT') {
        if (authn.user.role !== 'admin') return json(res,403,{error:'Administrator required'});
        let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res,400,{error:'invalid JSON'}); }
        if (!reasoningEffort.validEffort(body.default)) return json(res,400,{error:'default must be default, low or high'});
        authService.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('reasoning_effort_default',?)").run(body.default);
        authService.audit('reasoning.default',authn.user.id,null,{effort:body.default});
        return json(res,200,{default:body.default});
      }
      return json(res,405,{error:'Method not allowed'});
    }

    if (p === '/api/auto-roles') {
      if (req.method === 'GET') {
        const roles = autoRoles();
        return json(res, 200, { configured: !!roles, roles: roles || null, missing: missingRoles(roles, await servedCatalogue()) });
      }
      if (req.method === 'PUT') {
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return json(res, 400, { error: 'invalid JSON' });
        }
        const fast = typeof body.fast === 'string' ? body.fast.trim() : '';
        const smart = typeof body.smart === 'string' ? body.smart.trim() : '';
        const vision = typeof body.vision === 'string' ? body.vision.trim() : '';
        const code = typeof body.code === 'string' ? body.code.trim() : '';
        if (!fast || !smart) return json(res, 400, { error: 'both fast and smart model names are required' });
        setAutoRoles({ fast, smart, vision, code });
        ensureRolesLoaded(); // optional adapter warm-up; native routing stays on demand
        return json(res, 200, { configured: true, roles: autoRoles() });
      }
    }

    const freeContext = /^\/api\/chats\/([^/]+)\/context$/.exec(p);
    if (freeContext && ['GET', 'POST'].includes(req.method)) {
      const id = diaryExtras.chatProjectId(decodeURIComponent(freeContext[1]));
      if (!id) return json(res, 400, { error: 'Invalid chat identifier' });
      let project = getProject(id);
      if (!project && req.method === 'POST') {
        project = { ...diaryExtras.newProject(), id, name: 'Chat attachments ' + freeContext[1], instructions: '', toolboxes: [...DEFAULT_TOOLBOXES] };
        PROJECTS.push(project); saveProjects(PROJECTS);
      }
      return json(res, 200, { project });
    }

    if (p === '/api/diary/context' && ['GET', 'POST'].includes(req.method)) {
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      let project = getProject(diaryExtras.PROJECT_ID);
      if (!project && req.method === 'POST') {
        // Publish synchronously before awaiting storage to prevent duplicate contexts.
        project = diaryExtras.newProject();
        PROJECTS.push(project); saveProjects(PROJECTS);
      }
      return json(res, 200, { project });
    }

    if (p === '/api/projects' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      try { return json(res, 200, await createProject(body)); }
      catch (e) { if (e.status === 400) return json(res, 400, { error: e.message }); throw e; }
    }

    const projMatch = p.match(/^\/api\/projects\/([^/]+)$/);
    if (projMatch && req.method === 'DELETE') {
      const id = decodeURIComponent(projMatch[1]);
      const removedProject = getProject(id);
      const before = PROJECTS.length;
      const keptProjects = Array.from(PROJECTS).filter((pr) => pr.id !== id);
      PROJECTS.splice(0, PROJECTS.length, ...keptProjects);
      if (PROJECTS.length === before) return json(res, 404, { error: 'no such project' });
      if (removedProject) pruneDocuments(removedProject);
      saveProjects(PROJECTS);
      // Drop the project's RAG index too (best-effort).
      try {
        for (const suffix of ['.db', '.db-wal', '.db-shm']) {
          fs.rmSync(path.join(currentWorkspace().ragDir(), `${id}${suffix}`), { force: true });
        }
      } catch { /* best effort */ }
      if (removedProject) sweepDeletedProject(removedProject);
      return json(res, 200, { ok: true });
    }

    const skillRoute = p.match(/^\/api\/projects\/([^/]+)\/instruction-skills$/);
    if (skillRoute && ['GET', 'PUT'].includes(req.method)) {
      const project = getProject(decodeURIComponent(skillRoute[1]));
      if (!project) return json(res, 404, {error: 'No such project'});
      const skills = require('./instruction-skills.cjs');
      if (req.method === 'PUT') {
        try { skills.setSelection(project, await readJson(req)); }
        catch (err) { return json(res, err.status || 400, {error: err.message}); }
        project.updatedAt = Date.now();
        saveProjects(PROJECTS);
      }
      return json(res, 200, {skills: skills.list(project)});
    }

    // Plugins → Skills → Add to project: copy one published SKILL.md into the project. It lands
    // as "Review required" and stays off until the owner reviews and enables it.
    const skillInstall = p.match(/^\/api\/projects\/([^/]+)\/skills\/install$/);
    if (skillInstall && req.method === 'POST') {
      const project = getProject(decodeURIComponent(skillInstall[1]));
      if (!project) return json(res, 404, { error: 'no such project' });
      let body; try { body = await readJson(req); } catch { return json(res, 400, { error: 'invalid JSON' }); }
      let content;
      try { content = await require('./routes/plugin-directory.cjs').fetchPublishedSkill(body?.skill); } catch (e) { return json(res, e.status || 502, { error: e.message }); }
      const skills = require('./instruction-skills.cjs');
      const file = { name: `${body.skill}/SKILL.md`, content };
      const inspected = skills.inspect(file, project);
      if (!inspected?.valid) return json(res, 422, { error: `This skill cannot be used as a project skill: ${inspected?.error || 'no skill frontmatter'}` });
      const files = Array.isArray(project.files) ? project.files : [];
      if (files.filter((f) => !f.source).length >= 60 && !files.some((f) => f.name === file.name)) return json(res, 409, { error: 'This project already has the maximum of 60 files.' });
      project.files = [...files.filter((f) => f.name !== file.name), file];
      if (project.instructionSkills) delete project.instructionSkills[file.name]; // a replaced skill needs review again
      skills.reconcile(project);
      project.updatedAt = Date.now();
      currentWorkspace().saveProjects();
      return json(res, 201, { file: file.name, skills: skills.list(project).map(({ content: _c, ...rest }) => rest) });
    }
    const projCfg = p.match(/^\/api\/projects\/([^/]+)\/config$/);
    if (projCfg && req.method === 'POST') {
      const id = decodeURIComponent(projCfg[1]);
      const raw = await readBody(req);
      let patch;
      try {
        patch = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      const storedProject = getProject(id);
      if (!storedProject) return json(res, 404, { error: 'no such project' });
      let appearance;
      try { appearance = projectAppearance(patch); } catch (e) { return json(res, 400, { error: e.message }); }
      if (patch.reasoningEffort !== undefined && patch.reasoningEffort !== null && !reasoningEffort.validEffort(patch.reasoningEffort)) return json(res,400,{error:'Invalid reasoning effort'});
      const project = { ...storedProject, ...appearance };
      if (patch.reasoningEffort === null) delete project.reasoningEffort;
      else if (patch.reasoningEffort !== undefined) project.reasoningEffort = patch.reasoningEffort;
      if (typeof patch.name === 'string' && patch.name.trim()) project.name = patch.name.trim().slice(0, 120);
      if (typeof patch.goal === 'string') project.goal = patch.goal.slice(0, 2000);
      if (typeof patch.instructions === 'string') project.instructions = patch.instructions.slice(0, 8000);
      if (typeof patch.model === 'string' && patch.model) project.model = patch.model;
      // Pin and archive are plain booleans rather than a status enum: a project
      // can be both pinned and archived, and collapsing them would lose that.
      if (typeof patch.pinned === 'boolean') project.pinned = patch.pinned;
      if (Array.isArray(patch.sourceFolders)) {
        project.sourceFolders = patch.sourceFolders
          .filter((f) => typeof f === 'string' && f.trim())
          .map((f) => storageClient.safeRelativePath(f))
          .filter(Boolean)
          .slice(0, 10);
      }
      if (typeof patch.archived === 'boolean') project.archived = patch.archived;
      if (patch.modes !== undefined) {
        try { project.modes = require('./project-modes.cjs').sanitize(patch.modes); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (typeof patch.routing === 'string') {
        if (patch.routing !== 'auto' && patch.routing !== 'manual') {
          return json(res, 400, { error: "routing must be 'auto' or 'manual'" });
        }
        project.routing = patch.routing;
        if (patch.routing === 'auto') ensureRolesLoaded(); // no-op if unconfigured
      }
      if (typeof patch.provider === 'string' && patch.provider) {
        if (!getProvider(patch.provider)) return json(res, 400, { error: 'no such provider' });
        project.provider = patch.provider;
      }
      if (patch.toolboxes !== undefined) {
        const boxes = sanitizeToolboxes(patch.toolboxes);
        if (!boxes) return json(res, 400, { error: 'toolboxes must be an array of toolbox ids' });
        project.toolboxes = boxes;
      }
      if (Array.isArray(patch.memories)) {
        project.memories = patch.memories.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim().slice(0, 500)).slice(0, 50);
      }
      if (Array.isArray(patch.files)) {
        const prevFiles = Array.isArray(project.files) ? project.files : [];
        // Folder-derived files belong to the sync, not to this patch. The
        // client only ever sends uploads, and a patch that dropped the
        // folder-derived ones would silently detach every synced source (or,
        // if the client echoed them back with empty content, blank them).
        const fromFolders = prevFiles.filter((f) => f && f.source);
        const uploads = patch.files
          .filter((f) => f && typeof f.name === 'string' && typeof f.content === 'string' && !f.source)
          .slice(0, Math.max(0, 60 - fromFolders.length))
          .map((f) => {
            const existing = prevFiles.find(p => !p.source && p.name === f.name);
            return existing?.document || existing?.attachment ? existing : { name: f.name.slice(0, 200), content: f.content.slice(0, 200000) };
          });
        project.files = [...fromFolders, ...uploads];
        // RAG bookkeeping (step 10): drop chunks for removed files; index
        // new/changed ones. Fire-and-forget — upload latency must not depend
        // on embedding round-trips.
        const prevByName = new Map(prevFiles.map((f) => [f.name, f]));
        const nextNames = new Set(project.files.map((f) => f.name));
        project.assets = (project.assets || []).filter(a => !a.sourceName || nextNames.has(a.sourceName));
        for (const prev of prevFiles) {
          if (!nextNames.has(prev.name)) rag.deleteProjectFile(id, prev.name, currentWorkspace().userId);
        }
        for (const next of project.files) {
          const prev = prevByName.get(next.name);
          if (!prev || prev.content !== next.content) {
            indexSource(project, next);
          }
        }
      }
      project.updatedAt = Date.now();
      Object.assign(storedProject, project);
      saveProjects(PROJECTS);
      pruneDocuments(storedProject);
      return json(res, 200, { ok: true });
    }

    const projChats = p.match(/^\/api\/projects\/([^/]+)\/chats$/);
    if (projChats) {
      const id = decodeURIComponent(projChats[1]);
      if (req.method === 'GET') return json(res, 200, { chats: loadChats(id) });
      if (req.method === 'POST') {
        const raw = await readBody(req);
        try {
          const body = JSON.parse(raw);
          if (!Array.isArray(body.chats)) return json(res, 400, { error: 'chats array required' });
          saveChats(
            id,
            body.chats
              .filter((c) => c && typeof c.id === 'string')
              .slice(0, require('./chat-lists.cjs').LIST_CAP)
              .map((c) => ({
                id: c.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
                title: String(c.title || 'New task').slice(0, 120),
                updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : Date.now(),
                preview: String(c.preview || '').slice(0, 200),
                pinned: c.pinned === true,
                archived: c.archived === true,
              })),
          );
          return json(res, 200, { ok: true });
        } catch {
          return json(res, 400, { error: 'invalid JSON' });
        }
      }
    }

    // Re-read every attached storage folder and refresh the project's sources
    // from it. Folder-derived files carry `source`; uploaded ones do not, so a
    // sync replaces what came from folders and never touches an upload. This
    // is what makes an attached folder live rather than a one-time copy.
    // ── Image sources ────────────────────────────────────────────────────
    //
    // A project source is otherwise text, because that is all a chat could
    // ever read. Images are different: the model can genuinely see them, so
    // they are stored as bytes and attached to the conversation as image
    // parts rather than being decoded into replacement characters.
    // A document uploaded from disk. It is converted to text on arrival and
    // stored as an ordinary source, so everything downstream — RAG, the
    // read_project_file tool, the manifest — treats it like any other file.
    const projDocs = p.match(/^\/api\/projects\/([^/]+)\/documents$/);
    if (projDocs && req.method === 'POST') {
      const id = decodeURIComponent(projDocs[1]);
      const project = getProject(id);
      if (!project) return json(res, 404, { error: 'no such project' });
      let body;
      try {
        body = JSON.parse(await readBody(req, Math.ceil(DOCUMENT_UPLOAD_CAP / 3) * 4 + 512 * 1024));
      } catch (e) {
        if (e && e.status === 413) return json(res, 413, { error: `That document is larger than the ${Math.round(DOCUMENT_UPLOAD_CAP / (1024 * 1024))} MB limit.` });
        return json(res, 400, { error: 'invalid JSON' });
      }
      const name = String(body.name || '').slice(0, 200);
      if (!documents.isDocument(name)) return json(res, 400, { error: `${name || 'that file'} is not a supported document (PDF).` });
      let bytes;
      try { bytes = Buffer.from(String(body.dataBase64 || ''), 'base64'); } catch { bytes = null; }
      if (!bytes || !bytes.length) return json(res, 400, { error: 'document data was empty' });
      if (bytes.length > DOCUMENT_UPLOAD_CAP) {
        return json(res, 413, { error: `That document is ${Math.round(bytes.length / 1024 / 1024)} MB, over the ${Math.round(DOCUMENT_UPLOAD_CAP / (1024 * 1024))} MB limit.` });
      }
      return await withSourceLock(project, async () => {
        if (getProject(id) !== project) return json(res, 409, { error: 'Project changed; retry.' });
        const uploads = (project.files || []).filter(f => !f.source);
        if (uploads.length >= 20 && !uploads.some(f => f.name === name)) return json(res, 400, { error: 'A project holds at most 20 uploaded sources.' });
        const previous = uploads.find(f => f.name === name);
        const file = await documentSources.ingest(currentWorkspace(), id, name, bytes, previous);
        if (getProject(id) !== project || project.files.find(f => !f.source && f.name === name) !== previous) return json(res, 409, { error: 'Project changed; retry.' });
        project.files = [...(project.files || []).filter(f => f.source || f.name !== name), file];
        indexSource(project, file); saveProjects(PROJECTS);
        return json(res, 200, { name, pages: file.document.pages, characters: file.content.length, truncated: file.document.truncated, document: file.document });
      });
    }

    const docRead = p.match(/^\/api\/projects\/([^/]+)\/documents\/(pages|original)$/);
    if (docRead && req.method === 'GET') {
      const id = decodeURIComponent(docRead[1]);
      const project = getProject(id);
      const file = project?.files?.find(f => f.name === url.searchParams.get('name'));
      if (!file?.document) return json(res, 404, { error: 'no such document' });
      try {
        if (docRead[2] === 'pages') {
          const start = Number(url.searchParams.get('startPage') || 1);
          return json(res, 200, documentSources.readPages(currentWorkspace(), id, file, start,
            Number(url.searchParams.get('endPage') || start), Number(url.searchParams.get('offset') || 0)));
        }
        const bytes = documentSources.readOriginal(currentWorkspace(), id, file);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.name.split('/').pop()),
          'Content-Length': bytes.length, 'Cache-Control': 'private, no-store' });
        return res.end(bytes);
      } catch (err) { return json(res, err.status || 422, { error: err.status ? err.message : 'Saved document data is unavailable; upload or refresh again.' }); }
    }

    // Upload a file into the project's own folder. Text and PDFs both land as
    // real files in the user's storage; the sync that follows converts them
    // into sources, so there is exactly one path from a file to a source
    // regardless of whether it arrived from this machine or was dropped into
    // the folder from anywhere else.
    const projUpload = p.match(/^\/api\/projects\/([^/]+)\/upload$/);
    if (projUpload && req.method === 'POST') {
      const id = decodeURIComponent(projUpload[1]);
      const project = getProject(id);
      if (!project) return json(res, 404, { error: 'no such project' });
      let body;
      try {
        body = JSON.parse(await readBody(req, Math.ceil(require('./pdf-reduce.cjs').INPUT_CAP / 3) * 4 + 512 * 1024));
      } catch (e) {
        if (e && e.status === 413) return json(res, 413, { error: `That file is larger than the ${Math.round(DOCUMENT_UPLOAD_CAP / (1024 * 1024))} MB limit.` });
        return json(res, 400, { error: 'invalid JSON' });
      }
      const rawName = String(body.name || '').split('/').pop().slice(0, 200);
      if (!rawName) return json(res, 400, { error: 'a filename is required' });
      const isText = storageClient.TEXT_EXTENSIONS.has((rawName.slice(rawName.lastIndexOf('.')) || '').toLowerCase());
      if (body.organized === true) {
        const uploads = require('./uploads.cjs');
        const inputName = String(body.name || '');
        const inputBytes = Buffer.from(String(body.dataBase64 || ''), 'base64');
        // Validate the filename before contacting the document processor.
        uploads.validate(inputName, inputBytes.subarray(0,1));
        return await withSourceLock(project, async () => {
          if (getProject(id) !== project) return json(res, 409, { error: 'Project changed; retry.' });
          const connection = authService.getStorage(authn.user.id, true);
          const remote = storageClient.isBrowsable(connection) ? connection : null;
          const progress = requestScope.getStore()?.sourceProgress || (() => {});
          const {name,bytes,reduction} = await require('./pdf-reduce.cjs').prepare(inputName,inputBytes,{progress});
          uploads.validate(name,bytes);
          if (remote && !project.projectFolder) {
            progress('Creating upload folder');
            project.projectFolder = await ensureProjectFolder(project);
            if (!project.projectFolder) return json(res, 502, { error: 'Could not create the storage folder; retry.' });
          }
          const file = await uploads.ingest(currentWorkspace(), project, name, bytes, { connection: remote, progress });
          if(reduction){file.attachment.reduction=reduction;file.attachment.reason=[file.attachment.reason,reduction.note].filter(Boolean).join(' ');}
          if (getProject(id) !== project) return json(res, 409, { error: 'Project removed during upload.' });
          if (remote) project.sourceFolders = [...new Set([...(project.sourceFolders || []), project.projectFolder])];
          project.files = [...(project.files || []).filter(f => f.name !== file.name), file];
          project.updatedAt = Date.now();
          progress('Indexing extracted text');
          indexSource(project, file);
          saveProjects(PROJECTS);
          return json(res, 200, { name, path: file.name, bytes: bytes.length, document: file.document, attachment: file.attachment });
        });
      }
      if (!isText && !documents.isDocument(rawName)) {
        return json(res, 400, { error: `${rawName} is not a supported source (text file or PDF).` });
      }
      let bytes;
      try { bytes = Buffer.from(String(body.dataBase64 || ''), 'base64'); } catch { bytes = null; }
      if (!bytes || !bytes.length) return json(res, 400, { error: 'file was empty' });
      if (bytes.length > DOCUMENT_UPLOAD_CAP) return json(res, 413, { error: 'File exceeds the 25 MB limit.' });
      return await withSourceLock(project, async () => {
        if (getProject(id) !== project) return json(res, 409, { error: 'Project changed; retry.' });
        const connection = authService.getStorage(authn.user.id, true);
        if (!storageClient.isBrowsable(connection)) {
          // Remote storage is optional. Keep local uploads as project sources,
          // including PDF extraction, for installations without a cloud account.
          const uploads = (project.files || []).filter((f) => !f.source);
          if (uploads.length >= 20 && !uploads.some((f) => f.name === rawName)) {
            return json(res, 400, { error: 'A project holds at most 20 uploaded sources.' });
          }
          const previous = uploads.find(f => f.name === rawName);
          const file = documents.isDocument(rawName)
            ? await documentSources.ingest(currentWorkspace(), id, rawName, bytes, previous)
            : { name: rawName, content: bytes.toString('utf8').slice(0, 200000) };
          if (getProject(id) !== project || (project.files || []).find(f => !f.source && f.name === rawName) !== previous) return json(res, 409, { error: 'Source changed; retry.' });
          project.files = [...(project.files || []).filter(f => f.source || f.name !== rawName), file];
          project.updatedAt = Date.now();
          indexSource(project, file); saveProjects(PROJECTS);
          return json(res, 200, { name: rawName, path: rawName, bytes: bytes.length, document: file.document });
        }
        if (!project.projectFolder) {
          const folder = await ensureProjectFolder(project);
          if (!folder) return json(res, 502, { error: 'Could not create the project storage folder. Check your storage connection and retry.' });
          project.projectFolder = folder;
        }
        project.sourceFolders = [...new Set([...(project.sourceFolders || []), project.projectFolder])];
        saveProjects(PROJECTS);
        try {
          await storageClient.writeFile(connection, `${project.projectFolder}/${rawName}`, bytes);
        } catch (e) {
          return json(res, (e && e.status) || 502, { error: (e && e.message) || 'could not save the file' });
        }
        let file;
        if (documents.isDocument(rawName)) {
          const name = `${project.projectFolder}/${rawName}`;
          const previous = project.files.find(f => f.name === name && f.source === project.projectFolder);
          file = await documentSources.ingest(currentWorkspace(), id, name, bytes, previous);
          file.source = project.projectFolder;
          if (getProject(id) !== project || !project.sourceFolders.includes(file.source)) return json(res, 409, { error: 'Source changed; refresh again.' });
          project.files = [...project.files.filter(f => f.name !== name || f.source !== file.source), file];
          indexSource(project, file); saveProjects(PROJECTS);
        }
        return json(res, 200, { name: rawName, path: `${project.projectFolder}/${rawName}`, bytes: bytes.length, document: file?.document });
      });
    }

    // Delete one source file from the project's folder. This removes the file
    // from the user's storage, not merely from the project, so it is confined
    // to the project's OWN folder: a source pulled from a folder the user
    // attached for reading must never be deletable from here.
    const projFileDel = p.match(/^\/api\/projects\/([^/]+)\/files$/);
    if (projFileDel && req.method === 'DELETE') {
      const id = decodeURIComponent(projFileDel[1]);
      const project = getProject(id);
      if (!project) return json(res, 404, { error: 'no such project' });
      const body = await readJson(req);
      const target = String(body.path || '');
      if (!target) return json(res, 400, { error: 'a path is required' });
      if (!ownsFile(project, target)) {
        return json(res, 400, { error: 'That file is not in any folder attached to this project, so it cannot be deleted from here.' });
      }
      return await withSourceLock(project, async () => {
        if (getProject(id) !== project || !ownsFile(project, target)) return json(res, 409, { error: 'Source changed; retry.' });
        const connection = authService.getStorage(authn.user.id, true);
        if (!storageClient.isBrowsable(connection)) return json(res, 400, { error: 'no browsable storage connected' });
        try {
          await storageClient.deleteFile(connection, target);
        } catch (e) {
          return json(res, (e && e.status) || 502, { error: (e && e.message) || 'could not delete the file' });
        }
        project.files = (project.files || []).filter((f) => f.name !== target);
        pruneDocuments(project);
        require('./uploads.cjs').prune(currentWorkspace(), project);
        saveProjects(PROJECTS);
        rag.deleteProjectFile(id, target, currentWorkspace().userId);
        return json(res, 200, { ok: true, path: target });
      });
    }

    const originalUpload = p.match(/^\/api\/projects\/([^/]+)\/uploads\/original$/);
    if (originalUpload && req.method === 'GET') {
      const project = getProject(decodeURIComponent(originalUpload[1]));
      const file = project?.files.find(f => f.name === url.searchParams.get('name') && f.attachment);
      if (!file) return json(res, 404, { error: 'No such original' });
      const bytes = fs.readFileSync(require('./uploads.cjs').original(currentWorkspace(), project.id, file));
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name.split('/').pop())}`, 'Cache-Control': 'private, no-store', 'Content-Length': bytes.length });
      return res.end(bytes);
    }

    const projAssets = p.match(/^\/api\/projects\/([^/]+)\/assets$/);
    if (projAssets && req.method === 'POST') {
      const id = decodeURIComponent(projAssets[1]);
      const project = getProject(id);
      if (!project) return json(res, 404, { error: 'no such project' });
      let body;
      try {
        // Images do not fit the 1 MB default that text sources live under.
        body = JSON.parse(await readBody(req, Math.ceil(IMAGE_UPLOAD_CAP / 3) * 4 + 512 * 1024));
      } catch (e) {
        if (e && e.status === 413) return json(res, 413, { error: `That image is larger than the ${Math.round(IMAGE_UPLOAD_CAP / (1024 * 1024))} MB limit.` });
        return json(res, 400, { error: 'invalid JSON' });
      }
      const name = String(body.name || '').slice(0, 200);
      const mime = String(body.mime || '').toLowerCase();
      if (!IMAGE_MIME.has(mime)) {
        return json(res, 400, { error: `${mime || 'that file'} is not a supported image (png, jpeg, webp or gif).` });
      }
      let bytes;
      try {
        bytes = Buffer.from(String(body.dataBase64 || ''), 'base64');
      } catch {
        return json(res, 400, { error: 'image data was not valid base64' });
      }
      if (!bytes.length) return json(res, 400, { error: 'image data was empty' });
      if (bytes.length > IMAGE_UPLOAD_CAP) {
        return json(res, 413, { error: `That image is ${Math.round(bytes.length / 1024)} KB, over the ${Math.round(IMAGE_UPLOAD_CAP / (1024 * 1024))} MB limit.` });
      }
      const assets = Array.isArray(project.assets) ? project.assets : [];
      if (assets.length >= MAX_PROJECT_IMAGES) {
        return json(res, 400, { error: `A project holds at most ${MAX_PROJECT_IMAGES} images.` });
      }
      const assetId = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const dir = currentWorkspace().assetDir(id);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, assetId), bytes, { mode: 0o600 });
      project.assets = [...assets, { id: assetId, name, mime, bytes: bytes.length }];
      saveProjects(PROJECTS);
      return json(res, 200, { asset: { id: assetId, name, mime, bytes: bytes.length } });
    }

    const projAssetOne = p.match(/^\/api\/projects\/([^/]+)\/assets\/([^/]+)$/);
    if (projAssetOne) {
      const id = decodeURIComponent(projAssetOne[1]);
      const assetId = decodeURIComponent(projAssetOne[2]).replace(/[^a-zA-Z0-9_-]/g, '');
      const project = getProject(id);
      if (!project) return json(res, 404, { error: 'no such project' });
      const asset = (project.assets || []).find((a) => a.id === assetId);
      if (!asset) return json(res, 404, { error: 'no such image' });
      const file = path.join(currentWorkspace().assetDir(id), assetId);
      if (req.method === 'GET') {
        let bytes;
        try { bytes = fs.readFileSync(file); } catch { return json(res, 404, { error: 'image data is missing' }); }
        res.writeHead(200, {
          'Content-Type': asset.mime,
          'Content-Length': bytes.length,
          'Cache-Control': 'private, max-age=86400',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(bytes);
      }
      if (req.method === 'DELETE') {
        project.assets = (project.assets || []).filter((a) => a.id !== assetId);
        saveProjects(PROJECTS);
        try { fs.unlinkSync(file); } catch { /* already gone */ }
        return json(res, 200, { ok: true });
      }
    }

    const projSync = p.match(/^\/api\/projects\/([^/]+)\/sources\/sync$/);
    if (projSync && req.method === 'POST') {
      const id = decodeURIComponent(projSync[1]);
      const project = getProject(id);
      if (!project) return json(res, 404, { error: 'no such project' });
      return await withSourceLock(project, async () => {
        if (getProject(id) !== project) return json(res, 409, { error: 'Project changed; retry.' });
        const connection = authService.getStorage(authn.user.id, true);
        const fromFolders = [];
        const sourceLimit = Math.max(0, 60 - (project.files || []).filter(f => !f.source).length);
        const skipped = [];
        if (storageClient.isBrowsable(connection) && (project.assets || []).some(a => !a.sourceName)) {
          if (!project.projectFolder) project.projectFolder = await ensureProjectFolder(project);
          if (project.projectFolder) {
            for (const asset of [...(project.assets || [])].filter(a => !a.sourceName)) {
              try {
                const bytes = fs.readFileSync(path.join(currentWorkspace().assetDir(id), asset.id));
                // A stable suffix prevents overwriting a file already placed there outside noevia.
                const dot = asset.name.lastIndexOf('.');
                const name = dot > 0 ? `${asset.name.slice(0,dot)}-${asset.id}${asset.name.slice(dot)}` : `${asset.name}-${asset.id}`;
                const file = await require('./uploads.cjs').ingest(currentWorkspace(), project, name, bytes, { connection, progress: requestScope.getStore()?.sourceProgress });
                project.files = [...(project.files || []).filter(f => f.name !== file.name), file];
                project.assets = project.assets.filter(a => a.id !== asset.id);
                project.sourceFolders = [...new Set([...(project.sourceFolders || []), project.projectFolder])];
                saveProjects(PROJECTS);
              } catch (err) { skipped.push({ folder: project.projectFolder, file: asset.name, reason: 'Image remains in noevia: ' + err.message, retained: true }); }
            }
          }
        }
        const folders = Array.isArray(project.sourceFolders) ? project.sourceFolders : [];
        if (folders.length && !storageClient.isBrowsable(connection)) return json(res, 400, { error: 'no browsable storage connection is configured' });

        for (const folder of folders) {
          let entries;
          try {
            entries = await storageClient.listFiles(connection, folder);
          } catch (e) {
            const reason = e?.message || 'could not list folder';
            const previous = (project.files || []).filter(f => f.source === folder);
            fromFolders.push(...previous.map(f => documents.isDocument(f.name) ? { ...documentSources.failed(f, f.name, reason), source: folder } : f));
            skipped.push({ folder, reason, retained: previous.some(f => !!f.content) });
            continue;
          }
          if (folder === project.projectFolder) {
            for (const entry of [...entries]) {
              if (entry.isDir && require('./uploads.cjs').GROUPS.includes(entry.name)) {
                try { entries.push(...await storageClient.listFiles(connection, entry.path)); }
                catch (err) { fromFolders.push(...(project.files || []).filter(f => f.source === folder && f.name.startsWith(entry.path + '/'))); skipped.push({ folder, file: entry.path, reason: 'Could not refresh this category; previous sources retained.', retained: true }); }
              }
            }
          }
          for (const entry of entries) {
            if (entry.isDir) continue; // one level: recursing could pull a whole drive in
            const ext = (entry.ext || '').toLowerCase();
            const isText = storageClient.TEXT_EXTENSIONS.has(ext);
            const isDoc = documents.isDocument(entry.name);
            const isDocx = /\.docx$/i.test(entry.name);
            const managed = folder === project.projectFolder && require('./uploads.cjs').GROUPS.some(g => entry.path.startsWith(`${folder}/${g}/`));
            if (!isText && !isDoc && !isDocx && !managed) continue;
            if (fromFolders.length >= sourceLimit) { skipped.push({ folder, file: entry.path, reason: '60-source project limit reached; this file was not read.', retained: false }); continue; } // a cap, so one big folder cannot blow up a project
            try {
              if (managed || isDocx) {
                const bytes = await storageClient.readBinaryFile(connection, entry.path);
                const file = await require('./uploads.cjs').ingest(currentWorkspace(), project, entry.name, bytes, { source: folder, remotePath: entry.path, progress: requestScope.getStore()?.sourceProgress });
                fromFolders.push(file);
                if (file.document && file.document.state !== 'ready') skipped.push({ folder, file: entry.path, reason: documentSources.problem(file), retained: file.document.stale });
              } else if (isDoc) {
                // A document is converted to text here, so a PDF in an attached
                // folder becomes a readable source rather than being skipped.
                const bytes = await storageClient.readBinaryFile(connection, entry.path);
                const previous = (project.files || []).find(f => f.source === folder && f.name === entry.path);
                const file = await documentSources.ingest(currentWorkspace(), id, entry.path, bytes, previous);
                fromFolders.push({ ...file, source: folder });
                if (file.document.state !== 'ready') skipped.push({ folder, file: entry.path, reason: documentSources.problem(file), retained: file.document.stale });
              } else {
                const file = await storageClient.readTextFile(connection, entry.path);
                fromFolders.push({ name: entry.path, content: file.content, source: folder });
              }
            } catch (e) {
              const previous = (project.files || []).find((f) => f.source === folder && f.name === entry.path);
              const reason = e?.message || 'could not read';
              if (isDoc) fromFolders.push({ ...documentSources.failed(previous, entry.path, reason), source: folder });
              else if (previous) fromFolders.push(previous);
              skipped.push({ folder, file: entry.path, reason, retained: !!previous?.content });
            }
          }
        }
        if (getProject(id) !== project) return json(res, 409, { error: 'Project changed; retry.' });
        const prev = Array.isArray(project.files) ? project.files : [];
        // An upload or folder edit may have completed while storage was being
        // read. Preserve current uploads and never reattach a detached folder.
        const currentFolders = new Set(project.sourceFolders || []);
        const uploaded = prev.filter((f) => !f.source);
        const untouched = prev.filter((f) => f.source && currentFolders.has(f.source) && !folders.includes(f.source));
        const synced = fromFolders.filter((f) => currentFolders.has(f.source));
        project.files = [...uploaded, ...untouched, ...synced].slice(0, 60);
        require('./uploads.cjs').prune(currentWorkspace(), project);
        saveProjects(PROJECTS);
        // Same RAG bookkeeping the config patch does: drop chunks for files that
        // are gone, re-index the ones that arrived or changed.
        const prevByName = new Map(prev.map((f) => [f.name, f]));
        const nextNames = new Set(project.files.map((f) => f.name));
        for (const old of prev) {
          if (!nextNames.has(old.name)) rag.deleteProjectFile(id, old.name, currentWorkspace().userId);
        }
        for (const next of project.files) {
          const before = prevByName.get(next.name);
          if (!before || before.content !== next.content || (next.document && ['pending', 'failed', 'unavailable', 'partial'].includes(next.document.indexing))) {
            indexSource(project, next);
          }
        }
        return json(res, 200, {
          files: project.files.map((f) => ({ name: f.name, source: f.source || null, bytes: f.content.length, document: f.document })),
          skipped,
        });
      });
    }

    const chatDel = p.match(/^\/api\/projects\/([^/]+)\/chats\/([^/]+)$/);
    if (chatDel && req.method === 'DELETE') {
      const projectId = decodeURIComponent(chatDel[1]);
      const chatId = decodeURIComponent(chatDel[2]);
      const removed = deleteChat(projectId, chatId);
      return json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'no such chat' });
    }

    // ── Free-chat metas (server-side so they survive browser switches) ──
    if (p === '/api/freechats') {
      if (req.method === 'GET') return json(res, 200, { chats: FREE_CHATS });
      if (req.method === 'POST') {
        const raw = await readBody(req);
        try {
          const body = JSON.parse(raw);
          if (!Array.isArray(body.chats)) return json(res, 400, { error: 'chats array required' });
          const nextFreeChats = body.chats
            .filter((c) => c && typeof c.id === 'string')
            .slice(0, require('./chat-lists.cjs').LIST_CAP)
            .map((c) => ({
              id: c.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
              title: String(c.title || 'New chat').slice(0, 120),
              updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : Date.now(),
              preview: String(c.preview || '').slice(0, 200),
              pinned: c.pinned === true,
              archived: c.archived === true,
            }));
          const lists = require('./chat-lists.cjs');
          FREE_CHATS.splice(0, FREE_CHATS.length, ...lists.mergeChats(Array.from(FREE_CHATS), nextFreeChats, lists.readTombstones(currentWorkspace().dir)));
          saveFreeChats(FREE_CHATS);
          return json(res, 200, { ok: true });
        } catch {
          return json(res, 400, { error: 'invalid JSON' });
        }
      }
    }

    const freeDel = p.match(/^\/api\/freechats\/([^/]+)$/);
    if (freeDel && req.method === 'DELETE') {
      const removed = deleteFreeChat(decodeURIComponent(freeDel[1]));
      return json(res, removed ? 200 : 404, removed ? { ok: true } : { error: 'no such chat' });
    }

    if (p === '/api/health') {
      const defaultProvider = getProvider(DEFAULT_PROVIDER_ID);
      const diaryEnabled = authService.diaryEnabled(authn.user.id);
      const [inference, diary] = await Promise.allSettled([
        fetchJson(`${defaultProvider.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/models`, { headers: providerHeaders(defaultProvider) }, 5000),
        diaryEnabled ? fetchJson(`${DIARY_BASE}/api/health`, { headers: diaryHeaders() }, 5000) : Promise.resolve({ ok: false }),
      ]);
      return json(res, 200, {
        inferenceUp: inference.status === 'fulfilled' && inference.value.ok,
        lemonadeUp: inference.status === 'fulfilled' && inference.value.ok,
        diaryUp: diaryEnabled ? diary.status === 'fulfilled' && diary.value.ok : null,
        // True when project-file retrieval can run (native deps present).
        // False means RAG is silently degraded to keyword-only context.
        ragAvailable: rag.ragAvailable(),
      });
    }

    // A change to the models anywhere else (load, unload, download, delete) also invalidates the scan.
    if (p.startsWith('/api/models/') && !['GET','HEAD','OPTIONS'].includes(req.method || 'GET')) modelScanCache.clear();
    // Model manager (folded-in Model Loader) JSON API, administrators only.
    if (p.startsWith('/api/model-manager/')) {
      if(authn.user.role!=='admin')return json(res,403,{error:'Administrator required for model management'});
      if(!process.env.MODEL_LOADER_URL)return json(res,404,{error:'Model management service is not configured'});
      const rest=p.slice('/api/model-manager/'.length);
      if(!/^[\w./%:+@-]*$/.test(rest)||rest.includes('..'))return json(res,400,{error:'Invalid path'});
      const method=req.method||'GET';
      const body=['GET','HEAD','DELETE'].includes(method)?undefined:await readBody(req,1024*1024);
      // The file scan reads every model header from disk (~2 s on daserver). Serve the last scan at
      // once and refresh it behind the response; any change through this API drops it.
      if(method!=='GET')modelScanCache.clear();
      if(method==='GET'&&rest==='models'&&!url.search){
        const hit=modelScanCache.get('models');
        if(hit){res.setHeader('Cache-Control','no-store');res.setHeader('X-Model-Scan','cached');if(Date.now()-hit.at>5000)refreshModelScan();return json(res,200,hit.body);}
      }
      const result=await fetchJson(`${process.env.MODEL_LOADER_URL.replace(/\/+$/,'')}/api/v1/${rest}${url.search}`,{method,headers:{'Content-Type':'application/json',...(process.env.MODEL_LOADER_TOKEN?{'X-Model-Loader-Token':process.env.MODEL_LOADER_TOKEN}:{})},body},10*60*1000).catch(()=>null);
      res.setHeader('Cache-Control','no-store');
      if(!result)return json(res,502,{error:'The model management service is not responding.'});
      const detail=result.body&&typeof result.body==='object'?result.body:{error:String(result.body||'')};
      // A finished benchmark run viewed in the manager becomes throughput evidence (best-effort, throttled).
      if(result.ok&&method==='GET'&&/^benchmark\/runs\/\d+$/.test(rest)&&modelManager.recordEvidence){
        for(const {model,record} of require('./benchmark-evidence.cjs').throughputRecords(detail))modelManager.recordEvidence(model,record).catch(()=>undefined);
      }
      if(result.ok&&method==='GET'&&rest==='models'&&!url.search)modelScanCache.set('models',{at:Date.now(),body:detail});
      return json(res,result.status,result.ok?detail:{error:detail.detail||detail.error||'Model management request failed.'});
    }

    if (p === '/api/models/presets/reload') {
      if(authn.user.role!=='admin')return json(res,403,{error:'Administrator required for shared model profiles'});
      if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
      if(!modelManager.reloadPresets)return json(res,404,{error:'This engine does not use a preset file'});
      try { const result=await modelManager.reloadPresets({unload:(await readJson(req))?.unload===true}); return json(res,result.status,result.body); }
      catch(e){ return json(res,e.status||500,{error:e.status===409?'Requests are in progress. Try again when chats finish.':e.message}); }
    }

    if (p === '/api/models/evidence' && req.method === 'GET') {
      if (!modelManager.evidence) return json(res, 404, { error: 'Qualification evidence needs the native engine' });
      const model = url.searchParams.get('model') || '';
      if (!model || model.length > 200) return json(res, 400, { error: 'Choose a model' });
      const result = await modelManager.evidence(model);
      res.setHeader('Cache-Control', 'no-store');
      return json(res, result.status, result.body);
    }

    // Re-run the cheap image probe for one model and record the result. It may load the model.
    if (p === '/api/models/evidence/recheck') {
      if(authn.user.role!=='admin')return json(res,403,{error:'Administrator required for shared model evidence'});
      if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});
      if(!modelManager.recordEvidence)return json(res,404,{error:'Qualification evidence needs the native engine'});
      const body=await readJson(req).catch(()=>null);
      const model=typeof body?.model==='string'?body.model:'';
      if(!model||model.length>200)return json(res,400,{error:'Choose a model'});
      if(body.category!=='vision')return json(res,400,{error:'Only image input can be rechecked here; use Measure context for context capacity.'});
      const provider=getProvider(DEFAULT_PROVIDER_ID);
      const vision=await createVisionProbe()(provider.baseUrl,providerHeaders(provider),model);
      if(!vision.supported&&!/projector|mmproj/i.test(vision.reason||''))return json(res,503,{error:vision.reason||'The engine could not run the image probe.'});
      await modelManager.recordEvidence(model,{category:'vision',result:vision.supported?'passed':'failed',value:null,suite:{name:'vision-probe',version:1},source:'recheck',limitations:vision.supported?['1×1 image accepted; not an accuracy test']:[String(vision.reason||'').slice(0,200)]});
      return json(res,200,(await modelManager.evidence(model)).body);
    }

    if (p === '/api/models/autotune' || p === '/api/models/autotune/cancel') {
      if(authn.user.role!=='admin')return json(res,403,{error:'Administrator required for shared model profiles'});
      if(!modelManager.autotune)return json(res,404,{error:'Auto-tune is unavailable'});
      let result;
      if(p.endsWith('/cancel')){if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});result=modelManager.autotune.cancel();}
      else if(req.method==='GET')result=modelManager.autotune.status(url.searchParams.get('model')||'');
      else if(req.method==='POST'){const body=await readJson(req);result=await modelManager.autotune.start(String(body?.model||''),{confirmPause:body?.confirmPause,promptBudgetSeconds:body?.promptBudgetSeconds,extendContext:body?.extendContext,resume:body?.resume});}
      else return json(res,405,{error:'Method not allowed'});
      res.setHeader('Cache-Control','no-store');
      return json(res,result.status,result.body);
    }
    if (p === '/api/models/calibration' || p === '/api/models/calibration/cancel') {
      if(authn.user.role!=='admin')return json(res,403,{error:'Administrator required for shared model profiles'});
      if(!modelManager.calibration)return json(res,404,{error:'Native calibration is unavailable'});
      let result;
      if(p.endsWith('/cancel')){if(req.method!=='POST')return json(res,405,{error:'Method not allowed'});result=modelManager.calibration.cancel();}
      else if(req.method==='GET')result=modelManager.calibration.status(url.searchParams.get('model')||'');
      else if(req.method==='POST'){const body=await readJson(req);result=await modelManager.calibration.start(String(body?.model||''),{promptBudgetSeconds:body?.promptBudgetSeconds,confirmPause:body?.confirmPause});}
      else return json(res,405,{error:'Method not allowed'});
      res.setHeader('Cache-Control','no-store');
      return json(res,result.status,result.body);
    }

    if (p === '/api/models/preset/suggest') {
      if(authn.user.role!=='admin')return json(res,403,{error:'Administrator required for shared model profiles'});
      if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
      if(!modelManager.suggestPreset)return json(res,404,{error:'Native preset suggestions are unavailable'});
      const result=await modelManager.suggestPreset(url.searchParams.get('model') || '');
      return json(res,result.status,result.body);
    }

    if (p === '/api/models/preset') {
      if(authn.user.role!=='admin')return json(res,403,{error:'Administrator required for shared model profiles'});
      if(!modelManager.getPreset)return json(res,404,{error:'Native presets are unavailable'});
      if(!['GET','PUT'].includes(req.method))return json(res,405,{error:'Method not allowed'});
      const result=req.method==='GET' ? await modelManager.getPreset(url.searchParams.get('model') || '') : await modelManager.applyPreset(await readJson(req));
      return json(res,result.status,result.body);
    }

    if (p === '/api/models/capabilities' && req.method === 'GET') {
      return json(res,200,{kind:modelManager.kind,enabled:modelManager.enabled,admin:authn.user.role==='admin',...modelManager.capabilities,modelManagement:!!process.env.MODEL_LOADER_URL&&authn.user.role==='admin'});
    }

    if (p === '/api/models/hardware') {
      if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
      if(!modelManager.enabled)return json(res,404,{error:'Model manager is disabled. Enter a memory plan manually.'});
      try {
        const result=await modelManager.systemInfo();
        if(!result.ok)return json(res,502,{error:'Inference hardware is unavailable. Enter a memory plan manually or retry.'});
        return json(res,200,require('./model-hardware.cjs').modelHardware(result.body));
      } catch { return json(res,502,{error:'Could not read inference hardware. Enter a memory plan manually or retry.'}); }
    }

    if (p === '/api/models/installed') {
      try {
        return json(res, 200, await modelsInstalled());
      } catch (err) {
        return json(res, 502, { error: String(err.message || err) });
      }
    }

    if (p === '/api/models/mtp-artifact' && req.method === 'GET') {
      const repo = url.searchParams.get('repo') || '';
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return json(res,400,{error:'Invalid repository'});
      const result = await modelManager.variants(repo);
      if (!result.ok) return json(res,502,{error:'Could not resolve selected files'});
      const variant = (result.body?.variants || []).find(v=>v.name === url.searchParams.get('variant'));
      if (!variant) return json(res,404,{error:'Variant no longer available'});
      return json(res,200,await require('./mtp-artifact.cjs').check(repo,variant.files || [variant.primary_file]));
    }

    if (p === '/api/models/pull' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      if (!body.checkpoint) return json(res, 400, { error: 'checkpoint required' });
      if (!modelManager.enabled) return json(res, 404, { error: 'model management is disabled' });
      const modelName = body.modelName || deriveUserModelName(body.checkpoint);
      const r = await modelManager.pull({ modelName, checkpoint: body.checkpoint, recipe: body.recipe || 'llamacpp' });
      return json(
        res,
        r.ok ? 200 : 502,
        r.ok ? { jobId: r.body?.id || r.body?.job_id || 'pull', modelName: r.body?.modelName || modelName } : { error: r.body?.error || `pull failed: ${r.status}` },
      );
    }

    if (p === '/api/models/delete' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      if (!body.name) return json(res, 400, { error: 'name required' });
      if (!modelManager.enabled) return json(res, 404, { error: 'model management is disabled' });
      const r = await modelManager.deleteModel(body.name);
      return json(res, r.ok ? 200 : 502, r.ok ? { ok: true } : { error: `delete failed: ${r.status}` });
    }

    for (const verb of ['load', 'unload']) {
      if (p === `/api/models/${verb}` && req.method === 'POST') {
        const raw = await readBody(req);
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return json(res, 400, { error: 'invalid JSON' });
        }
        if (!body.name) return json(res, 400, { error: 'name required' });
        if (!modelManager.enabled) return json(res, 404, { error: 'model management is disabled' });
        if (verb === 'load' && body.mtp !== undefined && modelManager.kind === 'llamacpp') return json(res,400,{error:'Use the native preset editor to configure speculative decoding.'});
        if (verb === 'load' && body.mtp !== undefined) {
          const listing = await modelManager.listModels();
          if (!listing.ok) return json(res,502,{error:'Could not verify MTP support'});
          const model = (listing.body.data || []).find(m=>(m.id || m.model_name)===body.name);
          if (!model) return json(res,404,{error:'Model not installed'});
          let options;
          try { options = require('./mtp.cjs').loadOptions(model,body.mtp); }
          catch(error) { return json(res,400,{error:error.message}); }
          const loaded = await modelManager.load(body.name,options);
          if (!loaded.ok) return json(res,502,{error:'Model could not load with that MTP setting. Previous saved settings were kept.'});
          const saved = await modelManager.load(body.name,{...options,save_options:true});
          return json(res,saved.ok?200:502,saved.ok?{ok:true}:{error:'Model loaded, but its MTP preference could not be saved. Check before reloading.'});
        }
        const r = await modelManager[verb](body.name);
        return json(res, r.ok ? 200 : 502, r.ok ? { ok: true } : { error: `${verb} failed: ${r.status}` });
      }
    }

    if (p === '/api/models/downloads') {
      if (!modelManager.enabled) return json(res, 200, []);
      const r = await modelManager.downloads();
      if (!r.ok) return json(res, 502, {error:'Download status unavailable'});
      const arr = Array.isArray(r.body) ? r.body : r.body?.jobs || r.body?.downloads || [];
      // Lemonade reports `percent` as 0-100; the UI expects a 0-1 fraction.
      return json(res, 200, arr.map((j) => ({
        id: j.id || j.job_id || '',
        model: j.model_name || j.model || j.checkpoint || '',
        progress: typeof j.percent === 'number' ? j.percent / 100 : typeof j.progress === 'number' ? j.progress : null,
        status: j.status || j.state || '',
      })));
    }

    if(p==='/api/diary/exchanges' && req.method==='GET') {
      if(!authService.diaryEnabled(authn.user.id))return json(res,404,{error:'Diary add-on is disabled'});
      try{return json(res,200,{exchanges:require('./diary-jobs.cjs').list(currentWorkspace(),url.searchParams.get('day'))});}
      catch(e){return json(res,e.status||500,{error:e.status?e.message:'Could not read recovery records'});}
    }

    if (p === '/api/diary/workspace-trash') {
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { error: 'Method not allowed' });
      const body = req.method === 'POST' ? await readBody(req, 4096) : undefined;
      const query = req.method === 'GET' ? '?after=' + encodeURIComponent(url.searchParams.get('after') || '') : '';
      const r = await fetchJson(`${DIARY_BASE}/api/workspace-trash${query}`, { method: req.method, headers: diaryHeaders(), body }, 60000);
      res.setHeader('Cache-Control', 'no-store');
      return json(res, r.status, r.ok ? r.body : { error: r.body?.detail || 'Diary recovery request failed. Retry or refresh Trash.' });
    }

    if (p === '/api/diary/workspace-import') {
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });
      return require('./workspace-import.cjs').proxyWorkspaceImport(req, res, `${DIARY_BASE}/api/workspace-import${url.search}`, diaryHeaders());
    }

    if (p === '/api/diary/workspace-export') {
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
      return require('./workspace-export.cjs').proxyWorkspaceExport(res, `${DIARY_BASE}/api/workspace-export`, diaryHeaders());
    }

    if (['/api/diary/storage-status', '/api/diary/storage-import'].includes(p)) {
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      const status = p.endsWith('storage-status');
      if (req.method !== (status ? 'GET' : 'POST')) return json(res, 405, { error: 'Method not allowed' });
      const body = status ? undefined : await readBody(req, 4096);
      const r = await fetchJson(`${DIARY_BASE}/api/${status ? 'storage-status' : 'storage-import'}`, { method: req.method, headers: diaryHeaders(), body }, status ? 60000 : 300000);
      return json(res, r.status, r.ok ? r.body : { error: r.body?.detail || 'Diary storage request failed' });
    }

    if (['/api/diary/files', '/api/diary/file', '/api/diary/local-exchange'].includes(p)) {
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      const local = p.endsWith('/local-exchange');
      const listing = p.endsWith('/files');
      if (!(listing ? req.method === 'GET' : local ? req.method === 'POST' : ['POST', 'PUT'].includes(req.method))) return json(res, 405, { error: 'Method not allowed' });
      if (local && llmRateLimited(authn.user.id)) return json(res, 429, { error: 'Please wait before sending another message' });
      const body = listing ? undefined : await readBody(req, local ? 16 * 1024 * 1024 : 1024 * 1024);
      const suffix = listing ? '/files?path=' + encodeURIComponent(url.searchParams.get('path') || '') : local ? '/local-exchange' : '/file';
      if (local && JSON.parse(body).stream === true) {
        return require('./diary-stream.cjs').proxyDiaryStream(res, `${DIARY_BASE}/api${suffix}`, {
          method:'POST', headers:diaryHeaders(), body,
        }, {onEvent:event=>{if(event.type==='mtp')require('./mtp.cjs').record(authn.user.id,event.model,event.timings);}});
      }
      const r = await fetchJson(`${DIARY_BASE}/api${suffix}`, { method: req.method, headers: diaryHeaders(), body }, local ? 600000 : 60000);
      return json(res, r.status, r.ok ? r.body : { error: r.body?.detail || r.body?.error || 'Diary storage request failed' });
    }

    if (p === '/api/diary/source') {
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      const months = await corpusSource.listMonths();
      return json(res, 200, { source: corpusSource.name, months });
    }

    if (p === '/api/diary/today' || p === '/api/diary/history') {
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      const monthId = url.searchParams.get('month');
      const data = await corpusSource.readMonth(monthId);
      return json(res, 200, data);
    }

    if (p === '/api/diary/external-sources') {
      if (authn.user.role !== 'admin') return json(res, 403, { error: 'Administrator required for server import folders' });
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      const r = await fetchJson(`${DIARY_BASE}/api/external-sources`, { headers: diaryHeaders() }, 30000);
      if (!r.ok) return json(res, r.status >= 500 ? 502 : r.status, { error: `diary sidecar ${r.status}` });
      return json(res, 200, r.body);
    }

    if (p === '/api/diary/external-sources/import' && req.method === 'POST') {
      if (authn.user.role !== 'admin') return json(res, 403, { error: 'Administrator required for server import folders' });
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      if (!body || typeof body.sourcePath !== 'string' || typeof body.relPath !== 'string') {
        return json(res, 400, { error: 'sourcePath and relPath required' });
      }
      const r = await fetchJson(
        `${DIARY_BASE}/api/external-sources/import`,
        { method: 'POST', headers: diaryHeaders(), body: JSON.stringify({ source_path: body.sourcePath, rel_path: body.relPath }) },
        60000,
      );
      if (!r.ok) {
        const detail = r.body?.detail || `diary sidecar ${r.status}`;
        return json(res, r.status >= 500 ? 502 : r.status, { error: String(detail) });
      }
      return json(res, 200, r.body);
    }

    if (p === '/api/diary/entries/edit' && req.method === 'POST') {
      // Diary integrity guarantee: editing past entries is an explicit,
      // human-initiated correction routed to the sidecar's guarded, journaled
      // edit endpoint. The assistant never rewrites the user's own words on
      // its own; the xid identifies exactly one logged exchange.
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      if (!body || typeof body.xid !== 'string' || typeof body.me !== 'string' || (body.assistant !== undefined && typeof body.assistant !== 'string')) {
        return json(res, 400, { error: 'xid and me required' });
      }
      const r = await fetchJson(
        `${DIARY_BASE}/api/entries/edit`,
        { method: 'POST', headers: diaryHeaders(), body: JSON.stringify({ xid: body.xid, me: body.me, assistant: body.assistant || '', month: body.month || null }) },
        60000,
      );
      if (!r.ok) {
        const detail = r.body?.detail || r.body?.error || `diary sidecar ${r.status}`;
        return json(res, r.status >= 500 ? 502 : r.status, { error: String(detail) });
      }
      return json(res, 200, r.body);
    }

    if (await chatRoutes(req, res, { path: p, authn })) return;

    // Unused legacy spaces endpoints removed with the spaces UI (v4).

    const historyMatch = p.match(/^\/api\/chats\/([^/]+)\/history$/);
    if (historyMatch) {
      const spaceId = decodeURIComponent(historyMatch[1]);
      const revisionOf = (history) => crypto.createHash('sha256').update(JSON.stringify(history)).digest('hex');
      if (req.method === 'GET') { const history = readHistory(spaceId); return json(res, 200, { history, revision: revisionOf(history) }); }
      if (req.method === 'POST') {
        // A reply that finishes after its chat was deleted must not write the transcript back.
        if (require('./chat-lists.cjs').readTombstones(currentWorkspace().dir).has(spaceId)) return json(res, 410, { error: 'This chat was deleted.' });
        let raw;
        try { raw = await readBody(req, STORED_HISTORY_BYTES); }
        catch (e) { return json(res, e.status || 400, { error: e.status === 413 ? 'This chat is too large to save; start a new chat to keep going.' : 'could not read the chat' }); }
        try {
          const body = JSON.parse(raw);
          // Optimistic concurrency: a save based on an older copy (another device saved meanwhile)
          // gets the current copy back to merge. Saves without a base revision are accepted as before.
          if (typeof body.baseRevision === 'string') {
            const current = readHistory(spaceId);
            const revision = revisionOf(current);
            if (body.baseRevision !== revision) return json(res, 409, { error: 'This chat changed on another device.', history: current, revision });
          }
          const next = Array.isArray(body.history) ? body.history.slice(-STORED_HISTORY_CAP) : [];
          writeHistory(spaceId, next);
          return json(res, 200, { ok: true, revision: revisionOf(next) });
        } catch {
          return json(res, 400, { error: 'invalid JSON' });
        }
      }
    }

    // Static files with SPA fallback.
    const found = staticFiles.resolve(p);
    if (found && found.forbidden) return json(res, 403, { error: 'forbidden' });
    if (!found && !SPAFallbacks.includes(p)) return json(res, 404, { error: 'not found' });
    try {
      return staticFiles.send(req, res, found ? found.filePath : path.join(DIST_DIR, 'index.html'), found ? p : '/');
    } catch {
      if (!res.headersSent) return json(res, 500, { error: 'read error' });
      return res.end();
    }
  } catch (err) {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) {
      res.end(`data: ${JSON.stringify({ type: 'error', text: 'The request could not be completed. Please retry.' })}\n\n`);
    } else json(res, err.status || 500, { error: String((err && err.message) || err) });
  }
}

async function handleRequest(req,res) {
  const pathname=new URL(req.url,'http://localhost').pathname;
  const inference=req.method!=='GET' && (pathname==='/api/chat' || pathname.startsWith('/api/diary/'));
  let leave;
  try {if(inference && modelManager.enterInference)leave=modelManager.enterInference();}
  catch(error){return json(res,error.status||503,{error:error.message});}
  if(leave){res.once('finish',leave);res.once('close',leave);}
  try {return await handleRequestInner(req,res);}finally{if(leave && (res.writableEnded||res.destroyed))leave();}
}

if (require.main === module) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!UI_AUTH_TOKEN) {
    console.warn('WARNING: Set DIARY_AUTH_TOKEN to protect the internal diary connection. Browser accounts remain authenticated.');
  }
  const server = http.createServer((req, res) => { handleRequest(req, res).catch(() => { if (!res.destroyed) res.destroy(); }); });
  staticFiles.warm();
  // A chat waiting on a write approval is a legitimately long request. Node's
  // default requestTimeout is 5 minutes measured from the START of the request,
  // so a reply that spent two minutes generating would leave only three for the
  // human — and the connection would be cut mid-decision. Raised to 20 minutes,
  // comfortably past APPROVAL_TIMEOUT_MS, which is the limit that should
  // actually bite. headersTimeout still guards the slow-header attack this
  // setting otherwise protects against.
  if (davConfig.available) {
    const call = async (userId, endpoint, method, body) => {
      const workspace = workspaceStore.get(userId);
      const user = authService.publicUser(authService.db.prepare('SELECT * FROM users WHERE id=?').get(userId));
      return requestScope.run({ workspace, authn: { user, legacy: false } }, async () => {
        const r = await fetchJson(`${DIARY_BASE}/api${endpoint}`, { method, headers: diaryHeaders(), body: body === undefined ? undefined : JSON.stringify(body) }, 15000);
        if (!r.ok) throw Object.assign(Error(r.body?.detail || 'Diary file request failed'), { status: r.status });
        return r.body;
      });
    };
    const handler = require('./dav.cjs').createDavHandler({ auth: authService, settings: davSettings, config: davConfig, files: {
      list: async (id, path) => (await call(id, '/files?path='+encodeURIComponent(path), 'GET')).files,
      read: (id, path) => call(id, '/file', 'POST', { path }),
      write: (id, body) => call(id, '/file', 'PUT', body),
      mkdir: (id, path) => call(id, '/directory', 'POST', { path }),
      ops: (id, body) => call(id, '/workspace-ops', 'POST', body),
    } });
    const davServer = http.createServer((req, res) => { handler(req, res).catch(() => res.destroy()); });
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
        const r = await fetchJson(`${DIARY_BASE}/api${endpoint}`, { headers: diaryHeaders() }, 15000);
        if (!r.ok) throw new Error(String(r.body?.detail || r.body?.error || `diary sidecar ${r.status}`));
        return r.body || {};
      },
      ...(features.enabled('diaryMcpWrite') ? { diaryAppend: async ({ text, title, timezone }) => {
        const userId = requestScope.getStore()?.workspace?.userId;
        if (!userId || !authService.diaryEnabled(userId)) throw new Error('the Diary add-on is not enabled for this account');
        const body = { text, title, requestId: crypto.randomUUID(), entryTime: require('./mcp-internal-tools.cjs').isoWithOffset(new Date(), timezone) };
        const r = await fetchJson(`${DIARY_BASE}/api/entries/append`, { method: 'POST', headers: diaryHeaders(), body: JSON.stringify(body) }, 30000);
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
    run: user => requestScope.run({ workspace: workspaceStore.get(user.id), authn: { user, legacy: false } }, async () => {
      await fetchJson(`${DIARY_BASE}/api/storage-backup`, { method: 'POST', headers: diaryHeaders() }, 300000);
    }),
  });
  server.requestTimeout = 20 * 60 * 1000;
  server.listen(PORT, HOST, () => {
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

module.exports = { handleRequest, sanitizeChats, MCP_SERVERS, toolboxOffered, ownsFile, projectFolderName, prefill, TOOL_PREFILL_TARGET_MS, isWriteTool, chatWideApproved, pendingApprovals, resolveTools, allToolboxes, mcpCredentialOriginAllowed, toolTokenBudgetFor, MCP_TOOLBOX_MANIFEST, toolboxSummaries, estimateToolTokens, toolCapFor, sanitizeToolboxes, executeToolCall, TOOLBOXES, classifierVerdict, heuristicWantsSmart, heuristicWantsCode, CLASSIFIER_MAX_TOKENS, recordUsage, recordToolUse, readUsage, usageDayKey, USAGE_RETENTION_DAYS };
