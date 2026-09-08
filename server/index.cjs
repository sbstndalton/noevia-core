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

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { AsyncLocalStorage } = require('async_hooks');
const rag = require('./rag.cjs');
const mcp = require('./mcp.cjs');
const storageClient = require('./storage-client.cjs');
const { createModelManager } = require('./model-manager.cjs');
const { createAuth, createRateLimiter } = require('./auth.cjs');
const { createWorkspaceStore, atomicJson } = require('./workspace.cjs');
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
const HISTORY_CAP = 40;
const SPAFallbacks = ['/', '/chat', '/diary', '/projects', '/settings'];
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
if (process.env.LEMONADE_BASE_URL && !process.env.INFERENCE_BASE_URL) console.warn('LEMONADE_BASE_URL is deprecated; use INFERENCE_BASE_URL');
if (process.env.LEMONADE_API_KEY && !process.env.INFERENCE_API_KEY) console.warn('LEMONADE_API_KEY is deprecated; use INFERENCE_API_KEY');
const workspaceStore = createWorkspaceStore(DATA_DIR, { id: DEFAULT_PROVIDER_ID, label: DEFAULT_PROVIDER_LABEL, baseUrl: INFERENCE_BASE, apiKey: INFERENCE_KEY, shared: true }, secretStore);

// Per-user throttle for LLM-backed routes. Every hit is a full model call
// against the shared inference endpoint, so one member (or a runaway client)
// must not be able to hog it. Fixed window, shared bucket across chat and
// diary conversations. Admins are throttled like everyone else. Raise
// LLM_RATE_LIMIT for a beefier inference host.
const LLM_RATE_ROUTES = new Set(['/api/chat']);
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
rag.init({ dataDir: DATA_DIR, inferenceUrl: INFERENCE_BASE, headersFn: () => inferenceHeaders(), userDataDirFn: workspaceStore.userDir });

// User-created projects; the earlier fixed demo spaces were removed.
// spaces were deleted per user request — projects are user-created only.
// Each project: goal/description, custom instructions,
// and text files (pasted/uploaded text injected into context; true doc-RAG is a
// later feature — flagged in MIGRATION.md).

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function clientToken(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return String(req.headers['x-cowork-token'] || req.headers['x-diary-token'] || '').trim();
}

