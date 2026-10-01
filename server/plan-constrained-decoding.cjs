'use strict';
// Optional engine-side constrained decoding for the Planner's plan artifact (#517, #511;
// spec-agent-execution §2 output contract). Behind features.constrainedPlanDecoding
// (NOEVIA_FEATURE_CONSTRAINED_PLAN_DECODING), off by default. It ADDS
// `response_format: { type: 'json_schema', json_schema: { schema } }` to the plan request; the
// stream validator (stream-guard.cjs, Laya-lite) and the artifact check in planner-plan.cjs still
// run on the result and are never replaced. Masking rules out malformed structure only, not
// wrong-but-valid content.
//
// Who receives it is data, not code: only a provider whose capabilities declare
// `jsonSchemaParam: true` (providers.cjs). The local llama.cpp engine declares it through its engine
// definition (providers.cjs ENGINE_CAPABILITIES); any other row only if an administrator says so.
// No host, vendor or model is named here.
//
// Field choice (verified against llama.cpp b10920, the build docs/sources.md pins):
// tools/server/server-common.cpp reads `response_format.type === 'json_schema'` and takes
// `response_format.json_schema.schema` (the OpenAI-compatible shape), turning it into a grammar. The
// top-level `json_schema` body field means the same there, but other OpenAI-compatible APIs only know
// `response_format`, so that is the one sent. `name` and `strict` are ignored by llama.cpp.
//
// Thinking (the open question on #517). In b10920 the response-format grammar is
// `reasoning-block? json` only when the server extracts reasoning (common/chat-auto-parser-generator.cpp);
// with reasoning extraction off, a `<think>` opening would be masked and the template's reasoning
// channel broken. So a constrained plan call also sends `chat_template_kwargs.enable_thinking: false`:
// the plan is produced without a reasoning channel, which is also what §2 asks for ("no hidden
// reasoning requested") and what the prompt-preparation experiment does (thinking on spent the whole
// budget before any JSON). Unconstrained generation is used instead, with the reason recorded, when:
//   - the model family's reasoning channel cannot be switched off by that kwarg (harmony format,
//     sampling-recommendation.cjs family table) — a grammar would mask the channel,
//   - the caller explicitly asks for thinking on the plan call (`thinking: true`), or
//   - the engine rejects the fields (HTTP 400/422/501): retried once without them, logged text-free.
const { hasHarmonyReasoning } = require('./sampling-recommendation.cjs');

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

/** True when the provider row declares that it accepts a json_schema response_format. */
function supportsJsonSchema(provider) {
  return !!provider && provider.capabilities?.jsonSchemaParam === true;
}

/**
 * Decide what to add. Returns { fields, applied, mode, reason }; fields is {} whenever applied is false.
 * `provider` is a row as providers.cjs getProvider() returns it (effective capabilities attached).
 * @param {{ enabled?: boolean, provider?: any, model?: string|null, thinking?: boolean }} [input]
 */
function planConstraint({ enabled, provider, model, thinking = false } = {}) {
  const none = reason => ({ fields: {}, applied: false, mode: null, reason });
  if (!enabled) return none('flag_off');
  if (!supportsJsonSchema(provider)) return none('provider_unsupported');
  if (hasHarmonyReasoning(String(model || ''))) return none('reasoning_model');
  if (thinking) return none('thinking_enabled');
  return { applied: true, mode: 'json_schema', reason: null, fields: {
    response_format: { type: 'json_schema', json_schema: { name: 'plan_artifact', strict: true, schema: PLAN_ARTIFACT_SCHEMA } },
    chat_template_kwargs: { enable_thinking: false },
  } };
}

/** The payload with the constraint's fields merged in (existing template kwargs are kept). */
function constrainedPayload(payload, constraint) {
  const { chat_template_kwargs: kwargs, ...rest } = constraint.fields;
  return { ...payload, ...rest, ...(kwargs ? { chat_template_kwargs: { ...(payload.chat_template_kwargs || {}), ...kwargs } } : {}) };
}

/**
 * Send the plan request, constrained when allowed. `send(payload)` resolves to { ok, status, body }
 * (or throws an error with `.status`). An engine rejection retries once unconstrained; anything else
 * propagates. The result carries `constraint` for the record. `log` gets a text-free entry (status
 * only, never the engine's message or any model text) for a fallback. Callers still validate.
 */
/** @param {{ payload: object, send: (payload: object) => Promise<any>, constraint?: any, log?: (entry: object) => void }} input */
async function requestPlanArtifact({ payload, send, constraint, log = (_entry) => {} }) {
  if (!constraint?.applied) {
    const r = await unwrap(await send(payload));
    return { body: r.body, constraint: { applied: false, mode: null, reason: constraint?.reason || 'flag_off', fallback: false } };
  }
  let first;
  try { first = await send(constrainedPayload(payload, constraint)); } catch (error) { first = { ok: false, status: error?.status, error }; }
  if (first?.ok !== false) return { body: first?.body, constraint: { applied: true, mode: constraint.mode, reason: null, fallback: false } };
  if (!REJECTED.has(first.status)) throw first.error || Object.assign(new Error(`engine returned ${first.status}`), { status: first.status });
  try { log({ event: 'plan.constraint_rejected', status: first.status }); } catch { /* logging never changes the outcome */ }
  const r = await unwrap(await send(payload));
  return { body: r.body, constraint: { applied: false, mode: null, reason: `engine_rejected_${first.status}`, fallback: true } };
}

/** @param {any} r */
async function unwrap(r) {
  if (r && r.ok === false) throw r.error || Object.assign(new Error(`engine returned ${r.status}`), { status: r.status });
  return { body: r?.body };
}

module.exports = { PLAN_ARTIFACT_SCHEMA, REJECTED, supportsJsonSchema, planConstraint, constrainedPayload, requestPlanArtifact };
