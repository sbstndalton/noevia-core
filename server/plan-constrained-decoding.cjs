'use strict';
// Optional engine-side constrained decoding for the PromptArchitect plan artifact (#517,
// spec-agent-execution §2). Behind features.constrainedPlanDecoding
// (NOEVIA_FEATURE_CONSTRAINED_PLAN_DECODING), off by default. It ADDS llama.cpp's
// `response_format: json_schema` to the artifact request; the after-the-fact artifact validation
// still runs on the result and is never replaced. Masking rules out malformed structure only, not
// wrong-but-valid content.
//
// The fields go only to the llama.cpp-backed local provider. Any other provider (a remote or
// external endpoint, a ChatGPT row, a custom OpenAI-compatible URL) never receives them.
// Unconstrained generation is the fallback, with the reason recorded, when:
//   - the model is a harmony/reasoning type (a grammar would also mask the reasoning channel),
//   - the caller has thinking on (same reason), or
//   - the engine rejects the field (HTTP 400/422/501: a build without json_schema support).
const { hasHarmonyReasoning } = require('./llamacpp-full-autotune.cjs');

const LIST = { type: 'array', items: { type: 'string' } };
const PLAN_ARTIFACT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['goal', 'steps', 'completion', 'context', 'constraints', 'investigation', 'capabilities', 'approval_boundaries', 'verification', 'non_goals'],
  properties: {
    goal: { type: 'string', minLength: 1 },
    context: LIST, constraints: LIST, investigation: LIST, capabilities: LIST,
    approval_boundaries: LIST, verification: LIST, non_goals: LIST,
    steps: { type: 'array', minItems: 1, maxItems: 12, items: {
      type: 'object', additionalProperties: false, required: ['n', 'do', 'done_when'],
      properties: { n: { type: 'integer', minimum: 1, maximum: 12 }, do: { type: 'string' }, done_when: { type: 'string' } } } },
    completion: { type: 'string' },
  },
});

const REJECTED = new Set([400, 422, 501]);

/** True only for the operator-configured local llama.cpp provider. */
function isLlamaCppProvider(provider, { defaultProviderId, managerKind } = {}) {
  return !!provider && managerKind === 'llamacpp' && provider.id === defaultProviderId
    && !provider.external && !provider.kind;
}

/** Decide what to add. Returns { fields, applied, reason }; fields is {} whenever applied is false. */
function planConstraint({ enabled, provider, managerKind, defaultProviderId, model, thinking = false } = {}) {
  const none = reason => ({ fields: {}, applied: false, mode: null, reason });
  if (!enabled) return none('flag_off');
  if (!isLlamaCppProvider(provider, { defaultProviderId, managerKind })) return none('not_llamacpp_provider');
  if (hasHarmonyReasoning(String(model || ''))) return none('reasoning_model');
  if (thinking) return none('thinking_enabled');
  return { applied: true, mode: 'json_schema', reason: null,
    fields: { response_format: { type: 'json_schema', json_schema: { name: 'plan_artifact', strict: true, schema: PLAN_ARTIFACT_SCHEMA } } } };
}

/**
 * Send the artifact request, constrained when allowed. `send(payload)` resolves to
 * { ok, status, body } (or throws an error with `.status`). An engine rejection retries once
 * unconstrained; anything else propagates. The result carries `constraint` for the job record,
 * and a log line is written for any fallback. Callers still validate the artifact afterwards.
 */
async function requestPlanArtifact({ payload, send, constraint, log = () => {} }) {
  if (!constraint?.applied) {
    const r = await unwrap(await send(payload));
    return { body: r.body, constraint: { applied: false, mode: null, reason: constraint?.reason || 'flag_off', fallback: false } };
  }
  let first;
  try { first = await send({ ...payload, ...constraint.fields }); } catch (error) { first = { ok: false, status: error?.status, error }; }
  if (first?.ok !== false) return { body: first?.body, constraint: { applied: true, mode: constraint.mode, reason: null, fallback: false } };
  if (!REJECTED.has(first.status)) throw first.error || Object.assign(new Error(`engine returned ${first.status}`), { status: first.status });
  log(`plan artifact: constrained decoding refused by the engine (${first.status}); retrying unconstrained`);
  const r = await unwrap(await send(payload));
  return { body: r.body, constraint: { applied: false, mode: null, reason: `engine_rejected_${first.status}`, fallback: true } };
}

async function unwrap(r) {
  if (r && r.ok === false) throw r.error || Object.assign(new Error(`engine returned ${r.status}`), { status: r.status });
  return { body: r?.body };
}

module.exports = { PLAN_ARTIFACT_SCHEMA, isLlamaCppProvider, planConstraint, requestPlanArtifact };