function checkAuth(req) {
  return !!authService.authenticate(req);
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

const modelManager = createModelManager({
  kind: MODEL_MANAGER_KIND,
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
      throw Object.assign(new Error(STORAGE_PRIVATE_URL_ERROR), { status: 403 });
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

function loadProjects() {
  return currentWorkspace().projects;
}

function saveProjects(projects) {
  currentWorkspace().projects = Array.from(projects);
  currentWorkspace().saveProjects();
}

const PROJECTS = arrayProxy('projects');

function getProject(id) {
  return PROJECTS.find((p) => p.id === id) || null;
}

// ── Provider registry (step 9): generic OpenAI-compatible endpoints ────────
// One adapter covers all of them (same /chat/completions shape). Projects
// without a provider field use the environment-configured default provider.
function loadProviders() {
  return currentWorkspace().providers;
}

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

function migrateLegacyProviderIds() {
  let changedProviders = false;
  let changedProjects = false;
  for (const provider of PROVIDERS) {
    if (provider.id === 'lemonade') {
      provider.id = DEFAULT_PROVIDER_ID;
      provider.label = DEFAULT_PROVIDER_LABEL;
      changedProviders = true;
    }
  }
  if (changedProviders) {
    const seen = new Set();
    const filtered = Array.from(PROVIDERS).filter((provider) => {
      if (seen.has(provider.id)) return false;
      seen.add(provider.id);
      return true;
    });
    PROVIDERS.splice(0, PROVIDERS.length, ...filtered);
  }
  for (const project of PROJECTS) {
    if (project.provider === 'lemonade') {
      project.provider = DEFAULT_PROVIDER_ID;
      changedProjects = true;
    }
  }
  if (changedProviders) {
    backupOnce('providers.json');
    const renamed = Array.from(PROVIDERS).filter((p) => p.id === DEFAULT_PROVIDER_ID);
    if (renamed.some((p) => p.shared)) saveSharedProviders();
    if (renamed.some((p) => !p.shared)) saveProviders();
  }
  if (changedProjects) {
    backupOnce('projects.json');
    saveProjects(PROJECTS);
  }
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
// Each meta: { id, title, updatedAt } — the title is the first user message.
function loadChats(projectId) {
  const p = getProject(projectId);
  if (!p) return [];
  // Self-heal orphaned placeholder entries: a bare chat-id string (or any
  // non-object) can land in chats[] if the follow-up POST /chats never fires
  // (tab closed mid-send). Skip them here; the next saveChats drops them.
  return (p.chats || []).filter((c) => c && typeof c === 'object' && typeof c.id === 'string');
}

function saveChats(projectId, chats) {
  const p = getProject(projectId);
  if (!p) return;
  p.chats = chats.slice(0, 200);
  saveProjects(PROJECTS);
}

function deleteChat(projectId, chatId) {
  const p = getProject(projectId);
  if (!p) return false;
  const before = (p.chats || []).length;
  p.chats = (p.chats || []).filter((c) => c.id !== chatId);
  if (p.chats.length === before) return false;
  saveProjects(PROJECTS);
  try {
    fs.unlinkSync(currentWorkspace().historyPath(chatId));
  } catch {
    /* no history file — fine */
  }
  return true;
}

// Free (non-project) chat metas — persisted server-side so recent chats
// survive across browsers/devices (localStorage was the only home before).
function loadFreeChats() {
  return currentWorkspace().freeChats;
}

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
  saveFreeChats(FREE_CHATS);
  try {
    fs.unlinkSync(currentWorkspace().historyPath(chatId));
  } catch {
    /* no history file — fine */
  }
  return true;
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

// ── Usage accounting ──────────────────────────────────────────────────────
// Daily rollup buckets rather than a per-reply log: the dashboard only ever
// asks day-level questions (totals, a heat map, active days, per-model split),
// and a bucket file is bounded — one small record per day, capped at a year —
// where an append-only log on a self-hosted box grows until someone notices.
// Per-message detail is not lost; it already lives in each chat's history.
const USAGE_RETENTION_DAYS = 365;

// Local civil date, not UTC: "today" on the dashboard should mean the
// operator's today, and an evening request must not land in tomorrow's bucket.
function usageDayKey(at = new Date()) {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, '0');
  const d = String(at.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function readUsage(workspace) {
  try {
    const parsed = JSON.parse(fs.readFileSync(workspace.usagePath(), 'utf8'));
    return parsed && typeof parsed.days === 'object' && parsed.days ? parsed : { days: {} };
  } catch {
    return { days: {} };
  }
}

// Called once per completed reply, from the point the provider reports its
// usage chunk. Recording here rather than from the browser means the numbers
// survive a client that navigated away mid-reply, and cannot be shaped by
// anything the client sends.
function recordUsage(workspace, model, usage) {
  if (!workspace || !usage) return;
  const input = Number(usage.promptTokens) || 0;
  const output = Number(usage.completionTokens) || 0;
  if (!input && !output) return;
  try {
    const store = readUsage(workspace);
    const key = usageDayKey();
    const day = store.days[key] || { input: 0, output: 0, replies: 0, models: {} };
    day.input += input;
    day.output += output;
    day.replies += 1;
    const name = String(model || 'unknown');
    const perModel = day.models[name] || { input: 0, output: 0, replies: 0 };
    perModel.input += input;
    perModel.output += output;
    perModel.replies += 1;
    day.models[name] = perModel;
    store.days[key] = day;
    // Drop anything past the window on write, so the file cannot creep upward
    // even on a deployment that runs for years.
    const cutoff = usageDayKey(new Date(Date.now() - USAGE_RETENTION_DAYS * 86400000));
    for (const k of Object.keys(store.days)) if (k < cutoff) delete store.days[k];
    atomicJson(workspace.usagePath(), store);
  } catch (err) {
    // Accounting must never break a reply that already succeeded.
    console.warn('[usage] could not record:', err?.message || err);
  }
}

// ── Auto model router (feature doc Item 4 / master step 12) ───────────────
// Roles are config, never hardcoded model names: role→model mapping lives in
// ui/server/auto-roles.json (created on first use; never ships a default
// model string). Auto mode keeps BOTH role models loaded — no unload/swap.
function autoRoles() {
  return currentWorkspace().autoRoles;
}

function setAutoRoles(next) {
  currentWorkspace().autoRoles = { fast: String(next.fast), smart: String(next.smart) };
  currentWorkspace().saveAutoRoles();
}

async function ensureModelLoaded(name) {
  const installed = await modelsInstalled();
  const m = installed.find((x) => x.name === name);
  if (!m) throw new Error(`model not installed: ${name}`);
  if (!m.loaded) {
    await modelManager.load(name);
  }
}

function ensureRolesLoaded() {
  const roles = autoRoles();
  if (!roles) return;
  void (async () => {
    for (const role of ['fast', 'smart']) {
      try {
        await ensureModelLoaded(roles[role]);
      } catch (err) {
        console.warn(`[router] could not load ${role} model (${roles[role]}):`, err?.message || err);
      }
    }
  })();
}

// ── Built-in tools (Pi-style JSON-Schema schema, master step 13) ──────────
// Two safe built-ins to start. The schema follows the OpenAI-compatible
// function-calling format every provider speaks (and pi-ai uses TypeBox to
// produce exactly this shape). Results return to the model as role:'tool'
// messages keyed by tool_call_id — the wire form of pi's toolResult.
const CORE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description:
        'Get the current date and time on the server, optionally in a specific IANA timezone (e.g. Europe/Berlin). Use whenever freshness, "today", or a timezone matters.',
      parameters: {
        type: 'object',
        properties: { timezone: { type: 'string', description: 'Optional IANA timezone name' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_project_file',
      description:
        'Read the full content of a knowledge file attached to this project, by exact file name. Use when a retrieved excerpt is not enough.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Exact file name, e.g. notes.md' } },
        required: ['name'],
      },
    },
  },
];

const TOOL_RESULT_CAP = 8000; // chars — protect the context window

// ── Toolboxes (master step 14) ────────────────────────────────────────────
// Tools are no longer one flat global list. A *toolbox* is a named, selectable
// set; a project picks which boxes it wants and the active list is resolved
// per request. The seam exists so MCP-sourced tools can arrive as further
// boxes without the chat loop changing shape — but it already earns its keep:
// on the target hardware (a 9B model at ~14 tok/s) the catalogue is a real
// per-turn cost paid on every message, not a rounding error.
const TOOLBOXES = [
  {
    id: 'core',
    label: 'Core',
    description: 'Always-safe built-ins: the server clock, and full reads of this project\'s knowledge files.',
    source: 'builtin',
    tools: CORE_TOOLS,
  },
];

const DEFAULT_TOOLBOXES = ['core'];

// Built-ins plus whatever MCP discovery found. Everything downstream — the
// picker, the validator, the resolver — goes through here so an MCP box is
// indistinguishable from a built-in one once it exists.
function allToolboxes() {
  return [...TOOLBOXES, ...mcpState.boxes];
}

// A tool definition is re-sent on EVERY turn, so its size is a recurring cost
// and the count is the budget that matters.
//
// The naive ~4 chars/token rule badly undercounts here, because the provider
// does not put the JSON on the wire as-is: llama.cpp's chat template re-renders
// every tool into its own scaffolding before the model ever sees it. Measured
// against the live endpoint on 2026-09-08 with Qwen3.5-9B — the identical
// message cost 456 prompt tokens with the core box and 70 without it, so the
// two core tools really cost 386, against a naive estimate of 180. Hence the
// calibration factor, which is deliberately tuned to the heavier template:
// the same box on Gemma-4-E4B cost only 232 prompt tokens for the whole
// request, so the real factor is template-dependent and this one is closer to
// a worst case than an average. Treat the output as an order-of-magnitude hint
// — it is labelled "~" in the UI — but an estimate that is 2x LOW is worse
// than useless when the point is deciding what a 14 tok/s box can afford, and
// erring high fails safe.
const TOOL_TOKEN_CALIBRATION = 2.1;
function estimateToolTokens(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return 0; // no tools, no cost
  return Math.round((JSON.stringify(tools).length / 4) * TOOL_TOKEN_CALIBRATION);
}

// How many tools a model can be handed before the catalogue crowds out the
// conversation. This is a hardware/capability question, not a "what does this
// work need" question — which is precisely why box *selection* is per-project
// and only the cap looks at the model.
const TOOL_CAP_DEFAULT = 24;
const TOOL_CAP_SMALL = 12;

// A COUNT cap alone is the wrong unit, which only became clear once real MCP
// tools arrived. Measured against the reference server: nc_calendar_create_event
// is 7,355 chars (~3,900 calibrated tokens) while nc_notes_search_notes is 449.
// "12 tools" therefore describes anything between ~250 and ~47,000 tokens of
// prompt. The count cap still guards against overwhelming a small model with
// too many CHOICES; this budget guards the context window, which is the
// constraint that actually bites at ~14 tok/s. Both apply, whichever binds first.
const TOOL_TOKEN_BUDGET_DEFAULT = 8000;
const TOOL_TOKEN_BUDGET_SMALL = 3000;
function toolTokenBudgetFor(model) {
  const m = /(\d+(?:\.\d+)?)\s*[bB]\b/.exec(String(model || ''));
  if (m && Number(m[1]) <= 12) return TOOL_TOKEN_BUDGET_SMALL;
  return TOOL_TOKEN_BUDGET_DEFAULT;
}
function toolCapFor(model) {
  // Parameter count in the model id (…-9B-…, …-4b-it…) is the only signal
  // available here, and local GGUF names carry it by convention. An
  // unrecognised name gets the roomier default: wrongly withholding tools is
  // a worse failure than sending a few more than ideal.
  const m = /(\d+(?:\.\d+)?)\s*[bB]\b/.exec(String(model || ''));
  if (m && Number(m[1]) <= 12) return TOOL_CAP_SMALL;
  return TOOL_CAP_DEFAULT;
}

// Resolve a project's selection into the list actually sent upstream. Unknown
// box ids are ignored rather than fatal — a box can vanish when an MCP server
// goes away, and that must degrade to fewer tools, not to a broken chat. Over
// the cap the list is truncated, but never silently: the dropped names come
// back so the caller can log them.
function resolveTools(project, model) {
  // An absent key means a project predating toolboxes: fall back to core so
  // upgrading does not silently disarm existing projects. An empty ARRAY is a
  // deliberate choice — the operator unticked every box — and must be honoured,
  // or the UI checkbox would lie about what it does.
  const wanted = Array.isArray(project && project.toolboxes) ? project.toolboxes : DEFAULT_TOOLBOXES;
  const available = allToolboxes();
  const boxes = [];
  const candidates = [];
  const seen = new Set();
  for (const id of wanted) {
    const box = available.find((b) => b.id === id);
    if (!box) continue;
    boxes.push(box.id);
    for (const tool of box.tools) {
      const name = tool && tool.function && tool.function.name;
      if (!name || seen.has(name)) continue; // first box wins a name clash
      seen.add(name);
      candidates.push(tool);
    }
  }
  // Two independent limits; whichever binds first stops the list. Tools are
  // taken in selection order, so the box a user picked first keeps its tools
  // when the budget runs out — a stable, explainable rule beats picking the
  // cheapest tools and silently reshaping what the model can do.
  const cap = toolCapFor(model);
  const budget = toolTokenBudgetFor(model);
  const tools = [];
  const dropped = [];
  let spent = 0;
  for (const tool of candidates) {
    const cost = estimateToolTokens([tool]);
    if (tools.length >= cap) { dropped.push(`${tool.function.name} (over ${cap}-tool cap)`); continue; }
    if (spent + cost > budget) { dropped.push(`${tool.function.name} (~${cost} tok, over ${budget} budget)`); continue; }
    tools.push(tool);
    spent += cost;
  }
  return { tools, dropped, boxes, cap, budget, estTokens: spent };
}

// Shape for the UI: what boxes exist, how big each is, and what it costs.
// ── MCP toolboxes (master step 15) ───────────────────────────────────────
//
// Curation is by explicit tool NAME, not by app prefix, and that is not
// fussiness — it is forced by measurement. Against the reference server on
// 2026-09-08 the full catalogue is 160 tools / ~40k prompt tokens converted,
// but the cost is wildly uneven: nc_calendar_create_event alone is 7,355
// chars (~3,900 tokens), twenty times the entire core box, while
// nc_notes_search_notes is 449. A whole-app box is therefore still far too
// expensive — "Calendar" as a unit is ~20k tokens, unusable at ~14 tok/s.
//
// So each box is a hand-picked working set: the smallest group of tools that
// makes the app genuinely useful, and nothing else. Tools not listed here are
// simply never offered; adding one is a deliberate, costed decision.
const MCP_TOOLBOX_MANIFEST = [
  {
    id: 'nextcloud-notes',
    label: 'Nextcloud Notes',
    description: 'Search, read, create and edit notes.',
    tools: [
      'nc_notes_search_notes', 'nc_notes_get_note', 'nc_notes_create_note',
      'nc_notes_append_content', 'nc_notes_update_note', 'nc_notes_delete_note',
    ],
  },
  {
    id: 'nextcloud-calendar',
    label: 'Nextcloud Calendar',
    description: 'Read the calendar and create, change or cancel events.',
    tools: [
      'nc_calendar_list_calendars', 'nc_calendar_list_events', 'nc_calendar_get_upcoming_events',
      'nc_calendar_create_event', 'nc_calendar_update_event', 'nc_calendar_delete_event',
    ],
  },
  {
    id: 'nextcloud-files',
    label: 'Nextcloud Files',
    description: 'Browse, search, read and write files in Nextcloud.',
    tools: [
      'nc_webdav_list_directory', 'nc_webdav_read_file', 'nc_webdav_write_file',
      'nc_webdav_search_files', 'nc_webdav_find_by_name',
    ],
  },
  {
    id: 'nextcloud-contacts',
    label: 'Nextcloud Contacts',
    description: 'Look up and maintain contacts.',
    tools: [
      'nc_contacts_list_contacts', 'nc_contacts_search_contacts',
      'nc_contacts_create_contact', 'nc_contacts_update_contact',
    ],
  },
  {
    id: 'nextcloud-talk',
    label: 'Nextcloud Talk',
    description: 'Read conversations and send messages.',
    tools: ['talk_list_conversations', 'talk_get_messages', 'talk_send_message'],
  },
  {
    id: 'nextcloud-deck',
    label: 'Nextcloud Deck',
    description: 'Read boards and move or edit cards.',
    tools: [
      'deck_get_boards', 'deck_get_board_overview', 'deck_get_cards',
      'deck_create_card', 'deck_update_card', 'deck_move_card_to_board',
    ],
  },
];

// An MCP server URL is the same class of thing as a member-supplied provider
// or storage endpoint, so it reuses the existing policy rather than inventing
// a third. It is admin/deployment configuration (an env var, not something a
// member can set), which under endpointApproved() is exactly the admin case —
// pointing at a private address such as another container is legitimate and
// expected. The guard that matters here is the shape check: http/https only,
// and no credentials smuggled into the URL.
const MCP_SERVER_URL = (() => {
  const raw = (process.env.MCP_SERVER_URL || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) {
      console.warn(`[mcp] ignoring MCP_SERVER_URL: must be http(s) with no embedded credentials`);
      return '';
    }
    return raw;
  } catch {
    console.warn('[mcp] ignoring MCP_SERVER_URL: not a valid URL');
    return '';
  }
})();

// Discovered MCP tools, keyed by name, plus the boxes that survived curation.
// Discovery is a network round trip against a server that may be down, so it
// is lazy, cached, and failure is non-fatal: no MCP boxes simply means the
// built-in ones are all a project can choose. Chat must never break because a
// side-car is restarting.
const mcpState = { tools: new Map(), boxes: [], discoveredAt: 0, error: null, inflight: null };
const MCP_DISCOVERY_TTL_MS = 10 * 60 * 1000;

async function discoverMcpTools(force = false) {
  if (!MCP_SERVER_URL) return mcpState;
  const fresh = Date.now() - mcpState.discoveredAt < MCP_DISCOVERY_TTL_MS;
  if (!force && fresh && mcpState.boxes.length) return mcpState;
  if (mcpState.inflight) return mcpState.inflight;
  mcpState.inflight = (async () => {
    try {
      // Discovery lists the catalogue only; it carries no user credential, so
      // the shape of the toolbox is identical for everyone. The per-user
      // credential is attached at CALL time instead — see mcpAuthHeaders().
      const { session } = await mcp.connect(MCP_SERVER_URL);
      const discovered = await mcp.listTools(MCP_SERVER_URL, session);
      const byName = new Map();
      const dropped = [];
      for (const t of discovered) {
        const conv = mcp.convertTool(t);
        if (!conv.ok) { dropped.push(`${(t && t.name) || '(unnamed)'}: ${conv.reason}`); continue; }
        byName.set(conv.tool.function.name, { tool: conv.tool, readOnly: mcp.readOnlyHint(t) });
      }
      if (dropped.length) console.warn(`[mcp] dropped ${dropped.length} unconvertible tools: ${dropped.join(' | ')}`);
      const boxes = [];
      for (const box of MCP_TOOLBOX_MANIFEST) {
        const tools = [];
        const missing = [];
        for (const name of box.tools) {
          const hit = byName.get(name);
          if (hit) tools.push(hit.tool); else missing.push(name);
        }
        if (missing.length) console.warn(`[mcp] box ${box.id}: ${missing.length} curated tools not offered by the server: ${missing.join(', ')}`);
        // A box that lost every tool is not shown at all — an empty box in the
        // picker is a promise the server cannot keep.
        if (tools.length) boxes.push({ ...box, source: 'mcp', tools });
      }
      mcpState.tools = byName;
      mcpState.boxes = boxes;
      mcpState.discoveredAt = Date.now();
      mcpState.error = null;
      console.log(`[mcp] discovered ${byName.size} tools at ${MCP_SERVER_URL}; ${boxes.length} curated boxes available`);
    } catch (err) {
      mcpState.error = String((err && err.message) || err);
      mcpState.discoveredAt = Date.now(); // back off; do not hammer a dead server
      console.warn(`[mcp] discovery failed for ${MCP_SERVER_URL}: ${mcpState.error}`);
    } finally {
      mcpState.inflight = null;
    }
    return mcpState;
  })();
  return mcpState.inflight;
}

// Per-user credential pass-through, following the diaryHeaders() precedent.
//
// The MCP server runs in multi_user_basic mode: it stores no credential of its
// own and builds a Nextcloud client per request from the Authorization header.
// noevia already holds exactly the credential that wants — the per-user
// Nextcloud app password obtained through Login Flow v2 for diary storage — so
// the consent flow the user already completed is reused rather than rebuilt.
// Origins whose stored credential may be forwarded to the MCP server.
//
// This guard exists because the two ends can disagree. The MCP server talks to
// ONE Nextcloud, fixed by its own NEXTCLOUD_HOST. noevia stores whatever
// server each user happened to connect for diary storage — which may be a
// different host entirely. Forwarding a credential across that gap would hand
// a user's password for their server to somebody else's, so pass-through is
// allowed only for origins the operator has explicitly declared to be the same
// Nextcloud the MCP server uses.
//
// It is a LIST because one Nextcloud legitimately has several origins: this
// deployment reaches it as http://10.69.0.130:11000 over the LAN and
// https://drive.daserver.work from outside. Unset means no pass-through at
// all — MCP tools then return an actionable error instead of silently
// leaking, which is the correct way to fail.
const MCP_NEXTCLOUD_ORIGINS = (process.env.MCP_NEXTCLOUD_ORIGINS || '')
  .split(',').map((x) => x.trim().replace(/\/+$/, '')).filter(Boolean);

function mcpCredentialOriginAllowed(baseUrl) {
  try {
    return MCP_NEXTCLOUD_ORIGINS.includes(new URL(baseUrl).origin);
  } catch { return false; }
}

// Per-user credential pass-through, following the diaryHeaders() precedent.
//
// The MCP server runs in multi_user_basic mode: it stores no credential of its
// own and builds a Nextcloud client per request from the Authorization header.
// noevia already holds exactly the credential that wants — the per-user
// Nextcloud app password obtained for storage — so the consent the user has
// already given is reused rather than asked for a second time.
//
// Both 'nextcloud' and 'webdav' connections qualify: a Nextcloud app password
// is the same secret whichever way the user attached it, and in practice the
// generic WebDAV form is common. The origin allowlist above, not the `kind`
// label, is what makes this safe.
function mcpAuthHeaders() {
  const store = requestScope.getStore();
  const workspace = store && store.workspace;
  if (!workspace) return null;
  const storage = authService.getStorage(workspace.userId, true);
  if (!['nextcloud', 'webdav'].includes(storage.kind)) return null;
  if (!storage.username || !storage.secret) return null;
  if (!mcpCredentialOriginAllowed(storage.baseUrl)) {
    console.warn(`[mcp] refusing to forward credentials for ${storage.baseUrl}: origin not in MCP_NEXTCLOUD_ORIGINS`);
    return null;
  }
  const basic = Buffer.from(`${storage.username}:${storage.secret}`).toString('base64');
  return { Authorization: `Basic ${basic}`, 'X-Cowork-User-ID': workspace.userId };
}

// Accept only ids that name a real box, so a stale selection persisted by an
// older client cannot accumulate junk in the project record.
function sanitizeToolboxes(value) {
  if (!Array.isArray(value)) return null;
  const ids = value.filter((v) => typeof v === 'string' && allToolboxes().some((b) => b.id === v));
  return [...new Set(ids)];
}

function toolboxSummaries() {
  return allToolboxes().map((b) => ({
    id: b.id,
    label: b.label,
    description: b.description,
    source: b.source,
    toolCount: b.tools.length,
    estTokens: estimateToolTokens(b.tools),
  }));
}

// ── SKILL.md awareness (Hermes-style convention, master step 13) ─────────
// A project knowledge file that starts with SKILL.md frontmatter is treated
// as a skill: its name/description go into the system prompt as a always-on
// index (L0), and the model is told it can request the full body through the
// read_project_file tool (L1) — progressive disclosure, zero extra deps.
function parseSkillFrontmatter(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(content || ''));
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^['"]|['"]$/g, '');
  }
  if (!meta.name && !meta.description) return null;
  return { name: meta.name || '', description: meta.description || '', version: meta.version || '' };
}

