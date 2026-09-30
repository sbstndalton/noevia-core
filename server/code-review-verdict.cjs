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

const VERDICTS = Object.freeze(['approve', 'request_changes']);
const SEVERITIES = Object.freeze(['blocker', 'major', 'minor', 'note']);
const MAX_SUMMARY = 600, MAX_FINDINGS = 12, MAX_FINDING = 600, MAX_FILE = 240, MAX_REASON = 300;
const SHA = /^[0-9a-f]{7,64}$/;

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

// Control characters other than newline and tab are dropped: a verdict is shown to a person, and
// terminal escapes or bidi overrides in it would let the reviewer dress up what it says.
const clean = (value, max) => {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/g, '').trim();
  return Array.from(text).slice(0, max).join('');
};
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (object, allowed) => Object.keys(object).every((k) => allowed.includes(k));

/**
 * The reviewer's output, read strictly. Throws ReviewVerdictError with a short, reviewer-free
 * reason for anything but a well-formed, internally consistent verdict. Schema shape is checked
 * again here (not only by the stream guard) so this is safe on its own.
 */
function readVerdict(raw) {
  if (!isPlain(raw) || !own(raw, ['verdict', 'summary', 'findings'])) throw new ReviewVerdictError('The verdict had fields a review cannot have.');
  if (!VERDICTS.includes(raw.verdict)) throw new ReviewVerdictError('The verdict was neither approve nor request changes.');
  if (typeof raw.summary !== 'string' || !Array.isArray(raw.findings)) throw new ReviewVerdictError('The verdict was missing its summary or findings.');
  if (raw.findings.length > MAX_FINDINGS) throw new ReviewVerdictError('The verdict listed too many findings.');
  const findings = raw.findings.map((f) => {
    if (!isPlain(f) || !own(f, ['severity', 'file', 'message']) || !SEVERITIES.includes(f.severity)) throw new ReviewVerdictError('A finding was malformed.');
    if (f.file !== undefined && typeof f.file !== 'string') throw new ReviewVerdictError('A finding was malformed.');
    const message = clean(f.message, MAX_FINDING);
    if (!message) throw new ReviewVerdictError('A finding had no message.');
    const file = clean(f.file, MAX_FILE);
    return file ? { severity: f.severity, file, message } : { severity: f.severity, message };
  });
  const summary = clean(raw.summary, MAX_SUMMARY);
  if (!summary) throw new ReviewVerdictError('The verdict had no summary.');
  // Inconsistent verdicts are not guessed at: "request changes" with nothing to change, or
  // "approve" over a blocker, is a reviewer that did not do its job.
  if (raw.verdict === 'request_changes' && !findings.length) throw new ReviewVerdictError('Changes were requested without saying which.');
  if (raw.verdict === 'approve' && findings.some((f) => f.severity === 'blocker')) throw new ReviewVerdictError('The verdict approved a change it also called blocked.');
  return { verdict: raw.verdict, summary, findings };
}

const sha = (v) => (typeof v === 'string' && SHA.test(v) ? v : null);
const count = (v) => (Number.isInteger(v) && v >= 0 ? Math.min(v, 100000) : null);

/** What a `review.*` event keeps, on append and again on replay. Nothing else survives. */
function boundReviewEvent(type, data = {}) {
  const d = isPlain(data) ? data : {};
  const base = { reviewer: 'planner', baseSha: sha(d.baseSha), headSha: sha(d.headSha) };
  if (type === 'review.requested') return { status: 'pending', ...base, files: count(d.files) };
  if (type === 'review.failed') {
    return { status: 'failed', ...base, code: clean(d.code, 40) || 'failed',
      reason: clean(d.reason, MAX_REASON) || 'The review did not finish.' };
  }
  // review.completed: re-read through the same strict reader, so a hand-edited or legacy journal
  // line cannot put more on the card than a live verdict could. Unreadable becomes a failure.
  let verdict;
  try { verdict = readVerdict({ verdict: d.verdict, summary: d.summary, findings: d.findings }); }
  catch { return { status: 'failed', ...base, code: 'invalid', reason: 'The recorded verdict could not be read.' }; }
  return { status: 'completed', ...base, ...verdict, corrected: d.corrected === true };
}

module.exports = { VERDICT_SCHEMA, VERDICTS, SEVERITIES, MAX_FINDINGS, MAX_REASON, ReviewVerdictError, readVerdict, boundReviewEvent };
