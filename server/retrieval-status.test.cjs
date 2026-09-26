'use strict';
// #340 — rag.ragAvailable() only ever meant "native index deps are installed"; it said nothing
// about whether the configured embedding endpoint actually answers. /api/health and the Settings/
// Capabilities UI reported "Project retrieval: Available" even while cowork-embed-1 was restarting.
// rag.retrievalStatus() is the bounded, cached, tri-state probe that fixes that. These pin its
// three outcomes, its timeout bound, and its cache — independent of rag.test.cjs's embedding-path
// coverage, so a change to one cannot silently break the other's fixtures.
//
// Two probe shapes, chosen by whether a dedicated embedding sidecar is configured:
//   - EMBEDDING_BASE_URL set (sidecar): a live synthetic POST /v1/embeddings. The sidecar is not
//     the shared inference router, so it never holds the router's maintenance gate and a tiny
//     synthetic request there cannot load/evict the chat model — no inference guard needed.
//   - EMBEDDING_BASE_URL unset (router): embeddings share the chat engine. A POST there could load
//     the embed model and evict the loaded chat model on a single-slot engine, every TTL window,
//     triggered by nothing more than someone having Settings open — so this path only lists models
//     (GET /v1/models, no body ever sent) and checks EMBED_MODEL is among them. It goes through the
//     router's maintenance gate; if that gate is held (autotune/preset apply), that is not itself
//     an outage, so the probe falls back to the last cached status (or 'available' if none yet)
//     instead of reporting 'degraded'.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const Module = require('node:module');

delete process.env.RAG_DIR;
delete process.env.EMBEDDING_BASE_URL;
delete process.env.EMBEDDING_MODEL;
delete process.env.EMBED_MODEL;

function freshRag() {
  delete require.cache[require.resolve('./rag.cjs')];
  return require('./rag.cjs');
}

const realFetch = global.fetch;
test.afterEach(() => {
  global.fetch = realFetch;
  delete process.env.RETRIEVAL_PROBE_TIMEOUT_MS;
  delete process.env.RETRIEVAL_PROBE_TTL_MS;
});

function initFresh(overrides = {}) {
  const rag = freshRag();
  rag.init({ dataDir: os.tmpdir(), embedModel: 'probe-model', inferenceUrl: 'http://router.invalid', ...overrides });
  return rag;
}

// A maintenance gate double matching inference-maintenance.cjs's enter(): throws a 503 while
// `held` is true, otherwise returns a leave() the test can count.
function gate(heldRef) {
  return () => {
    if (heldRef.held) throw Object.assign(new Error('Model configuration is being applied. Try again shortly.'), { status: 503 });
    return () => {};
  };
}

// ── Router path (no EMBEDDING_BASE_URL): GET /v1/models, never POST ────────────────────────────

test('router path: EMBED_MODEL listed reads available, and no POST embeddings request is ever made', async () => {
  const seen = [];
  global.fetch = async (url, opts) => {
    seen.push({ url, method: opts?.method || 'GET' });
    return { ok: true, json: async () => ({ data: [{ id: 'probe-model' }, { id: 'chat-model' }] }) };
  };
  const rag = initFresh();
  assert.equal(await rag.retrievalStatus(), 'available');
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /\/v1\/models$/);
  assert.equal(seen[0].method, 'GET');
  assert.ok(!seen.some((s) => /\/v1\/embeddings/.test(s.url)), 'a health poll must never POST a live embedding request to the shared router');
});

test('router path: EMBED_MODEL missing from the listing reads degraded, not unavailable', async () => {
  global.fetch = async () => ({ ok: true, json: async () => ({ data: [{ id: 'chat-model' }] }) });
  const rag = initFresh();
  assert.equal(await rag.retrievalStatus(), 'degraded');
  assert.equal(rag.ragAvailable(), true, 'native deps are present; only the embed model is not loadable there');
});

test('router path: an unreachable or non-2xx router reads degraded', async () => {
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const rag = initFresh();
  assert.equal(await rag.retrievalStatus(), 'degraded');

  const rag2 = initFresh();
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
  assert.equal(await rag2.retrievalStatus(), 'degraded');
});

