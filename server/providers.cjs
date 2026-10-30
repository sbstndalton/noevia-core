'use strict';
// ── Provider registry (step 9): generic OpenAI-compatible endpoints ────────
// One adapter covers all of them (same /chat/completions shape). Projects
// without a provider field use the environment-configured default provider.
//
// The registry is the workspace's merged view (shared rows plus the user's
// private ones); PROVIDERS is the request-scoped array index.cjs builds over
// it. This module owns the lookup with its legacy alias, key masking for the
// client, and the request headers a provider gets. Both provider files are the
// Rust front's to write (sbstndalton/noevia#2190 round 6, rust-providers.cjs):
// the routes live there, with these definitions (validation, capabilities,
// context window) ported to noevia-rs provider_routes.rs.

/**
 * @param {object} deps
 * @param {object[]} deps.PROVIDERS   request-scoped view of the workspace's providers
 * @param {string} deps.DEFAULT_PROVIDER_ID
 */
function createProviderRegistry({ PROVIDERS, DEFAULT_PROVIDER_ID }) {
  function getProvider(id) {
    const normalized = id === 'lemonade' ? DEFAULT_PROVIDER_ID : id;
    const row = PROVIDERS.find((pr) => pr.id === normalized) || PROVIDERS.find((pr) => pr.id === DEFAULT_PROVIDER_ID) || null;
    // Effective capabilities travel on the row the chat sees, so consumers read data only.
    return row ? { ...row, capabilities: effectiveCapabilities(row) } : null;
  }

  function providerHeaders(provider, extra) {
    const h = { 'Content-Type': 'application/json', ...(extra || {}) };
    if (provider.apiKey && provider.apiKey !== 'local') h.Authorization = `Bearer ${provider.apiKey}`;
    return h;
  }

  return { getProvider, providerHeaders };
}

// A provider's context window (#536): a whole number of tokens in [CONTEXT_TOKENS_MIN,
// CONTEXT_TOKENS_MAX]. Stating it is the Rust front's (provider_routes.rs); the chat reads it.
const CONTEXT_TOKENS_MIN = 2048;
const CONTEXT_TOKENS_MAX = 2000000;
/** A stored contextTokens that is still in bounds, else null (hand-edited files included). */
function validContextTokens(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= CONTEXT_TOKENS_MIN && value <= CONTEXT_TOKENS_MAX ? value : null;
}

// ── Provider capabilities (#675) ────────────────────────────────────────────
// What a provider's API accepts is data on the provider row, never code in the chat path:
//   reasoningEffortParam   boolean  send a real reasoning_effort field (else a prompt hint)
//   reasoningEffortModels  string[] optional exact model ids the parameter applies to (absent = any)
//   tokenBudgetField       'max_tokens' | 'max_completion_tokens'  the output-budget field name
//   jsonSchemaParam        boolean  accepts `response_format: { type: 'json_schema', json_schema: { schema } }`
//                                   and constrains decoding to it (#517; read by plan-constrained-decoding.cjs)
const TOKEN_BUDGET_FIELDS = ['max_tokens', 'max_completion_tokens'];
const CAPABILITY_KEYS = ['reasoningEffortParam', 'reasoningEffortModels', 'tokenBudgetField', 'jsonSchemaParam'];
/** Validates admin/tenant input. { value } is a clean object (possibly {}), or { error }. */
function parseCapabilities(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'capabilities must be an object' };
  for (const key of Object.keys(input)) if (!CAPABILITY_KEYS.includes(key)) return { error: `unknown capability: ${key}` };
  const out = {};
  if (input.reasoningEffortParam !== undefined) {
    if (typeof input.reasoningEffortParam !== 'boolean') return { error: 'reasoningEffortParam must be true or false' };
    out.reasoningEffortParam = input.reasoningEffortParam;
  }
  if (input.reasoningEffortModels !== undefined) {
    const m = input.reasoningEffortModels;
    if (!Array.isArray(m) || m.length > 50 || m.some((x) => typeof x !== 'string' || !x.trim() || x.length > 200)) {
      return { error: 'reasoningEffortModels must be a list of up to 50 model ids' };
    }
    out.reasoningEffortModels = m.map((x) => x.trim());
  }
  if (input.tokenBudgetField !== undefined) {
    if (!TOKEN_BUDGET_FIELDS.includes(input.tokenBudgetField)) return { error: `tokenBudgetField must be one of ${TOKEN_BUDGET_FIELDS.join(', ')}` };
    out.tokenBudgetField = input.tokenBudgetField;
  }
  if (input.jsonSchemaParam !== undefined) {
    if (typeof input.jsonSchemaParam !== 'boolean') return { error: 'jsonSchemaParam must be true or false' };
    out.jsonSchemaParam = input.jsonSchemaParam;
  }
  return { value: out };
}

// What the operator-configured default provider accepts, by the engine kind the deployment declares
// (MODEL_MANAGER_KIND), not by its address or model. The engine kinds here document the field in the
// version this repository pins (llama.cpp b10920 tools/server: `response_format` json_schema, converted
// to a grammar). A kind not listed declares nothing. The default row cannot be edited (routes/providers),
// so this definition is the only source of its capabilities.
const ENGINE_CAPABILITIES = Object.freeze({ llamacpp: Object.freeze({ jsonSchemaParam: true }) });
/** Capabilities for the env-derived default provider row, or null when the engine kind declares none. */
function engineCapabilities(kind) {
  const caps = Object.prototype.hasOwnProperty.call(ENGINE_CAPABILITIES, kind) ? ENGINE_CAPABILITIES[kind] : null;
  return caps ? { ...caps } : null;
}

// The built-in presets' capability definitions (mirrors the presets in ProviderForm.tsx). A stored
// row that predates capabilities (no `capabilities` key) and points at a preset's address inherits
// that preset's definition, so existing connections behave exactly as before. A row that carries
// its own capabilities (even {}) is never overridden.
const PRESET_CAPABILITIES = [{
  origin: 'https://api.openai.com',
  tokenBudgetField: 'max_completion_tokens',
  reasoning: { paths: ['', '/', '/v1', '/v1/'], models: ['gpt-5.4'] },
}];
function legacyPresetCapabilities(baseUrl) {
  try {
    const url = new URL(baseUrl);
    for (const preset of PRESET_CAPABILITIES) {
      if (url.origin !== preset.origin) continue;
      const out = { tokenBudgetField: preset.tokenBudgetField };
      if (preset.reasoning && !url.search && !url.hash && !url.username && !url.password && preset.reasoning.paths.includes(url.pathname)) {
        out.reasoningEffortParam = true;
        out.reasoningEffortModels = [...preset.reasoning.models];
      }
      return out;
    }
  } catch { /* unparseable address: no capabilities */ }
  return {};
}
/** The capabilities in force for a stored provider row. Stored values are re-validated (hand-edited files). */
function effectiveCapabilities(row) {
  if (row && row.capabilities !== undefined) {
    const parsed = parseCapabilities(row.capabilities);
    return parsed.error ? {} : parsed.value;
  }
  return legacyPresetCapabilities(row?.baseUrl);
}

module.exports = { parseCapabilities, effectiveCapabilities, engineCapabilities, createProviderRegistry, validContextTokens, CONTEXT_TOKENS_MIN, CONTEXT_TOKENS_MAX };
