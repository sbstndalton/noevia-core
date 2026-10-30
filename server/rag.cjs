// Project-scoped RAG index (feature doc Item 8 / master step 10).
//
// Technique mirrors diary-companion/agent/retrieval.py (sqlite-vec + an
// OpenAI-compatible /embeddings call), but is deliberately a separate store:
// one sqlite file per project under <DATA_DIR>/rag/<projectId>.db. No shared
// index, no dependency on the diary sidecar being alive, and its index.db is
// never touched.
//
// Native deps load lazily and optionally: if either is missing, indexing and
// search no-op and chat falls back to small-file direct injection — the server
// must never fail to boot because of RAG.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { frameUntrusted } = require('./prompt-framing.cjs');
const { notice: documentNotice } = require('./document-sources.cjs');
const { readCappedText, readCappedJson } = require('./http.cjs');
const { quoteName, quotedNames } = require('./quoted-name.cjs');
const { frame } = require('./embedding-profile.cjs');
const { createEmbeddingConfig } = require('./embedding-config.cjs');
const slots = require('./vector-slots.cjs');

// #1760: every embedding and rerank request goes through the on-this-network fetch (service-endpoint.cjs),
// which resolves a name itself and refuses the connection unless every answer is on this network and not
// public by the Rust address check (ssrf.cjs). The address check when an address is SET (embedding-address.cjs)
// cannot see a name that answers private then and public later (DNS rebinding); this one runs at connect.
// Link-local is refused. A redirect is refused by it too. `setRagFetch` is the test seam (exported only under tests).
// Embeddings are LOCAL-ONLY (local-first policy): with no EMBEDDING_SERVICE_URL / EMBEDDING_BASE_URL they fall back to
// INFERENCE_BASE_URL, so pointing that at a public API makes every embedding fail closed; index.cjs warns at start-up (#1762).
let netFetch = null;
function ragFetch(input, init) {
  if (!netFetch) netFetch = makeRagFetch();
  return netFetch(input, init);
}
function makeRagFetch(extra = {}) {
  const { createServiceFetch } = require('./service-endpoint.cjs');
  return createServiceFetch({ linkLocal: false, addressesPublic: (a) => require('./ssrf.cjs').ssrfWasm().ssrfAddressesPublic(a), ...extra });
}
function setRagFetch(fn) { const prev = netFetch; netFetch = fn; return prev; }
// #1762: the test seam (setRagFetch swaps the on-this-network fetch) is only exported under the test runner,
// so production code cannot reach it (same rule as provider-egress.cjs).
const testSeam = process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test' ? { _test: { setRagFetch, makeRagFetch, rerankBackend, rerankState: () => rerank, openIndex } } : {};
// The reranker's backend, built here so a test can drive it without a chat. #1665: `backend` is
// rerank-target.cjs's 'llamacpp' (POST /v1/rerank) or 'tei' (POST /rerank); both go through ragFetch.
// #1638: `apiKey` comes from the reranker's effective environment (rerank-settings.cjs), which drops RERANK_API_KEY
// for a reranker on another machine than the deployment's.
function rerankBackend(baseUrl, backend = 'llamacpp', model = process.env.RERANK_MODEL || null, apiKey = process.env.RERANK_API_KEY || null) {
  const { llamaRerankBackend, teiRerankBackend } = require('./decision/backends.cjs');
  const fetchImpl = (u, i) => ragFetch(u, { ...i, redirect: 'error' });
  /* #697: the inference key never goes to a reranker sidecar */
  if (backend === 'tei') return teiRerankBackend({ baseUrl, fetchImpl, apiKey });
  return llamaRerankBackend({ baseUrl, fetchImpl, model: model || null, apiKey });
}

// Injected by init() from index.cjs (keeps this module testable standalone).
let RAG_DIR = null;
// #1636: endpoint, model and profile come from the one embedding configuration (embedding-config.cjs):
// the active target embeds queries and new chunks; a re-index fills the next target's slot
// (embedding-migration.cjs). A target without baseUrl embeds on the inference engine; one with a
// baseUrl (e.g. a CPU-only llama-server, so retrieval never evicts the chat model on a single-slot
// engine) never receives the inference credentials.
let embeddingConfig = createEmbeddingConfig({ env: {} });
let inferenceBase = null;
let inferenceHeaders = () => ({ 'Content-Type': 'application/json' });
let dataDirForUser = null;
let listUserIds = () => [];
let userActive = () => true;
let enterInference = () => () => {};
// #1636: told after each index run, so a re-index under way also covers newly indexed files.
let afterIndex = () => {};
function onIndexed(fn) { afterIndex = typeof fn === 'function' ? fn : () => {}; }

function init({ dataDir, embedModel, inferenceUrl, headersFn, userDataDirFn, userActive: userActiveFn, inferenceGuard, embeddingConfig: config, listUserIds: listUsers }) {
  RAG_DIR = process.env.RAG_DIR || path.join(dataDir, 'rag');
  dataDirForUser = userDataDirFn || null;
  userActive = userActiveFn || (() => true);
  listUserIds = listUsers || (() => []);
  // Without an injected configuration (tests, tools) the environment seeds one held in memory.
  embeddingConfig = config || createEmbeddingConfig({ env: process.env, fallbackModel: embedModel || 'default' });
  inferenceBase = inferenceUrl;
  if (headersFn) inferenceHeaders = headersFn;
  if (inferenceGuard) enterInference = inferenceGuard;
  initRerank();
  // A new init() (endpoint/model swap, or a test isolating scenarios) invalidates whatever the
  // last readiness probe found — never serve a cached verdict from before the reconfiguration.
  retrievalProbeCache = null;
  retrievalProbeInFlight = null;
  servedCache = new Map();
  servedInFlight = new Map();
}
// Chunk sizing starts from diary-companion's shape (subsection-scale bodies).
// ~1200 chars with a 150-char overlap keeps chunks coherent.
const CHUNK_SIZE = 1200;
const CHUNK_STRIDE = 150;
// Files at or under this size skip embedding entirely and inject verbatim —
// a two-sentence file must not round-trip an embedding call.
const DIRECT_INJECT_MAX = 2400;
const TOP_K = 6;
// Overall cap on file text put into one prompt by filesContext, so 60 large
// sources cannot add ~1.4M characters. Env-overridable like the rerank knobs.
const FILES_CONTEXT_MAX_CHARS = clampInt(process.env.FILES_CONTEXT_MAX_CHARS, 120_000, 4_000, 2_000_000);
const LARGE_FILE_HEAD = 24000;
const MIN_SCORE = 0.3;

// Optional cross-encoder rerank (docs/research/system-one; experiments/system-one/rag was removed
// in #846, see git history at f9dc5df2). Off unless
// NOEVIA_FEATURE_RAG_RERANK=1 and RERANK_BASE_URL are set. Retrieval then pulls a wider cosine pool
// and the reranker picks the kept chunks; any failure or a missed deadline falls back to today's
// cosine top-6, so chat never waits longer than the deadline. KEEP defaults to 6, not the
// measured-best 3: 3 won on the synthetic corpus (91% vs 86%) but it demoted gold chunks on
// exact-number questions, and with only 3 kept one demotion loses the answer outright. POOL defaults
// to 12: on DaServer's GPU 12 chunks rerank in ~2 s vs ~3.9 s for 24, and 12->6 scored 89% vs 86%.
const RERANK_POOL_MAX = 24;
let rerank = null; // { decisions, pool, keep, deadlineMs }
// #1665: the environment the reranker is configured from. The deployment's by default; index.cjs points it at
// rerank-settings.cjs (the admin's saved switch over the deployment's) and calls reloadRerank() after a change.
let rerankEnv = () => process.env;
function configureRerank(envFn) {
  rerankEnv = typeof envFn === 'function' ? envFn : () => process.env;
  initRerank();
}
function reloadRerank() { initRerank(); }
function initRerank() {
  // #697: never on the shared inference engine unless the operator allows it (rerank-target.cjs).
  let env;
  try { env = rerankEnv() || process.env; } catch { env = process.env; }
  const target = require('./rerank-target.cjs').rerankTarget(env);
  if (target.reason) console.warn('[rag] rerank off:', target.reason);
  if (!target.enabled) { rerank = null; return; }
  const baseUrl = target.baseUrl;
  const { createDecisions } = require('./decision/index.cjs');
  const backend = rerankBackend(baseUrl, target.backend, target.model, Object.prototype.hasOwnProperty.call(env, 'RERANK_API_KEY') ? env.RERANK_API_KEY || null : process.env.RERANK_API_KEY || null);
  const decisions = createDecisions({
    backends: { [backend.id]: backend },
    chains: { 'rag.rerank': [backend.id] },
    log: (e) => { if (e.failed || e.fellBack) console.warn('[rag] rerank', JSON.stringify(e)); },
  });
  rerank = { backend: target.backend, decisions, pool: clampInt(process.env.RAG_RERANK_POOL, 12, TOP_K, RERANK_POOL_MAX), keep: clampInt(process.env.RAG_RERANK_KEEP, 6, 1, RERANK_POOL_MAX), deadlineMs: clampInt(process.env.RAG_RERANK_DEADLINE_MS, 3000, 100, 30000) };
}
function clampInt(v, dflt, lo, hi) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; }

// Pure: cosine-ordered pool in, kept hits out. Fallback is the cosine top-K. Never throws.
async function rerankPool({ query, pool, decisions, keep, deadlineMs, fallbackK = TOP_K }) {
  const cosine = pool.slice(0, fallbackK);
  if (!decisions || pool.length <= 1) return cosine;
  const items = pool.map((h, i) => ({ id: String(i), label: h.body, score: h.score }));
  const ids = cosine.map((_, i) => String(i));
  try {
    const r = await decisions.rank({
      purpose: 'rag.rerank', question: String(query), items,
      fallback: { selected: ids, scores: Object.fromEntries(items.map((it) => [it.id, it.score])), confidence: null },
      constraints: { deadlineMs },
    });
    if (r.source === 'fallback') return cosine;
    return r.selected.slice(0, keep).map((id) => pool[Number(id)]).filter(Boolean);
  } catch { return cosine; }
}