test('router path: a slow listing is bounded by its own timeout and never sends a body', async () => {
  process.env.RETRIEVAL_PROBE_TIMEOUT_MS = '80';
  let aborted = false, sawBody = false;
  global.fetch = (url, opts) => {
    if (opts?.body) sawBody = true;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ ok: true, json: async () => ({ data: [{ id: 'probe-model' }] }) }), 5000);
      opts.signal?.addEventListener('abort', () => { aborted = true; clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    });
  };
  const rag = initFresh();
  const started = Date.now();
  const status = await rag.retrievalStatus();
  assert.equal(status, 'degraded');
  assert.ok(aborted, 'the bounded probe actually aborted the slow request');
  assert.ok(Date.now() - started < 1000, 'the probe gave up near its own timeout');
  assert.equal(sawBody, false, 'GET /v1/models never carries a request body');
});

test('router path: the result is cached for the TTL, and the cache expires and re-probes', async () => {
  process.env.RETRIEVAL_PROBE_TTL_MS = '100';
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: true, json: async () => ({ data: [{ id: 'probe-model' }] }) }; };
  const rag = initFresh();
  const [a, b] = await Promise.all([rag.retrievalStatus(), rag.retrievalStatus()]);
  assert.equal(a, 'available'); assert.equal(b, 'available');
  assert.equal(calls, 1, 'concurrent callers share one in-flight probe');
  assert.equal(await rag.retrievalStatus(), 'available');
  assert.equal(calls, 1, 'a repeat call inside the TTL does not re-probe');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(await rag.retrievalStatus(), 'available');
  assert.equal(calls, 2, 'the stale cache entry was not reused past its TTL');
});

test('re-init() (an endpoint/model change) invalidates whatever the last probe found', async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: true, json: async () => ({ data: [{ id: 'probe-model' }] }) }; };
  const rag = initFresh();
  assert.equal(await rag.retrievalStatus(), 'available');
  assert.equal(calls, 1);
  rag.init({ dataDir: os.tmpdir(), embedModel: 'probe-model-2', inferenceUrl: 'http://router2.invalid' });
  await rag.retrievalStatus();
  assert.equal(calls, 2, 'a fresh init() must not serve a cached verdict from before the reconfiguration');
});

// ── Router path: the maintenance gate is not an outage ──────────────────────────────────────────

test('router path: the router maintenance gate being held reports the last cached status, not degraded', async () => {
  process.env.RETRIEVAL_PROBE_TTL_MS = '150'; // clamped to the module's own floor if lower
  const held = { held: false };
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls++; return { ok: true, json: async () => ({ data: [{ id: 'probe-model' }] }) }; };
  const rag = initFresh({ inferenceGuard: gate(held) });

  // First probe succeeds normally and is cached as available.
  assert.equal(await rag.retrievalStatus(), 'available');
  assert.equal(fetchCalls, 1);

  // Autotune/preset-apply now holds the gate; wait past the TTL so a new probe is attempted, finds
  // the gate held, and must fall back to the cached 'available' rather than 'degraded'.
  await new Promise((r) => setTimeout(r, 250));
  held.held = true;
  assert.equal(await rag.retrievalStatus(), 'available', 'maintenance is not an outage — the last real finding wins');
  assert.equal(fetchCalls, 1, 'no listing request is made while the gate is held');

  // The gate releases; the next stale probe runs for real again.
  held.held = false;
  await new Promise((r) => setTimeout(r, 250));
  global.fetch = async () => { fetchCalls++; return { ok: true, json: async () => ({ data: [{ id: 'other-model' }] }) }; };
  assert.equal(await rag.retrievalStatus(), 'degraded', 'a real probe runs again once the gate is free');
  assert.equal(fetchCalls, 2);
});

test('router path: a held gate with nothing cached yet reads available, not degraded', async () => {
  const held = { held: true };
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls++; return { ok: true, json: async () => ({ data: [] }) }; };
  const rag = initFresh({ inferenceGuard: gate(held) });
  assert.equal(await rag.retrievalStatus(), 'available', 'no finding yet and the gate is held — assume available rather than alarm');
  assert.equal(fetchCalls, 0, 'the gate throwing means no listing request is ever attempted');
});