function skillsIndexFor(project) {
  const files = (project && Array.isArray(project.files)) ? project.files : [];
  const skills = [];
  for (const f of files) {
    const skill = parseSkillFrontmatter(f.content);
    if (skill) skills.push({ file: f.name, ...skill });
  }
  return skills;
}

async function executeToolCall(project, name, rawArgs, allowed) {
  // A model can name a tool it was never offered — by hallucination, or from
  // a box the project has since deselected mid-conversation. Enforce the
  // resolved list here rather than trusting that whatever was sent upstream is
  // still what came back.
  if (allowed instanceof Set && !allowed.has(name)) {
    return `ERROR: tool "${name}" is not enabled for this project`;
  }
  let args = {};
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {};
  } catch {
    return `ERROR: tool arguments were not valid JSON: ${String(rawArgs).slice(0, 200)}`;
  }
  if (name === 'get_current_time') {
    const tz = typeof args.timezone === 'string' && args.timezone ? args.timezone : undefined;
    const now = new Date();
    try {
      const formatted = tz
        ? new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' }).format(now)
        : now.toString();
      return `Current time: ${formatted}${tz ? ` (${tz})` : ''} | ISO: ${now.toISOString()}`;
    } catch {
      return `ERROR: unknown IANA timezone "${tz}"`;
    }
  }
  if (name === 'read_project_file') {
    const wanted = typeof args.name === 'string' ? args.name : '';
    const files = (project && Array.isArray(project.files)) ? project.files : [];
    const f = files.find((x) => x.name === wanted);
    if (!f) {
      const names = files.map((x) => x.name).join(', ') || '(none attached)';
      return `ERROR: no project file named "${wanted}". Available: ${names}`;
    }
    return `File "${f.name}" (${f.content.length} chars):\n\n${f.content.slice(0, TOOL_RESULT_CAP)}${f.content.length > TOOL_RESULT_CAP ? '\n…[truncated]' : ''}`;
  }
  // Not a built-in: if the name came from a discovered MCP box, execute it
  // there. The per-user credential is attached here rather than at discovery,
  // so two users sharing a project each act as themselves.
  if (mcpState.tools.has(name)) return executeMcpToolCall(name, args);
  return `ERROR: unknown tool "${name}"`;
}

