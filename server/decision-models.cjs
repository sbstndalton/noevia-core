'use strict';
// #1639: which decision model serves a decision endpoint, and what follows from it: the wire protocol,
// the wording the callers use, and the calibration temperature applied to its scores.
//
// The model is an explicit id the operator sets next to the endpoint's URL (COWORK_DECISION_MODEL, and
// COWORK_SENSITIVITY_DECISION_MODEL for the sensitivity override), never a file name or a name the
// service reports: wording must be chosen before the first request is sent, and a name says nothing
// about the weights behind it. Unset or unknown ids get the Laya profile, which is exactly what every
// release before #1639 sent: the Laya contract, the Laya-measured wording and no temperature.
//
// Adding or changing a profile changes what production sends; the wording behind 'kev' was tuned and
// measured on the #1639 split (tools/decision-eval), the temperature fitted there (T 0.45).

// The id the decision service (Laya) reports for itself in a reply. The one place this literal lives in
// non-test code (#221): decision-endpoint.cjs and system-one-router.cjs expose a reported model only when it
// equals this, and null for anything else. It is the identity the service answers with, not a setting: changing
// it changes what the callers accept, so it is a code change like the profile table below.
const DECISION_SERVICE_REPORTED_MODEL = "convaiinnovations/laya";

const PROFILES = Object.freeze({
  // services/laya: POST /v1/decisions { state, question, options } -> { selected, scores, model, ... }.
  laya: Object.freeze({ id: 'laya', protocol: 'laya', wording: 'laya', temperature: 1, reportedModel: DECISION_SERVICE_REPORTED_MODEL }),
  // Kev-0.8B served by Ollaya 0.13.0 (TypeSafe /v1/decisions, a bearer key), as in the #1639 evaluation.
  'kev-0.8b': Object.freeze({ id: 'kev-0.8b', protocol: 'typesafe', servedModel: 'ollaya.dev/library/kev:0.8b', wording: 'kev', temperature: 0.45 }),
});

/** The profile for an operator-set model id; unset or unknown: Laya's. */
function profileFor(id) {
  const key = typeof id === 'string' ? id.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(PROFILES, key) ? PROFILES[key] : PROFILES.laya;
}

/** True when `id` names a known profile (for a startup warning on a typo). Unset counts as known. */
function knownModel(id) {
  const key = typeof id === 'string' ? id.trim().toLowerCase() : '';
  return !key || Object.prototype.hasOwnProperty.call(PROFILES, key);
}

/** Scores sharpened (T < 1) or flattened (T > 1) by a calibration temperature: s^(1/T), renormalised.
 *  T 1 (or anything not a positive finite number) returns the scores object itself, untouched. The
 *  order of the options, and so the argmax, never changes. */
function tempered(scores, temperature) {
  if (!(Number.isFinite(temperature) && temperature > 0) || temperature === 1) return scores;
  const ids = Object.keys(scores);
  const w = ids.map((id) => Math.max(scores[id], 1e-9) ** (1 / temperature));
  const z = w.reduce((a, b) => a + b, 0);
  return Object.fromEntries(ids.map((id, i) => [id, w[i] / z]));
}

module.exports = { DECISION_SERVICE_REPORTED_MODEL, PROFILES, profileFor, knownModel, tempered };
