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
    return PROVIDERS.find((pr) => pr.id === normalized) || PROVIDERS.find((pr) => pr.id === DEFAULT_PROVIDER_ID) || null;
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

module.exports = { createProviderRegistry, parseContextTokens, validContextTokens, CONTEXT_TOKENS_MIN, CONTEXT_TOKENS_MAX };
