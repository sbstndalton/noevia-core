'use strict';
// ── Provider registry (step 9): generic OpenAI-compatible endpoints ────────
// One adapter covers all of them (same /chat/completions shape). Projects
// without a provider field use the environment-configured default provider.
//
// The registry is the workspace's merged view (shared rows plus the user's
// private ones); PROVIDERS is the request-scoped array index.cjs builds over
// it. This module owns the two persistence paths, the lookup with its legacy
// alias, key masking for the client, and the request headers a provider gets.

/**
 * @param {object} deps
 * @param {() => object} deps.currentWorkspace
 * @param {object[]} deps.PROVIDERS   request-scoped view of the workspace's providers
 * @param {string} deps.DEFAULT_PROVIDER_ID
 */
function createProviderRegistry({ currentWorkspace, PROVIDERS, DEFAULT_PROVIDER_ID }) {
  // Syncs the private half of the registry from the current merged view and
  // persists ONLY the user's private provider file. Shared rows are excluded:
  // a per-user save must never rewrite shared-providers.json (checkpoint 1c —
  // a stale snapshot could erase another admin's shared provider).
  function saveProviders() {
    const ws = currentWorkspace();
    ws.privateProviders = Array.from(ws.providers).filter((p) => !p.shared && p.id !== DEFAULT_PROVIDER_ID);
    ws.saveProviders();
  }

  // Admin path: persists the shared half of the registry from the current
  // merged view (private rows are synced in memory only, untouched on disk).
  function saveSharedProviders() {
    const ws = currentWorkspace();
    ws.privateProviders = Array.from(ws.providers).filter((p) => !p.shared && p.id !== DEFAULT_PROVIDER_ID);
    ws.saveShared();
  }

  function getProvider(id) {
    const normalized = id === 'lemonade' ? DEFAULT_PROVIDER_ID : id;
    const row = PROVIDERS.find((pr) => pr.id === normalized) || PROVIDERS.find((pr) => pr.id === DEFAULT_PROVIDER_ID) || null;
    // Effective capabilities travel on the row the chat sees, so consumers read data only.
    return row ? { ...row, capabilities: effectiveCapabilities(row) } : null;
  }

  function maskKey(key) {
    if (!key || key === 'local') return null;
    return key.length > 8 ? `${key.slice(0, 3)}…${key.slice(-4)}` : `…${key.slice(-4)}`;
  }

  function providerHeaders(provider, extra) {
    const h = { 'Content-Type': 'application/json', ...(extra || {}) };
    if (provider.apiKey && provider.apiKey !== 'local') h.Authorization = `Bearer ${provider.apiKey}`;
    return h;
  }

  return { saveProviders, saveSharedProviders, getProvider, maskKey, providerHeaders };
}

// A provider's context window, as a person states it (#536): a whole number of tokens in
// [CONTEXT_TOKENS_MIN, CONTEXT_TOKENS_MAX]. null, undefined or '' clear it (the chat falls back
// to its default for that kind of provider). Anything else is an error, never silently clamped.
const CONTEXT_TOKENS_MIN = 2048;
const CONTEXT_TOKENS_MAX = 2000000;
function parseContextTokens(value) {
  if (value === undefined || value === null || value === '') return { value: null };
  const n = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < CONTEXT_TOKENS_MIN || n > CONTEXT_TOKENS_MAX) {
    return { error: `contextTokens must be a whole number from ${CONTEXT_TOKENS_MIN} to ${CONTEXT_TOKENS_MAX}` };
  }
  return { value: n };
}
/** A stored contextTokens that is still in bounds, else null (hand-edited files included). */
function validContextTokens(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= CONTEXT_TOKENS_MIN && value <= CONTEXT_TOKENS_MAX ? value : null;
}

// ── Provider capabilities (#675) ────────────────────────────────────────────
// What a provider's API accepts is data on the provider row, never code in the chat path:
//   reasoningEffortParam   boolean  send a real reasoning_effort field (else a prompt hint)
//   reasoningEffortModels  string[] optional exact model ids the parameter applies to (absent = any)
//   tokenBudgetField       'max_tokens' | 'max_completion_tokens'  the output-budget field name
const TOKEN_BUDGET_FIELDS = ['max_tokens', 'max_completion_tokens'];
const CAPABILITY_KEYS = ['reasoningEffortParam', 'reasoningEffortModels', 'tokenBudgetField'];
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
  return { value: out };
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

module.exports = { parseCapabilities, effectiveCapabilities, createProviderRegistry, parseContextTokens, validContextTokens, CONTEXT_TOKENS_MIN, CONTEXT_TOKENS_MAX };
