'use strict';
// #1639: our decision request as a TypeSafe choice question (Ollaya's /v1/decisions), and its answer
// back as { selected, scores }. The same rules as tools/decision-eval/adapter.cjs, which measured
// Kev-0.8B (that copy stays dependency-free for the eval host; decision-typesafe.test.cjs checks
// that both read every answer the same way). The probabilities come rounded to 4 decimals, so they
// are renormalised (core checks the sum within 0.002); an exact tie is refused, so the caller falls
// back instead of picking by option order.

const QUESTION_ID = 'd';
const TIE_EPSILON = 1e-9;
const fail = (reason) => Object.assign(Error('Invalid decision result'), { reason });

/** { model, state, questions: { d: { type: 'choice', instructions, criteria } } } for `servedModel`. */
function toTypeSafe({ state, question, options }, servedModel) {
  const criteria = {};
  for (const o of options) criteria[o.id] = o.label;
  return { model: servedModel, state, questions: { [QUESTION_ID]: { type: 'choice', instructions: question, criteria } } };
}

/** The answer as { selected, scores } over exactly `ids`; throws { reason } when it cannot be used. */
function fromTypeSafe(json, ids) {
  const probs = json?.answers?.[QUESTION_ID]?.probabilities;
  if (!probs || typeof probs !== 'object' || Array.isArray(probs)) throw fail('invalid-result');
  const keys = Object.keys(probs);
  if (keys.length !== ids.length || !ids.every((id) => Object.prototype.hasOwnProperty.call(probs, id))) throw fail('invalid-result');
  const values = ids.map((id) => probs[id]);
  if (!values.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)) throw fail('invalid-result');
  const total = values.reduce((a, b) => a + b, 0);
  if (!(total > 0)) throw fail('invalid-result');
  const scores = Object.fromEntries(ids.map((id, i) => [id, values[i] / total]));
  const ranked = ids.map((id) => [id, scores[id]]).sort((a, b) => b[1] - a[1]);
  if (ranked.length > 1 && ranked[0][1] - ranked[1][1] < TIE_EPSILON) throw fail('invalid-result');
  return { selected: ranked[0][0], scores };
}

module.exports = { toTypeSafe, fromTypeSafe, QUESTION_ID };