// ── Sidecar path (EMBEDDING_BASE_URL set): POST /v1/embeddings, no inference gate ──────────────

test('sidecar path: a healthy synthetic embedding response reads available, and never carries real content', async () => {
  process.env.EMBEDDING_BASE_URL = 'http://sidecar.invalid';
  try {
    const seen = [];
    global.fetch = async (url, opts) => {
      seen.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }) };
    };
    const rag = initFresh();
    assert.equal(await rag.retrievalStatus(), 'available');
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /\/v1\/embeddings$/);
    assert.deepEqual(seen[0].body.input, ['noevia health probe'], 'the probe is a fixed synthetic string, never user/project content');
    assert.equal(seen[0].body.model, 'probe-model');
  } finally { delete process.env.EMBEDDING_BASE_URL; }
});

test('sidecar path: an unreachable, non-2xx or malformed response reads degraded', async () => {
  process.env.EMBEDDING_BASE_URL = 'http://sidecar.invalid';
  try {
    global.fetch = async () => { throw new Error('synthetic sidecar unavailable'); };
    const rag = initFresh();
    assert.equal(await rag.retrievalStatus(), 'degraded');

    global.fetch = async () => ({ ok: false, status: 503, text: async () => 'restarting' });
    const rag2 = initFresh();
    assert.equal(await rag2.retrievalStatus(), 'degraded');

    global.fetch = async () => ({ ok: true, json: async () => ({ data: [] }) });
    const rag3 = initFresh();
    assert.equal(await rag3.retrievalStatus(), 'degraded', 'an empty data array is not a real vector');
  } finally { delete process.env.EMBEDDING_BASE_URL; }
});

test('sidecar path: never goes through the router maintenance gate, even while it is held', async () => {
  process.env.EMBEDDING_BASE_URL = 'http://sidecar.invalid';
  try {
    global.fetch = async () => ({ ok: true, json: async () => ({ data: [{ embedding: [1] }] }) });
    // A gate that ALWAYS throws: if the sidecar probe called it, every result would degrade.
    const alwaysHeld = () => { throw Object.assign(new Error('held'), { status: 503 }); };
    const rag = initFresh({ inferenceGuard: alwaysHeld });
    assert.equal(await rag.retrievalStatus(), 'available', 'the sidecar is not the router — its probe must not consult the router gate at all');
  } finally { delete process.env.EMBEDDING_BASE_URL; }
});

test('sidecar path: a slow probe is bounded by its own timeout', async () => {
  process.env.EMBEDDING_BASE_URL = 'http://sidecar.invalid';
  process.env.RETRIEVAL_PROBE_TIMEOUT_MS = '80';
  try {
    let aborted = false;
    global.fetch = (url, opts) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ ok: true, json: async () => ({ data: [{ embedding: [1] }] }) }), 5000);
      opts.signal?.addEventListener('abort', () => { aborted = true; clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    });
    const rag = initFresh();
    const started = Date.now();
    assert.equal(await rag.retrievalStatus(), 'degraded');
    assert.ok(aborted);
    assert.ok(Date.now() - started < 1000);
  } finally { delete process.env.EMBEDDING_BASE_URL; }
});

// ── Shared behaviour: missing native deps short-circuits before any probe ──────────────────────

test('missing native SQLite modules read unavailable and never probe the embedder', async () => {
  const orig = Module._load;
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({ data: [{ id: 'probe-model' }] }) }; };
  Module._load = function (request, ...rest) {
    if (request === 'better-sqlite3' || request === 'sqlite-vec') {
      throw Object.assign(new Error(`Cannot find module '${request}'`), { code: 'MODULE_NOT_FOUND' });
    }
    return orig.apply(this, [request, ...rest]);
  };
  try {
    const rag = initFresh();
    assert.equal(await rag.retrievalStatus(), 'unavailable');
    assert.equal(rag.ragAvailable(), false);
    assert.equal(fetchCalled, false, 'no request is made when the index cannot run at all');
  } finally {
    Module._load = orig;
  }
});
