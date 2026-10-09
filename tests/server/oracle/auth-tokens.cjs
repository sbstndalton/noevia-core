'use strict';

// TEST ORACLE (#1071): never required by production code (server/oracle-isolation.test.cjs
// enforces that). The JS reference of the auth-token env parsing, kept only so
// tools/gen-policy-leaves-fixtures.cjs can regenerate tests/fixtures/policy-leaves.v1.json and the
// differential tests can compare it with dav-parse.wasm (sbstndalton/noevia-rs crates/policy-leaves).
// Production decides through the Rust module alone (server/auth-tokens.cjs).
// Moved here unchanged from server/auth-tokens.cjs resolveAuthTokensJs.

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

module.exports = { resolveAuthTokensJs };
