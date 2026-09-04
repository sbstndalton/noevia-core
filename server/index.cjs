// Cowork UI proxy server — zero-dependency Node http server.
//
// This server IS the app's backend:
//   - Router: space → model dispatch. Ordinary spaces chat with Lemonade
//     directly (OpenAI-compatible /v1/chat/completions) with the space's
//     system prompt + memories injected; the Diary tab routes through the
//     diary-companion sidecar (called exactly ONCE per exchange — it logs
//     every call, no retry).
//   - Model manager: front for Lemonade's /api/v1 + /v1 management verbs
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
const rag = require('./rag.cjs');

const PORT = Number(process.env.UI_PORT || 8021);
const HOST = process.env.UI_HOST || '0.0.0.0';
const LEMONADE = process.env.LEMONADE_BASE_URL || 'http://lemonade:13305';
const LEMONADE_KEY = process.env.LEMONADE_API_KEY || 'local';
const DIARY_BASE = process.env.DIARY_BASE_URL || 'http://cowork-diary-companion:8010';
const DIARY_TOKEN = process.env.DIARY_AUTH_TOKEN || '';
const UI_AUTH_TOKEN = (process.env.UI_AUTH_TOKEN || DIARY_TOKEN).trim();
const DIST_DIR = path.join(__dirname, '..', 'dist');
const DATA_DIR = process.env.UI_DATA_DIR || path.join(__dirname, 'ui-data');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const HISTORY_CAP = 40;
const SPAFallbacks = ['/', '/chat', '/diary', '/projects', '/settings'];
const PROVIDERS_FILE = path.join(DATA_DIR, 'providers.json');
rag.init({ dataDir: DATA_DIR, lemonadeUrl: LEMONADE, headersFn: () => lemonadeHeaders() });

// Claude-style projects (v4 rework, user feedback 2026-09-03): the fixed demo
// spaces were deleted per user request — projects are user-created only.
// Each project: goal/description, instructions (Claude's "custom instructions"),
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
  // Match diary-companion's single-user model: an empty token keeps local-dev
  // open, while every /api/* request is protected when a token is configured.
  if (!UI_AUTH_TOKEN) return true;
  const supplied = clientToken(req);
  if (!supplied) return false;
  const expectedBytes = Buffer.from(UI_AUTH_TOKEN);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && crypto.timingSafeEqual(expectedBytes, suppliedBytes);
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
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
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
  }
}

function lemonadeHeaders(extra) {
  const h = { 'Content-Type': 'application/json' };
  if (LEMONADE_KEY && LEMONADE_KEY !== 'local') h.Authorization = `Bearer ${LEMONADE_KEY}`;
  return { ...h, ...extra };
}

function diaryHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (DIARY_TOKEN) h.Authorization = `Bearer ${DIARY_TOKEN}`;
  return h;
}

// ── Projects config (Claude-style: instructions, files, memories, model) ───

function loadProjects() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    if (Array.isArray(parsed.projects)) return parsed.projects;
  } catch {
    /* first boot */
  }
  return [];
}

function saveProjects(projects) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${PROJECTS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ projects }, null, 2));
  fs.renameSync(tmp, PROJECTS_FILE);
}

let PROJECTS = loadProjects();

function getProject(id) {
  return PROJECTS.find((p) => p.id === id) || null;
}

// ── Provider registry (step 9): generic OpenAI-compatible endpoints ────────
// One adapter covers all of them (same /chat/completions shape). Seeded with
// lemonade so existing behavior is byte-identical; projects without a
// provider field are treated as lemonade.
function loadProviders() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8'));
    if (Array.isArray(parsed.providers)) return parsed.providers;
  } catch {
    /* first boot */
  }
  return [];
}

function saveProviders(providers) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${PROVIDERS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ providers }, null, 2));
  fs.renameSync(tmp, PROVIDERS_FILE);
}

let PROVIDERS = loadProviders();
if (!PROVIDERS.some((pr) => pr.id === 'lemonade')) {
  PROVIDERS.unshift({ id: 'lemonade', label: 'Local (Lemonade)', baseUrl: LEMONADE, apiKey: LEMONADE_KEY });
  saveProviders(PROVIDERS);
}

