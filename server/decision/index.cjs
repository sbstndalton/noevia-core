'use strict';
// Decision layer v0 (docs/research/system-one/04-decision-provider-api.md). One primitive, decide(),
// in front of pluggable backends. It never carries authority: the caller passes the ALLOWED
// options/items and a deterministic fallback, the answer is validated against them, and every
// failure — unavailable, slow, malformed, unsure — resolves to that fallback. Nothing here throws
// into the caller. Not wired into chat yet: the RAG rerank prototype (experiments/system-one/rag)
// is its first user.

const KINDS = new Set(['choice', 'multi', 'rank', 'noul', 'score']);

/**
 * @param {{ backends: Record<string, object>, chains?: Record<string, string[]>, log?: (entry: object) => void,
 *           now?: () => number }} deps
 *   chains: purpose -> backend ids tried in order, e.g. { 'rag.rerank': ['llama-rerank'] }. The
 *   request's own fallback always follows the chain.
 */
function createDecisions({ backends, chains = {}, log = () => {}, now = Date.now }) {
  const benched = new Map(); // backend id -> until (ms): skipped after repeated deadline misses
  const misses = new Map();

  async function decide(request) {
    const started = now();
    const fallback = () => {
      const f = typeof request.fallback === 'function' ? request.fallback() : request.fallback;
      return { ...f, source: 'fallback', metadata: { ...(f?.metadata || {}), latencyMs: now() - started } };
    };
    const problem = invalidRequest(request);
    if (problem) return done(request, withReason(fallback(), `invalid-request: ${problem}`));
    for (const id of chains[request.purpose] || []) {
      const backend = backends[id];
      if (!backend || !backend.supports(request.kind, request.purpose)) continue;
      if ((benched.get(id) || 0) > now()) continue;
      if (backend.locality === 'remote' && request.context?.cloud !== 'allowed') continue;
      let result;
      try {
        result = await withDeadline(backend.decide(request), request.constraints.deadlineMs);
      } catch (error) {
        if (error?.deadline) { const n = (misses.get(id) || 0) + 1; misses.set(id, n); if (n >= 3) { benched.set(id, now() + 60_000); misses.set(id, 0); } }
        log({ purpose: request.purpose, backend: id, failed: error?.deadline ? 'deadline' : String(error?.message || error).slice(0, 200) });
        continue;
      }
      misses.set(id, 0);
      const invalid = invalidResult(request, result);
      if (invalid) { log({ purpose: request.purpose, backend: id, failed: `invalid: ${invalid}` }); continue; }
      const min = request.constraints.minConfidence;
      if (typeof min === 'number' && request.kind !== 'rank' && !(result.confidence >= min)) {
        return done(request, withReason(fallback(), 'low-confidence'), { backend: id, confidence: result.confidence });
      }
      return done(request, { ...result, source: id, metadata: { ...(result.metadata || {}), latencyMs: now() - started } });
    }
    return done(request, withReason(fallback(), 'no-backend-answered'));
  }

  function done(request, result, extra = {}) {
    log({ purpose: request.purpose, source: result.source, fellBack: result.metadata?.fellBack || null,
      latencyMs: result.metadata?.latencyMs, confidence: result.confidence ?? null, ...extra });
    return result;
  }

  return { decide, rank: (request) => decide({ ...request, kind: 'rank' }) };
}

function withReason(result, reason) { return { ...result, metadata: { ...result.metadata, fellBack: reason } }; }

function withDeadline(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error('deadline'), { deadline: true })), ms); })])
    .finally(() => clearTimeout(timer));
}

function invalidRequest(r) {
  if (!r || typeof r !== 'object') return 'not an object';
  if (!KINDS.has(r.kind)) return 'unknown kind';
  if (typeof r.purpose !== 'string' || !r.purpose) return 'purpose required';
  if (r.fallback === undefined) return 'fallback required';
  if (!r.constraints || !(r.constraints.deadlineMs > 0)) return 'deadlineMs required';
  if (r.kind === 'rank' && (!Array.isArray(r.items) || !r.items.length)) return 'rank needs items';
  if (['choice', 'multi'].includes(r.kind) && (!Array.isArray(r.options) || !r.options.length)) return 'options required';
  return null;
}

/** A backend's answer must stay inside what the caller allowed. */
function invalidResult(r, result) {
  if (!result || typeof result !== 'object' || !result.scores || typeof result.scores !== 'object') return 'no scores';
  const allowed = new Set((r.kind === 'rank' ? r.items : r.options || []).map((o) => o.id));
  if (Object.keys(result.scores).some((id) => !allowed.has(id))) return 'score for an id that was not offered';
  if (Object.values(result.scores).some((v) => typeof v !== 'number' || !Number.isFinite(v))) return 'non-numeric score';
  if (r.kind === 'rank') {
    if (!Array.isArray(result.selected) || result.selected.some((id) => !allowed.has(id))) return 'ranking outside the items';
    if (new Set(result.selected).size !== result.selected.length) return 'duplicate in ranking';
  } else if (r.kind === 'choice' && result.selected !== null && !allowed.has(result.selected)) return 'choice outside the options';
  return null;
}

module.exports = { createDecisions, invalidResult, invalidRequest };