async function executeMcpToolCall(name, args) {
  if (!MCP_SERVER_URL) return 'ERROR: no MCP server is configured';
  const auth = mcpAuthHeaders();
  if (!auth) {
    // Actionable on purpose: the model relays this to the user, and the fix is
    // something only the user can do.
    return 'ERROR: this tool needs your Nextcloud account. Connect Nextcloud in Settings → Storage, then try again. (If it is already connected, the administrator has not listed its address in MCP_NEXTCLOUD_ORIGINS.)';
  }
  try {
    const { session } = await mcp.connect(MCP_SERVER_URL, auth);
    const result = await mcp.callTool(MCP_SERVER_URL, session, name, args, auth);
    const text = mcp.resultToText(result);
    return text.length > TOOL_RESULT_CAP
      ? `${text.slice(0, TOOL_RESULT_CAP)}\n…[truncated]`
      : (text || '(the tool returned no output)');
  } catch (err) {
    // Returned, not thrown: a failed tool call is information the model can
    // act on or relay, and throwing would strand the chip with no result.
    return `ERROR calling ${name}: ${String((err && err.message) || err).slice(0, 300)}`;
  }
}

// Deterministic pre-escalation: obviously complex messages go to the smart
// role without burning a classifier round-trip (zero false negatives on the
// patterns below; everything else falls through to the classifier).
// Tuned against an 8-message battery (2026-09-03): the two misses were a
// multi-step word problem (5 numbers, no keywords) and an explicit
// "write 600 words" request — hence the numbers>=3 and effort-phrase rules.
function heuristicWantsSmart(message) {
  const m = String(message);
  if (m.length > 600) return true;
  if (m.includes('```')) return true;
  if (/\b(function|algorithm|debug|refactor|implement|optimize|architecture|regex|sql|migration)\b/i.test(m)) return true;
  // Multi-step quantitative asks: several numbers in one message rarely
  // reduce to single-step arithmetic (e.g. chase/rate problems). False
  // positives just get a better model — cheap; false negatives are the
  // costly direction.
  const numbers = m.match(/\d+(?:[.,]\d+)?/g);
  if (numbers && numbers.length >= 3) return true;
  // Explicit effort/length requests ("600 words", "step by step", ...).
  if (/\b\d{2,}\s*(words?|paragraphs?|pages?|sentences?)\b/i.test(m)) return true;
  if (/\b(step[- ]by[- ]step|in detail|detailed|thoroughly|comprehensive|deep dive|prove|derive)\b/i.test(m)) return true;
  return false;
}

// One cheap classification call before an auto-routed message. Mirrors the
// fail-open philosophy of diary-companion's pipeline.py skip_classifier: any
// error or unparseable reply defaults to the fast role — the classifier must
// never block the chat.
const CLASSIFIER_SYSTEM_PROMPT =
  'You classify a user message for a model router. Reply with exactly one word: FAST for short simple questions or small talk, SMART for complex reasoning, multi-step work, code, or analysis. No other text.';

// Budget for the classifier reply. A non-reasoning answer is 1-3 tokens; this
// only has to be large enough for a reasoning model that ignores the
// no-thinking hint below to finish its chain of thought and still emit the
// verdict. Measured against the local roster (2026-09-07): gemma-4-E2B needs
// ~162 tokens thinking, Qwen3.5-9B ~427. The old value of 64 truncated both —
// finish_reason came back 'length' with an empty content field, no verdict was
// ever found, and every message silently fell open to fast. That is why auto
// mode looked biased rather than broken.
const CLASSIFIER_MAX_TOKENS = 512;

function classifierBody(model, message, suppressThinking) {
  const body = {
    model,
    messages: [
      { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
      { role: 'user', content: String(message).slice(0, 1000) },
    ],
    max_tokens: CLASSIFIER_MAX_TOKENS,
    temperature: 0,
    stream: false,
  };
  // Routing is a mechanical label, not a reasoning task, so ask the model to
  // skip its chain of thought. llama.cpp/vLLM honour this; on the local
  // roster it cuts the call from ~162-427 tokens (12-31s on an iGPU, paid
  // before every single auto-routed message) to 2-3 tokens under 80ms.
  // Providers that reject unknown fields get a retry without it — see below.
  if (suppressThinking) body.chat_template_kwargs = { enable_thinking: false };
  return JSON.stringify(body);
}

// Read the verdict out of a classifier reply. content is authoritative when
// present; the reasoning channel is only a fallback, and deliberately a
// last-resort one: a thinking model restates the prompt's own FAST/SMART
// wording while deliberating, so scanning it can pick up the prompt's words
// rather than the model's conclusion.
function classifierVerdict(msg) {
  const content = String(msg.content || '').toUpperCase();
  const direct = content.match(/\b(SMART|FAST)\b/g);
  if (direct) return direct[direct.length - 1].toLowerCase();
  const reasoning = String(msg.reasoning_content || '').toUpperCase();
  const hits = reasoning.match(/\b(SMART|FAST)\b/g);
  return hits ? hits[hits.length - 1].toLowerCase() : null;
}

async function classifyFastOrSmart(message) {
  const roles = autoRoles();
  if (!roles) return 'fast';
  if (heuristicWantsSmart(message)) return 'smart';
  try {
    const defaultProvider = getProvider(DEFAULT_PROVIDER_ID);
    const url = `${defaultProvider.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/chat/completions`;
    const call = (suppressThinking) =>
      fetchJson(
        url,
        {
          method: 'POST',
          headers: providerHeaders(defaultProvider),
          body: classifierBody(roles.fast, message, suppressThinking),
        },
        20000,
      );
    let r = await call(true);
    // chat_template_kwargs is a llama.cpp/vLLM extension. A strict provider
    // (or a gateway in front of one) may 400 on the unknown field; retry once
    // plainly rather than degrading to fast, which is the failure this whole
    // function exists to avoid.
    if (r.status === 400) {
      console.warn('[router] classifier rejected chat_template_kwargs (400), retrying without it');
      r = await call(false);
    }
    if (!r.ok) throw new Error(`classifier ${r.status}`);
    const choice = r.body?.choices?.[0] || {};
    const verdict = classifierVerdict(choice.message || {});
    if (!verdict) {
      // Distinguish "ran out of room mid-thought" from "answered something
      // unparseable" — the first is a budget problem, the second a prompt one.
      const truncated = choice.finish_reason === 'length';
      console.warn(
        `[router] no verdict in classifier reply${truncated ? ` (truncated at ${CLASSIFIER_MAX_TOKENS} tokens)` : ''}, failing open to fast`,
      );
      return 'fast';
    }
    console.log(`[router] classified -> ${verdict}`);
    return verdict;
  } catch (err) {
    console.warn('[router] classify failed, failing open to fast:', err?.message || err);
    return 'fast';
  }
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
      maxContext: m.max_context_window || null,
      suggested: !!m.suggested,
    }));
  if (!LAST_LOADED_MODEL) {
    const firstLoaded = installed.find((m) => m.loaded);
    if (firstLoaded) LAST_LOADED_MODEL = firstLoaded.name;
  }
  return installed;
}