function getProvider(id) {
  return PROVIDERS.find((pr) => pr.id === id) || PROVIDERS.find((pr) => pr.id === 'lemonade') || null;
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

// Chats are history keys, Claude-style: each project holds ordered chat metas.
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
    fs.unlinkSync(path.join(DATA_DIR, `history-${chatId.replace(/[^a-zA-Z0-9_-]/g, '')}.json`));
  } catch {
    /* no history file — fine */
  }
  return true;
}

// Free (non-project) chat metas — persisted server-side so recent chats
// survive across browsers/devices (localStorage was the only home before).
const FREE_CHATS_FILE = path.join(DATA_DIR, 'free-chats.json');

function loadFreeChats() {
  try {
    const raw = JSON.parse(fs.readFileSync(FREE_CHATS_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function saveFreeChats(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FREE_CHATS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, FREE_CHATS_FILE);
}

let FREE_CHATS = loadFreeChats();

function deleteFreeChat(chatId) {
  const before = FREE_CHATS.length;
  FREE_CHATS = FREE_CHATS.filter((c) => c.id !== chatId);
  if (FREE_CHATS.length === before) return false;
  saveFreeChats(FREE_CHATS);
  try {
    fs.unlinkSync(path.join(DATA_DIR, `history-${chatId.replace(/[^a-zA-Z0-9_-]/g, '')}.json`));
  } catch {
    /* no history file — fine */
  }
  return true;
}

// ── History persistence (atomic write, JSON per space) ─────────────────────

function historyPath(spaceId) {
  const safe = String(spaceId).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(DATA_DIR, `history-${safe}.json`);
}

function readHistory(spaceId) {
  try {
    return JSON.parse(fs.readFileSync(historyPath(spaceId), 'utf8')).history || [];
  } catch {
    return [];
  }
}

function writeHistory(spaceId, history) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = historyPath(spaceId);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ history }, null, 2));
  fs.renameSync(tmp, file);
}

// ── Model manager (fronts Lemonade /api/v1 + /v1 mgmt verbs) ───────────────

// The last model Lemonade reported as loaded — the non-hardcoded default for
// projects that have not picked a model yet (replaces the old DEFAULT_MODEL
// literal per feature doc Item 0 / step 9).
let LAST_LOADED_MODEL = null;

// ── Auto model router (feature doc Item 4 / master step 12) ───────────────
// Roles are config, never hardcoded model names: role→model mapping lives in
// ui/server/auto-roles.json (created on first use; never ships a default
// model string). Auto mode keeps BOTH role models loaded — no unload/swap.
const AUTO_ROLES_FILE = path.join(DATA_DIR, 'auto-roles.json');
let AUTO_ROLES = null; // { fast, smart } | null until first read

function autoRoles() {
  if (AUTO_ROLES) return AUTO_ROLES;
  try {
    const parsed = JSON.parse(fs.readFileSync(AUTO_ROLES_FILE, 'utf8'));
    if (parsed && typeof parsed.fast === 'string' && typeof parsed.smart === 'string') {
      AUTO_ROLES = { fast: parsed.fast, smart: parsed.smart };
    }
  } catch {
    /* not written yet */
  }
  return AUTO_ROLES;
}

