'use strict';
// #1647: which decision models may be trusted for a decision whose answer can send data off the
// server. Today that is one decision, 'sensitivity': in Hybrid routing a "not sensitive" verdict
// clears a turn for a cloud provider (routing-modes.cjs createSensitivity). A model that has not
// passed the sensitivity bar on the #1639 evaluation set may not make that call, so without a
// qualified model the check counts as unavailable and the turn stays local (no card), as it did on
// every release before #1640.
//
// An entry is keyed by the identity the decision service itself reports with each answer (its model
// id AND a content revision pinning the served weights; decision-endpoint.cjs identityOf), never by
// a file name or a display name: a name says nothing about the weights behind it (the decision service
// reports DECISION_SERVICE_REPORTED_MODEL, decision-models.cjs, whatever is mounted at /model). An entry counts only with its
// qualifying evidence recorded next to it and at or above the bar; anything else is ignored.
//
// Adding a model here is the owner's decision (#1639), made on a measured run, not a code change
// that an agent makes on its own.

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
// A Hugging Face commit (40 hex) or a SHA-256 digest of the served weights (64 hex), lowercase.
const REVISION_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The bar per decision: the metric the evidence must report and its minimum. */
const BARS = Object.freeze({
  // Recall on the sensitive texts of the #1639 sensitivity set, in the production request shape.
  sensitivity: Object.freeze({ metric: 'sensitiveRecall', min: 0.85 }),
});

// Measured and NOT qualified (kept here so nobody adds them by name):
// - Laya-en, the live decision service (reported id DECISION_SERVICE_REPORTED_MODEL, HF revision
//   1c5edc17a7acd8701df6fc341c0d179f1c62c982), #1639 run 2026-10-13: sensitive recall 1.9% over all
//   languages and 0 of 40 English sensitive texts in the production request shape (18 of 40 with the
//   Context section left out); 48.0% sensitivity accuracy. Every one of the 40 English sensitive
//   texts was answered "not sensitive" at a share of 0.6 or more, so after #1640 all 40 would have
//   been cleared for cloud.
const QUALIFIED = Object.freeze({
  sensitivity: Object.freeze([
    // { model: '<id the service reports>', revision: '<40 or 64 hex the service reports>',
    //   evidence: { set: '#1639 sensitivity', sensitiveRecall: 0.9, benignFlagged: 0.03, measured: 'YYYY-MM-DD', issue: '#NNNN' } },
  ]),
});

/** A reported identity, validated: { model, revision } or null. Accepts the service's own field
 *  names (`model`, `model_revision`) or the normalized ones. Anything malformed is null. */
function identityOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const model = raw.model;
  const revision = raw.revision !== undefined ? raw.revision : raw.model_revision;
  if (typeof model !== 'string' || !MODEL_ID_RE.test(model)) return null;
  if (typeof revision !== 'string' || !REVISION_RE.test(revision)) return null;
  return { model, revision };
}

/** True when an entry carries evidence that meets the decision's bar. */
function entryMeetsBar(entry, bar) {
  if (!bar || !entry || typeof entry !== 'object' || !identityOf(entry)) return false;
  const evidence = entry.evidence;
  if (!evidence || typeof evidence !== 'object') return false;
  const value = evidence[bar.metric];
  return typeof evidence.set === 'string' && evidence.set.length > 0 && typeof evidence.measured === 'string' && evidence.measured.length > 0
    && typeof value === 'number' && Number.isFinite(value) && value >= bar.min && value <= 1;
}

/** The entries that count for `decision` in `list` (default: the shipped list). */
function qualifiedEntries(decision, list = QUALIFIED[decision]) {
  const bar = BARS[decision];
  return (Array.isArray(list) ? list : []).filter((entry) => entryMeetsBar(entry, bar));
}

/** The matching qualified entry for a reported identity, or null. Exact match on model AND revision. */
function qualifiedFor(decision, identity, list = QUALIFIED[decision]) {
  const id = identityOf(identity);
  if (!id) return null;
  return qualifiedEntries(decision, list).find((e) => e.model === id.model && e.revision === id.revision) || null;
}

module.exports = { BARS, QUALIFIED, identityOf, qualifiedEntries, qualifiedFor, entryMeetsBar };
