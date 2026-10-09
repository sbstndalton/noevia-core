'use strict';
// The Planner review verdict (#519): its schema, the strict reading of what a reviewer model
// returned, and the bounded shape a `review.*` job event keeps. Pure and dependency-free, like
// code-plan.cjs, so jobs.cjs can bound replayed events without loading the reviewer runner.
//
// The verdict is ADVICE. Nothing in its schema can name a capability, a domain, an approval or a
// decision, and `additionalProperties: false` at every level means a reviewer that tries to add
// one ("grant", "allow", "approvalId", ...) produces an invalid verdict, which fails closed to the
// person's own review. See code-review.cjs for how it is produced and code-harness.cjs for the
// card that still has to be answered by a human either way.
//
// Reading and bounding (CODE_REVIEW_VERDICT_IMPL, retired in #1071: Rust is always used) happen in
// noevia-rs's review-verdict crate (in dav-parse.wasm). Fails closed: a missing or tampered module
// stops startup; a fault in readVerdict throws ReviewVerdictError (the person reviews the change
// themselves), and a fault in boundReviewEvent keeps a failed review. Where the old JS would look
// inside an object that is not plain JSON data (a class instance, a sparse array), the port
// refuses instead of guessing, which is that same failure. The JS reference is
// tests/server/oracle/code-review-verdict.cjs (fixtures and tests only).

const VERDICTS = Object.freeze(['approve', 'request_changes']);
const SEVERITIES = Object.freeze(['blocker', 'major', 'minor', 'note']);
const MAX_SUMMARY = 600, MAX_FINDINGS = 12, MAX_FINDING = 600, MAX_FILE = 240, MAX_REASON = 300;

/** Restricted JSON-schema subset stream-guard.cjs understands (and llama.cpp's json_schema). */
const VERDICT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'findings'],
  properties: {
    verdict: { type: 'string', enum: [...VERDICTS] },
    summary: { type: 'string', maxLength: MAX_SUMMARY },
    findings: {
      type: 'array',
      maxItems: MAX_FINDINGS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'message'],
        properties: {
          severity: { type: 'string', enum: [...SEVERITIES] },
          file: { type: 'string', maxLength: MAX_FILE },
          message: { type: 'string', maxLength: MAX_FINDING },
        },
      },
    },
  },
});

class ReviewVerdictError extends Error {
  constructor(message) { super(message); this.name = 'ReviewVerdictError'; }
}

const MESSAGES = {
  fields: 'The verdict had fields a review cannot have.',
  verdict: 'The verdict was neither approve nor request changes.',
  missing: 'The verdict was missing its summary or findings.',
  too_many: 'The verdict listed too many findings.',
  malformed: 'A finding was malformed.',
  no_message: 'A finding had no message.',
  no_summary: 'The verdict had no summary.',
  unspecified: 'Changes were requested without saying which.',
  blocked: 'The verdict approved a change it also called blocked.',
};
const FAULT_MESSAGE = 'The verdict could not be read.';

let warnedFault = '';
function warnFault(err) {
  const reason = String(err?.reason || 'unexpected');
  if (warnedFault !== reason) { warnedFault = reason; console.warn(`[code-review-verdict] the Rust port failed (${reason}); failing closed`); }
}
const wasm = () => require('./dav-parse-wasm.cjs');

/** The reviewer's output, read strictly by the Rust port: the cleaned verdict or ReviewVerdictError;
 *  a fault throws ReviewVerdictError too (never a verdict the port did not give). */
function readVerdict(raw) {
  let r;
  try { r = wasm().reviewVerdictRead(raw); } catch (err) {
    warnFault(err);
    throw new ReviewVerdictError(FAULT_MESSAGE);
  }
  if (r.invalid) throw new ReviewVerdictError(MESSAGES[r.invalid]);
  return r.verdict;
}

/** boundReviewEvent through the Rust port; a fault keeps a failed review that names nothing. */
function boundReviewEvent(type, data = {}) {
  try { return wasm().reviewEventBound(type, data); } catch (err) {
    warnFault(err);
    return { status: 'failed', reviewer: 'planner', baseSha: null, headSha: null, code: 'invalid', reason: 'The recorded verdict could not be read.' };
  }
}

module.exports = { VERDICT_SCHEMA, VERDICTS, SEVERITIES, MAX_FINDINGS, MAX_REASON, ReviewVerdictError, readVerdict, boundReviewEvent, MESSAGES, FAULT_MESSAGE };
