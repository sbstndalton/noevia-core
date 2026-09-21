'use strict';
// The auto router's classifier (feature doc Item 4). Lifted out of index.cjs unchanged
// (2026-09-21): it is a pure decision — a heuristic, one cheap model call, and how to read a
// verdict out of the reply — and it was the largest piece of index.cjs that never touched the
// request handler at all.
//
// It fails open to `fast` on every error, because a router that blocks the chat is worse than
// a router that picks the cheaper model.

/** @param {{roles: () => object|null, provider: () => object, headers: (p: object) => object,
 *           fetchJson: (url: string, init: object, timeoutMs: number) => Promise<object>,
 *           log?: object}} deps */
function createAutoRouter({ roles, provider, headers, fetchJson, log = console }) {

  function heuristicWantsSmart(message) {
    const m = String(message);
    if (m.length > 600) return true;
    if (m.includes('```')) return true;
    if (/\b(function|algorithm|debug|refactor|implement|optimize|architecture|regex|sql|migration)\b/i.test(m)) return true;
    // Multi-step quantitative asks: several numbers in one message rarely
    // reduce to single-step arithmetic (e.g. chase/rate problems). False
    // positives just get a better model — cheap; false negatives are the
    // costly direction.
    const numbers = m.match(/\d+(?:[.,]\d+)?/g);
    if (numbers && numbers.length >= 3) return true;
    // Explicit effort/length requests ("600 words", "step by step", ...).
    if (/\b\d{2,}\s*(words?|paragraphs?|pages?|sentences?)\b/i.test(m)) return true;
    if (/\b(step[- ]by[- ]step|in detail|detailed|thoroughly|comprehensive|deep dive|prove|derive)\b/i.test(m)) return true;
    return false;
  }

  // One cheap classification call before an auto-routed message. Mirrors the
  // fail-open philosophy of diary-companion's pipeline.py skip_classifier: any
  // error or unparseable reply defaults to the fast role — the classifier must
  // never block the chat.
  // CODE is only offered to the model when a code role is configured. Asking for a verdict
  // the router cannot honour would spend the call and then discard the answer.
  const CLASSIFIER_SYSTEM_PROMPT =
    'You classify a user message for a model router. Reply with exactly one word: FAST for short simple questions or small talk, SMART for complex reasoning, multi-step work, code, or analysis. No other text.';
  const CLASSIFIER_SYSTEM_PROMPT_CODE =
    'You classify a user message for a model router. Reply with exactly one word: FAST for short simple questions or small talk, CODE for writing, reading, debugging or explaining source code, SMART for any other complex reasoning, multi-step work or analysis. No other text.';

  // Budget for the classifier reply. A non-reasoning answer is 1-3 tokens; this
  // only has to be large enough for a reasoning model that ignores the
  // no-thinking hint below to finish its chain of thought and still emit the
  // verdict. Measured against the local roster (2026-09-07): gemma-4-E2B needs
  // ~162 tokens thinking, Qwen3.5-9B ~427. The old value of 64 truncated both —
  // finish_reason came back 'length' with an empty content field, no verdict was
  // ever found, and every message silently fell open to fast. That is why auto
  // mode looked biased rather than broken.
  const CLASSIFIER_MAX_TOKENS = 512;

  function classifierBody(model, message, suppressThinking, withCode = false) {
    const body = {
      model,
      messages: [
        { role: 'system', content: withCode ? CLASSIFIER_SYSTEM_PROMPT_CODE : CLASSIFIER_SYSTEM_PROMPT },
        { role: 'user', content: String(message).slice(0, 1000) },
      ],
      max_tokens: CLASSIFIER_MAX_TOKENS,
      temperature: 0,
      stream: false,
    };
    // Routing is a mechanical label, not a reasoning task, so ask the model to
    // skip its chain of thought. llama.cpp/vLLM honour this; on the local
    // roster it cuts the call from ~162-427 tokens (12-31s on an iGPU, paid
    // before every single auto-routed message) to 2-3 tokens under 80ms.
    // Providers that reject unknown fields get a retry without it — see below.
    if (suppressThinking) body.chat_template_kwargs = { enable_thinking: false };
    return JSON.stringify(body);
  }

  // Read the verdict out of a classifier reply. content is authoritative when
  // present; the reasoning channel is only a fallback, and deliberately a
  // last-resort one: a thinking model restates the prompt's own FAST/SMART
  // wording while deliberating, so scanning it can pick up the prompt's words
  // rather than the model's conclusion.
  function classifierVerdict(msg, withCode = false) {
    const words = withCode ? /\b(SMART|FAST|CODE)\b/g : /\b(SMART|FAST)\b/g;
    const content = String(msg.content || '').toUpperCase();
    const direct = content.match(words);
    if (direct) return direct[direct.length - 1].toLowerCase();
    const reasoning = String(msg.reasoning_content || '').toUpperCase();
    const hits = reasoning.match(words);
    return hits ? hits[hits.length - 1].toLowerCase() : null;
  }

  // Code work the heuristic can name without a round-trip: a fenced block, or a diff.
  // Everything else is left to the classifier, as with `smart`.
  function heuristicWantsCode(message) {
    const m = String(message);
    if (m.includes('```')) return true;
    if (/^(diff --git|@@ -|\+\+\+ b\/)/m.test(m)) return true;
    return false;
  }

  async function classifyFastOrSmart(message) {
    const active = roles();
    if (!active) return 'fast';
    // A code role only participates when one is configured; otherwise the router
    // behaves exactly as it did before, and code work keeps going to smart.
    const withCode = !!active.code;
    if (withCode && heuristicWantsCode(message)) return 'code';
    if (heuristicWantsSmart(message)) return 'smart';
    try {
      const defaultProvider = provider();
      const url = `${defaultProvider.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/chat/completions`;
      const call = (suppressThinking) =>
        fetchJson(
          url,
          {
            method: 'POST',
            headers: headers(defaultProvider),
            body: classifierBody(active.fast, message, suppressThinking, withCode),
          },
          20000,
        );
      let r = await call(true);
      // chat_template_kwargs is a llama.cpp/vLLM extension. A strict provider
      // (or a gateway in front of one) may 400 on the unknown field; retry once
      // plainly rather than degrading to fast, which is the failure this whole
      // function exists to avoid.
      if (r.status === 400) {
        log.warn('[router] classifier rejected chat_template_kwargs (400), retrying without it');
        r = await call(false);
      }
      if (!r.ok) throw new Error(`classifier ${r.status}`);
      const choice = r.body?.choices?.[0] || {};
      const verdict = classifierVerdict(choice.message || {}, withCode);
      if (!verdict) {
        // Distinguish "ran out of room mid-thought" from "answered something
        // unparseable" — the first is a budget problem, the second a prompt one.
        const truncated = choice.finish_reason === 'length';
        log.warn(
          `[router] no verdict in classifier reply${truncated ? ` (truncated at ${CLASSIFIER_MAX_TOKENS} tokens)` : ''}, failing open to fast`,
        );
        return 'fast';
      }
      log.log(`[router] classified -> ${verdict}`);
      return verdict;
    } catch (err) {
      log.warn('[router] classify failed, failing open to fast:', err?.message || err);
      return 'fast';
    }
  }

  return { classify: classifyFastOrSmart, heuristicWantsSmart, heuristicWantsCode, classifierVerdict, classifierBody, CLASSIFIER_MAX_TOKENS };
}

module.exports = { createAutoRouter, CLASSIFIER_MAX_TOKENS: 512 };
