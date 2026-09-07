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
const storageClient = require('./storage-client.cjs');
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
const TOOL_DEFS = [
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

function executeToolCall(project, name, rawArgs) {
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
  return `ERROR: unknown tool "${name}"`;
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
async function classifyFastOrSmart(message) {
  const roles = autoRoles();
  if (!roles) return 'fast';
  if (heuristicWantsSmart(message)) return 'smart';
  try {
    const defaultProvider = getProvider(DEFAULT_PROVIDER_ID);
    const r = await fetchJson(
      `${defaultProvider.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/chat/completions`,
      {
        method: 'POST',
        headers: providerHeaders(defaultProvider),
        body: JSON.stringify({
          model: roles.fast,
          messages: [
            {
              role: 'system',
              content:
                'You classify a user message for a model router. Reply with exactly one word: FAST for short simple questions or small talk, SMART for complex reasoning, multi-step work, code, or analysis. No other text.',
            },
            { role: 'user', content: String(message).slice(0, 1000) },
          ],
          max_tokens: 64,
          temperature: 0,
          stream: false,
        }),
      },
      20000,
    );
    if (!r.ok) throw new Error(`classifier ${r.status}`);
    const msg = r.body?.choices?.[0]?.message || {};
    // Scan the whole reply (some small models spend tokens on preamble before
    // the verdict, or put it in the reasoning channel): last FAST/SMART wins.
    const text = `${msg.content || ''} ${msg.reasoning_content || ''}`.toUpperCase();
    const hits = text.match(/\b(SMART|FAST)\b/g);
    const verdict = hits ? hits[hits.length - 1].toLowerCase() : 'fast';
    console.log(`[router] classified -> ${verdict}${hits ? '' : ' (no verdict found, fail-open)'}`);
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
  // the model called built-in tools, execute them, append role:'tool'
  // results, and stream a continuation. Max 3 rounds so a broken model can
  // never loop forever. No tool-calling-capable model in the roster yet, so
  // this is dormant plumbing until one lands — the loop simply never fires.
  const decoder = new TextDecoder();
  let roundMessages = wire;
  for (let round = 0; round < 3 && !chatSignal.signal.aborted; round++) {
    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify({ model, messages: roundMessages, stream: true, tools: TOOL_DEFS }),
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
            const delta = evt.choices?.[0]?.delta || {};
            if (delta.reasoning_content) {
              sawAnything = true;
              send({ type: 'reasoning', text: delta.reasoning_content });
            }
            if (delta.reasoning) {
              sawAnything = true;
              send({ type: 'reasoning', text: delta.reasoning });
            }
            if (delta.content) {
              sawAnything = true;
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
                send({ type: 'tool', name: tc.function?.name || '', args: tc.function?.arguments || '' });
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
          { method: 'POST', headers: upstreamHeaders, body: JSON.stringify({ model, messages: roundMessages, tools: TOOL_DEFS }), signal: chatSignal.signal },
          300000,
        );
        if (!full.ok) throw new Error(`Provider returned ${full.status}`);
        const msg = full.body?.choices?.[0]?.message;
        if (msg?.reasoning_content) send({ type: 'reasoning', text: msg.reasoning_content });
        if (msg?.content) send({ type: 'delta', text: msg.content });
        if (Array.isArray(msg?.tool_calls)) {
          for (const tc of msg.tool_calls) {
            toolCalls.set(toolCalls.size, { id: tc.id || `call-${toolCalls.size}`, name: tc.function?.name || '', args: tc.function?.arguments || '' });
            send({ type: 'tool', name: tc.function?.name || '', args: tc.function?.arguments || '' });
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
        const result = executeToolCall(project, tc.name, tc.args);
        send({ type: 'tool_result', name: tc.name, text: result.slice(0, 300) });
        roundMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    }

    if (round === 2 || toolCalls.size === 0) break; // last round or no tools requested
  }

  if (chatSignal.signal.aborted) return; // client gone — nothing more to write
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
      const r = await modelManager.pull(body.checkpoint);
      return json(res, r.ok ? 200 : 502, r.ok ? { jobId: r.body?.job_id || r.body?.id || 'pull' } : { error: `pull failed: ${r.status}` });
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
      return json(res, 200, arr.map((j) => ({ id: j.id || j.job_id || '', model: j.model || j.model_name || j.checkpoint || '', progress: typeof j.progress === 'number' ? j.progress : null, status: j.status || j.state || '' })));
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
    console.log(`cowork-ui listening on http://${HOST}:${PORT} (inference: ${INFERENCE_BASE}, manager: ${modelManager.kind}, diary: ${DIARY_BASE})`);
  });
}

module.exports = { checkAuth, handleRequest };
