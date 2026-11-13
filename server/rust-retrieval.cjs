'use strict';
// Rust port track R4: the project search of the paired Rust front (noevia-rs native_retrieval, `POST
// /v1/retrieval/search` on its private store listener, `--features rust-retrieval-v1`), asked by rag.cjs
// searchProject. One switch for both processes, NOEVIA_RUST_RETRIEVAL:
//   off (the default; unset or empty)  this process searches, as before; the front is never asked;
//   shadow                             this process searches and answers; the front is asked too, and one log
//                                      line says whether the two answers agree (counts and a position, no text);
//   on                                 the front answers, unless it defers (the reranker is on, the target embeds
//                                      on the shared engine, ...) or cannot be reached: then this process searches.
// The request carries this process's wanted versions for the project's files (rag.cjs fileVersions), so a file
// it is re-indexing is filtered there as here. Only the front's own loopback listener with the per-start secret; a
// front without the route answers 404, which is a deferral like any other.

const MODES = new Set(['off', 'shadow', 'on']);
const DEADLINE_MS = 30000;
const MAX_BYTES = 16 * 1024 * 1024;

function mode(env = process.env) {
  const raw = String(env.NOEVIA_RUST_RETRIEVAL ?? '').trim();
  if (raw === '') return 'off';
  return MODES.has(raw) ? raw : null;
}

// A hit as searchProject returns it: { file, body, score } with a string file and body and a finite score.
function hitsOf(value) {
  if (!value || !Array.isArray(value.hits)) return null;
  const out = [];
  for (const h of value.hits) {
    if (!h || typeof h.file !== 'string' || typeof h.body !== 'string' || typeof h.score !== 'number' || !Number.isFinite(h.score)) return null;
    out.push({ file: h.file, body: h.body, score: h.score });
  }
  return out;
}

/** The shadow log line: agreement by count and the first differing position (file, body and score). */
function compare(local, native) {
  const same = (a, b) => a.file === b.file && a.body === b.body && a.score === b.score;
  const n = Math.min(local.length, native.length);
  let i = 0;
  while (i < n && same(local[i], native[i])) i++;
  if (i === n && local.length === native.length) return `match (${local.length} hits)`;
  return `differs (node ${local.length} hits, native ${native.length} hits, first difference at ${i})`;
}

/**
 * `{ mode, ask(projectId, query, userId, versions) }`, or null when the switch is off or invalid, or the front's
 * listener or secret is missing. `ask` resolves to the hits, or null: the front deferred, failed or lacks the
 * route, so this process searches.
 */
function createClient({ env = process.env, port = Number(env.NOEVIA_PROJECT_STORE_PORT), token = '', fetchImpl = globalThis.fetch, log = (line) => console.warn(line) } = {}) {
  const m = mode(env);
  if (m === null) { log('[rag] NOEVIA_RUST_RETRIEVAL must be off, shadow or on; the native search stays off.'); return null; }
  if (m === 'off') return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== 'string' || token.length < 32) {
    log('[rag] NOEVIA_RUST_RETRIEVAL is set but the paired front is not configured; this process searches.');
    return null;
  }
  async function ask(projectId, query, userId, versions) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/v1/retrieval/search`, {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-noevia-store-token': token },
        body: JSON.stringify({ user: userId || null, projectId, query, versions }),
        signal: AbortSignal.timeout(DEADLINE_MS),
      });
      if (!response.ok) return null;
      const value = await require('./http.cjs').readCappedJson(response, MAX_BYTES);
      return hitsOf(value);
    } catch { return null; }
  }
  return { mode: m, ask };
}

module.exports = { createClient, mode, compare, hitsOf };
