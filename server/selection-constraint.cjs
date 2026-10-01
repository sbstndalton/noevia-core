'use strict';
// Reasoning-off, JSON-constrained request fields for the bounded System-One skill/tool selection
// call (#716, #265). The selection reply is one small JSON proposal; a reasoning model that thinks
// first spends the whole token budget before any JSON (empty content, finish_reason length).
// Who gets what is provider capability data (providers.cjs), never a host or model name here:
//   jsonSchemaParam        -> response_format json_schema (the proposal schema) and
//                             chat_template_kwargs.enable_thinking=false (same engine family, same
//                             reason as plan-constrained-decoding.cjs)
//   reasoningEffortParam   -> reasoning_effort 'low' (when reasoningEffortModels lists the model or is absent)
// A provider that declares neither receives no extra field, and the caller keeps its tight max_tokens.
// The feature flag for the production selector stays off; this is only the request shaper.
const { hasHarmonyReasoning } = require('./sampling-recommendation.cjs');
const { REJECTED, supportsJsonSchema, constrainedPayload } = require('./plan-constrained-decoding.cjs');

const SELECTION_MAX_ITEMS = 4; // 1 skill + 3 toolboxes, the contract.cjs bounds
const SELECTION_MAX_TOKENS = 192;

// Mirrors contract.cjs validateProposal's shape; the validator still runs on every reply.
const SELECTION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['selected', 'scores', 'confidence', 'abstain'],
  properties: {
    selected: { type: 'array', maxItems: SELECTION_MAX_ITEMS, items: { type: 'string' } },
    scores: { type: 'object', additionalProperties: { type: 'number', minimum: 0, maximum: 1 } },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    abstain: { type: 'boolean' },
  },
});

function effortParamApplies(provider, model) {
  const caps = provider?.capabilities;
  if (!caps || caps.reasoningEffortParam !== true) return false;
  return !Array.isArray(caps.reasoningEffortModels) || caps.reasoningEffortModels.includes(model);
}

/** Decide the extra request fields. Returns { fields, schema, thinkingOff, reasoningEffort }. */
function selectionConstraint({ provider, model } = {}) {
  const fields = {};
  let schema = false, thinkingOff = false, reasoningEffort = false;
  if (effortParamApplies(provider, model)) { fields.reasoning_effort = 'low'; reasoningEffort = true; }
  // A harmony-format reasoning channel cannot be switched off by the kwarg and a grammar would mask it.
  if (supportsJsonSchema(provider) && !hasHarmonyReasoning(String(model || ''))) {
    fields.response_format = { type: 'json_schema', json_schema: { name: 'selection_proposal', strict: true, schema: SELECTION_SCHEMA } };
    fields.chat_template_kwargs = { enable_thinking: false };
    schema = true; thinkingOff = true;
  }
  return { fields, schema, thinkingOff, reasoningEffort, applied: schema || reasoningEffort };
}

/**
 * Send the selection request with the constraint. `send(payload)` resolves to the parsed response or
 * throws an error with `.status`. An engine rejection (400/422/501) retries once without the added
 * fields; anything else propagates. Returns { result, fallback, status } where status is text-free.
 * @param {{ payload: object, send: (p: object) => Promise<any>, constraint: any }} input
 */
async function requestSelection({ payload, send, constraint }) {
  if (!constraint?.applied) return { result: await send(payload), fallback: false, status: null };
  try {
    return { result: await send(constrainedPayload(payload, constraint)), fallback: false, status: null };
  } catch (error) {
    if (!REJECTED.has(error?.status)) throw error;
    return { result: await send(payload), fallback: true, status: error.status };
  }
}

/**
 * Text-free cause for a reply that cannot be used. Never reads content beyond its type and length.
 * @param {{ content?: unknown, finishReason?: string|null, parsed?: unknown }} r
 */
function selectionCause({ content, finishReason, parsed }) {
  if (finishReason === 'length') return 'truncated';
  if (typeof content !== 'string' || !content.trim()) return 'empty-content';
  if (parsed === null || parsed === undefined) return 'invalid-json';
  return null;
}

module.exports = { SELECTION_SCHEMA, SELECTION_MAX_TOKENS, selectionConstraint, requestSelection, selectionCause };
