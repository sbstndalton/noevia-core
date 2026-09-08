'use strict';

// ── Passive prefill measurement (master step 17) ─────────────────────────
//
// How many tools a model can be handed is a question about how fast it reads
// them, and until now noevia answered it with a REGEX ON THE MODEL'S FILENAME
// — /(\d+)B/ — which worked only because local GGUF names carry "9B" by
// convention and was right about cloud models by accident.
//
// This measures it instead. Every chat already reveals the two numbers needed:
// the provider reports `prompt_tokens`, and we can time how long the first
// token took. Fitting those gives tokens/ms of prefill, which is the real
// budget currency, because the tool catalogue is re-sent and re-read on every
// single message.
//
// Deliberately PASSIVE — no synthetic probe requests. Two reasons:
//   1. Lemonade here runs max_loaded_models=1, so a probe naming a model that
//      is not currently loaded forces a model swap and thrashes the box.
//      Measuring the model already in use cannot.
//   2. It costs nothing. Zero extra inference load, and it keeps working for
//      any OpenAI-compatible provider, since they all report prompt_tokens.
//
// The hard part is that time-to-first-token is contaminated: a cold start
// includes model LOAD time, which on a swap is many seconds and has nothing to
// do with prefill. Averaging would bake that in. So samples are bucketed by
// prompt size and only the FASTEST time ever seen in each bucket is kept — a
// lower envelope. A load-contaminated sample is by definition slower than a
// warm one at the same size, so it is discarded automatically as soon as one
// clean sample arrives, and never drags the fit.

const BUCKET_TOKENS = 250;        // prompt sizes are grouped this coarsely
const MIN_SPAN_TOKENS = 500;      // two buckets must differ by at least this
const MAX_BUCKETS_PER_MODEL = 32; // bounded memory; models are few
const SAMPLE_TTL_MS = 24 * 60 * 60 * 1000;

// model -> Map(bucket -> { ttftMs, tokens, at })
const samples = new Map();

function bucketOf(tokens) {
  return Math.round(tokens / BUCKET_TOKENS) * BUCKET_TOKENS;
}

// Record one observation. Called from the chat stream; must never throw into
// the response path, so callers are not expected to guard it.
function recordSample(model, promptTokens, ttftMs) {
  if (!model || !Number.isFinite(promptTokens) || !Number.isFinite(ttftMs)) return;
  if (promptTokens <= 0 || ttftMs <= 0) return;
  if (ttftMs > 120000) return; // absurd: a stall or a very cold load, not prefill
  let byBucket = samples.get(model);
  if (!byBucket) { byBucket = new Map(); samples.set(model, byBucket); }
  const b = bucketOf(promptTokens);
  const prev = byBucket.get(b);
  // Lower envelope: keep the fastest observation for this prompt size. A stale
  // one is replaced regardless, so the fit follows the hardware if it changes.
  if (!prev || ttftMs < prev.ttftMs || Date.now() - prev.at > SAMPLE_TTL_MS) {
    byBucket.set(b, { ttftMs, tokens: promptTokens, at: Date.now() });
  }
  if (byBucket.size > MAX_BUCKETS_PER_MODEL) {
    const oldest = [...byBucket.entries()].sort((a, b2) => a[1].at - b2[1].at)[0];
    byBucket.delete(oldest[0]);
  }
}

function freshSamples(model) {
  const byBucket = samples.get(model);
  if (!byBucket) return [];
  const cutoff = Date.now() - SAMPLE_TTL_MS;
  return [...byBucket.values()].filter((s) => s.at >= cutoff).sort((a, b) => a.tokens - b.tokens);
}

// Tokens per millisecond of prefill, or null when not yet measurable.
//
// Two points, taken from the extremes of the observed range, rather than a
// regression over all of them: the fixed per-request overhead (queueing, the
// tool-calling preamble, the template) cancels in the difference, which is
// exactly what we want — the budget question is marginal cost per extra tool
// token, not the intercept.
function rateFor(model) {
  const s = freshSamples(model);
  if (s.length < 2) return null;
  const lo = s[0];
  const hi = s[s.length - 1];
  const dTokens = hi.tokens - lo.tokens;
  const dMs = hi.ttftMs - lo.ttftMs;
  if (dTokens < MIN_SPAN_TOKENS) return null; // too narrow a range to fit
  if (dMs <= 0) return null; // bigger prompt came back faster: noise, not signal
  return dTokens / dMs;
}

// The measured token budget for a latency target, or null when unmeasured so
// the caller can fall back to its heuristic.
function budgetFor(model, targetMs) {
  const rate = rateFor(model);
  if (!rate) return null;
  return Math.round(rate * targetMs);
}

function stats() {
  const out = {};
  for (const model of samples.keys()) {
    const s = freshSamples(model);
    const rate = rateFor(model);
    out[model] = {
      buckets: s.length,
      tokensPerSecond: rate ? Math.round(rate * 1000) : null,
      range: s.length ? [s[0].tokens, s[s.length - 1].tokens] : null,
    };
  }
  return out;
}

function reset() { samples.clear(); }

module.exports = { recordSample, rateFor, budgetFor, stats, reset, BUCKET_TOKENS, MIN_SPAN_TOKENS };
