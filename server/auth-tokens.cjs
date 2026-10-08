'use strict';
// Pure env parsing for the two independent auth tokens (#294), pulled out of index.cjs so it
// stays wiring only and this can be unit tested without booting the server.
//
// DIARY_AUTH_TOKEN and UI_AUTH_TOKEN each protect a different thing and no longer fall back to
// one another: DIARY_AUTH_TOKEN authenticates web's own calls to the Diary sidecar; UI_AUTH_TOKEN
// is the legacy bearer `auth.cjs` accepts when LEGACY_AUTH_COMPAT=true. An operator who sets one
// gets no free protection on the other.
//
// POLICY_LEAVES_IMPL=js|wasm (default js; any other value means js, with one warning), read from
// process.env on every call: wasm trims and decides in noevia-rs's policy-leaves crate (in
// dav-parse.wasm, as a secret call). Fails closed: the flag is in dav-parse-wasm.cjs IMPL_FLAGS,
// and any refusal or bad reply throws (startup stops) with a message that never carries a token.

/**
 * @param {object} [env] process.env, or a fake for tests
 * @returns {{ diaryToken: string, uiAuthToken: string, legacyCompat: boolean, warnings: string[] }}
 */
function resolveAuthTokensJs(env = process.env) {
  const diaryToken = String(env.DIARY_AUTH_TOKEN || '').trim();
  const uiAuthToken = String(env.UI_AUTH_TOKEN || '').trim();
  const legacyCompat = env.LEGACY_AUTH_COMPAT === 'true';
  const warnings = [];
  if (!diaryToken) {
    warnings.push('WARNING: Set DIARY_AUTH_TOKEN to protect the internal diary connection. Browser accounts remain authenticated.');
  }
  if (legacyCompat && !uiAuthToken) {
    warnings.push('WARNING: LEGACY_AUTH_COMPAT is true but UI_AUTH_TOKEN is empty; the legacy bearer sign-in has no token to check requests against.');
  }
  return { diaryToken, uiAuthToken, legacyCompat, warnings };
}

const IMPLS = new Set(['js', 'wasm']);
let warnedImpl = '';
/** POLICY_LEAVES_IMPL: 'js' (default) or 'wasm'. Shared with tool-policy.cjs. */
function policyLeavesImpl(env = process.env) {
  const raw = env.POLICY_LEAVES_IMPL;
  if (raw === undefined || raw === '') return 'js';
  const value = String(raw).trim().toLowerCase();
  if (IMPLS.has(value)) return value;
  if (warnedImpl !== value) {
    warnedImpl = value;
    console.warn(`[policy-leaves] POLICY_LEAVES_IMPL=${JSON.stringify(String(raw))} is not js or wasm; using js`);
  }
  return 'js';
}

// dav-parse-wasm.cjs DavParseError reasons, plus the module's own refusal codes.
const REASONS = new Set(['abi', 'checksum', 'compile', 'input', 'lock', 'missing', 'options', 'reply', 'too_large', 'trap', 'unknown']);

/** resolveAuthTokensJs decided by the Rust port. The coercion `String(v || '')` stays here. */
function resolveAuthTokensWasm(env = process.env, { wasm = require('./dav-parse-wasm.cjs') } = {}) {
  const compat = env.LEGACY_AUTH_COMPAT;
  try {
    return wasm.authTokens(String(env.DIARY_AUTH_TOKEN || ''), String(env.UI_AUTH_TOKEN || ''), typeof compat === 'string' ? compat : undefined);
  } catch (err) {
    // Only a known fixed reason: never the token, never the module's or error's text.
    const reason = REASONS.has(err?.reason) ? err.reason : 'unexpected';
    throw new Error(`Auth tokens could not be checked by the Rust port (${reason}).`);
  }
}

/** resolveAuthTokensJs or its Rust port, by POLICY_LEAVES_IMPL. */
function resolveAuthTokens(env = process.env) {
  return policyLeavesImpl() === 'wasm' ? resolveAuthTokensWasm(env) : resolveAuthTokensJs(env);
}

module.exports = { resolveAuthTokens, resolveAuthTokensJs, resolveAuthTokensWasm, policyLeavesImpl };
