'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAuthTokens } = require('./auth-tokens.cjs');

test('the two tokens are independent: neither falls back to the other (#294)', () => {
  const r = resolveAuthTokens({ DIARY_AUTH_TOKEN: 'diary-secret', UI_AUTH_TOKEN: '' });
  assert.equal(r.diaryToken, 'diary-secret');
  assert.equal(r.uiAuthToken, '', 'UI_AUTH_TOKEN no longer defaults to DIARY_AUTH_TOKEN');
});

test('both empty, LEGACY_AUTH_COMPAT off: only the Diary warning fires', () => {
  const r = resolveAuthTokens({});
  assert.deepEqual(r, { diaryToken: '', uiAuthToken: '', legacyCompat: false,
    warnings: ['WARNING: Set DIARY_AUTH_TOKEN to protect the internal diary connection. Browser accounts remain authenticated.'] });
});

test('DIARY_AUTH_TOKEN set: no Diary warning regardless of UI_AUTH_TOKEN', () => {
  const r = resolveAuthTokens({ DIARY_AUTH_TOKEN: 't' });
  assert.deepEqual(r.warnings, []);
});

test('LEGACY_AUTH_COMPAT=true with an empty UI_AUTH_TOKEN warns, independently of DIARY_AUTH_TOKEN', () => {
  const withDiary = resolveAuthTokens({ DIARY_AUTH_TOKEN: 't', LEGACY_AUTH_COMPAT: 'true' });
  assert.deepEqual(withDiary.warnings, [
    'WARNING: LEGACY_AUTH_COMPAT is true but UI_AUTH_TOKEN is empty; the legacy bearer sign-in has no token to check requests against.',
  ]);
  const withoutDiary = resolveAuthTokens({ LEGACY_AUTH_COMPAT: 'true' });
  assert.equal(withoutDiary.warnings.length, 2, 'both warnings fire independently when both are unset');
});

test('LEGACY_AUTH_COMPAT=true with UI_AUTH_TOKEN set: no legacy warning', () => {
  const r = resolveAuthTokens({ UI_AUTH_TOKEN: 'ui-secret', LEGACY_AUTH_COMPAT: 'true', DIARY_AUTH_TOKEN: 'd' });
  assert.deepEqual(r.warnings, []);
  assert.equal(r.uiAuthToken, 'ui-secret');
});

test('values are trimmed and LEGACY_AUTH_COMPAT is strictly the string "true"', () => {
  const r = resolveAuthTokens({ DIARY_AUTH_TOKEN: '  d  ', UI_AUTH_TOKEN: '  u  ', LEGACY_AUTH_COMPAT: 'TRUE' });
  assert.equal(r.diaryToken, 'd');
  assert.equal(r.uiAuthToken, 'u');
  assert.equal(r.legacyCompat, false);
});
