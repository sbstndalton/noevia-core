'use strict';
// Decision layer v0 (docs/research/system-one/04-decision-provider-api.md). One primitive, decide(),
// in front of pluggable backends. It never carries authority: the caller passes the ALLOWED
// options/items and a deterministic fallback, the answer is validated against them, and every
// failure — unavailable, slow, malformed, unsure — resolves to that fallback. Nothing here throws
// into the caller. Used by offline experiments and the opt-in System-One auto-role router.
//
// DECISION_IMPL=js|wasm (default js; any other value means js, with one warning), read on every
// call: wasm decides invalidRequest, invalidResult and causeOf in noevia-rs's decision crate (in
// dav-parse.wasm) over a projection of exactly the values they read. The chain, deadlines,
// benching and logging stay here. Fails closed: the flag is in dav-parse-wasm.cjs IMPL_FLAGS (a
// missing or tampered module stops startup); a fault makes the request or the backend's answer
// invalid (the caller's fallback answers) and a cause 'exception'. Stricter than the JS, as
// faults: where the JS would throw (an item that is null, options that are not an array), compare
// object identities (ids that are objects), coerce an object (a deadlineMs that is not a
// primitive) or iterate a sparse array or one over 65,536 entries.

const KINDS = new Set(['choice', 'multi', 'rank', 'noul', 'score']);

/**
 * @param {{ backends: Record<string, object>, chains?: Record<string, string[]>, log?: (entry: object) => void,
 *           now?: () => number, onDiagnostic?: (entry: object) => void }} deps
 *   onDiagnostic: OPT-IN, for offline experiments only. Receives the backend's own structured
 *   diagnostics (error.diagnostics on failure, result.metadata.diagnostics on success) for every
 *   backend attempt. Backends put measurements there, never prompt text. Production does not pass
 *   it, so nothing extra is recorded there.
 *   chains: purpose -> backend ids tried in order, e.g. { 'rag.rerank': ['llama-rerank'] }. The
 *   request's own fallback always follows the chain.
 */
function createDecisions({ backends, chains = {}, log = () => {}, now = Date.now, onDiagnostic = null, impl, wasmLoader }) {
  const opts = { impl, wasmLoader };
  const benched = new Map(); // backend id -> until (ms): skipped after repeated deadline misses
  const misses = new Map();

  async function decide(request) {
    const started = now();
    const fallback = () => {
      const f = typeof request.fallback === 'function' ? request.fallback() : request.fallback;
      return { ...f, source: 'fallback', metadata: { ...(f?.metadata || {}), latencyMs: now() - started } };
    };
    const problem = invalidRequest(request, opts);
    if (problem) return done(request, withReason(fallback(), `invalid-request: ${problem}`, 'invalid-request'));
    // #682: why the last backend in the chain did not answer, as a short code (never message text),
    // so a fallback record says more than "no-backend-answered".
    let cause = (chains[request.purpose] || []).length ? null : 'no-chain';
    for (const id of chains[request.purpose] || []) {
      const backend = backends[id];
      if (!backend) { cause = 'backend-missing'; continue; }
      if (!backend.supports(request.kind, request.purpose)) { cause = 'unsupported-kind'; continue; }
      if ((benched.get(id) || 0) > now()) { cause = 'benched'; continue; }
      if (backend.locality === 'remote' && request.context?.cloud !== 'allowed') { cause = 'remote-forbidden'; continue; }
      let result;
      try {
        result = await withDeadline((signal) => backend.decide(request, { signal }), request.constraints.deadlineMs);
      } catch (error) {
        if (error?.deadline) { const n = (misses.get(id) || 0) + 1; misses.set(id, n); if (n >= 3) { benched.set(id, now() + 60_000); misses.set(id, 0); } }
        const reason = error?.deadline ? 'deadline' : String(error?.message || error);
        cause = causeOf(error, opts);
        log({ purpose: request.purpose, backend: id, failed: reason.slice(0, 200) });
        if (onDiagnostic) onDiagnostic({ purpose: request.purpose, backend: id, ok: false, reason, diagnostics: error?.diagnostics ?? null });
        continue;
      }
      misses.set(id, 0);
      const invalid = invalidResult(request, result, opts);
      if (onDiagnostic) onDiagnostic({ purpose: request.purpose, backend: id, ok: !invalid, reason: invalid ? `invalid: ${invalid}` : null, diagnostics: result?.metadata?.diagnostics ?? null });
      if (invalid) { cause = 'invalid-result'; log({ purpose: request.purpose, backend: id, failed: `invalid: ${invalid}` }); continue; }
      const min = request.constraints.minConfidence;
      if (typeof min === 'number' && request.kind !== 'rank' && !(result.confidence >= min)) {
        return done(request, withReason(fallback(), 'low-confidence'), { backend: id, confidence: result.confidence });
      }
      return done(request, { ...result, source: id, metadata: { ...(result.metadata || {}), latencyMs: now() - started } });
    }
    return done(request, withReason(fallback(), 'no-backend-answered', cause || 'no-backend'));
  }

  function done(request, result, extra = {}) {
    log({ purpose: request.purpose, source: result.source, fellBack: result.metadata?.fellBack || null, cause: result.metadata?.cause || null,
      latencyMs: result.metadata?.latencyMs, confidence: result.confidence ?? null, ...extra });
    return result;
  }

  return { decide, rank: (request) => decide({ ...request, kind: 'rank' }) };
}