async function searchModels(query) {
  modelManager.requireEnabled();
  // Hugging Face's public search API, called server-side for the Lemonade adapter.
  const r = await fetchJson(
    `https://huggingface.co/api/models?search=${encodeURIComponent(`${query} gguf`)}&sort=downloads&limit=12`,
    {},
    20000,
  );
  if (!r.ok) throw new Error(`search failed: ${r.status}`);
  const arr = Array.isArray(r.body) ? r.body : [];
  return arr
    .filter((h) => !h.private)
    .map((h) => ({
      repo: h.id,
      name: (h.id || '').split('/').pop() || h.id,
      downloads: typeof h.downloads === 'number' ? h.downloads : null,
    }));
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

async function modelVariants(repo) {
  modelManager.requireEnabled();
  // Param name is `checkpoint` for the Lemonade adapter; each variant's id is
  // `<repo>/<variant-name>`-style GGUF filename reference the pull verb accepts.
  const r = await modelManager.variants(repo);
  if (!r.ok) throw new Error(`variants failed: ${r.status}`);
  const suggested = r.body?.suggested_name;
  const arr = Array.isArray(r.body?.variants) ? r.body.variants : [];
  return arr.slice(0, 20).map((v) => ({
    id: suggested ? `${repo}:${v.name}` : String(v.primary_file || v.name),
    label: String(v.name || v.primary_file || 'default'),
    sizeGB: typeof v.size_bytes === 'number' ? Math.round((v.size_bytes / 1e9) * 10) / 10 : null,
  }));
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

// ── Chat ────────────────────────────────────────────────────────────────────

async function handleChat(req, res, body, authn) {
  const { spaceId, message, history } = body || {};
  if (!message || typeof message !== 'string') return json(res, 400, { error: 'message required' });

  // Client-disconnect handling: if the browser goes away mid-generation,
  // abort the upstream fetches and stop the tool-round loop instead of
  // streaming into a dead socket. ServerResponse 'close' fires both when the
  // response completes and when the connection terminates prematurely — only
  // the premature case (end() never called) means the client is gone.
  // (IncomingMessage 'close' is not usable here: it fires as soon as the
  // request body has been read, long before the response finishes.)
  const chatSignal = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) chatSignal.abort();
  });
  // A write to a socket the client already killed must not surface as an
  // unhandled 'error' and crash the (single) server process.
  res.on('error', () => {});

  // Captured up front rather than resolved inside the stream loop: usage is
  // recorded after the upstream response has been iterated, and pinning the
  // workspace here keeps that write bound to the requesting user no matter
  // what the async context looks like by then.
  const chatWorkspace = (() => { try { return currentWorkspace(); } catch { return null; } })();

  const msgs = (Array.isArray(history) ? history : [])
    .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content)
    .slice(-HISTORY_CAP)
    .map((h) => ({ role: h.role, content: h.content }));
  msgs.push({ role: 'user', content: message });

  // ── Project context: instructions + knowledge files prepend
  // the system message for every chat in the project.
  let projectId = body.projectId || null;
  let chatId = body.chatId || null;
  let project = null;
  if (projectId && spaceId !== 'diary') {
    project = getProject(projectId);
    if (project && !chatId) {
      chatId = `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      saveChats(projectId, [...loadChats(projectId), chatId]);
    }
  }

  // Project knowledge files: RAG retrieval replaces whole-file pasting (step 10).
  // rag.filesContext never throws; on any RAG failure it falls back to verbatim
  // injection (small files whole, big files capped) — the old behavior.
  let filesBlock = null;
  if (project && Array.isArray(project.files) && project.files.length) {
    filesBlock = await rag.filesContext(project.id, project.files, message, currentWorkspace().userId);
  }

  const sysParts = [];
  if (project) {
    if (project.name) sysParts.push(`You are working inside the user's project "${project.name}".`);
    if (project.goal) sysParts.push(`Project goal: ${project.goal}`);
    if (project.instructions) sysParts.push(`Project instructions (follow closely):\n${project.instructions}`);
    if (Array.isArray(project.memories) && project.memories.length) {
      sysParts.push(`Things you know about the user (persistent memory, apply silently):\n${project.memories.map((m) => `- ${m}`).join('\n')}`);
    }
    if (filesBlock) {
      sysParts.push(`Relevant knowledge-file excerpts for this message:\n${filesBlock}`);
    }
    // Skills index (L0): name+description only, always visible. The model
    // pulls the full SKILL.md body on demand via read_project_file (L1).
    const skills = skillsIndexFor(project);
    if (skills.length) {
      sysParts.push(
        `Available skills (load the full file with the read_project_file tool when a task matches; do not guess their contents):\n` +
          skills.map((s) => `- ${s.name || s.file}${s.version ? ` (v${s.version})` : ''}: ${s.description || '(no description)'}`).join('\n'),
      );
    }
  }

  const send = (obj) => { if (!res.destroyed && !chatSignal.signal.aborted) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  // ── Diary tab: sidecar pipeline, called exactly once (no retry, no stream) ──
  if (spaceId === 'diary') {
    let full;
    try {
      full = await fetchJson(
        `${DIARY_BASE}/v1/chat/completions`,
        { method: 'POST', headers: diaryHeaders(), body: JSON.stringify({ messages: msgs, session_id: body.sessionId, entryTime: body.entryTime, entryDay: body.entryDay }), signal: chatSignal.signal },
        300000,
      );
    } catch (err) {
      if (chatSignal.signal.aborted) return; // client went away mid-generation
      throw err;
    }
    if (chatSignal.signal.aborted) return;
    if (!full.ok) {
      const detail = typeof full.body === 'string' ? full.body.slice(0, 200) : JSON.stringify(full.body || {}).slice(0, 200);
      return json(res, 502, { error: `diary sidecar ${full.status}: ${detail}` });
    }
    const choice = full.body?.choices?.[0]?.message;
    if (!choice?.content) return json(res, 502, { error: 'diary sidecar returned no content' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    send({ type: 'meta', model: 'diary' });
    send({ type: 'delta', text: choice.content });
    if (full.body.diary) send({ type: 'diary', decision: full.body.diary.decision, xid: full.body.diary.xid });
    send({ type: 'done', model: 'diary' });
    res.end();
    return;
  }

  // ── Ordinary space / project chat: routed via the project's provider ──
  const sys = sysParts.join('\n\n');
  const wire = sys ? [{ role: 'system', content: sys }, ...msgs] : msgs;

  // Projects without a provider field use the configured default provider.
  const projectProvider = project?.provider === 'lemonade' ? DEFAULT_PROVIDER_ID : project?.provider;
  const wantsAuto = !!(project && project.routing === 'auto' && (!projectProvider || projectProvider === DEFAULT_PROVIDER_ID));
  const provider = getProvider(wantsAuto ? DEFAULT_PROVIDER_ID : projectProvider || DEFAULT_PROVIDER_ID);

  let model = (project && project.model) || null;
  let routedRole = null;
  if (wantsAuto) {
    const roles = autoRoles();
    if (!roles) {
      return json(res, 400, { error: 'Auto routing is not configured yet — pick Fast and Smart models in the model popup first.' });
    }
    routedRole = await classifyFastOrSmart(message); // fail-open inside
    model = roles[routedRole];
  } else if (!model && provider.id === DEFAULT_PROVIDER_ID && modelManager.enabled) {
    // No hardcoded model name: default to whatever the manager reports as loaded.
    try {
      await modelsInstalled();
    } catch {
      /* fall through to the no-model error below */
    }
    model = LAST_LOADED_MODEL;
  }
  if (!model) {
    return json(res, 400, { error: 'no model selected and none loaded — pick one in the model popup' });
  }

  // Accept both bare-host and conventional /v1-suffixed base URLs (cloud
  // providers like OpenRouter use https://host/api/v1).
  const upstreamUrl = `${provider.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/chat/completions`;
  const upstreamHeaders = providerHeaders(provider);

  // SSRF guard for member-registered providers (see the /api/providers POST
  // guard): a member must not reach internal addresses through a chat pinned
  // to a provider they registered themselves. Admin-configured providers
  // (the env default, or shared ones) may legitimately point at private
  // addresses (local inference), and member chat through them is the normal
  // default-deployment path — so only the member's own private providers
  // are subject to the denylist here.
  const memberOwnProvider = authn && authn.user.role !== 'admin' && !provider.shared && provider.id !== DEFAULT_PROVIDER_ID;
  if (memberOwnProvider && !endpointApproved(authn, upstreamUrl)) {
    return json(res, 400, { error: 'Provider origin is not approved for member connections; contact an administrator.' });
  }

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  send({ type: 'meta', model, chatId: chatId || undefined, route: routedRole || undefined });

  // ── Tool rounds (Pi-style loop, master step 13): stream a completion; if
  // the model called a tool, execute it, append role:'tool' results, and
  // stream a continuation. Max 3 rounds so a broken model can never loop
  // forever. Verified end to end against Qwen3.5-9B on 2026-09-08; the tool
  // list is resolved per request from the project's toolboxes (step 14).
  const decoder = new TextDecoder();
  // Resolve the project's toolboxes once for the whole exchange: every round
  // must offer the same list, or the model gets told a tool exists and then
  // punished for calling it.
  const resolved = resolveTools(project, model);
  const activeTools = resolved.tools;
  const allowedToolNames = new Set(activeTools.map((t) => t.function.name));
  if (resolved.dropped.length) {
    console.warn(`[tools] ${model}: cap ${resolved.cap} exceeded, dropped ${resolved.dropped.length}: ${resolved.dropped.join(', ')}`);
  }
  let roundMessages = wire;
  // After a tool result, a reasoning model often emits its whole continuation
  // on the reasoning channel and never opens a content block — the answer is
  // real and correct, it is just filed as thinking. Rendering that as an empty
  // reply with a collapsed "Thought process" makes tool calling look broken.
  // Track both so the stream can never end with nothing shown.
  let sentContent = false;
  let roundReasoning = '';
  for (let round = 0; round < 3 && !chatSignal.signal.aborted; round++) {
    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        // include_usage adds one final chunk carrying token counts (and, on
        // llama.cpp, timings) after the content is done. It is the only way to
        // report real usage for a streamed reply instead of guessing from
        // character counts client-side. Providers that do not know the field
        // ignore it; the chunk simply never arrives and the UI omits the stats.
        body: JSON.stringify({
          model,
          messages: roundMessages,
          stream: true,
          stream_options: { include_usage: true },
          ...(activeTools.length ? { tools: activeTools } : {}),
        }),
        signal: chatSignal.signal,
        redirect: 'error', // see the provider test route: no inward bounces
      });
    } catch (err) {
      if (chatSignal.signal.aborted) break; // client went away; stop quietly

      send({ type: 'error', text: `${provider.label} unreachable: ${err.message}` });
      break;
    }
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      const msg = `${provider.label} ${upstream.status}: ${detail.slice(0, 200)}`;

      send({ type: 'error', text: msg });
      break;
    }

    const toolCalls = new Map(); // index -> {id, name, args}
    let sawAnything = false;
    roundReasoning = '';
    // SSE line reassembly must live outside the chunk loop so a `data: {...}`
    // line split across a chunk boundary keeps its leading fragment
    // (same pattern as the client-side reader in src/api.ts).
    let buffer = '';
    try {
      for await (const chunk of upstream.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const evt = JSON.parse(payload);
            // The include_usage chunk carries no choices — only totals. Emit it
            // as its own event so the client can label the finished reply.
            if (evt.usage) {
              const reported = {
                promptTokens: Number(evt.usage.prompt_tokens) || 0,
                completionTokens: Number(evt.usage.completion_tokens) || 0,
                totalTokens: Number(evt.usage.total_tokens) || 0,
                tokensPerSecond: Number(evt.timings?.predicted_per_second) || 0,
              };
              recordUsage(chatWorkspace, model, reported);
              send({ type: 'usage', ...reported });
            }
            const delta = evt.choices?.[0]?.delta || {};
            if (delta.reasoning_content) {
              sawAnything = true;
              roundReasoning += delta.reasoning_content;
              send({ type: 'reasoning', text: delta.reasoning_content });
            }
            if (delta.reasoning) {
              sawAnything = true;
              roundReasoning += delta.reasoning;
              send({ type: 'reasoning', text: delta.reasoning });
            }
            if (delta.content) {
              sawAnything = true;
              sentContent = true;
              send({ type: 'delta', text: delta.content });
            }
            if (Array.isArray(delta.tool_calls)) {
              sawAnything = true;
              for (const tc of delta.tool_calls) {
                const i = typeof tc.index === 'number' ? tc.index : 0;
                const slot = toolCalls.get(i) || { id: tc.id || `call-${i}`, name: '', args: '' };
                if (tc.id) slot.id = tc.id;
                if (tc.function?.name) slot.name += tc.function.name;
                if (tc.function?.arguments) slot.args += tc.function.arguments;
                toolCalls.set(i, slot);
                // Emit the accumulated slot, keyed by index — not the raw
                // fragment. A single call arrives in many deltas (name once,
                // then arguments a few characters at a time), so forwarding
                // fragments made the client render one chip per delta, most
                // of them nameless with partial args like `/T`. The client
                // upserts on index and always sees the best-known state.
                send({ type: 'tool', index: i, name: slot.name, args: slot.args });
              }
            }
          } catch {
            /* keepalive or partial line */
          }
        }
      }
    } catch (err) {
      if (chatSignal.signal.aborted) break; // client went away; stop quietly
      send({ type: 'error', text: String(err?.message || err) });
      break;
    }

    // Fallback: some models/non-streaming paths return nothing on stream. One
    // non-streaming retry is safe for generation (no side effects, unlike diary).
    if (!sawAnything) {
      try {
        const full = await fetchJson(
          upstreamUrl,
          { method: 'POST', headers: upstreamHeaders, body: JSON.stringify({ model, messages: roundMessages, ...(activeTools.length ? { tools: activeTools } : {}) }), signal: chatSignal.signal },
          300000,
        );
        if (!full.ok) throw new Error(`Provider returned ${full.status}`);
        const msg = full.body?.choices?.[0]?.message;
        if (msg?.reasoning_content) { roundReasoning += msg.reasoning_content; send({ type: 'reasoning', text: msg.reasoning_content }); }
        if (msg?.content) { sentContent = true; send({ type: 'delta', text: msg.content }); }
        if (Array.isArray(msg?.tool_calls)) {
          for (const tc of msg.tool_calls) {
            const index = toolCalls.size;
            toolCalls.set(index, { id: tc.id || `call-${index}`, name: tc.function?.name || '', args: tc.function?.arguments || '' });
            send({ type: 'tool', index, name: tc.function?.name || '', args: tc.function?.arguments || '' });
          }
        }
        sawAnything = true;
      } catch (err) {
        send({ type: 'error', text: String(err?.message || err) });
      }
    }

    // Execute each requested tool and append assistant tool_calls + results.
    // This runs even on the final round: the client has already received the
    // `tool` events, so leaving the calls unexecuted would strand them with no
    // result ever arriving. After the last round the loop ends (the results
    // cannot be fed back to the model), but they are still streamed to the
    // user instead of dangling.
    if (toolCalls.size > 0) {
      const assistantMsg = { role: 'assistant', content: null, tool_calls: [...toolCalls.entries()].map(([i, tc]) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } })) };
      roundMessages = [...roundMessages, assistantMsg];
      for (const [, tc] of toolCalls) {
        const result = await executeToolCall(project, tc.name, tc.args, allowedToolNames);
        send({ type: 'tool_result', name: tc.name, text: result.slice(0, 300) });
        roundMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    }

    if (round === 2 || toolCalls.size === 0) break; // last round or no tools requested
  }

  if (chatSignal.signal.aborted) return; // client gone — nothing more to write
  // Nothing was ever emitted as content, but the model did think — most often
  // after a tool result, where the continuation arrives entirely on the
  // reasoning channel. The thinking IS the answer in that case, so promote it
  // rather than leaving the user with a tool chip and an empty bubble.
  if (!sentContent && roundReasoning.trim()) {
    send({ type: 'delta', text: roundReasoning.trim() });
  }
  send({ type: 'done', model });
  res.end();
}

