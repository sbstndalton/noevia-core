'use strict';
// #1639: the adapter between our decision contract and a TypeSafe-shaped decision server (Ollaya's
// /v1/decisions, an alias of /v1/systemone). Our request is { state, question, options:[{id,label}] }
// (server/decision-endpoint.cjs); TypeSafe's is { model, state, questions: { <id>: { type:'choice',
// instructions, criteria: { <label id>: <description> } } } } and answers with per-option
// probabilities rounded to 4 decimals. The adapter renormalises them (rounding can break core's
// ±0.002 sum check), takes the argmax, and refuses an exact tie, so the caller falls back.
//
// Dependency-free on purpose: run.cjs uses it on the eval host, which has Node but no checkout.

const QUESTION_ID = 'd';
const SUM_TOLERANCE = 0.002; // decision-endpoint.cjs: scores must sum to 1 within this
const TIE_EPSILON = 1e-9;

const fail = (reason) => Object.assign(Error(reason), { reason });

/** Our request body as a TypeSafe choice question for `model`. */
function toTypeSafe(body, model) {
  if (!body || typeof body.state !== 'string' || typeof body.question !== 'string' || !Array.isArray(body.options)) throw fail('invalid-request');
  if (typeof model !== 'string' || !model) throw fail('invalid-model');
  const criteria = {};
  for (const o of body.options) {
    if (!o || typeof o.id !== 'string' || typeof o.label !== 'string') throw fail('invalid-request');
    if (Object.prototype.hasOwnProperty.call(criteria, o.id)) throw fail('duplicate-option');
    criteria[o.id] = o.label;
  }
  return { model, state: body.state, questions: { [QUESTION_ID]: { type: 'choice', instructions: body.question, criteria } } };
}

/**
 * A TypeSafe response as our decision result: { selected, scores, model, calibrated:false, raw }.
 * `raw` keeps the server's own probabilities, as sent, for the record. Throws { reason } when the
 * answer cannot be used: missing or extra options, a non-finite or negative probability, no mass,
 * or an exact tie between the top two.
 */
function fromTypeSafe(json, body, modelId) {
  const answer = json?.answers?.[QUESTION_ID];
  const probs = answer?.probabilities;
  if (!probs || typeof probs !== 'object' || Array.isArray(probs)) throw fail('no-probabilities');
  const ids = body.options.map((o) => o.id);
  const keys = Object.keys(probs);
  if (keys.length !== ids.length || !ids.every((id) => Object.prototype.hasOwnProperty.call(probs, id))) throw fail('option-mismatch');
  const values = ids.map((id) => probs[id]);
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)) throw fail('invalid-probability');
  const total = values.reduce((a, b) => a + b, 0);
  if (!(total > 0)) throw fail('no-mass');
  const scores = Object.fromEntries(ids.map((id, i) => [id, values[i] / total]));
  const ranked = ids.map((id) => [id, scores[id]]).sort((a, b) => b[1] - a[1]);
  if (ranked.length > 1 && ranked[0][1] - ranked[1][1] < TIE_EPSILON) throw fail('exact-tie');
  return { selected: ranked[0][0], scores, model: modelId, calibrated: false, raw: Object.fromEntries(ids.map((id, i) => [id, values[i]])) };
}

/**
 * Why `result` would be refused by core's decision endpoint (decision-endpoint.cjs choice()), or
 * null. The same five checks: selected is offered, one score per option, each in [0,1], the sum
 * within ±0.002, and selected the strict argmax.
 */
function contractProblem(body, result) {
  const ids = body.options.map((o) => o.id);
  if (!result || !ids.includes(result.selected)) return 'selected-not-offered';
  const scores = result.scores;
  if (!scores || typeof scores !== 'object' || Object.keys(scores).length !== ids.length) return 'score-count';
  if (!ids.every((id) => Number.isFinite(scores[id]) && scores[id] >= 0 && scores[id] <= 1)) return 'score-range';
  if (Math.abs(Object.values(scores).reduce((a, b) => a + b, 0) - 1) > SUM_TOLERANCE) return 'score-sum';
  if (ids.some((id) => id !== result.selected && scores[id] >= scores[result.selected])) return 'not-argmax';
  return null;
}

module.exports = { toTypeSafe, fromTypeSafe, contractProblem, QUESTION_ID, SUM_TOLERANCE };