let depsCache = null;
function loadDeps() {
  if (depsCache) return depsCache;
  try {
    const Database = require('better-sqlite3');
    const sqliteVec = require('sqlite-vec');
    depsCache = { Database, sqliteVec };
  } catch (err) {
    console.warn(`[rag] deps unavailable (${err.message}) — project RAG disabled, chat unaffected`);
    depsCache = { broken: true };
  }
  return depsCache;
}

// "Index support installed": native sqlite-vec/better-sqlite3 deps loaded. Unchanged meaning —
// callers that only care whether the index CAN run (filesContext, the internal MCP tool, the
// #340 tri-state below) keep using this. It says nothing about whether the embedding endpoint
// configured for this deployment is actually reachable right now.
function ragAvailable() {
  return !loadDeps().broken;
}

// Bounded, cached probe of the configured embedding endpoint (#340): "index support installed"
// does not mean "search works" — a restarting or misconfigured embedder leaves the index able to
// store text but never gains vectors, and search silently returns nothing (see indexProjectFileNow
// and searchProject above). /api/health polls every few seconds, so this must be cheap: a fixed,
// synthetic probe string (never real project or chat content), a short timeout so one slow health
// poll cannot stall behind it, and a short cache so concurrent/rapid polls share one probe instead
// of hammering the embedder.
const RETRIEVAL_PROBE_TEXT = ['noevia health probe'];
const RETRIEVAL_PROBE_TIMEOUT_MS = clampInt(process.env.RETRIEVAL_PROBE_TIMEOUT_MS, 2500, 200, 5000);
const RETRIEVAL_PROBE_TTL_MS = clampInt(process.env.RETRIEVAL_PROBE_TTL_MS, 45000, 200, 300000);
let retrievalProbeCache = null; // { status: 'available'|'degraded', at: number }
let retrievalProbeInFlight = null; // shared promise while a probe is in flight

const HELD_BY_MAINTENANCE = Symbol('retrieval-probe-held-by-maintenance');

