'use strict';
// Pure env parsing for the two independent auth tokens (#294), pulled out of index.cjs so it
// stays wiring only and this can be unit tested without booting the server.
//
// DIARY_AUTH_TOKEN and UI_AUTH_TOKEN each protect a different thing and no longer fall back to
// one another: DIARY_AUTH_TOKEN authenticates web's own calls to the Diary sidecar; UI_AUTH_TOKEN
// is the legacy bearer `auth.cjs` accepts when LEGACY_AUTH_COMPAT=true. An operator who sets one
// gets no free protection on the other.

/**
 * @param {object} [env] process.env, or a fake for tests
 * @returns {{ diaryToken: string, uiAuthToken: string, legacyCompat: boolean, warnings: string[] }}
 */
function resolveAuthTokens(env = process.env) {
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

module.exports = { resolveAuthTokens };
