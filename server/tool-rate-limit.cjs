'use strict';
// #1693: a tool provider that answers 429 (rate limited, or its quota spent) is not called again at once. Two
// back-to-back web searches both hit 429 and the model was told only "Returned an error". Now the model gets a
// retryable error that says to wait, and further calls to the same provider inside the wait are answered here
// without a request: the backoff doubles on each 429 (a Retry-After the provider sends wins, within the cap) and a
// success clears it. Keyed by the caller (server id, plus the account for a per-account key), so one account's own
// key never pauses another's. Providers stay generic: nothing here names one.

const BASE_MS = 15000;
const MAX_MS = 5 * 60 * 1000;
// A tool result that reports a rate limit in its text (an MCP `isError` result rather than an HTTP status).
const RATE_LIMIT_TEXT = /\b(?:HTTP|status(?:\s+code)?)[\s:]*429\b|\brate[\s-]?limit(?:ed|ing)?\b|\btoo many requests\b|\bquota (?:exceeded|exhausted)\b|\busage limit\b/i;

function isRateLimitedText(text) { return RATE_LIMIT_TEXT.test(String(text || '').slice(0, 2000)); }

/** Retry-After in ms (seconds or an HTTP date), or null. */
function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const at = Date.parse(s);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function createToolRateLimit({ now = () => Date.now(), baseMs = BASE_MS, maxMs = MAX_MS } = {}) {
  const state = new Map(); // key -> { until, strikes }
  // #1701: entries whose wait ended more than one maximum wait ago are pruned (every key, on every lookup), so the
  // map holds only keys still waiting or recently throttled. Until then a key keeps its strike count, so a provider
  // that answers 429 again right after a wait gets the doubled one.
  const prune = (at) => { for (const [key, s] of state) if (at - s.until > maxMs) state.delete(key); };
  const remaining = (key) => {
    const at = now();
    prune(at);
    const s = state.get(key);
    return s && s.until > at ? s.until - at : 0;
  };
  return {
    /** ms left before this key may call again (0: go ahead). */
    remaining,
    /** A 429 for this key; returns the wait in ms. */
    hit(key, retryAfterMs = null) {
      remaining(key);
      const prev = state.get(key);
      const strikes = (prev ? prev.strikes : 0) + 1;
      const backoff = Math.min(maxMs, baseMs * 2 ** (strikes - 1));
      const wait = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(maxMs, Math.max(retryAfterMs, 1000)) : backoff;
      state.set(key, { until: now() + wait, strikes });
      return wait;
    },
    clear(key) { state.delete(key); },
    /** Entries held (tests). */
    size() { return state.size; },
  };
}

const seconds = (ms) => Math.max(1, Math.ceil(ms / 1000));
/** The model's text for a 429 just received. Starts with "ERROR: " so the call counts as failed. */
function rateLimitedText(name, waitMs) {
  return `ERROR: ${name} was rate limited by its provider (HTTP 429). This is retryable, but not now: wait about ${seconds(waitMs)} s before calling it again. Answer from the results you already have, or say the search is rate limited.`;
}
/** The model's text for a call skipped because the provider is still in its wait. */
function coolingDownText(name, waitMs) {
  return `ERROR: ${name} was not called: its provider is rate limiting requests (HTTP 429), retry in about ${seconds(waitMs)} s. Answer from the results you already have, or say the search is rate limited.`;
}

module.exports = { createToolRateLimit, isRateLimitedText, parseRetryAfter, rateLimitedText, coolingDownText, BASE_MS, MAX_MS };