// A dedicated embedding sidecar (EMBEDDING_BASE_URL set) is not the shared inference router: it
// never holds the router's maintenance gate, and a tiny synthetic embedding request there cannot
// load or evict the chat model. Safe to call directly, with no inference guard at all.
async function probeEmbeddingSidecar(base, target) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RETRIEVAL_PROBE_TIMEOUT_MS);
  try {
    const input = frame(target.profile, RETRIEVAL_PROBE_TEXT, { kind: 'query' });
    const res = await ragFetch(`${base.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: target.model, input }),
      redirect: 'error', // an embeddings server never sends the text on to another address
      signal: ctrl.signal,
    });
    if (!res.ok) return false;
    const body = await readCappedJson(res, 1024 * 1024);
    const items = Array.isArray(body?.data) ? body.data : [];
    return items.length >= 1 && Array.isArray(items[0]?.embedding) && items[0].embedding.length > 0;
  } catch {
    // Network failure, non-2xx thrown by a stub, JSON error, or the timeout's abort — all mean
    // the same thing to a caller: the sidecar cannot be reached right now.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// No dedicated sidecar: embeddings share the chat engine. A live embedding request here would
// hit the same single-slot router chat uses, which can load the embed model and evict whatever
// chat model is loaded — every TTL window, triggered by nothing more than a health poll (e.g.
// someone with Settings open). GET /v1/models is side-effect-free and answers the same question:
// is EMBED_MODEL actually available there right now.
async function probeEmbeddingRouter(base, target) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RETRIEVAL_PROBE_TIMEOUT_MS);
  try {
    const res = await ragFetch(`${base.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/models`, {
      headers: inferenceHeaders(),
      redirect: 'error',
      signal: ctrl.signal,
    });
    if (!res.ok) return false;
    const body = await readCappedJson(res, 2 * 1024 * 1024);
    const ids = Array.isArray(body?.data) ? body.data.map((m) => m?.id) : [];
    return ids.includes(target.model);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function probeEmbeddingEndpoint() {
  const target = embeddingConfig.active();
  // An unknown profile cannot embed anything correctly: retrieval is degraded, not available.
  try { frame(target.profile, [], {}); } catch { return false; }
  if (target.baseUrl) return probeEmbeddingSidecar(target.baseUrl, target);
  if (!inferenceBase) return false;
  // The router's maintenance gate (autotune, preset apply) is a "a human is mid-change" signal,
  // never an outage — reporting 'degraded' every time someone tunes the model would be a false
  // alarm distinct from an actually unreachable embedder.
  let leave;
  try {
    leave = enterInference();
  } catch {
    return HELD_BY_MAINTENANCE;
  }
  try {
    return await probeEmbeddingRouter(inferenceBase, target);
  } finally {
    leave();
  }
}

// Tri-state retrieval readiness for /api/health and the Settings/Capabilities UI:
//   'unavailable' — native index deps are missing; retrieval cannot run at all (unchanged case).
//   'degraded'    — the index is installed but the configured embedding endpoint/model did not
//                    answer the probe within the timeout; small files and source excerpts still
//                    reach the model (filesContext's direct-injection path), semantic search does not.
//   'available'   — the probe found the embedder answering (sidecar) or the embed model listed
//                    (router) within the timeout.
// Never throws; never issues more than one live probe per RETRIEVAL_PROBE_TTL_MS window.
// #1668: the admin turned the embedding service off (embedding-service.cjs). Search says so
// instead of probing a stopped container; small files and excerpts still reach the model.
function embeddingOff(target = null) {
  const service = require('./embedding-service.cjs').current();
  if (!service || !service.managed() || service.enabled()) return false;
  const t = target || embeddingConfig.active();
  return !t || !t.baseUrl || service.isAt(t.baseUrl);
}

async function retrievalStatus() {
  if (!ragAvailable()) return 'unavailable';
  if (embeddingOff()) return 'off';
  const now = Date.now();
  if (retrievalProbeCache && now - retrievalProbeCache.at < RETRIEVAL_PROBE_TTL_MS) {
    return retrievalProbeCache.status;
  }
  if (!retrievalProbeInFlight) {
    retrievalProbeInFlight = probeEmbeddingEndpoint()
      .then((result) => {
        // Model maintenance holding the gate is not itself a finding — nothing was actually
        // probed, so keep whatever the last real probe found, or assume available until one runs.
        if (result === HELD_BY_MAINTENANCE) return retrievalProbeCache ? retrievalProbeCache.status : 'available';
        return result ? 'available' : 'degraded';
      })
      .catch(() => 'degraded')
      .then((status) => {
        retrievalProbeCache = { status, at: Date.now() };
        retrievalProbeInFlight = null;
        return status;
      });
  }
  return retrievalProbeInFlight;
}

function chunkText(text, pagePart = false) {
  if (!pagePart && /^\[Page \d+\]/.test(String(text))) {
    return String(text).split(/(?=\[Page \d+\]\n)/).filter(Boolean).flatMap(part => {
      const marker = part.match(/^\[Page \d+\]/)?.[0] || '';
      return chunkText(part.slice(marker.length), true).map(chunk => marker + '\n' + chunk);
    });
  }
  const clean = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= CHUNK_SIZE) return [clean];
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + CHUNK_SIZE, clean.length);
    if (end < clean.length) {
      // Prefer a paragraph break, then a sentence/line end, in the back half.
      const window = clean.slice(start, end);
      const para = window.lastIndexOf('\n\n');
      if (para > CHUNK_SIZE * 0.5) {
        end = start + para + 1;
      } else {
        let best = -1;
        for (let i = window.length - 1; i >= CHUNK_SIZE * 0.5; i--) {
          if ('.!?\n'.includes(window[i])) { best = i; break; }
        }
        if (best > 0) end = start + best + 1;
      }
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - CHUNK_STRIDE, start + 1);
  }
  return chunks;
}

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

const serializeF32 = slots.serializeF32;

// `input` is already framed for the target's profile.
async function embedOnce(target, input, signal) {
  const leave=enterInference();
  try {
  const base = target.baseUrl || inferenceBase;
  const res = await ragFetch(`${base.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/embeddings`, {
    method: 'POST',
    headers: target.baseUrl ? { 'Content-Type': 'application/json' } : inferenceHeaders(),
    body: JSON.stringify({ model: target.model, input }),
    redirect: 'error', // the project text goes to the configured server only (cf. decision-endpoint.cjs)
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await readCappedText(res, 64 * 1024)).text.slice(0, 120)}`);
  // A batch of 8 chunks, a few thousand floats each; 16 MB is far above that (#920).
  const body = await readCappedJson(res, 16 * 1024 * 1024);
  return Array.isArray(body?.data) ? body.data : [];
  } finally {leave();}
}

// #1660 review: the model ids an embeddings endpoint says it serves (GET /v1/models: `data[].id`,
// plus llama-server `aliases` and Ollama-style `models[].name`), from the same address and with the
// same headers embedOnce uses. A single-model llama-server answers /v1/embeddings for ANY model name
// with its own vectors, so a target the endpoint does not list would be embedded by another model
// and stored under the wrong identity. Throws when the listing cannot be read.
async function servedModels(target, { timeoutMs = 10000 } = {}) {
  const base = (target && target.baseUrl) || inferenceBase;
  if (!base) throw new Error('no embeddings address');
  // An explicit address never receives the inference credentials (as embedOnce).
  const res = await ragFetch(`${base.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/models`, {
    method: 'GET', headers: target && target.baseUrl ? {} : inferenceHeaders(), redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`models ${res.status}`);
  const body = await readCappedJson(res, SERVED_MODELS_MAX_BYTES);
  const ids = new Set();
  for (const m of Array.isArray(body?.data) ? body.data : []) {
    // #1668: a llama.cpp router lists every preset with status.value; only a loaded one is served.
    // An unloaded preset would be loaded on demand, but nothing has proved it runs, and a switch
    // must never label vectors with a model the server has not actually loaded.
    // #1758: a sleeping model is served too: it ran, and the next request wakes it.
    if (m?.status && typeof m.status === 'object' && 'value' in m.status && !['loaded', 'sleeping'].includes(m.status.value)) continue;
    if (typeof m?.id === 'string') ids.add(m.id);
    for (const a of Array.isArray(m?.aliases) ? m.aliases : []) if (typeof a === 'string') ids.add(a);
  }
  for (const m of Array.isArray(body?.models) ? body.models : []) for (const k of ['name', 'model']) if (typeof m?.[k] === 'string') ids.add(m[k]);
  return [...ids];
}

// #1660 review: the Models page's view of servedModels. Shared per address for SERVED_CACHE_TTL_MS
// (a failure for SERVED_CACHE_FAIL_TTL_MS), one request in flight per address, and a short timeout
// so the page never waits long. Never throws: null means unknown. A switch never uses this (it asks
// servedModels itself, so it never acts on a stale or unverified answer).
const SERVED_MODELS_MAX_BYTES = 1024 * 1024;
const SERVED_CACHE_TTL_MS = 45000;
const SERVED_CACHE_FAIL_TTL_MS = 10000;
const SERVED_CACHE_TIMEOUT_MS = 2000;
let servedCache = new Map(); // key -> { ids: string[]|null, at }
let servedInFlight = new Map(); // key -> Promise<string[]|null>
function servedModelsCached(target) {
  const explicit = (target && target.baseUrl) || null;
  const key = explicit ? `url:${explicit}` : `engine:${inferenceBase || ''}`;
  const hit = servedCache.get(key);
  if (hit && Date.now() - hit.at < (hit.ids ? SERVED_CACHE_TTL_MS : SERVED_CACHE_FAIL_TTL_MS)) return Promise.resolve(hit.ids);
  if (servedInFlight.has(key)) return servedInFlight.get(key);
  const cache = servedCache, inFlight = servedInFlight; // an init() in between starts fresh maps
  const p = servedModels({ baseUrl: explicit }, { timeoutMs: SERVED_CACHE_TIMEOUT_MS })
    .catch(() => null)
    .then((ids) => { cache.set(key, { ids, at: Date.now() }); inFlight.delete(key); return ids; });
  inFlight.set(key, p);
  return p;
}

async function embedFramed(target, input, signal) {
  if (!input.length) return [];
  if (input.length === 1) {
    const items = await embedOnce(target, input, signal);
    if (items.length !== 1 || !items[0]?.embedding) throw new Error('embeddings returned no vector');
    return [items[0].embedding];
  }
  // Some OpenAI-compatible providers answer a multi-input batch with an empty data array —
  // fall back to one call per text (cheap on local hardware). Order follows `index` when given.
  const items = await embedOnce(target, input, signal);
  if (items.length === input.length && items.every((it) => it?.embedding)) {
    const ordered = items.every((it) => Number.isInteger(it.index)) ? [...items].sort((a, b) => a.index - b.index) : items;
    return ordered.map((it) => it.embedding);
  }
  const out = [];
  for (const t of input) out.push(...(await embedFramed(target, [t], signal)));
  return out;
}

// Optional { signal } (#760): aborts the embeddings request, including the per-text fallback.
// #1636: `kind` ('query' | 'document' | 'similarity', or one per text) and `titles` (documents)
// frame the texts for the target's profile (embedding-profile.cjs); `target` defaults to the
// active one. Under the default nomic-v1 profile the texts are sent unchanged, as before.
async function embed(texts, { signal, kind = 'document', titles = null, target = null } = {}) {
  if (!texts.length) return [];
  const t = target || embeddingConfig.active();
  if (embeddingOff(t)) throw Object.assign(new Error('Embedding is turned off.'), { code: 'embeddingOff' });
  return embedFramed(t, frame(t.profile, texts, { kind, titles }), signal);
}

// #1636: project chunks are framed with the profile's untitled document prompt
// (embeddinggemma-2: `title: none | text: …`), the same as the Diary's index. File names are not
// sent: a name is not part of the chunk's text, and both indexes must use one framing.

// Where a project's index lives: the account's own data directory, else the shared RAG_DIR.
function indexDir(userId) {
  return userId && dataDirForUser ? path.join(dataDirForUser(userId), 'rag') : RAG_DIR;
}
/** #1771: whether this project already has an index file. Creates nothing (no directory, no file). */
function indexExists(projectId, userId) {
  try { return fs.existsSync(path.join(indexDir(userId), `${projectId}.db`)); } catch { return false; }
}

// #2191: a project the Rust front deleted (a tombstone in its index outbox) never gets its index back.
const deletedByFront = (projectId, userId) => { try { return lifecycleGuard.deletedSince(projectId, userId, 0); } catch { return false; } };

function openIndex(projectId, userId) {
  // Queued indexing may begin after account deletion. Refuse the directory
  // creation before opening SQLite, including for detached index promises.
  if (userId && !userActive(userId)) return null;
  if (deletedByFront(projectId, userId)) return null;
  const { Database, sqliteVec } = loadDeps();
  if (!Database || !sqliteVec) return null;
  try {
    const ragDir = indexDir(userId);
    fs.mkdirSync(ragDir, { recursive: true });
    const file = path.join(ragDir, `${projectId}.db`);
    const db = new Database(file);
    // Deleted between the check above and the open: the open created the file again, so remove it.
    if (deletedByFront(projectId, userId)) {
      try { db.close(); } catch { /* closing a fresh handle */ }
      for (const f of [file, `${file}-wal`, `${file}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* best effort */ } }
      return null;
    }
    db.pragma('journal_mode = WAL');
    sqliteVec.load(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        file TEXT NOT NULL,
        chunk_no INTEGER NOT NULL,
        body TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_file_hash ON chunks(file, content_hash);
      CREATE TABLE IF NOT EXISTS vec_meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    // Which version of the file (sha256 of its full text) a chunk was cut from (#122). Older
    // indexes gain the column empty; those rows are simply unversioned until re-indexed.
    const columns = db.prepare('PRAGMA table_info(chunks)').all();
    if (!columns.some((c) => c.name === 'version')) db.exec('ALTER TABLE chunks ADD COLUMN version TEXT');
    // #1636: 1 marks a small file stored whole for direct injection (never embedded). Older rows are
    // NULL; vector-slots.cjs recognises those by shape (a file's only chunk, at most 2400 characters).
    if (!columns.some((c) => c.name === 'direct')) db.exec('ALTER TABLE chunks ADD COLUMN direct INTEGER');
    // #1726: what a row holds. NULL (every row before #1726) and 'text' are text chunks; 'image' is an
    // image source or document figure (multimodal-rag.cjs), whose vector sits in the same slot as the
    // text vectors and whose `body` is only its label. `meta` is that row's JSON (source, page, figure).
    if (!columns.some((c) => c.name === 'kind')) db.exec('ALTER TABLE chunks ADD COLUMN kind TEXT');
    if (!columns.some((c) => c.name === 'meta')) db.exec('ALTER TABLE chunks ADD COLUMN meta TEXT');
    // #1636: vectors live in per-model slots; `slot` is the active model's (null until it has one).
    const active = embeddingConfig.active();
    slots.adoptLegacy(db, active);
    return { db, active, slot: slots.findSlot(db, active) };
  } catch (err) {
    console.warn(`[rag] index unavailable for ${projectId} (${err.message}) — falling back to direct injection`);
    return null;
  }
}

// Remove one file's chunks AND their vectors, in every model's slot. chunks.id is INTEGER PRIMARY
// KEY, so SQLite reuses freed ids: a vector left behind would join to whatever chunk takes its id
// next. Callers run this inside a transaction with whatever replaces the file.
// #1726: `textOnly` leaves the file's image rows (a document's figures, an image source's own vector)
// alone: re-cutting a file's text is not a change of its images, which the media pass reconciles.
// #1868: `keepTailOf` (a version) also leaves the file's tail rows cut from that same version: a re-index
// of unchanged text keeps the pages past the head it already has (appendFileTail), instead of embedding them again.
function dropFileRows(index, fileName, { textOnly = false, keepTailOf = null } = {}) {
  let which = textOnly ? ` AND ${TEXT_ROW}` : '';
  const args = [fileName];
  if (keepTailOf) { which += ` AND NOT (${TAIL_ROW} AND version IS ?)`; args.push(keepTailOf); }
  slots.dropChunks(index.db, index.db.prepare(`SELECT id FROM chunks WHERE file = ?${which}`).all(...args).map((r) => r.id));
  index.db.prepare(`DELETE FROM chunks WHERE file = ?${which}`).run(...args);
}
// #1868: a text chunk cut from the page store past the head of a long document (appendFileTail). Its `meta`
// is {"tail":1,"page":N}; every other text row has no meta.
const TAIL_ROW = `COALESCE(meta, '') LIKE '{"tail":1,%'`;
// #1726: a text chunk (every row written before the kind column existed is one).
const TEXT_ROW = "COALESCE(kind, 'text') = 'text'";

// Per project+tenant+file: runs are chained so two index runs never interleave, and every
// index or delete bumps a generation so a superseded run stops before writing anything more.
const fileQueues = new Map(); // key -> promise tail
const fileGenerations = new Map(); // key -> latest generation
const fileKey = (projectId, fileName, userId) => JSON.stringify([userId || null, projectId, fileName]);
// The version (sha256 of the full text) each file is being indexed at, set the moment a
// re-index is requested. Searches drop hits whose chunk version differs, so a chat that runs
// while a newer version waits in the queue (or is mid-embed) never reads the old text (#122).
const fileVersions = new Map(); // key -> version hash
// Called when a file's queue has drained: nothing is running or waiting for it, so the generation
// counter has no run left to supersede and, once the newest version is safely in the index, no
// search needs the version to filter by. Without this both maps keep a key for every file ever
// indexed (#796). The version stays when it is still doing work: after a delete that could not drop
// the rows (null), or an index run that threw part-way and may have left the previous version's chunks.
function pruneFileState(key, outcome) {
  fileGenerations.delete(key);
  if (fileVersions.get(key) === null) return;
  if (outcome?.failed) return;
  // `rag-unavailable` is also what a transient open error (disk full, EACCES, SQLITE_BUSY) returns:
  // the index may still hold the previous version's chunks, so the wanted version must keep
  // filtering them. Only when the deps themselves are missing is there no index to protect.
  if (outcome?.ok === false && ragAvailable()) return;
  fileVersions.delete(key);
}
const bumpGeneration = (key) => { const g = (fileGenerations.get(key) || 0) + 1; fileGenerations.set(key, g); return g; };

// Embeds rows ({ id, file, body, hash }) with `target` and stores them in its slot (created on the
// first vector). The slot is re-read inside the write, and a row is written only while its chunk
// still holds the text that was embedded, so a concurrent re-index or delete never gets a vector
// attached to different text. Returns how many vectors were stored.
async function embedRowsInto(index, target, rows, { isCurrent = () => true, batchSize = 8, signal } = {}) {
  let embedded = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    if (!isCurrent()) break;
    const batch = rows.slice(i, i + batchSize);
    const vectors = await embed(batch.map((r) => r.body), { kind: 'document', target, signal });
    // A newer run (or a delete) replaced these chunks while we were embedding: writing now
    // would attach vectors to ids that no longer mean this text.
    if (!isCurrent()) break;
    const still = index.db.prepare('SELECT 1 FROM chunks WHERE id = ? AND content_hash = ?');
    const stored = index.db.transaction(() => {
      const slot = slots.ensureSlot(index.db, target, vectors[0].length);
      const items = batch.map((r, j) => ({ id: r.id, hash: r.hash, vector: vectors[j] }))
        .filter((r) => still.get(r.id, r.hash) && Array.isArray(r.vector) && r.vector.length === slot.dim);
      slots.writeVectors(index.db, slot, items);
      return { slot, n: items.length };
    })();
    if (stored.n < batch.length && vectors.some((v) => v?.length !== stored.slot.dim)) {
      console.warn(`[rag] ${target.model} returned ${vectors[0]?.length}-wide vectors but its slot holds ${stored.slot.dim}; skipped`);
    }
    if (index.active && slots.slotId(target) === slots.slotId(index.active)) index.slot = stored.slot;
    embedded += stored.n;
  }
  return embedded;
}
const embedBatchAndStore = (index, rows, isCurrent) => embedRowsInto(index, index.active, rows, { isCurrent });

// Index (or re-index) one project file. Returns counts for logging; throws on
// hard failures is deliberately avoided — callers log the result.
//
// Runs for the same file are serialized, and a newer run supersedes an older one: the older
// one stops before writing further vectors. The old version's chunks and vectors are replaced
// by the new chunks in one transaction, so a search during re-index sees only the NEW version
// (at first without vectors, then gaining them batch by batch) — never a mix of versions, and
// never an old vector joined to new text.
// #2191 round 2: the Rust front deletes projects (rust-project-lifecycle.cjs). A run queued before a
// delete of its project stops at its next step and closes its handle (rust-index-outbox.cjs tombstones),
// so it never recreates the deleted project's index. Without a guard nothing is ever deleted elsewhere.
let lifecycleGuard = { generation: () => 0, deletedSince: () => false };
function setLifecycleGuard(guard) { lifecycleGuard = guard || { generation: () => 0, deletedSince: () => false }; }
const notDeleted = (projectId, userId) => {
  let seen = 0;
  try { seen = lifecycleGuard.generation(userId); } catch { seen = 0; }
  return () => { try { return !lifecycleGuard.deletedSince(projectId, userId, seen); } catch { return true; } };
};

function indexProjectFile(projectId, fileName, text, userId) {
  const key = fileKey(projectId, fileName, userId);
  const alive = notDeleted(projectId, userId);
  const generation = bumpGeneration(key);
  const version = hash(String(text));
  fileVersions.set(key, version);
  const run = (fileQueues.get(key) || Promise.resolve())
    .catch(() => {})
    .then(() => indexProjectFileNow(projectId, fileName, text, userId,
      () => fileGenerations.get(key) === generation && (!userId || userActive(userId)) && alive(), version));
  const tail = run.catch(() => ({ ok: false, failed: true }));
  fileQueues.set(key, tail);
  tail.then((outcome) => {
    if (fileQueues.get(key) !== tail) return; // a newer run is queued behind this one
    fileQueues.delete(key);
    pruneFileState(key, outcome);
    try { afterIndex(); } catch { /* a hook never breaks indexing */ }
  });
  return run;
}

async function indexProjectFileNow(projectId, fileName, text, userId, isCurrent, version = hash(String(text))) {
  if (!isCurrent()) return { ok: true, stored: 0, embedded: 0, superseded: true };
  const index = openIndex(projectId, userId);
  if (!index) return { ok: false, reason: 'rag-unavailable' };
  // #2191 round 2: deleted elsewhere between the check above and the open: nothing is written.
  if (!isCurrent()) { index.db.close(); return { ok: true, stored: 0, embedded: 0, superseded: true }; }
  try {
    if (text.length <= DIRECT_INJECT_MAX) {
      // Small file: stored for the record, injected directly by handleChat.
      index.db.transaction(() => {
        dropFileRows(index, fileName, { textOnly: true });
        index.db
          .prepare('INSERT INTO chunks (file, chunk_no, body, content_hash, version, direct) VALUES (?, 0, ?, ?, ?, 1)')
          .run(fileName, text, hash(text), version);
      })();
      return { ok: true, stored: 1, embedded: 0, direct: true };
    }
    const pieces = chunkText(text);
    // Overlapping windows can yield byte-identical chunks (repeated padding /
    // template text), which would violate the (file, content_hash) unique
    // index — dedupe, keeping the first occurrence.
    const seen = new Set();
    const unique = [];
    for (const body of pieces) {
      const h = hash(body);
      if (seen.has(h)) continue;
      seen.add(h);
      unique.push(body);
    }
    const ins = index.db.prepare('INSERT INTO chunks (file, chunk_no, body, content_hash, version, direct) VALUES (?, ?, ?, ?, ?, 0)');
    const rows = index.db.transaction(() => {
      // #1868: the tail of this same text stays (a tail chunk is never one of the head's, see appendFileTail;
      // one that is now is dropped so the head keeps its row). Without tail rows this is exactly as before.
      dropFileRows(index, fileName, { textOnly: true, keepTailOf: version });
      const clash = index.db.prepare(`SELECT id FROM chunks WHERE file = ? AND content_hash = ? AND ${TAIL_ROW}`);
      const clashing = unique.map((body) => clash.get(fileName, hash(body))?.id).filter((id) => id != null);
      if (clashing.length) { slots.dropChunks(index.db, clashing); for (const id of clashing) index.db.prepare('DELETE FROM chunks WHERE id = ?').run(id); }
      return unique.map((body, i) => { const h = hash(body); return { id: Number(ins.run(fileName, i, body, h, version).lastInsertRowid), file: fileName, body, hash: h }; });
    })();
    let embedded = 0;
    try {
      embedded = await embedBatchAndStore(index, rows, isCurrent);
    } catch (err) {
      console.warn(`[rag] embedding failed for ${projectId}/${fileName} (${err.message}) — text stored, vectors pending`);
    }
    return { ok: true, stored: rows.length, embedded };
  } finally {
    index.db.close();
  }
}

// #1868: the pages of a long document past its head. `indexProjectFile` indexes a source's text, which for a
// document is its first EXTRACT_CAP (200,000) characters; the page store holds up to PROJECT_DOCUMENT_TEXT_LIMIT.
// This appends the rest, cut by the same chunker (document-backfill.cjs tailChunks), as extra rows of the same
// file and the same version as its head, at most `limit` chunks embedded per call, so a caller with a budget
// (the paced backfill) decides how much embedding one document gets at a time. Leftover chunks are appended on
// a later call; nothing is re-cut or re-embedded that is already there.
//
//   tail      [{ body, page }] in document order: chunkText of the full page-store text. A chunk the head
//             already has (same text) is skipped, so the head rows are never touched.
//   headText  the source text the head was indexed from. Nothing is appended unless the index holds the head of
//             exactly this text (and no re-index of the file is waiting), so a tail never joins another version.
//
// Rows: chunks with meta {"tail":1,"page":N}, the head's version, no `direct`. Search, the version filter, the
// #1636 re-index (fillMissing) and delete treat them as any text chunk. Tail rows no longer in `tail` (the record
// changed) are dropped with their vectors. Runs in the file's queue, after any index run of it.
// #1881: `fromPage`/`toPage` limit the call to a window of the tail (the caller chunks only those pages);
// `final` says the window reaches the end, so rows past it are stale. Embed requests carry TAIL_EMBED_REQUEST
// texts and stop as soon as chat or a search is in flight (`yielded`).
// Returns { ok, reason?, yielded?, embedded, inserted, attempted, pending, searchableTo, windowDone, complete }:
// `searchableTo` is the last page before the window's first chunk without a vector (the window's last page when
// it has none and is not final), `complete` says the final window has every vector.
function appendFileTail(projectId, fileName, headText, tail, userId, { limit = 8, signal, fromPage = null, toPage = null, final = true } = {}) {
  const key = fileKey(projectId, fileName, userId);
  const alive = notDeleted(projectId, userId);
  const prior = fileQueues.get(key) || null;
  const generation = fileGenerations.get(key);
  const run = (prior || Promise.resolve(null)).then(() => appendFileTailNow(projectId, fileName, String(headText), Array.isArray(tail) ? tail : [], userId, {
    limit, signal, fromPage, toPage, final, isCurrent: () => fileGenerations.get(key) === generation && (!userId || userActive(userId)) && !signal?.aborted && alive(),
  }));
  // The queue resolves to the outcome of the last INDEX run, which decides what pruneFileState may forget.
  const tailP = Promise.all([prior || Promise.resolve(null), run.catch(() => null)]).then(([outcome]) => outcome);
  fileQueues.set(key, tailP);
  tailP.then((outcome) => {
    if (fileQueues.get(key) !== tailP) return;
    fileQueues.delete(key);
    if (prior) pruneFileState(key, outcome);
  });
  return run;
}

const pageOf = (body) => { const m = /^\[Page (\d+)\]/.exec(String(body)); return m ? Number(m[1]) : 0; };
const metaPage = (meta) => { try { return Number(JSON.parse(meta).page) || 0; } catch { return 0; } };

// #1881: chat comes first. Chat and Diary requests (index.cjs) and every project search hold `foreground()`
// while they run; a tail append checks `foregroundBusy()` before each embed request and stops (its stored
// rows keep no vector and are embedded first next time), so a query waits behind at most one small request.
let foregroundCount = 0;
function foreground() { foregroundCount += 1; let left = false; return () => { if (!left) { left = true; foregroundCount = Math.max(0, foregroundCount - 1); } }; }
const foregroundBusy = () => foregroundCount > 0;
// #1881: texts per embed request of a tail append (the head and the re-index keep their 8).
const TAIL_EMBED_REQUEST = 4;

async function appendFileTailNow(projectId, fileName, headText, tail, userId, { limit, signal, isCurrent, fromPage, toPage, final }) {
  const none = (reason) => ({ ok: false, reason, embedded: 0, inserted: 0, attempted: 0, pending: null, searchableTo: null, complete: false });
  if (!isCurrent()) return none('superseded');
  if (foregroundBusy()) return none('busy');
  if (!indexExists(projectId, userId)) return none('no-index'); // #1776: never creates an index
  const index = openIndex(projectId, userId);
  if (!index) return none('rag-unavailable');
  try {
    const version = hash(headText);
    const key = fileKey(projectId, fileName, userId);
    if (fileVersions.has(key) && fileVersions.get(key) !== version) return none('reindex-pending');
    const head = index.db.prepare(`SELECT version, COUNT(*) AS n FROM chunks WHERE file = ? AND ${TEXT_ROW} AND NOT ${TAIL_ROW} GROUP BY version`).all(fileName);
    if (head.length !== 1 || head[0].version !== version || headText.length <= DIRECT_INJECT_MAX) return none('head-not-indexed');
    if (embeddingOff(index.active)) return none('embedding-off');
    const headHashes = new Set(index.db.prepare(`SELECT content_hash FROM chunks WHERE file = ? AND ${TEXT_ROW} AND NOT ${TAIL_ROW}`).all(fileName).map((r) => r.content_hash));
    const wanted = [];
    const seen = new Set();
    for (const t of tail) {
      const body = String(t?.body || '');
      if (!body) continue;
      const h = hash(body);
      if (seen.has(h) || headHashes.has(h)) continue;
      seen.add(h);
      wanted.push({ body, hash: h, page: Number.isInteger(t.page) && t.page > 0 ? t.page : pageOf(body) });
    }
    // The pages this call speaks for: a window (fromPage..toPage) of the tail, or all of it.
    const lo = Number.isInteger(fromPage) ? fromPage : -Infinity;
    const hi = Number.isInteger(toPage) ? toPage : Infinity;
    const vectored = () => {
      const slot = slots.findSlot(index.db, index.active);
      return new Set(slot ? index.db.prepare(`SELECT c.id FROM ${slots.joinSql(slot)} WHERE c.file = ? AND ${TAIL_ROW}`).all(fileName).map((r) => r.id) : []);
    };
    const max = Math.max(0, Math.floor(Number(limit) || 0));
    const rows = index.db.transaction(() => {
      // Tail rows this record no longer yields (in this window, or past the end on the last one), or cut from
      // another version, go with their vectors.
      const stale = index.db.prepare(`SELECT id, content_hash, version, meta FROM chunks WHERE file = ? AND ${TAIL_ROW}`).all(fileName).filter((r) => {
        if (r.version !== version) return true;
        const page = metaPage(r.meta);
        if (page >= lo && page <= hi) return !seen.has(r.content_hash);
        return final && page > hi;
      }).map((r) => r.id);
      if (stale.length) { slots.dropChunks(index.db, stale); const del = index.db.prepare('DELETE FROM chunks WHERE id = ?'); for (const id of stale) del.run(id); }
      const present = new Map(index.db.prepare(`SELECT id, content_hash FROM chunks WHERE file = ? AND ${TAIL_ROW}`).all(fileName).map((r) => [r.content_hash, r.id]));
      const have = vectored();
      const out = [];
      // First the rows already appended whose embedding failed or was cut short, then new rows, in document order.
      for (const w of wanted) { if (out.length >= max) break; const id = present.get(w.hash); if (id != null && !have.has(id)) out.push({ id, file: fileName, body: w.body, hash: w.hash }); }
      let next = (index.db.prepare('SELECT MAX(chunk_no) AS n FROM chunks WHERE file = ?').get(fileName).n ?? -1) + 1;
      const ins = index.db.prepare('INSERT INTO chunks (file, chunk_no, body, content_hash, version, direct, meta) VALUES (?, ?, ?, ?, ?, 0, ?)');
      for (const w of wanted) {
        if (out.length >= max) break;
        if (present.has(w.hash)) continue;
        const id = Number(ins.run(fileName, next++, w.body, w.hash, version, JSON.stringify({ tail: 1, page: w.page })).lastInsertRowid);
        present.set(w.hash, id);
        out.push({ id, file: fileName, body: w.body, hash: w.hash, fresh: true });
      }
      return out;
    })();
    const inserted = rows.filter((r) => r.fresh).length;
    let embedded = 0, error = null;
    if (rows.length) {
      try { embedded = await embedRowsInto(index, index.active, rows, { isCurrent: () => isCurrent() && !foregroundBusy(), batchSize: TAIL_EMBED_REQUEST, signal }); }
      catch (err) { if (signal?.aborted) throw err; error = String(err?.message || err).slice(0, 200); }
    }
    const yielded = !error && embedded < rows.length && foregroundBusy();
    const have = vectored();
    const ids = new Map(index.db.prepare(`SELECT id, content_hash FROM chunks WHERE file = ? AND ${TAIL_ROW}`).all(fileName).map((r) => [r.content_hash, r.id]));
    const firstMissing = wanted.find((w) => !have.has(ids.get(w.hash)));
    const pending = wanted.filter((w) => !have.has(ids.get(w.hash))).length;
    const lastPage = wanted.length ? wanted[wanted.length - 1].page : (Number.isFinite(hi) ? hi : null);
    const searchableTo = firstMissing ? Math.max(0, firstMissing.page - 1) : (final ? null : lastPage);
    return { ok: !error, ...(error ? { reason: 'embed-failed', error } : {}), ...(yielded ? { yielded: true } : {}), embedded, inserted, attempted: rows.length, pending,
      searchableTo, windowDone: !firstMissing, complete: !!final && !firstMissing };
  } finally {
    index.db.close();
  }
}

// Drop one file's chunks (called when a file is removed from a project). #1726: `keepMedia` drops
// only its text (a source that has no text, such as an image, keeps its image vector).
function deleteProjectFile(projectId, fileName, userId, { keepMedia = false } = {}) {
  // Supersede any index run still embedding this file, so it cannot write vectors afterwards.
  const key = fileKey(projectId, fileName, userId);
  bumpGeneration(key);
  // No version is current any more: until the rows are gone, and if dropping them fails, every
  // remaining chunk of this file is filtered out of search.
  fileVersions.set(key, null);
  const index = openIndex(projectId, userId);
  if (!index) {
    // Without the deps there is no index to read, so no chunk can need filtering. With them, the
    // open failed transiently (disk full, EACCES, SQLITE_BUSY) and the rows were NOT dropped: the
    // null version must stay so they remain filtered out of search.
    if (!ragAvailable()) {
      fileVersions.delete(key);
      if (!fileQueues.has(key)) fileGenerations.delete(key);
    }
    return;
  }
  try {
    index.db.transaction(() => dropFileRows(index, fileName, { textOnly: keepMedia }))();
    if (fileVersions.get(key) === null) fileVersions.delete(key);
    // With no run queued the delete's generation bump has nothing left to supersede; a queued
    // run still needs it to see that it is stale, and its drain prunes the key.
    if (!fileQueues.has(key)) fileGenerations.delete(key);
  } finally {
    index.db.close();
  }
}

// A chunk is current when no re-index or delete of its file has been requested in this process
// (nothing newer is known), or when it was cut from the version most recently requested.
function isCurrentVersion(projectId, fileName, userId, version) {
  const key = fileKey(projectId, fileName, userId);
  if (!fileVersions.has(key)) return true;
  const want = fileVersions.get(key);
  return want !== null && version === want;
}

// Top-K chunks for a query, this project's index only. Empty array on any
// failure — chat falls back to direct injection of small files.
// #1726: text chunks only. Image rows (multimodal-rag.cjs) are never returned here, whatever the flag:
// every caller of this function (chat excerpts, the project search tool, Deep Research) reads `body`
// as text. searchProjectWithImages is the one search that also returns images.
async function searchProject(projectId, query, userId) {
  const leave = foreground(); // #1881: a running tail backfill yields to this query
  try { return await searchProjectNow(projectId, query, userId); } finally { leave(); }
}
async function searchProjectNow(projectId, query, userId) {
  if (!indexExists(projectId, userId)) return []; // #1776: a read never creates an index
  const index = openIndex(projectId, userId);
  if (!index) return [];
  // #1636: only the active model's slot is searched, with a query embedded by that same model.
  // No slot yet (a re-index has not reached this project) means no vector search, never another
  // model's vectors.
  if (!index.slot) { index.db.close(); return []; }
  try {
    const [qvec] = await embed([query], { kind: 'query', target: index.active });
    if (!qvec || qvec.length !== index.slot.dim) return [];
    return await textHits(index, serializeF32(qvec), projectId, query, userId);
  } catch (err) {
    console.warn(`[rag] search failed for ${projectId}: ${err.message}`);
    return [];
  } finally {
    index.db.close();
  }
}

// The text side of a search: cosine pool, version filter, then the optional reranker. Unchanged by #1726
// apart from the kind filter, which matches every row of an index that holds no image rows.
async function textHits(index, qbuf, projectId, query, userId) {
  const rows = index.db
    .prepare(
      `SELECT c.file, c.chunk_no, c.body, c.version, 1.0 - vec_distance_cosine(v.embedding, ?) AS score
       FROM ${slots.joinSql(index.slot)}
       WHERE 1.0 - vec_distance_cosine(v.embedding, ?) >= ? AND COALESCE(c.kind, 'text') = 'text'
       ORDER BY score DESC
       LIMIT ?`
    )
    .all(qbuf, qbuf, MIN_SCORE, (rerank ? rerank.pool : TOP_K) * 4);
  const hits = rows.filter((r) => isCurrentVersion(projectId, r.file, userId, r.version)).slice(0, rerank ? rerank.pool : TOP_K).map((r) => ({ file: r.file, body: r.body, score: Math.round(r.score * 1000) / 1000 }));
  if (!rerank) return hits;
  return rerankPool({ query, pool: hits, decisions: rerank.decisions, keep: rerank.keep, deadlineMs: rerank.deadlineMs });
}

// #1726: one query vector against the text AND the image vectors of this project's index (they share the
// active model's slot, so they share one vector space). The merge rule:
//   - text hits are exactly searchProject's: same pool, MIN_SCORE, TOP_K, version filter and, when on, the
//     reranker. Images never displace a text hit.
//   - image hits cannot be scored by a reranker (it reads text), so they bypass it and keep their cosine
//     score: at most RAG_IMAGE_TOP_K (default 2) of them, each at or above RAG_IMAGE_MIN_SCORE (default
//     MIN_SCORE), best first. They are added beside the text hits, never counted against them.
// `indexed` lists the image rows that have a current vector (their meta), so the caller knows which
// images retrieval can see at all; an image without one is not "not relevant", just not indexed yet.
// Never throws: { text: [], images: [], indexed: [] } on any failure.
async function searchProjectWithImages(projectId, query, userId) {
  const leave = foreground(); // #1881
  try { return await searchProjectWithImagesNow(projectId, query, userId); } finally { leave(); }
}
async function searchProjectWithImagesNow(projectId, query, userId) {
  const empty = { text: [], images: [], indexed: [] };
  if (!indexExists(projectId, userId)) return empty; // #1776: a read never creates an index
  const index = openIndex(projectId, userId);
  if (!index) return empty;
  if (!index.slot) { index.db.close(); return empty; }
  try {
    const [qvec] = await embed([query], { kind: 'query', target: index.active });
    if (!qvec || qvec.length !== index.slot.dim) return empty;
    const qbuf = serializeF32(qvec);
    const text = await textHits(index, qbuf, projectId, query, userId);
    const join = slots.joinSql(index.slot);
    const indexed = index.db.prepare(`SELECT c.file, c.meta FROM ${join} WHERE c.kind = 'image'`).all().map(mediaRow).filter(Boolean);
    const images = index.db
      .prepare(
        `SELECT c.file, c.body, c.content_hash, c.meta, 1.0 - vec_distance_cosine(v.embedding, ?) AS score
         FROM ${join}
         WHERE c.kind = 'image' AND 1.0 - vec_distance_cosine(v.embedding, ?) >= ?
         ORDER BY score DESC
         LIMIT ?`
      )
      .all(qbuf, qbuf, IMAGE_MIN_SCORE, IMAGE_TOP_K)
      .map((r) => { const m = mediaRow(r); return m && { ...m, label: r.body, hash: r.content_hash, score: Math.round(r.score * 1000) / 1000 }; })
      .filter(Boolean);
    return { text, images, indexed };
  } catch (err) {
    console.warn(`[rag] search failed for ${projectId}: ${err.message}`);
    return empty;
  } finally {
    index.db.close();
  }
}
const IMAGE_TOP_K = clampInt(process.env.RAG_IMAGE_TOP_K, 2, 0, 8);
const IMAGE_MIN_SCORE = (() => { const n = Number(process.env.RAG_IMAGE_MIN_SCORE); return Number.isFinite(n) && n >= -1 && n <= 1 ? n : MIN_SCORE; })();
// An image row as search results carry it: { file, kind, ...meta }. null when its meta is unreadable.
function mediaRow(row) {
  let meta;
  try { meta = JSON.parse(row.meta || 'null'); } catch { return null; }
  if (!meta || typeof meta !== 'object') return null;
  return { file: row.file, kind: 'image', meta };
}

// ── #1726 media (image) rows ──────────────────────────────────────────────────────────────────
// multimodal-rag.cjs decides WHICH images a project has (its image sources and the figures Docling
// returned from its documents, never a scanned page) and when to embed them; this file stores them.
// An image row is a chunks row with kind 'image': `file` is the source it belongs to, `content_hash`
// 'img:' + sha256 of the image bytes, `body` its label (name, page, caption), `meta` its JSON. Its
// vector is written into the ACTIVE model's slot, the same vec0 table as the text vectors, by the same
// model (with its image projector), so a text query finds it by content.

/**
 * The model name an image is embedded under for `target`, or null when no image projector is known to
 * be there. A model-manager-run embedding service lists each served model's projector alias (#1726,
 * noevia-rs model-manager: `<model>.vision`); a service it does not run answers images under
 * EMBEDDING_IMAGE_MODEL, else under the text model's own name (a llama-server started with --mmproj).
 */
function mediaModelFor(target) {
  const service = require('./embedding-service.cjs').current();
  if (service && service.managed() && (!target.baseUrl || service.isAt(target.baseUrl))) {
    const vision = service.status()?.vision;
    const hit = Array.isArray(vision) ? vision.find((v) => v && v.model === target.model && typeof v.alias === 'string') : null;
    return hit ? hit.alias : null;
  }
  // #1738: without the model manager, only a named image model is known to take images; the text model's own
  // name would fail every retry on a text-only server, so report no-image-projector instead.
  const named = String(process.env.EMBEDDING_IMAGE_MODEL || '').trim();
  return named || null;
}

/**
 * One request to the embeddings server for media `parts` (one OpenAI-style content part per item, e.g.
 * { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }). llama.cpp's /v1/embeddings
 * accepts an `input` entry of the form { content: [parts] } for a model loaded with --mmproj
 * (tools/server/README.md at b11610, "/v1/embeddings"; server-context.cpp tokenize_oai_content_array).
 * EmbeddingGemma 2 takes images with no prompt prefix (its model card), so nothing is framed.
 */
async function embedMediaOnce(target, model, parts, signal) {
  const leave = enterInference();
  try {
    const base = target.baseUrl || inferenceBase;
    if (!base) throw new Error('no embeddings address');
    const res = await ragFetch(`${base.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/embeddings`, {
      method: 'POST',
      headers: target.baseUrl ? { 'Content-Type': 'application/json' } : inferenceHeaders(),
      body: JSON.stringify({ model, input: parts.map((part) => ({ content: [part] })), encoding_format: 'float' }),
      redirect: 'error', // the image goes to the configured embeddings server only
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(MEDIA_EMBED_TIMEOUT_MS)]) : AbortSignal.timeout(MEDIA_EMBED_TIMEOUT_MS),
    });
    if (!res.ok) throw Object.assign(new Error(`embeddings ${res.status}: ${(await readCappedText(res, 64 * 1024)).text.slice(0, 120)}`), { status: res.status });
    const body = await readCappedJson(res, 4 * 1024 * 1024);
    const items = Array.isArray(body?.data) ? body.data : [];
    if (items.length !== parts.length || !items.every((it) => Array.isArray(it?.embedding))) throw new Error('embeddings returned no vector for the image');
    const ordered = items.every((it) => Number.isInteger(it.index)) ? [...items].sort((a, b) => a.index - b.index) : items;
    return ordered.map((it) => it.embedding);
  } finally { leave(); }
}
const MEDIA_EMBED_TIMEOUT_MS = clampInt(process.env.RAG_MEDIA_EMBED_TIMEOUT_MS, 120000, 5000, 600000);

/**
 * Brings one project index's image rows in line with `items` (multimodal-rag.cjs mediaItems) and
 * embeds at most `limit` of the ones still without a vector in the active slot.
 *   items: [{ file, hash ('img:<sha256>'), label, meta, part: () => content part | null }]
 * Rows no item names any more are removed with their vectors and their cached caption. Returns
 * { ok, embedded, pending, removed, failed, reason }: `pending` is how many images still have no
 * vector, so the caller (the rate-limited backfill) knows whether to come back. Never throws.
 */
async function syncProjectMedia(projectId, userId, items, { limit = 1, signal, embedParts = null } = {}) {
  // #1771: a project with no image and no index has nothing to reconcile. Opening its index would
  // create an empty SQLite file (and the rag directory) for every project of every account on every
  // pass, so return before openIndex. A project that already has an index is still opened: its
  // stale image rows must go when its last image does.
  const anyItem = Array.isArray(items) && items.some((it) => it && typeof it.file === 'string' && /^img:[0-9a-f]{64}$/.test(String(it.hash || '')));
  if (!anyItem && !indexExists(projectId, userId)) return { ok: true, reason: 'no-index', embedded: 0, pending: 0, removed: 0 };
  const index = openIndex(projectId, userId);
  if (!index) return { ok: false, reason: 'rag-unavailable', embedded: 0, pending: 0, removed: 0 };
  try {
    const target = index.active;
    const profile = require('./embedding-profile.cjs').profileNamed(target.profile);
    if (!profile || !Array.isArray(profile.media) || !profile.media.includes('image')) return { ok: false, reason: 'profile-has-no-images', embedded: 0, pending: 0, removed: 0 };
    const wanted = new Map();
    for (const it of Array.isArray(items) ? items : []) {
      if (!it || typeof it.file !== 'string' || !/^img:[0-9a-f]{64}$/.test(String(it.hash || ''))) continue;
      const key = JSON.stringify([it.file, it.hash]);
      if (!wanted.has(key)) wanted.set(key, it);
    }
    const existing = index.db.prepare("SELECT id, file, content_hash FROM chunks WHERE kind = 'image'").all();
    const have = new Set(existing.map((r) => JSON.stringify([r.file, r.content_hash])));
    const stale = existing.filter((r) => !wanted.has(JSON.stringify([r.file, r.content_hash])));
    index.db.transaction(() => {
      if (stale.length) {
        slots.dropChunks(index.db, stale.map((r) => r.id));
        const del = index.db.prepare('DELETE FROM chunks WHERE id = ?');
        for (const r of stale) del.run(r.id);
      }
      const ins = index.db.prepare("INSERT INTO chunks (file, chunk_no, body, content_hash, version, direct, kind, meta) VALUES (?, ?, ?, ?, NULL, 0, 'image', ?)");
      let n = 0;
      for (const [key, it] of wanted) if (!have.has(key)) ins.run(it.file, n++, String(it.label || it.file).slice(0, 500), it.hash, JSON.stringify(it.meta || {}));
      dropOrphanCaptions(index.db);
    })();
    const slot = slots.findSlot(index.db, target);
    const missingSql = slot && slot.map
      ? `SELECT c.id, c.file, c.content_hash AS hash FROM chunks c LEFT JOIN ${slot.map} m ON m.chunk_id = c.id AND m.content_hash = c.content_hash WHERE c.kind = 'image' AND m.chunk_id IS NULL ORDER BY c.id`
      : "SELECT c.id, c.file, c.content_hash AS hash FROM chunks c WHERE c.kind = 'image' ORDER BY c.id";
    const missing = index.db.prepare(missingSql).all();
    const model = mediaModelFor(target);
    if (!missing.length) return { ok: true, embedded: 0, pending: 0, removed: stale.length };
    if (!model) return { ok: false, reason: 'no-image-projector', embedded: 0, pending: missing.length, removed: stale.length };
    if (embeddingOff(target)) return { ok: false, reason: 'embedding-off', embedded: 0, pending: missing.length, removed: stale.length };
    let embedded = 0;
    const failed = [];
    // At most `limit` embedding requests; an image that cannot be read is skipped (and reported), so it
    // never holds back the ones after it.
    for (const row of missing) {
      if (embedded + failed.filter((f) => f.reason === 'width').length >= Math.max(1, limit)) break;
      const it = wanted.get(JSON.stringify([row.file, row.hash]));
      let part = null;
      try { part = it && typeof it.part === 'function' ? it.part() : null; } catch { part = null; }
      if (!part) { failed.push({ file: row.file, reason: 'unreadable' }); continue; }
      let vector;
      try {
        [vector] = await (embedParts || ((p) => embedMediaOnce(target, model, p, signal)))([part]);
      } catch (err) {
        if (signal?.aborted) throw err;
        return { ok: false, reason: 'embed-failed', error: String(err?.message || err).slice(0, 200), status: err?.status, embedded, pending: missing.length - embedded, removed: stale.length, failed };
      }
      const wrote = index.db.transaction(() => {
        if (!index.db.prepare('SELECT 1 FROM chunks WHERE id = ? AND content_hash = ?').get(row.id, row.hash)) return 0;
        if (!Array.isArray(vector) || !vector.length) return 0;
        const s2 = slots.ensureSlot(index.db, target, vector.length);
        if (vector.length !== s2.dim) return 0;
        slots.writeVectors(index.db, s2, [{ id: row.id, hash: row.hash, vector }]);
        return 1;
      })();
      if (!wrote) failed.push({ file: row.file, reason: 'width' });
      embedded += wrote;
    }
    return { ok: true, embedded, pending: Math.max(0, missing.length - embedded - failed.length), removed: stale.length, failed };
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn(`[rag] media sync failed for ${projectId}: ${err.message}`);
    return { ok: false, reason: 'error', embedded: 0, pending: 0, removed: 0 };
  } finally {
    index.db.close();
  }
}

/**
 * #1726: after a backfill pass, unload the image preset (`<model>.vision`) from a model-manager-run
 * embedding router, so its projector is held only while images are being embedded. Best effort;
 * never the text model, never a server the model manager does not run.
 */
// #1772: returns { released, alias, status?, evicted? } (or { released: false, skipped } when there is no
// separate image preset to unload). `evicted`: the router answered that the preset was not running, so
// it had already been unloaded by the router's own LRU eviction before the pass ended, which happens
// when the router holds fewer models than the saved text models plus the image preset (--models-max).
async function releaseMediaModel() {
  const target = embeddingConfig.active();
  const alias = mediaModelFor(target);
  const service = require('./embedding-service.cjs').current();
  if (!alias || alias === target.model || !target.baseUrl || !service || !service.isAt(target.baseUrl)) return { released: false, skipped: true };
  try {
    const res = await ragFetch(`${target.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/models/unload`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: alias }), redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (res.ok) return { released: true, alias };
    const text = (await readCappedText(res, 4096).catch(() => ({ text: '' }))).text;
    return { released: false, alias, status: res.status, evicted: /not (running|loaded)/i.test(text) };
  } catch (err) { return { released: false, alias, error: String(err?.message || err).slice(0, 120) }; }
}

// #1726: one caption per image, cached in the project's own index beside the image's rows and keyed by
// the image bytes' hash, so it is made once and made again only when the image changes. Removed when no
// image row of the index uses that hash any more.
function ensureCaptions(db) {
  db.exec('CREATE TABLE IF NOT EXISTS media_captions (content_hash TEXT PRIMARY KEY, caption TEXT NOT NULL, model TEXT, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
}
function dropOrphanCaptions(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'media_captions'").get()) return;
  db.prepare("DELETE FROM media_captions WHERE content_hash NOT IN (SELECT content_hash FROM chunks WHERE kind = 'image')").run();
}
/** The cached caption { caption, model } for an image of this project, or null. Never throws. */
function readCaption(projectId, userId, contentHash) {
  if (!ragAvailable() || !indexExists(projectId, userId)) return null; // #1776: a read never creates an index
  const index = openIndex(projectId, userId);
  if (!index) return null;
  try {
    if (!index.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'media_captions'").get()) return null;
    const row = index.db.prepare('SELECT caption, model FROM media_captions WHERE content_hash = ?').get(String(contentHash));
    return row ? { caption: row.caption, model: row.model || null } : null;
  } catch { return null; } finally { index.db.close(); }
}
/** Stores a caption for an image this index holds. Returns false (nothing stored) for any other hash. */
function writeCaption(projectId, userId, contentHash, caption, model) {
  if (!ragAvailable() || !indexExists(projectId, userId)) return false; // #1776: captions belong to existing image rows
  const index = openIndex(projectId, userId);
  if (!index) return false;
  try {
    if (!index.db.prepare("SELECT 1 FROM chunks WHERE kind = 'image' AND content_hash = ?").get(String(contentHash))) return false;
    ensureCaptions(index.db);
    index.db.prepare('INSERT OR REPLACE INTO media_captions (content_hash, caption, model) VALUES (?, ?, ?)').run(String(contentHash), String(caption).slice(0, 4000), model ? String(model).slice(0, 200) : null);
    return true;
  } catch { return false; } finally { index.db.close(); }
}

// ── #1636 re-index support (embedding-migration.cjs drives it) ───────────────────────────────
// Every project index file this process owns: the shared RAG_DIR (no tenant) and each active
// account's own rag directory. Each entry is processed on its own; nothing is copied between them.
function listIndexes() {
  const out = [];
  const scan = (dir, userId) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const m = /^(.+)\.db$/.exec(name);
      if (m && !name.startsWith('.')) out.push({ userId, projectId: m[1] });
    }
  };
  if (RAG_DIR) scan(RAG_DIR, null);
  if (dataDirForUser) {
    let ids = [];
    try { ids = listUserIds() || []; } catch { ids = []; }
    for (const userId of ids) {
      if (!userActive(userId)) continue;
      let dir; try { dir = path.join(dataDirForUser(userId), 'rag'); } catch { continue; }
      scan(dir, userId);
    }
  }
  return out;
}

function withIndex(entry, fn) {
  if (!ragAvailable() || !indexExists(entry.projectId, entry.userId)) return null; // #1776: entries name existing files; never create one
  const index = openIndex(entry.projectId, entry.userId);
  if (!index) return null;
  const close = () => { try { index.db.close(); } catch { /* already closed */ } };
  let result;
  try { result = fn(index); } catch (err) { close(); throw err; }
  if (result && typeof result.then === 'function') return result.finally(close);
  close();
  return result;
}

/** { chunks, vectors } of `target`'s slot in one index file, or null when it cannot be opened. */
function indexCoverage(entry, target) {
  return withIndex(entry, (index) => slots.coverage(index.db, slots.findSlot(index.db, target)));
}

/**
 * Embeds up to `limit` chunks of one index file that have no current vector for `target`, skipping
 * the ids in `exclude`. A batch the server refuses is retried one chunk at a time, so one chunk it
 * cannot embed does not hold back the rest; those ids come back in `refused`.
 * Returns { embedded, attempted, refused, remaining } (remaining: chunks still without a vector).
 */
function fillMissing(entry, target, { limit = 4, signal, isCurrent = () => true, exclude = [] } = {}) {
  return withIndex(entry, async (index) => {
    const rows = slots.missingChunks(index.db, slots.findSlot(index.db, target), limit, exclude);
    let embedded = 0;
    const refused = [];
    if (rows.length) {
      try {
        embedded = await embedRowsInto(index, target, rows, { isCurrent, batchSize: limit, signal });
      } catch (err) {
        if (signal?.aborted) throw err;
        for (const row of rows) {
          try { embedded += await embedRowsInto(index, target, [row], { isCurrent, batchSize: 1, signal }); } catch { refused.push(row.id); }
        }
      }
    }
    const left = slots.coverage(index.db, slots.findSlot(index.db, target));
    return { embedded, attempted: rows.length, refused, remaining: left.chunks - left.vectors };
  });
}

/** Drops `target`'s slot from one index file. */
function dropIndexSlot(entry, target) {
  return withIndex(entry, (index) => index.db.transaction(() => slots.dropSlot(index.db, target))());
}

// The files-context for one chat message: retrieved chunks when the index has
// vectors, otherwise the verbatim small files (old behavior, still the path
// for anything <= DIRECT_INJECT_MAX). Never throws. `{ attached: true }` words it for a chat's own attachments.
// #1726: `images: true` (only when NOEVIA_MULTIMODAL_RAG is on, decided by chat.cjs) also searches the
// project's image vectors with the same query vector and hands the permitted image hits, plus which
// images are indexed at all, to `onImages({ hits, indexed })`. They are never put into the returned text:
// what the model gets for an image is decided at answer time (multimodal-rag.cjs answerImages).
async function filesContext(projectId, files, query, userId, onSources, { attached = false, images = false, onImages = null } = {}) {
  if (!Array.isArray(files) || files.length === 0) return null;
  // #1457: whether the question names a file, by its full stored name or its last path segment, as a
  // whole token ("data.md" is not named by "mydata.md" or "data.md.bak"). Whole files are reported as
  // sources only when named: every small file is injected whole whatever the question, so the prompt
  // cannot say which of them an answer drew on, and naming the file is the one signal we have.
  // (Defined inside the function, not beside it: unreadable-sources.test.cjs runs this body as a slice.)
  const questionNames = (name) => {
    const q = String(query || '').toLowerCase();
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const whole = (s) => new RegExp(`(?<![a-z0-9_.\\-])${escape(s)}(?![a-z0-9_\\-]|\\.[a-z0-9])`);
    const full = String(name).toLowerCase();
    return whole(full).test(q) || whole(full.split('/').pop()).test(q);
  };
  // #1806: a source whose text is in its own file (source-text.cjs) has its length saved beside the
  // pointer, so sorting small from large does not read every large text. (Inline, not
  // source-text.cjs textLength: the tests run this body as a slice.)
  const lengthOf = (f) => {
    const d = f && Object.getOwnPropertyDescriptor(f, 'content');
    return d && typeof d.get === 'function' && /^[0-9a-f]{64}$/.test(String(f.textRef)) && Number.isSafeInteger(f.chars) ? f.chars : String((f && f.content) || '').length;
  };
  const small = files.filter((f) => lengthOf(f) <= DIRECT_INJECT_MAX);
  const large = files.filter((f) => lengthOf(f) > DIRECT_INJECT_MAX);

  // Name every source, always. Retrieval injects excerpts of the large files
  // chosen for THIS question, so a question about the sources themselves —
  // "what have you got?", "is my file attached?" — was answered from whatever
  // happened to be retrieved, and looked exactly like a file that had not
  // attached. The manifest costs a few tokens and settles it.
  // `attached`: a free chat's own attachments (#1441). They are the user's files for this chat, not a
  // project's knowledge, and are worded that way so a small model does not deny having them.
  let manifest = `${attached ? 'The user attached these files to this chat' : 'Sources attached to this project'} (${files.length}): ${quotedNames(files.map((f) => f.name))}. Excerpts of the relevant ones follow; ask to read a file in full if you need more of it.`;

  const notices = files.map(f => documentNotice(f) || (f.attachment?.reason ? `${quoteName(f.name)}: ${f.attachment.reason}` : '')).filter(Boolean);
  const parts = [];
  // What is placed in the prompt, in order, for the caller's optional onSources (#552): `placed` is what
  // the reply reports as its sources (#1457: a whole file or a file head only when the question names it),
  // `injected` is everything the prompt holds, which is what a coverage check must count (#1513).
  const placed = [];
  const injected = [];
  const withImages = images === true && typeof onImages === 'function';
  if (ragAvailable() && (large.length > 0 || withImages)) {
    let hits;
    if (withImages) {
      const found = await searchProjectWithImages(projectId, query, userId);
      const named = new Set(files.map(f => f.name));
      try { onImages({ hits: found.images.filter(h => named.has(h.file)), indexed: found.indexed.filter(h => named.has(h.file)) }); } catch { /* a reporting hook never breaks the prompt */ }
      hits = large.length > 0 ? found.text : [];
    } else hits = await searchProject(projectId, query, userId);
    if (hits.length > 0) {
      const permitted = new Set(files.map(f => f.name));
      for (const h of hits) if (permitted.has(h.file)) { parts.push(frameUntrusted('excerpt', h.file, h.body)); const e = { file: h.file, body: h.body, score: h.score, kind: 'excerpt' }; placed.push(e); injected.push(e); }
    }
  }
  // Whole small files (and, without hits, the head of each large file) are
  // added smallest first until FILES_CONTEXT_MAX_CHARS is spent; anything that
  // does not fit is named below so the model knows it exists.
  let budget = FILES_CONTEXT_MAX_CHARS - parts.reduce((n, x) => n + x.length, 0);
  const candidates = small.map((f) => ({ f, text: frameUntrusted('file', f.name, f.content), body: String(f.content || '') }));
  if (parts.length === 0) for (const f of large) candidates.push({ f, text: frameUntrusted('file excerpts', f.name, String(f.content).slice(0, LARGE_FILE_HEAD)), body: String(f.content).slice(0, LARGE_FILE_HEAD) });
  candidates.sort((a, b) => a.text.length - b.text.length);
  const omitted = [];
  for (const c of candidates) {
    // #1457: injected either way, but reported as a source only when the question names it.
    if (c.text.length <= budget) { parts.push(c.text); budget -= c.text.length; const e = { file: c.f.name, body: c.body, kind: 'file' }; injected.push(e); if (questionNames(c.f.name)) placed.push(e); }
    else omitted.push(c.f.name);
  }
  if (omitted.length) manifest += ` ${omitted.length} more file${omitted.length === 1 ? '' : 's'} not included (prompt size limit): ${quotedNames(omitted)}.`;
  if (typeof onSources === 'function') { try { onSources(placed, injected); } catch { /* a reporting hook never breaks the prompt */ } }
  const coverage = 'Source completeness: ' + (notices.join('\n') || 'Legacy text sources have no page completeness metadata.') + '\nContext may contain excerpts only.' + READ_FILE_HINT + ' Do not treat missing excerpts or failed/partial sources as evidence of absence.';
  return parts.length ? [manifest, coverage, ...parts].join('\n\n') : [manifest, coverage].join("\n");
}

// Which model embed() is currently using. Callers that CACHE vectors need the identity in their
// key: a vector outlives a change of model or profile, and a stale one scores silently rather than
// failing.
function embedModel() { return embeddingConfig.active().model; }
function embeddingIdentity() { const t = embeddingConfig.active(); return `${t.profile}\u0000${t.model}`; }
function getEmbeddingConfig() { return embeddingConfig; }

// How many per-file entries the process is tracking; for tests and diagnostics.
const trackedFileState = () => ({ queues: fileQueues.size, generations: fileGenerations.size, versions: fileVersions.size });

// #1646: the sentence a hybrid cloud route without a grant removes (read_project_file is not offered there).
const READ_FILE_HINT = ' Use read_project_file with PDF startPage/endPage and offset for pages beyond the summary.';
module.exports = { ...testSeam, setLifecycleGuard, appendFileTail, foreground, foregroundBusy, searchProjectWithImages, syncProjectMedia, releaseMediaModel, readCaption, writeCaption, mediaModelFor, embeddingOff, READ_FILE_HINT, servedModels, servedModelsCached, init, trackedFileState, indexProjectFile, deleteProjectFile, searchProject, filesContext, chunkText, ragAvailable, retrievalStatus, embed, embedModel, embeddingIdentity, embeddingConfig: getEmbeddingConfig, onIndexed, listIndexes, indexCoverage, fillMissing, dropIndexSlot, rerankPool, configureRerank, reloadRerank };
