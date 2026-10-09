'use strict';
// Pure env parsing for the two independent auth tokens (#294), pulled out of index.cjs so it
// stays wiring only and this can be unit tested without booting the server.
//
// DIARY_AUTH_TOKEN and UI_AUTH_TOKEN each protect a different thing and no longer fall back to
// one another: DIARY_AUTH_TOKEN authenticates web's own calls to the Diary sidecar; UI_AUTH_TOKEN
// is the legacy bearer `auth.cjs` accepts when LEGACY_AUTH_COMPAT=true. An operator who sets one
// gets no free protection on the other.
//
// Policy leaves (POLICY_LEAVES_IMPL, retired in #1071: Rust is always used): the trimming and the
// warnings are decided in noevia-rs's policy-leaves crate (in dav-parse.wasm, as a secret call).
// Fails closed: any refusal or bad reply throws (startup stops) with a message that never carries
// a token. The JS reference is tests/server/oracle/auth-tokens.cjs (fixtures and tests only).

// dav-parse-wasm.cjs DavParseError reasons, plus the module's own refusal codes.
const REASONS = new Set(['abi', 'checksum', 'compile', 'input', 'lock', 'missing', 'options', 'reply', 'too_large', 'trap', 'unknown']);

/** The tokens, flags and warnings decided by the Rust port. The coercion `String(v || '')` stays here. */
function resolveAuthTokens(env = process.env, { wasm = require('./dav-parse-wasm.cjs') } = {}) {
  const compat = env.LEGACY_AUTH_COMPAT;
  try {
    return wasm.authTokens(String(env.DIARY_AUTH_TOKEN || ''), String(env.UI_AUTH_TOKEN || ''), typeof compat === 'string' ? compat : undefined);
  } catch (err) {
    // Only a known fixed reason: never the token, never the module's or error's text.
    const reason = REASONS.has(err?.reason) ? err.reason : 'unexpected';
    throw new Error(`Auth tokens could not be checked by the Rust port (${reason}).`);
  }
}

module.exports = { resolveAuthTokens };