function setAutoRoles(next) {
  AUTO_ROLES = { fast: String(next.fast), smart: String(next.smart) };
  const tmp = `${AUTO_ROLES_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(AUTO_ROLES, null, 2));
  fs.renameSync(tmp, AUTO_ROLES_FILE);
}

async function ensureModelLoaded(name) {
  const installed = await modelsInstalled();
  const m = installed.find((x) => x.name === name);
  if (!m) throw new Error(`model not installed: ${name}`);
  if (!m.loaded) {
    await fetchJson(
      `${LEMONADE}/api/v1/load`,
      { method: 'POST', headers: lemonadeHeaders(), body: JSON.stringify({ model_name: name }) },
      120000,
    );
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
    const r = await fetchJson(
      `${LEMONADE}/v1/chat/completions`,
      {
        method: 'POST',
        headers: lemonadeHeaders(),
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
  const [list, health] = await Promise.allSettled([
    fetchJson(`${LEMONADE}/api/v1/models`, { headers: lemonadeHeaders() }, 8000),
    fetchJson(`${LEMONADE}/api/v1/health`, { headers: lemonadeHeaders() }, 8000),
  ]);
  if (list.status !== 'fulfilled' || !list.value.ok) {
    throw new Error(`lemonade list failed: ${list.status === 'fulfilled' ? list.value.status : 'unreachable'}`);
  }
  const loadedNames = new Set();
  if (health.status === 'fulfilled' && health.value.ok) {
    for (const m of health.value.body.all_models_loaded || []) {
      if (m.loaded && m.model_name) loadedNames.add(m.model_name);
    }
  }
  const installed = (list.value.body.data || [])
    // Lemonade registers cosmetic hash-ID duplicates of some models (noted in
    // MIGRATION.md) — hide bare hex-hash names (32/40-char SHA-like) from the UI.
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
  // Hugging Face's public search API, called server-side. (Lemonade's newer
  // builds add /v1/registry/search; the deployed image predates it — this
  // works regardless and keeps the UI contract stable.)
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
  // Param name is `checkpoint` per the deployed Lemonade; each variant's id is
  // `<repo>/<variant-name>`-style GGUF filename reference the pull verb accepts.
  const r = await fetchJson(
    `${LEMONADE}/api/v1/pull/variants?checkpoint=${encodeURIComponent(repo)}`,
    { headers: lemonadeHeaders() },
    20000,
  );
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
          // Tolerant: on failure, fall back to just the current month so the
          // Diary tab still renders today's file.
          const now = new Date();
          const currentId = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
          const currentLabel = now.toLocaleString('en-US', { month: 'long', year: 'numeric' });
          try {
            const r = await fetchJson(`${DIARY_BASE}/api/months`, { headers: diaryHeaders() }, 15000);
            const months = (r.ok && Array.isArray(r.body?.months) ? r.body.months : [])
              .filter((m) => m && typeof m.id === 'string' && /^\d{4}-\d{2}$/.test(m.id))
              .map((m) => ({ id: m.id, label: m.label || m.id }));
            if (!months.some((m) => m.id === currentId)) {
              months.push({ id: currentId, label: currentLabel });
            }
            months.sort((a, b) => a.id.localeCompare(b.id));
            return months;
          } catch {
            return [{ id: currentId, label: currentLabel }];
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

async function handleChat(req, res, body) {
  const { spaceId, message, history } = body || {};
  if (!message || typeof message !== 'string') return json(res, 400, { error: 'message required' });

  const msgs = (Array.isArray(history) ? history : [])
    .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content)
    .slice(-HISTORY_CAP)
    .map((h) => ({ role: h.role, content: h.content }));
  msgs.push({ role: 'user', content: message });

  // ── Project context (Claude-style): instructions + knowledge files prepend
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
    filesBlock = await rag.filesContext(project.id, project.files, message);
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

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // ── Diary tab: sidecar pipeline, called exactly once (no retry, no stream) ──
  if (spaceId === 'diary') {
    const full = await fetchJson(
      `${DIARY_BASE}/v1/chat/completions`,
      { method: 'POST', headers: diaryHeaders(), body: JSON.stringify({ messages: msgs }) },
      300000,
    );
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

  // Projects without a provider field are lemonade (seeded default), so every
  // existing project behaves exactly as before (feature doc Item 0 guardrail).
  const wantsAuto = !!(project && project.routing === 'auto' && (!project.provider || project.provider === 'lemonade'));
  const provider = getProvider(wantsAuto ? 'lemonade' : (project && project.provider) || 'lemonade');

  let model = (project && project.model) || null;
  let routedRole = null;
  if (wantsAuto) {
    const roles = autoRoles();
    if (!roles) {
      return json(res, 400, { error: 'Auto routing is not configured yet — pick Fast and Smart models in the model popup first.' });
    }
    routedRole = await classifyFastOrSmart(message); // fail-open inside
    model = roles[routedRole];
  } else if (!model && provider.id === 'lemonade') {
    // No hardcoded model name (step 9): default to whatever Lemonade currently
    // reports as loaded.
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

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  send({ type: 'meta', model, chatId: chatId || undefined, route: routedRole || undefined });

  // ── Tool rounds (Pi-style loop, master step 13): stream a completion; if
  // the model called built-in tools, execute them, append role:'tool'
  // results, and stream a continuation. Max 3 rounds so a broken model can
  // never loop forever. No tool-calling-capable model in the roster yet, so
  // this is dormant plumbing until one lands — the loop simply never fires.
  const decoder = new TextDecoder();
  let roundMessages = wire;
  for (let round = 0; round < 3; round++) {
    let upstream;
    try {
      upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify({ model, messages: roundMessages, stream: true, tools: TOOL_DEFS }),
      });
    } catch (err) {
      if (round === 0) return json(res, 502, { error: `${provider.label} unreachable: ${err.message}` });
      send({ type: 'error', text: `${provider.label} unreachable: ${err.message}` });
      break;
    }
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      const msg = `${provider.label} ${upstream.status}: ${detail.slice(0, 200)}`;
      if (round === 0) return json(res, 502, { error: msg });
      send({ type: 'error', text: msg });
      break;
    }

    const toolCalls = new Map(); // index -> {id, name, args}
    let sawAnything = false;
    try {
      for await (const chunk of upstream.body) {
        let buffer = '';
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
      send({ type: 'error', text: String(err?.message || err) });
      break;
    }

    // Fallback: some models/non-streaming paths return nothing on stream. One
    // non-streaming retry is safe for generation (no side effects, unlike diary).
    if (!sawAnything) {
      try {
        const full = await fetchJson(
          upstreamUrl,
          { method: 'POST', headers: upstreamHeaders, body: JSON.stringify({ model, messages: roundMessages, tools: TOOL_DEFS }) },
          300000,
        );
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

    if (round === 2 || toolCalls.size === 0) break; // last round or no tools requested

    // Execute each requested tool and append assistant tool_calls + results.
    const assistantMsg = { role: 'assistant', content: null, tool_calls: [...toolCalls.entries()].map(([i, tc]) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } })) };
    roundMessages = [...roundMessages, assistantMsg];
    for (const [, tc] of toolCalls) {
      const result = executeToolCall(project, tc.name, tc.args);
      send({ type: 'tool_result', name: tc.name, text: result.slice(0, 300) });
      roundMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }

  send({ type: 'done', model });
  res.end();
}

// ── Routing ────────────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  try {
    if (p.startsWith('/api/') && !checkAuth(req)) return unauthorized(res);

    if (p === '/api/workspace') {
      return json(res, 200, { projects: PROJECTS, freeChats: FREE_CHATS });
    }

    // ── Provider registry (step 9): list / connect / remove. GET never returns
    // a saved apiKey in plaintext — masked, e.g. sk-…last4.
    if (p === '/api/providers' && req.method === 'GET') {
      return json(res, 200, {
        providers: PROVIDERS.map((pr) => ({ id: pr.id, label: pr.label, baseUrl: pr.baseUrl, apiKeyMasked: maskKey(pr.apiKey) })),
      });
    }
    if (p === '/api/providers' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      const label = String(body.label || '').trim().slice(0, 80);
      let baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '');
      const apiKey = String(body.apiKey || '').trim();
      if (!label) return json(res, 400, { error: 'label required' });
      if (!/^https?:\/\//.test(baseUrl)) return json(res, 400, { error: 'baseUrl must be an http(s) URL' });
      const id = `prov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      PROVIDERS.push({ id, label, baseUrl, apiKey });
      saveProviders(PROVIDERS);
      return json(res, 200, { id, label, baseUrl, apiKeyMasked: maskKey(apiKey) });
    }
    const provDel = p.match(/^\/api\/providers\/([^/]+)$/);
    if (provDel && req.method === 'DELETE') {
      const id = decodeURIComponent(provDel[1]);
      if (id === 'lemonade') return json(res, 400, { error: 'the lemonade provider cannot be removed' });
      const before = PROVIDERS.length;
      PROVIDERS = PROVIDERS.filter((pr) => pr.id !== id);
      if (PROVIDERS.length === before) return json(res, 404, { error: 'no such provider' });
      saveProviders(PROVIDERS);
      // Projects pointing at the removed provider fall back to lemonade.
      for (const pr of PROJECTS) {
        if (pr.provider === id) {
          delete pr.provider;
        }
      }
      saveProjects(PROJECTS);
      return json(res, 200, { ok: true });
    }

    // ── Live stats (Lemonade /v1/stats + /v1/system-stats passthrough, trimmed).
    // Tolerant: returns nulls per key rather than failing when Lemonade is down.
    if (p === '/api/stats') {
      const [gen, sys] = await Promise.allSettled([
        fetchJson(`${LEMONADE}/v1/stats`, { headers: lemonadeHeaders() }, 6000),
        fetchJson(`${LEMONADE}/v1/system-stats`, { headers: lemonadeHeaders() }, 6000),
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

    // ── Projects CRUD (Claude-style) ──
    if (p === '/api/auto-roles') {
      if (req.method === 'GET') {
        const roles = autoRoles();
        return json(res, 200, { configured: !!roles, roles: roles || null });
      }
      if (req.method === 'PUT') {
        let raw = '';
        for await (const c of req) raw += c;
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
        return json(res, 200, { configured: true, roles: AUTO_ROLES });
      }
    }

    if (p === '/api/projects' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
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
        rag.indexProjectFile(project.id, f.name, f.content)
          .then((r) => console.log(`[rag] indexed ${project.id}/${f.name}:`, JSON.stringify(r)))
          .catch((err) => console.warn(`[rag] index failed for ${project.id}/${f.name}:`, err?.message || err));
      }
      return json(res, 200, project);
    }

    const projMatch = p.match(/^\/api\/projects\/([^/]+)$/);
    if (projMatch && req.method === 'DELETE') {
      const id = decodeURIComponent(projMatch[1]);
      const before = PROJECTS.length;
      PROJECTS = PROJECTS.filter((pr) => pr.id !== id);
      if (PROJECTS.length === before) return json(res, 404, { error: 'no such project' });
      saveProjects(PROJECTS);
      // Drop the project's RAG index too (best-effort).
      try {
        for (const suffix of ['.db', '.db-wal', '.db-shm']) {
          fs.rmSync(path.join(DATA_DIR, 'rag', `${id}${suffix}`), { force: true });
        }
      } catch { /* best effort */ }
      return json(res, 200, { ok: true });
    }

    const projCfg = p.match(/^\/api\/projects\/([^/]+)\/config$/);
    if (projCfg && req.method === 'POST') {
      const id = decodeURIComponent(projCfg[1]);
      let raw = '';
      for await (const c of req) raw += c;
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
          if (!nextNames.has(prev.name)) rag.deleteProjectFile(id, prev.name);
        }
        for (const next of project.files) {
          const prev = prevByName.get(next.name);
          if (!prev || prev.content !== next.content) {
            rag.indexProjectFile(id, next.name, next.content)
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
        let raw = '';
        for await (const c of req) raw += c;
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
        let raw = '';
        for await (const c of req) raw += c;
        try {
          const body = JSON.parse(raw);
          if (!Array.isArray(body.chats)) return json(res, 400, { error: 'chats array required' });
          FREE_CHATS = body.chats
            .filter((c) => c && typeof c.id === 'string')
            .slice(0, 200)
            .map((c) => ({
              id: c.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
              title: String(c.title || 'New chat').slice(0, 120),
              updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : Date.now(),
            }));
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
      const [lemonade, diary] = await Promise.allSettled([
        fetchJson(`${LEMONADE}/api/v1/models`, { headers: lemonadeHeaders() }, 5000),
        fetchJson(`${DIARY_BASE}/api/health`, { headers: diaryHeaders() }, 5000),
      ]);
      return json(res, 200, {
        lemonadeUp: lemonade.status === 'fulfilled' && lemonade.value.ok,
        diaryUp: diary.status === 'fulfilled' && diary.value.ok,
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
      let raw = '';
      for await (const c of req) raw += c;
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      if (!body.checkpoint) return json(res, 400, { error: 'checkpoint required' });
      const r = await fetchJson(
        `${LEMONADE}/api/v1/pull`,
        { method: 'POST', headers: lemonadeHeaders(), body: JSON.stringify({ checkpoint: body.checkpoint }) },
        600000,
      );
      return json(res, r.ok ? 200 : 502, r.ok ? { jobId: r.body?.job_id || r.body?.id || 'pull' } : { error: `pull failed: ${r.status}` });
    }

    if (p === '/api/models/delete' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      if (!body.name) return json(res, 400, { error: 'name required' });
      const r = await fetchJson(
        `${LEMONADE}/api/v1/delete`,
        { method: 'POST', headers: lemonadeHeaders(), body: JSON.stringify({ model_name: body.name }) },
        60000,
      );
      return json(res, r.ok ? 200 : 502, r.ok ? { ok: true } : { error: `delete failed: ${r.status}` });
    }

    for (const verb of ['load', 'unload']) {
      if (p === `/api/models/${verb}` && req.method === 'POST') {
        let raw = '';
        for await (const c of req) raw += c;
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return json(res, 400, { error: 'invalid JSON' });
        }
        if (!body.name) return json(res, 400, { error: 'name required' });
        const r = await fetchJson(
          `${LEMONADE}/api/v1/${verb}`,
          { method: 'POST', headers: lemonadeHeaders(), body: JSON.stringify({ model_name: body.name }) },
          120000,
        );
        return json(res, r.ok ? 200 : 502, r.ok ? { ok: true } : { error: `${verb} failed: ${r.status}` });
      }
    }

    if (p === '/api/models/downloads') {
      const r = await fetchJson(`${LEMONADE}/api/v1/downloads`, { headers: lemonadeHeaders() }, 8000);
      if (!r.ok) return json(res, 200, []);
      const arr = Array.isArray(r.body) ? r.body : r.body?.jobs || r.body?.downloads || [];
      return json(res, 200, arr.map((j) => ({ id: j.id || j.job_id || '', model: j.model || j.model_name || j.checkpoint || '', progress: typeof j.progress === 'number' ? j.progress : null, status: j.status || j.state || '' })));
    }

    if (p === '/api/diary/source') {
      const months = await corpusSource.listMonths();
      return json(res, 200, { source: corpusSource.name, months });
    }

    if (p === '/api/diary/today' || p === '/api/diary/history') {
      const monthId = url.searchParams.get('month');
      const data = await corpusSource.readMonth(monthId);
      return json(res, 200, data);
    }

    if (p === '/api/chat' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'invalid JSON' });
      }
      return handleChat(req, res, body);
    }

    // Unused legacy spaces endpoints removed with the spaces UI (v4).

    const historyMatch = p.match(/^\/api\/chats\/([^/]+)\/history$/);
    if (historyMatch) {
      const spaceId = decodeURIComponent(historyMatch[1]);
      if (req.method === 'GET') return json(res, 200, { history: readHistory(spaceId) });
      if (req.method === 'POST') {
        let raw = '';
        for await (const c of req) raw += c;
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
    if (!filePath.startsWith(DIST_DIR)) return json(res, 403, { error: 'forbidden' });
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
    json(res, 500, { error: String((err && err.message) || err) });
  }
}

if (require.main === module) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!UI_AUTH_TOKEN) {
    console.warn('WARNING: cowork-ui API authentication is disabled; set DIARY_AUTH_TOKEN or UI_AUTH_TOKEN before tunnel exposure.');
  }
  http.createServer(handleRequest).listen(PORT, HOST, () => {
    console.log(`cowork-ui listening on http://${HOST}:${PORT} (lemonade: ${LEMONADE}, diary: ${DIARY_BASE})`);
  });
}

module.exports = { checkAuth, handleRequest };
