'use strict';
// sbstndalton/noevia#2190 close-out: the Rust front answers GET /api/health (noevia-rs
// bins/noevia-server health_routes.rs, capability rust-health). It probes the default provider and
// the Diary sidecar itself. What only this process knows, whether retrieval can run (the native index
// dependencies) and the embedding probe's tri-state (rag.cjs retrievalStatus, with its cache and the
// administrator's embedding switch), is published here as rag-status.json (published-snapshot.cjs);
// the front reads it on every request and reports a file older than two intervals as
// `retrieval: "unavailable"`. It is published only while a signed-in page has asked in the last minute
// (the front's demand marker, published-snapshot.cjs), so an idle installation does not probe the embedder.
//
// Only the GET is the front's, and it is refused here before authentication, so a stale route table
// cannot make two processes answer. Node answered the path for every method; the other methods now
// find no route (404), which no client used.
const path = require('node:path');
const { createPublisher, intervalFrom } = require('./published-snapshot.cjs');

const ROUTE_REFUSAL = Object.freeze({ error: 'The health check is owned by the Rust front.', code: 'RUST_HEALTH_OWNED' });
const SNAPSHOT_FILE = 'rag-status.json';
const KIND = 'rag-status';
const WORDS = Object.freeze(['available', 'degraded', 'off', 'unavailable']);
/** The timer. The embedding service refreshes itself every 10 s; the probe behind retrieval caches 45 s. */
const DEFAULT_EVERY_MS = 10000;

/** Whether `method` on the exact `pathname` is the front's. */
const owned = (method, pathname) => method === 'GET' && pathname === '/api/health';

function refuseOwned(req, res, { parseRequestUrl, json }) {
  const url = parseRequestUrl(req, `http://${req.headers.host || 'localhost'}`) || parseRequestUrl(req);
  if (!url || !owned(req.method, url.pathname)) return false;
  json(res, 503, ROUTE_REFUSAL);
  return true;
}

/**
 * The retrieval state as the front reads it: `ragAvailable` (a boolean) and `retrieval` (one of the
 * four words; anything else, or a probe that threw, is "unavailable").
 * @param {{ ragAvailable: () => boolean, retrievalStatus: () => Promise<string> }} rag
 */
async function ragState(rag) {
  let retrieval = 'unavailable';
  try {
    const word = await rag.retrievalStatus();
    if (WORDS.includes(word)) retrieval = word;
  } catch { /* the probe never throws; if it did, the front says "unavailable" */ }
  return { ragAvailable: !!rag.ragAvailable(), retrieval };
}

/** The publisher of rag-status.json. `watch(service)` also republishes after the embedding service refreshes. */
function createRagStatusPublisher({ dataDir, rag, demand = null, env = process.env, onError = (err) => console.warn('[rag-status] could not publish:', err?.message || err) }) {
  const everyMs = intervalFrom(env.RAG_STATUS_PUBLISH_MS, DEFAULT_EVERY_MS);
  const publisher = createPublisher({ file: path.join(dataDir, SNAPSHOT_FILE), kind: KIND, everyMs, build: () => ragState(rag), onError, demand });
  return {
    ...publisher,
    everyMs,
    file: path.join(dataDir, SNAPSHOT_FILE),
    /** An administrator's embedding change shows up at the next refresh of the service: publish after it. */
    watch(service) {
      if (!service || typeof service.refresh !== 'function') return;
      const refresh = service.refresh.bind(service);
      service.refresh = async (...args) => { try { return await refresh(...args); } finally { publisher.changed(); } };
    },
  };
}

module.exports = { ROUTE_REFUSAL, SNAPSHOT_FILE, KIND, WORDS, owned, refuseOwned, ragState, createRagStatusPublisher };
