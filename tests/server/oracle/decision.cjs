'use strict';

// TEST ORACLE (#1071): never required by production code (server/oracle-isolation.test.cjs
// enforces that). The JS references of the decision layer's request and result checks and cause
// codes, kept only so tools/gen-decision-fixtures.cjs can regenerate tests/fixtures/decision.v1.json
// and the differential tests can compare them with dav-parse.wasm (sbstndalton/noevia-rs
// crates/decision). Production decides through the Rust module alone (server/decision/index.cjs).
// Moved here unchanged from server/decision/index.cjs invalidRequestJs, invalidResultJs and causeOfJs.

const { CAUSE_RE } = require('../../../server/decision/index.cjs');

const KINDS = new Set(['choice', 'multi', 'rank', 'noul', 'score']);

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

module.exports = { invalidRequestJs, invalidResultJs, causeOfJs };