// ── Routing ────────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
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
    const publicAuthRoutes = new Set([
      '/api/setup/status', '/api/setup/complete', '/api/auth/login/password',
      '/api/auth/login/passkey/options', '/api/auth/login/passkey/verify',
      '/api/auth/invitations/accept', '/api/auth/recovery/complete',
    ]);
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
    if (p === '/api/auth/session' && req.method === 'GET') {
      const csrfCookie = String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('cowork_csrf='));
      return json(res, 200, { user: authn.user, csrfToken: authn.legacy ? null : decodeURIComponent((csrfCookie || '').slice(12)), legacy: authn.legacy });
    }
    if (p === '/api/auth/logout' && req.method === 'POST') return authResult(res, authService.logout(req, res, authn));
    if (p.startsWith('/api/models/') && !['GET', 'HEAD'].includes(req.method || 'GET') && authn.user.role !== 'admin') {
      return json(res, 403, { error: 'administrator required' });
    }
    if (p === '/api/profile' && req.method === 'GET') return json(res, 200, { user: authn.user, passkeys: authService.listPasskeys(authn.user.id), sessions: authService.listSessions(authn.user.id) });
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
            const headers = { 'X-Cowork-User-ID': id };
            if (DIARY_TOKEN) headers.Authorization = `Bearer ${DIARY_TOKEN}`;
            await fetchJson(`${DIARY_BASE}/api/internal/tenant`, { method: 'DELETE', headers }, 15000).catch(() => null);
          }
          return json(res, ok ? 200 : 400, { ok });
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      return json(res, 404, { error: 'not found' });
    }

    if (p === '/api/toolboxes' && req.method === 'GET') {
      // Await discovery: on a cold start the picker would otherwise show only
      // the built-in box and the user would think MCP was broken. Cached for
      // MCP_DISCOVERY_TTL_MS, so this is one round trip every ten minutes.
      await discoverMcpTools();
      return json(res, 200, {
        toolboxes: toolboxSummaries(),
        mcp: MCP_SERVER_URL
          ? { configured: true, error: mcpState.error, discovered: mcpState.tools.size }
          : { configured: false },
      });
    }

    if (p === '/api/workspace') {
      return json(res, 200, { projects: PROJECTS, freeChats: FREE_CHATS });
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
      const [gen, sys] = await Promise.allSettled([
        modelManager.enabled ? modelManager.stats() : Promise.resolve({ ok: false }),
        modelManager.enabled ? modelManager.systemStats() : Promise.resolve({ ok: false }),
      ]);
      const g = gen.status === 'fulfilled' && gen.value.ok ? gen.value.body : {};
      const s = sys.status === 'fulfilled' && sys.value.ok ? sys.value.body : {};
      return json(res, 200, {
        up: gen.status === 'fulfilled' && gen.value.ok,
        tokensPerSecond: typeof g.tokens_per_second === 'number' ? g.tokens_per_second : null,
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
    if (p === '/api/usage' && req.method === 'GET') {
      const store = readUsage(currentWorkspace());
      const today = usageDayKey();
      // The heat map wants a dense year: every day present, zeros included,
      // so the client never has to reconstruct the calendar itself.
      const days = [];
      const cursor = new Date();
      cursor.setHours(12, 0, 0, 0); // midday avoids DST days shifting the key
      for (let i = USAGE_RETENTION_DAYS - 1; i >= 0; i--) {
        const at = new Date(cursor.getTime() - i * 86400000);
        const key = usageDayKey(at);
        const bucket = store.days[key];
        days.push({
          day: key,
          input: bucket?.input || 0,
          output: bucket?.output || 0,
          replies: bucket?.replies || 0,
        });
      }
      const windowTotals = (n) => days.slice(-n).reduce(
        (acc, d) => ({ input: acc.input + d.input, output: acc.output + d.output, replies: acc.replies + d.replies }),
        { input: 0, output: 0, replies: 0 },
      );
      const models = {};
      for (const bucket of Object.values(store.days)) {
        for (const [name, m] of Object.entries(bucket.models || {})) {
          const entry = models[name] || { input: 0, output: 0, replies: 0 };
          entry.input += m.input || 0;
          entry.output += m.output || 0;
          entry.replies += m.replies || 0;
          models[name] = entry;
        }
      }
      // Streak counts back from today, but a day with no usage yet does not
      // break it — otherwise every streak reads 0 until the first reply.
      let streak = 0;
      for (let i = days.length - 1; i >= 0; i--) {
        if (days[i].replies > 0) streak++;
        else if (days[i].day !== today) break;
      }
      let longest = 0;
      let run = 0;
      for (const d of days) { run = d.replies > 0 ? run + 1 : 0; if (run > longest) longest = run; }
      return json(res, 200, {
        days,
        allTime: windowTotals(days.length),
        last7: windowTotals(7),
        last30: windowTotals(30),
        activeDays: days.filter((d) => d.replies > 0).length,
        currentStreak: streak,
        longestStreak: longest,
        models: Object.entries(models)
          .map(([name, m]) => ({ name, ...m }))
          .sort((a, b) => b.input + b.output - (a.input + a.output)),
        retentionDays: USAGE_RETENTION_DAYS,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'server local time',
      });
    }
    if (p === '/api/auto-roles') {
      if (req.method === 'GET') {
        const roles = autoRoles();
        return json(res, 200, { configured: !!roles, roles: roles || null });
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
        if (!fast || !smart) return json(res, 400, { error: 'both fast and smart model names are required' });
        setAutoRoles({ fast, smart });
        ensureRolesLoaded(); // warm both models; never blocks the response
        return json(res, 200, { configured: true, roles: autoRoles() });
      }
    }

    if (p === '/api/projects' && req.method === 'POST') {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      const name = String(body.name || '').trim().slice(0, 120);
      if (!name) return json(res, 400, { error: 'name required' });
      const project = {
        id: `proj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        goal: String(body.goal || '').slice(0, 2000),
        instructions: String(body.instructions || '').slice(0, 8000),
        memories: [],
        files: Array.isArray(body.files)
          ? body.files
              .filter((f) => f && typeof f.name === 'string' && typeof f.content === 'string')
              .slice(0, 20)
              .map((f) => ({ name: f.name.slice(0, 200), content: f.content.slice(0, 200000) }))
          : [],
        model: typeof body.model === 'string' && body.model ? body.model : undefined,
        provider: typeof body.provider === 'string' && body.provider ? body.provider : undefined,
        routing: body.routing === 'auto' ? 'auto' : 'manual', // default manual (step 12 guardrail)
        toolboxes: sanitizeToolboxes(body.toolboxes) || [...DEFAULT_TOOLBOXES], // step 14: core only by default
        // (files normalization below is shared with the config route's RAG bookkeeping)
        chats: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      PROJECTS.unshift(project);
      saveProjects(PROJECTS);
      // Index any files that arrived with the create call (same RAG bookkeeping
      // as the config route).
      for (const f of project.files) {
        rag.indexProjectFile(project.id, f.name, f.content, currentWorkspace().userId)
          .then((r) => console.log(`[rag] indexed ${project.id}/${f.name}:`, JSON.stringify(r)))
          .catch((err) => console.warn(`[rag] index failed for ${project.id}/${f.name}:`, err?.message || err));
      }
      return json(res, 200, project);
    }

    const projMatch = p.match(/^\/api\/projects\/([^/]+)$/);
    if (projMatch && req.method === 'DELETE') {
      const id = decodeURIComponent(projMatch[1]);
      const before = PROJECTS.length;
      const keptProjects = Array.from(PROJECTS).filter((pr) => pr.id !== id);
      PROJECTS.splice(0, PROJECTS.length, ...keptProjects);
      if (PROJECTS.length === before) return json(res, 404, { error: 'no such project' });
      saveProjects(PROJECTS);
      // Drop the project's RAG index too (best-effort).
      try {
        for (const suffix of ['.db', '.db-wal', '.db-shm']) {
          fs.rmSync(path.join(currentWorkspace().ragDir(), `${id}${suffix}`), { force: true });
        }
      } catch { /* best effort */ }
      return json(res, 200, { ok: true });
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
      const project = getProject(id);
      if (!project) return json(res, 404, { error: 'no such project' });
      if (typeof patch.name === 'string' && patch.name.trim()) project.name = patch.name.trim().slice(0, 120);
      if (typeof patch.goal === 'string') project.goal = patch.goal.slice(0, 2000);
      if (typeof patch.instructions === 'string') project.instructions = patch.instructions.slice(0, 8000);
      if (typeof patch.model === 'string' && patch.model) project.model = patch.model;
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
        project.files = patch.files
          .filter((f) => f && typeof f.name === 'string' && typeof f.content === 'string')
          .slice(0, 20)
          .map((f) => ({ name: f.name.slice(0, 200), content: f.content.slice(0, 200000) }));
        // RAG bookkeeping (step 10): drop chunks for removed files; index
        // new/changed ones. Fire-and-forget — upload latency must not depend
        // on embedding round-trips.
        const prevByName = new Map(prevFiles.map((f) => [f.name, f]));
        const nextNames = new Set(project.files.map((f) => f.name));
        for (const prev of prevFiles) {
          if (!nextNames.has(prev.name)) rag.deleteProjectFile(id, prev.name, currentWorkspace().userId);
        }
        for (const next of project.files) {
          const prev = prevByName.get(next.name);
          if (!prev || prev.content !== next.content) {
            rag.indexProjectFile(id, next.name, next.content, currentWorkspace().userId)
              .then((r) => console.log(`[rag] indexed ${id}/${next.name}:`, JSON.stringify(r)))
              .catch((err) => console.warn(`[rag] index failed for ${id}/${next.name}:`, err?.message || err));
          }
        }
      }
      project.updatedAt = Date.now();
      saveProjects(PROJECTS);
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
              .slice(0, 200)
              .map((c) => ({
                id: c.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
                title: String(c.title || 'New task').slice(0, 120),
                updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : Date.now(),
              })),
          );
          return json(res, 200, { ok: true });
        } catch {
          return json(res, 400, { error: 'invalid JSON' });
        }
      }
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
            .slice(0, 200)
            .map((c) => ({
              id: c.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
              title: String(c.title || 'New chat').slice(0, 120),
              updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : Date.now(),
            }));
          FREE_CHATS.splice(0, FREE_CHATS.length, ...nextFreeChats);
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

    if (p === '/api/models/installed') {
      try {
        return json(res, 200, await modelsInstalled());
      } catch (err) {
        return json(res, 502, { error: String(err.message || err) });
      }
    }

    if (p === '/api/models/search') {
      try {
        return json(res, 200, await searchModels(url.searchParams.get('q') || ''));
      } catch (err) {
        return json(res, 502, { error: String(err.message || err) });
      }
    }

    if (p === '/api/models/variants') {
      try {
        return json(res, 200, await modelVariants(url.searchParams.get('repo') || ''));
      } catch (err) {
        return json(res, 502, { error: String(err.message || err) });
      }
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
        r.ok ? { jobId: r.body?.id || r.body?.job_id || 'pull', modelName } : { error: r.body?.error || `pull failed: ${r.status}` },
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
        const r = await modelManager[verb](body.name);
        return json(res, r.ok ? 200 : 502, r.ok ? { ok: true } : { error: `${verb} failed: ${r.status}` });
      }
    }

    if (p === '/api/models/downloads') {
      if (!modelManager.enabled) return json(res, 200, []);
      const r = await modelManager.downloads();
      if (!r.ok) return json(res, 200, []);
      const arr = Array.isArray(r.body) ? r.body : r.body?.jobs || r.body?.downloads || [];
      // Lemonade reports `percent` as 0-100; the UI expects a 0-1 fraction.
      return json(res, 200, arr.map((j) => ({
        id: j.id || j.job_id || '',
        model: j.model_name || j.model || j.checkpoint || '',
        progress: typeof j.percent === 'number' ? j.percent / 100 : typeof j.progress === 'number' ? j.progress : null,
        status: j.status || j.state || '',
      })));
    }

    if (['/api/diary/files', '/api/diary/file', '/api/diary/local-exchange'].includes(p)) {
      if (!authService.diaryEnabled(authn.user.id)) return json(res, 404, { error: 'Diary add-on is disabled' });
      const local = p.endsWith('/local-exchange');
      const listing = p.endsWith('/files');
      if (!(listing ? req.method === 'GET' : local ? req.method === 'POST' : ['POST', 'PUT'].includes(req.method))) return json(res, 405, { error: 'Method not allowed' });
      if (local && llmRateLimited(authn.user.id)) return json(res, 429, { error: 'Please wait before sending another message' });
      const body = listing ? undefined : await readBody(req, local ? 16 * 1024 * 1024 : 1024 * 1024);
      const suffix = listing ? '/files?path=' + encodeURIComponent(url.searchParams.get('path') || '') : local ? '/local-exchange' : '/file';
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

    if (p === '/api/chat' && req.method === 'POST') {
      if (llmRateLimited(authn.user.id)) return json(res, 429, { error: 'Too many requests — the model endpoint is shared; wait a moment and try again' });
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      if (body.spaceId === 'diary' && !authService.diaryEnabled(authn.user.id)) {
        return json(res, 404, { error: 'Diary add-on is disabled' });
      }
      return await handleChat(req, res, body, authn);
    }

    // Unused legacy spaces endpoints removed with the spaces UI (v4).

    const historyMatch = p.match(/^\/api\/chats\/([^/]+)\/history$/);
    if (historyMatch) {
      const spaceId = decodeURIComponent(historyMatch[1]);
      if (req.method === 'GET') return json(res, 200, { history: readHistory(spaceId) });
      if (req.method === 'POST') {
        const raw = await readBody(req);
        try {
          const body = JSON.parse(raw);
          writeHistory(spaceId, Array.isArray(body.history) ? body.history.slice(-HISTORY_CAP) : []);
          return json(res, 200, { ok: true });
        } catch {
          return json(res, 400, { error: 'invalid JSON' });
        }
      }
    }

    // Static files with SPA fallback.
    let filePath = path.normalize(path.join(DIST_DIR, p === '/' ? 'index.html' : p));
    // path.sep suffix check: a bare startsWith(DIST_DIR) would also accept a
    // sibling directory like `${DIST_DIR}-evil`.
    if (filePath !== DIST_DIR && !filePath.startsWith(DIST_DIR + path.sep)) return json(res, 403, { error: 'forbidden' });
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      if (!SPAFallbacks.includes(p)) return json(res, 404, { error: 'not found' });
      filePath = path.join(DIST_DIR, 'index.html');
    }
    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
      '.woff': 'font/woff', '.ico': 'image/x-icon', '.json': 'application/json',
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) json(res, 500, { error: 'read error' });
      else res.end();
    });
    stream.pipe(res);
  } catch (err) {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) {
      res.end(`data: ${JSON.stringify({ type: 'error', text: 'The request could not be completed. Please retry.' })}\n\n`);
    } else json(res, err.status || 500, { error: String((err && err.message) || err) });
  }
}

if (require.main === module) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!UI_AUTH_TOKEN) {
    console.warn('WARNING: Set DIARY_AUTH_TOKEN to protect the internal diary connection. Browser accounts remain authenticated.');
  }
  http.createServer((req, res) => { handleRequest(req, res).catch(() => { if (!res.destroyed) res.destroy(); }); }).listen(PORT, HOST, () => {
    console.log(`cowork-ui listening on http://${HOST}:${PORT} (inference: ${INFERENCE_BASE}, manager: ${modelManager.kind}, diary: ${DIARY_BASE}, mcp: ${MCP_SERVER_URL || 'disabled'})`);
    // Warm the tool catalogue so the first chat does not pay for discovery.
    // Never blocks startup: a side-car that is still booting must not stop
    // noevia from serving.
    discoverMcpTools().catch(() => undefined);
  });
}

module.exports = { checkAuth, handleRequest, resolveTools, allToolboxes, mcpCredentialOriginAllowed, toolTokenBudgetFor, MCP_TOOLBOX_MANIFEST, toolboxSummaries, estimateToolTokens, toolCapFor, sanitizeToolboxes, executeToolCall, TOOLBOXES, classifierVerdict, heuristicWantsSmart, CLASSIFIER_MAX_TOKENS, recordUsage, readUsage, usageDayKey, USAGE_RETENTION_DAYS };