function withReason(result, reason, cause = null) { return { ...result, metadata: { ...result.metadata, fellBack: reason, ...(cause ? { cause } : {}) } }; }

const CAUSE_RE = /^[a-z][a-z0-9-]{0,39}$/;
/**
 * A short, text-free code for why a decision call failed (#682). Only a vetted `reason` slug set by
 * our own code, or a classification of the error's type, is returned: never an error message, which
 * may echo a service body or model output.
 */
function causeOfJs(error) {
  if (error?.deadline) return 'deadline';
  if (typeof error?.reason === 'string' && CAUSE_RE.test(error.reason)) return error.reason;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'aborted';
  if (error instanceof SyntaxError) return 'parse';
  if (error instanceof TypeError && /fetch failed/i.test(String(error.message))) return 'network';
  return 'exception';
}

// The backend gets an AbortSignal that fires at the deadline, so an HTTP call or worker job it
// started is cancelled rather than left running after its answer stopped mattering.
function withDeadline(start, ms) {
  const ctl = new AbortController();
  let timer;
  return Promise.race([start(ctl.signal), new Promise((_, reject) => { timer = setTimeout(() => { ctl.abort(); reject(Object.assign(Error('deadline'), { deadline: true })); }, ms); })])
    .finally(() => clearTimeout(timer));
}

function invalidRequestJs(r) {
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
function invalidResultJs(r, result) {
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

const IMPLS = new Set(['js', 'wasm']);
let warnedImpl = '';
/** DECISION_IMPL: 'js' (default) or 'wasm'. */
function decisionImpl(env = process.env) {
  const raw = env.DECISION_IMPL;
  if (raw === undefined || raw === '') return 'js';
  const value = String(raw).trim().toLowerCase();
  if (IMPLS.has(value)) return value;
  if (warnedImpl !== value) {
    warnedImpl = value;
    console.warn(`[decision] DECISION_IMPL=${JSON.stringify(String(raw))} is not js or wasm; using js`);
  }
  return 'js';
}
let warnedFault = '';
function warnFault(err) {
  const reason = String(err?.reason || 'unexpected');
  if (warnedFault !== reason) { warnedFault = reason; console.warn(`[decision] the Rust port failed (${reason}); failing closed`); }
}
const defaultLoader = () => require('../dav-parse-wasm.cjs');
const REQUEST_FAULT = 'the request could not be checked';
const RESULT_FAULT = 'the result could not be checked';
const useWasm = (impl) => (impl || decisionImpl()) === 'wasm';

/** invalidRequest(r): the problem, or null. `opts` ({ impl, wasmLoader }) is for tests. */
function invalidRequest(r, { impl, wasmLoader = defaultLoader } = {}) {
  if (!useWasm(impl)) return invalidRequestJs(r);
  try { return wasmLoader().decisionInvalidRequest(r); } catch (err) { warnFault(err); return REQUEST_FAULT; }
}

/** invalidResult(r, result): why the answer is not inside what was offered, or null. */
function invalidResult(r, result, { impl, wasmLoader = defaultLoader } = {}) {
  if (!useWasm(impl)) return invalidResultJs(r, result);
  try { return wasmLoader().decisionInvalidResult(r, result); } catch (err) { warnFault(err); return RESULT_FAULT; }
}

/** causeOf(error): a short, text-free code. */
function causeOf(error, { impl, wasmLoader = defaultLoader } = {}) {
  if (!useWasm(impl)) return causeOfJs(error);
  try { return wasmLoader().decisionCauseOf(error); } catch (err) { warnFault(err); return 'exception'; }
}

module.exports = { createDecisions, invalidResult, invalidRequest, causeOf, CAUSE_RE, invalidResultJs, invalidRequestJs, causeOfJs, decisionImpl, REQUEST_FAULT, RESULT_FAULT };
